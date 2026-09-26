import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, cycleStart, monthToDate, type Context, type Incoming } from "./rules.ts";
import { DEFAULT_CONFIG } from "./config.ts";

function ctx(over: Partial<Context> = {}): Context {
  return {
    exclusionRules: [
      { matchType: "merchant", matchValue: "EMPRESS PORRIDGE", type: "combined", reason: "shared with wife", cardId: "mtgczdzqa9a8j", cap: 750, resetMode: "calendar" },
      { matchType: "cardLast4", matchValue: "8959", type: "combined", reason: "UOB Lady Supplementary card (wife's) - combined expense", cardId: "uob_lady_supp_8959" },
      { matchType: "cardLast4", matchValue: "3902", type: "combined", reason: "Citibank Rewards - combined expense", cardId: "citi_rewards_3902", cap: 1000, resetMode: "statement", statementDay: 5 },
      { matchType: "paynowRecipient", matchValue: "5006", type: "combined", reason: "PayNow to mobile ending 5006 - combined transport expense", cardId: "paynow_5006", category: "Transport" },
      { matchType: "paynowSourceAccount", matchValue: "7831", type: "combined", reason: "UOB joint account (a/c ending 7831) - combined expense", cardId: "uob_joint_7831" },
      { matchType: "paynowRecipient", matchValue: "INSPIRE MEDICAL", type: "not_expense", reason: "Transfer to own clinic" },
      { matchType: "paynowRecipient", matchValue: "INTERACTIVE BROKERS", type: "not_expense", reason: "IBKR contribution" },
    ],
    categoryRules: [{ merchantPattern: "PLAYTOMIC", category: "Badminton" }],
    selfTransferAccounts: ["7831", "3561"],
    config: DEFAULT_CONFIG,
    existingIds: new Set(),
    recent: [],
    ...over,
  };
}

const charge = (id: string, last4: string, amount: number, merchant: string, date = "2026-09-25", currency = "SGD"): Incoming => ({
  messageId: id,
  event: { kind: "card_charge", bank: "X", last4, amount, merchant, date, currency },
});

test("personal card charge goes to expenses with gm- id and mapped card", () => {
  const [d] = classify([charge("m1", "3051", 35.01, "KrisPay*LeNu Chef Wai")], ctx(), "2026-09-25");
  assert.equal(d.action, "log");
  if (d.action !== "log") return;
  assert.equal(d.target, "expenses");
  assert.equal(d.entry.id, "gm-m1");
  assert.equal(d.entry.cardId, "msx1uobkris01");
  assert.equal(d.entry.note, "KrisPay*LeNu Chef Wai, auto-logged from email");
  assert.equal(d.needsCategory, true);
});

test("categoryRules win before any guessing", () => {
  const [d] = classify([charge("m1", "2101", 20, "PLAYTOMIC SG")], ctx(), "2026-09-25");
  assert.ok(d.action === "log" && d.entry.category === "Badminton" && !d.needsCategory);
});

test("wife's supplementary card and Citi are combined, with the rule's cardId", () => {
  const [a, b] = classify([charge("a", "8959", 56.4, "HELPLING* SG-8674120"), charge("b", "3902", 20.8, "Grab* A-9SGE")], ctx(), "2026-09-25");
  assert.ok(a.action === "log" && a.target === "excluded" && a.entry.cardId === "uob_lady_supp_8959" && (a.entry as any).type === "combined");
  assert.ok(b.action === "log" && b.target === "excluded" && b.entry.cardId === "citi_rewards_3902");
});

test("Empress Porridge merchant rule on UOB Lady", () => {
  const [d] = classify([charge("m", "6110", 12, "EMPRESS PORRIDGE PTE LTD")], ctx(), "2026-09-25");
  assert.ok(d.action === "log" && d.target === "excluded" && d.entry.cardId === "mtgczdzqa9a8j");
});

