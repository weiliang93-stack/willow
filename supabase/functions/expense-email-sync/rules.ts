// Pure decision logic: parsed events + current rules/state -> what to do with
// each email. Mirrors the nightly "Auto-log expenses from bank emails"
// routine's written process step for step (card mapping, exclusionRules,
// categoryRules, self-transfers, PayNow recipient/source rules, bill
// payments, reversals, CDG Zig vs Cabcharge de-duplication), so shadow-mode
// output can be compared against what the routine actually logged. No I/O.

import type { ParsedEvent } from "./parse.ts";

export interface Expense {
  id: string;
  date: string;
  amount: number;
  category: string;
  cardId: string;
  note: string;
}
export interface ExcludedExpense extends Expense {
  type: string;
  reason: string;
}
export interface ExclusionRule {
  matchType: "merchant" | "cardLast4" | "paynowRecipient" | "paynowSourceAccount";
  matchValue: string;
  type: "fixed" | "combined" | "not_expense";
  reason: string;
  cardId?: string;
  cap?: number;
  resetMode?: string;
  statementDay?: number;
  category?: string;
}
export interface CategoryRule {
  merchantPattern: string;
  category: string;
}
// last4 -> how that card maps onto the app's cards. `split` handles the two
// UOB cards the owner tracks as two separate caps in-app.
export type CardMapEntry =
  | { cardId: string }
  | { split: "overseas"; foreign: string; local: string }
  | { split: "online"; online: string; local: string };

export interface SyncConfig {
  cardMap: Record<string, CardMapEntry>;
  onlineMerchantHints: string[]; // lowercase substrings that mean "online" for split:"online" cards
  categoryKeywords: CategoryRule[]; // built-in fallbacks tried after the owner's categoryRules
}

export interface Context {
  exclusionRules: ExclusionRule[];
  categoryRules: CategoryRule[];
  selfTransferAccounts: string[];
  config: SyncConfig;
  existingIds: Set<string>; // every id already in expenses + excludedExpenses
  recent: (Expense & { target: "expenses" | "excluded" })[]; // last ~7 days of logged entries, for reversal/Cabcharge matching
}

export interface Incoming {
  messageId: string;
  event: ParsedEvent & { kind: string };
}

export type Decision =
  | { messageId: string; action: "log"; target: "expenses" | "excluded"; entry: Expense | ExcludedExpense; needsCategory: boolean; lowConfidence?: string; summary: string }
  | { messageId: string; action: "remove"; removeId: string; target: "expenses" | "excluded"; summary: string }
  | { messageId: string; action: "incoming"; amount: number; destAcct: string | null; date: string; summary: string }
  | { messageId: string; action: "review"; summary: string }
  | { messageId: string; action: "defer"; summary: string }
  | { messageId: string; action: "skip"; summary: string; label: boolean };

const ID = (messageId: string) => `gm-${messageId}`;