test("UOB Visa Signature splits on currency; Preferred Platinum guesses online and flags it", () => {
  const [a, b, c] = classify(
    [charge("a", "4828", 10, "SHOP"), charge("b", "4828", 10, "AMAZON.COM", "2026-09-25", "USD"), charge("c", "3602", 10, "SHOPEE SINGAPORE")],
    ctx(),
    "2026-09-25",
  );
  assert.ok(a.action === "log" && a.entry.cardId === "msjitr13dp43f");
  assert.ok(b.action === "log" && b.entry.cardId === "msjiu41k2t7yo" && b.entry.note.includes("USD 10.00"));
  assert.ok(c.action === "log" && c.entry.cardId === "msjiuwsowo52n" && !!c.lowConfidence);
});

test("unmapped card goes to cash with a prefixed note", () => {
  const [d] = classify([charge("m", "9999", 5, "SHOP")], ctx(), "2026-09-25");
  assert.ok(d.action === "log" && d.entry.cardId === "cash" && d.entry.note.startsWith("[card ending 9999 — not mapped] "));
});

test("already-logged message is skipped (safe to overlap with the routine)", () => {
  const [d] = classify([charge("m1", "3051", 1, "X")], ctx({ existingIds: new Set(["gm-m1"]) }), "2026-09-25");
  assert.equal(d.action, "skip");
});

test("reversal in the same batch cancels the charge", () => {
  const ds = classify(
    [charge("c", "8959", 27.9, "Gopay-Gojek"), { messageId: "r", event: { kind: "reversal", bank: "UOB", last4: "8959", amount: 27.9, currency: "SGD", merchant: "Gopay-Gojek", date: "2026-09-24" } }],
    ctx(),
    "2026-09-25",
  );
  assert.deepEqual(ds.map((d) => d.action).sort(), ["skip", "skip"]);
});

test("later reversal removes the already-logged entry", () => {
  const recent = [{ id: "gm-old", date: "2026-09-24", amount: 18.1, category: "Transport", cardId: "uob_lady_supp_8959", note: "Cabcharge Asia Pte Ltd, auto-logged from email", target: "excluded" as const, type: "combined", reason: "" }];
  const [d] = classify([{ messageId: "r", event: { kind: "reversal", bank: "UOB", last4: "8959", amount: 18.1, currency: "SGD", merchant: "Cabcharge Asia Pte Ltd", date: "2026-09-24" } }], ctx({ recent }), "2026-09-25");
  assert.ok(d.action === "remove" && d.removeId === "gm-old" && d.target === "excluded");
});

test("CDG Zig: card-paid receipt is logged; wallet-paid dedupes against Cabcharge, else waits then asks", () => {
  const cdg = (id: string, payment: string, date = "2026-09-18"): Incoming => ({ messageId: id, event: { kind: "cdg_receipt", amount: 45.9, payment, date, pickup: "Home", dropoff: "NUS" } });
  const [a] = classify([cdg("a", "3014")], ctx(), "2026-09-18");
  assert.ok(a.action === "log" && a.entry.cardId === "msjivaj3mypi2" && a.entry.category === "Transport" && a.entry.note === "CDG Zig — Home to NUS, auto-logged from email");
  const ds = classify([cdg("b", "Apple Pay"), charge("c", "2101", 45.9, "Cabcharge Asia Pte Ltd", "2026-09-18")], ctx(), "2026-09-18");
  assert.equal(ds.find((d) => d.messageId === "b")!.action, "skip");
  const cab = ds.find((d) => d.messageId === "c")!;
  assert.ok(cab.action === "log" && cab.entry.category === "Transport");
  assert.equal(classify([cdg("d", "Apple Pay")], ctx(), "2026-09-18")[0].action, "defer");
  assert.equal(classify([cdg("e", "Apple Pay")], ctx(), "2026-09-21")[0].action, "review");
});

test("transfers: self, not_expense recipients, recipient rule, joint account, default", () => {
  const out = (id: string, recipient: string, sourceAcct: string | null, destAcct: string | null = null): Incoming => ({
    messageId: id,
    event: { kind: "transfer_out", bank: "UOB", format: "paynow", amount: 10, recipient, sourceAcct, destAcct, date: "2026-09-25" },
  });
  const ds = classify(
    [
      out("self", "UOB a/c ending 3561", "7831", "3561"),
      out("clinic", "INSPIRE MEDICAL PTE. LTD. (UEN ending 080E)", "7272"),
      out("ibkr", "Interactive Brokers DBS BANK LTD a/c ending 0775", "3561", "0775"),
      out("taxi", "RAZLXXX BTX EUSXXX (Mobile ending 5006)", "3561"),
      out("joint", "PESTOPIA PTE. LTD. (UEN ending 942R)", "7831"),
      out("personal", "NIPPON HOME PTE. LTD (UEN ending KANX)", "3561"),
    ],
    ctx(),
    "2026-09-25",
  );
  const by = Object.fromEntries(ds.map((d) => [d.messageId, d]));
  assert.equal(by.self.action, "skip");
  assert.equal(by.clinic.action, "skip");
  assert.equal(by.ibkr.action, "skip");
  assert.ok(by.taxi.action === "log" && by.taxi.target === "excluded" && by.taxi.entry.category === "Transport" && by.taxi.entry.cardId === "paynow_5006");
  assert.ok(by.joint.action === "log" && by.joint.target === "excluded" && by.joint.entry.cardId === "uob_joint_7831");
  assert.ok(by.personal.action === "log" && by.personal.target === "expenses" && by.personal.entry.cardId === "cash" && by.personal.entry.note.startsWith("PayNow to NIPPON"));
});

test("bill payment for a tracked card is skipped, unknown ref asks", () => {
  const bill = (ref: string): Incoming => ({ messageId: ref, event: { kind: "bill_payment", bank: "UOB", amount: 100, payee: "UOB Cards", sourceAcct: "3561", billRef: ref, date: "2026-09-06" } });
  const [a, b] = classify([bill("6110"), bill("1234")], ctx(), "2026-09-06");
  assert.equal(a.action, "skip");
  assert.equal(b.action, "review");
});

test("incoming PayNow is surfaced, never logged", () => {
  const [d] = classify([{ messageId: "i", event: { kind: "transfer_in", bank: "UOB", amount: 8.25, destAcct: "3561", date: "2026-09-19" } }], ctx(), "2026-09-19");
  assert.equal(d.action, "incoming");
});

test("statement cycles and month-to-date caps", () => {
  assert.equal(cycleStart("2026-09-03", "statement", 5), "2026-08-05");
  assert.equal(cycleStart("2026-09-05", "statement", 5), "2026-09-05");
  assert.equal(cycleStart("2026-01-02", "statement", 5), "2025-12-05");
  assert.equal(cycleStart("2026-09-20", "calendar", null), "2026-09-01");
  const mtd = monthToDate(
    "2026-09-20",
    [{ id: "1", date: "2026-09-10", amount: 100, category: "Food", cardId: "hsbc", note: "" }, { id: "2", date: "2026-08-30", amount: 50, category: "Food", cardId: "hsbc", note: "" }],
    [{ id: "3", date: "2026-09-06", amount: 30, category: "Food", cardId: "citi", note: "", type: "combined", reason: "Citibank Rewards - combined expense" }],
    [{ id: "hsbc", name: "HSBC Revolution", cap: 1000, resetMode: "calendar", statementDay: null }],
    [{ matchType: "cardLast4", matchValue: "3902", type: "combined", reason: "Citibank Rewards - combined expense", cardId: "citi", cap: 1000, resetMode: "statement", statementDay: 5 }],
    2000,
  );
  assert.equal(mtd.spent, 100);
  assert.deepEqual(mtd.caps, [{ name: "HSBC Revolution", spent: 100, cap: 1000 }, { name: "Citibank Rewards", spent: 30, cap: 1000 }]);
});