function includesCI(hay: string, needle: string) {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

export function money(n: number) {
  return `$${n.toFixed(2)}`;
}

function resolveCard(last4: string, merchant: string, currency: string, ctx: Context): { cardId: string; mapped: boolean; lowConfidence?: string } {
  const entry = ctx.config.cardMap[last4];
  if (!entry) return { cardId: "cash", mapped: false };
  if ("cardId" in entry) return { cardId: entry.cardId, mapped: true };
  if (entry.split === "overseas") {
    const foreign = currency !== "SGD";
    return { cardId: foreign ? entry.foreign : entry.local, mapped: true };
  }
  const online = ctx.config.onlineMerchantHints.some((h) => merchant.toLowerCase().includes(h));
  return {
    cardId: online ? entry.online : entry.local,
    mapped: true,
    lowConfidence: `card ${last4}: guessed ${online ? "Online" : "Contactless"} from merchant "${merchant}"`,
  };
}

// categoryRules (owner's) first, then built-in keywords; null = needs a guess.
export function ruleCategory(text: string, ctx: Context): string | null {
  for (const r of ctx.categoryRules) if (includesCI(text, r.merchantPattern)) return r.category;
  for (const r of ctx.config.categoryKeywords) if (includesCI(text, r.merchantPattern)) return r.category;
  return null;
}

function matchRule(ctx: Context, type: ExclusionRule["matchType"], value: string): ExclusionRule | undefined {
  return ctx.exclusionRules.find((r) => {
    if (r.matchType !== type) return false;
    if (type === "cardLast4" || type === "paynowSourceAccount") return r.matchValue === value;
    return includesCI(value, r.matchValue);
  });
}

function buildLog(
  messageId: string,
  base: { date: string; amount: number; note: string; cardId: string; category: string | null },
  rule: ExclusionRule | undefined,
  extraSummary: string,
  lowConfidence?: string,
): Decision {
  const category = rule?.category ?? base.category;
  const needsCategory = category == null;
  if (rule && rule.type !== "not_expense") {
    const entry: ExcludedExpense = {
      id: ID(messageId),
      date: base.date,
      note: base.note,
      amount: base.amount,
      category: category ?? "",
      cardId: rule.cardId ?? base.cardId,
      type: rule.type,
      reason: rule.reason,
    };
    return { messageId, action: "log", target: "excluded", entry, needsCategory, lowConfidence, summary: `${extraSummary} → ${rule.type} (${rule.reason})` };
  }
  const entry: Expense = { id: ID(messageId), date: base.date, amount: base.amount, category: category ?? "", cardId: base.cardId, note: base.note };
  return { messageId, action: "log", target: "expenses", entry, needsCategory, lowConfidence, summary: extraSummary };
}

function daysApart(a: string, b: string) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

export function classify(batch: Incoming[], ctx: Context, nowDate: string): Decision[] {
  const out: Decision[] = [];
  const handled = new Set<string>();

  // --- Reversals: cancel a charge in this same batch, else remove an
  // already-logged entry, else ask.
  for (const r of batch) {
    const ev = r.event;
    if (ev.kind !== "reversal") continue;
    handled.add(r.messageId);
    const twin = batch.find(
      (c) => !handled.has(c.messageId) && c.event.kind === "card_charge" && c.event.last4 === ev.last4 && c.event.amount === ev.amount,
    );
    if (twin) {
      handled.add(twin.messageId);
      out.push({ messageId: twin.messageId, action: "skip", label: true, summary: `${money(ev.amount)} ${ev.merchant}: reversed in the same batch, not logged` });
      out.push({ messageId: r.messageId, action: "skip", label: true, summary: `reversal of ${money(ev.amount)} ${ev.merchant}` });
      continue;
    }
    const cardIds = new Set<string>();
    const map = ctx.config.cardMap[ev.last4];
    if (map) for (const v of Object.values(map)) if (typeof v === "string" && v !== "overseas" && v !== "online") cardIds.add(v);
    const rule = matchRule(ctx, "cardLast4", ev.last4);
    if (rule?.cardId) cardIds.add(rule.cardId);
    const prefix = ev.merchant.slice(0, 6).toLowerCase();
    const logged = ctx.recent.find(
      (e) => e.amount === ev.amount && cardIds.has(e.cardId) && daysApart(e.date, ev.date) <= 3 && e.note.toLowerCase().startsWith(prefix),
    );
    if (logged) {
      out.push({ messageId: r.messageId, action: "remove", removeId: logged.id, target: logged.target, summary: `reversal: removed ${money(ev.amount)} ${ev.merchant} (${logged.date})` });
    } else {
      out.push({ messageId: r.messageId, action: "review", summary: `reversal of ${money(ev.amount)} at ${ev.merchant} (card ${ev.last4}) — no matching logged charge found` });
    }
  }

  for (const item of batch) {
    const { messageId } = item;
    const ev = item.event;
    if (handled.has(messageId)) continue;
    if (ctx.existingIds.has(ID(messageId))) {
      out.push({ messageId, action: "skip", label: true, summary: "already logged" });
      continue;
    }

    switch (ev.kind) {
      case "card_charge": {
        const card = resolveCard(ev.last4, ev.merchant, ev.currency, ctx);
        const rule = matchRule(ctx, "merchant", ev.merchant) ?? matchRule(ctx, "cardLast4", ev.last4);
        const cab = /cabcharge/i.test(ev.merchant);
        let category = ruleCategory(ev.merchant, ctx);
        if (cab) category = "Transport";
        const fx = ev.currency !== "SGD" ? ` (${ev.currency} ${ev.amount.toFixed(2)})` : "";
        const note = `${card.mapped ? "" : `[card ending ${ev.last4} — not mapped] `}${ev.merchant}${fx}, auto-logged from email`;
        out.push(
          buildLog(
            messageId,
            { date: ev.date, amount: ev.amount, note, cardId: card.cardId, category },
            rule,
            `${money(ev.amount)} ${ev.merchant} (${ev.bank} ${ev.last4})`,
            card.lowConfidence,
          ),
        );
        break;
      }

      case "cdg_receipt": {
        if (/^\d{4}$/.test(ev.payment)) {
          // Paid straight from a card: no bank alert will follow, so the
          // receipt is the only record.
          const card = resolveCard(ev.payment, "CDG Zig", "SGD", ctx);
          const rule = matchRule(ctx, "cardLast4", ev.payment);
          const route = ev.pickup && ev.dropoff ? ` — ${ev.pickup} to ${ev.dropoff}` : "";
          out.push(
            buildLog(
              messageId,
              { date: ev.date, amount: ev.amount, note: `CDG Zig${route}, auto-logged from email`, cardId: card.cardId, category: "Transport" },
              rule,
              `${money(ev.amount)} CDG Zig (card ${ev.payment})`,
            ),
          );
          break;
        }
        // Wallet-paid: the linked card's own "Cabcharge Asia" alert is the
        // record. Skip the receipt once that alert is seen (this batch or
        // already logged); wait up to 2 days for it, then ask.
        const inBatch = batch.some(
          (b) => b.event.kind === "card_charge" && /cabcharge/i.test(b.event.merchant) && b.event.amount === ev.amount && daysApart(b.event.date, ev.date) <= 1,
        );
        const logged = ctx.recent.some((e) => /cabcharge/i.test(e.note) && e.amount === ev.amount && daysApart(e.date, ev.date) <= 1);
        if (inBatch || logged) {
          out.push({ messageId, action: "skip", label: true, summary: `CDG Zig ${money(ev.amount)} (${ev.payment}): duplicate of the card's Cabcharge alert` });
        } else if (daysApart(nowDate, ev.date) >= 2) {
          out.push({ messageId, action: "review", summary: `CDG Zig ${money(ev.amount)} on ${ev.date} paid by ${ev.payment}, but no matching Cabcharge card alert arrived` });
        } else {
          out.push({ messageId, action: "defer", summary: `CDG Zig ${money(ev.amount)} (${ev.payment}): waiting for the card's Cabcharge alert` });
        }
        break;
      }

      case "bill_payment": {
        if (ctx.config.cardMap[ev.billRef] || matchRule(ctx, "cardLast4", ev.billRef)) {
          out.push({ messageId, action: "skip", label: true, summary: `bill payment ${money(ev.amount)} to ${ev.payee} (ref ${ev.billRef}): settles already-logged charges` });
        } else {
          out.push({ messageId, action: "review", summary: `bill payment ${money(ev.amount)} to ${ev.payee}, ref ${ev.billRef} doesn't match a tracked card` });
        }
        break;
      }

      case "transfer_in": {
        out.push({ messageId, action: "incoming", amount: ev.amount, destAcct: ev.destAcct, date: ev.date, summary: `received ${money(ev.amount)} into a/c ${ev.destAcct ?? "?"}` });
        break;
      }

      case "transfer_out": {
        const self = ctx.selfTransferAccounts;
        if (ev.sourceAcct && ev.destAcct && self.includes(ev.sourceAcct) && self.includes(ev.destAcct)) {
          out.push({ messageId, action: "skip", label: true, summary: `self-transfer ${money(ev.amount)} ${ev.sourceAcct}→${ev.destAcct}` });
          break;
        }
        const recipientRule = matchRule(ctx, "paynowRecipient", ev.recipient);
        if (recipientRule?.type === "not_expense") {
          out.push({ messageId, action: "skip", label: true, summary: `${money(ev.amount)} to ${ev.recipient}: ${recipientRule.reason}` });
          break;
        }
        const rule = recipientRule ?? (ev.sourceAcct ? matchRule(ctx, "paynowSourceAccount", ev.sourceAcct) : undefined);
        if (rule?.type === "not_expense") {
          out.push({ messageId, action: "skip", label: true, summary: `${money(ev.amount)} to ${ev.recipient}: ${rule.reason}` });
          break;
        }
        const note = ev.format === "paynow" ? `PayNow to ${ev.recipient}, auto-logged from email` : `Funds transfer to ${ev.recipient}, auto-logged from email`;
        out.push(
          buildLog(
            messageId,
            { date: ev.date, amount: ev.amount, note, cardId: "cash", category: ruleCategory(ev.recipient, ctx) },
            rule,
            `${money(ev.amount)} ${ev.format === "paynow" ? "PayNow" : "transfer"} to ${ev.recipient}`,
          ),
        );
        break;
      }

      case "info":
        out.push({ messageId, action: "skip", label: false, summary: ev.reason });
        break;

      default:
        out.push({ messageId, action: "review", summary: (ev as { reason?: string }).reason ?? "unrecognised alert" });
    }
  }
  return out;
}

// ---------------- month-to-date figures for the daily report ----------------

export interface Card {
  id: string;
  name: string;
  cap: number;
  resetMode: string;
  statementDay: number | null;
}

export function cycleStart(today: string, resetMode: string | undefined, statementDay: number | null | undefined): string {
  const [y, m, d] = today.split("-").map(Number);
  if (resetMode !== "statement" || !statementDay) return `${y}-${String(m).padStart(2, "0")}-01`;
  if (d >= statementDay) return `${y}-${String(m).padStart(2, "0")}-${String(statementDay).padStart(2, "0")}`;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-${String(statementDay).padStart(2, "0")}`;
}

export interface CapLine {
  name: string;
  spent: number;
  cap: number;
}

export function monthToDate(
  today: string,
  expenses: Expense[],
  excluded: ExcludedExpense[],
  cards: Card[],
  rules: ExclusionRule[],
  monthlyBudget: number | null,
) {
  const month = today.slice(0, 7);
  const spent = round2(expenses.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0));
  const caps: CapLine[] = [];
  for (const c of cards) {
    if (!(c.cap > 0)) continue;
    const from = cycleStart(today, c.resetMode, c.statementDay);
    const sum = [...expenses, ...excluded].filter((e) => e.cardId === c.id && e.date >= from && e.date <= today).reduce((s, e) => s + e.amount, 0);
    caps.push({ name: c.name, spent: round2(sum), cap: c.cap });
  }
  for (const r of rules) {
    if (!(r.cap && r.cap > 0) || !r.cardId) continue;
    const from = cycleStart(today, r.resetMode, r.statementDay);
    const sum = excluded.filter((e) => e.cardId === r.cardId && e.date >= from && e.date <= today).reduce((s, e) => s + e.amount, 0);
    caps.push({ name: r.matchType === "merchant" ? `${r.matchValue} (combined)` : r.reason.split(" - ")[0], spent: round2(sum), cap: r.cap });
  }
  return { spent, budget: monthlyBudget, caps };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
