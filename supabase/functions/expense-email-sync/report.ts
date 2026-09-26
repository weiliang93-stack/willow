// Daily summary email (HTML + plain-text fallback), same content and look as
// the old routine's report: yesterday's logged charges, combined/excluded
// ones, incoming PayNow to review, skipped items, month-to-date budget bar
// and card caps. Email-safe HTML only (tables + inline CSS).

import { money, type CapLine } from "./rules.ts";

export interface ReportItem {
  merchant: string;
  category: string;
  cardLabel: string;
  amount: number;
  excludedReason?: string;
}

export interface ReportInput {
  dateLabel: string; // e.g. "Friday, 25 September 2026"
  charges: ReportItem[];
  excluded: ReportItem[];
  incoming: string[];
  skipped: string[];
  review: string[];
  spent: number;
  budget: number | null;
  caps: CapLine[];
}

const COLORS: Record<string, string> = {
  Food: "#f59e0b", Restaurant: "#ef4444", Transport: "#3b82f6", Shopping: "#a855f7", Entertainment: "#ec4899",
  "Gifts & Charity": "#14b8a6", Bills: "#64748b", "Personal Care": "#f472b6", Health: "#22c55e", Badminton: "#06b6d4", Travel: "#6366f1",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bar(pct: number, color: string, h: number) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#e2e8f0;border-radius:6px;height:${h}px;"><table role="presentation" cellpadding="0" cellspacing="0" width="${w || 1}%" style="height:${h}px;"><tr><td style="background:${color};height:${h}px;border-radius:6px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr></table>`;
}

function rows(items: ReportItem[], excluded: boolean) {
  return items
    .map(
      (i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;width:8px;background:${excluded ? "#94a3b8" : COLORS[i.category] ?? "#94a3b8"};"></td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;"><span style="font-weight:bold;">${esc(i.merchant)}</span><br><span style="font-size:12px;color:#64748b;">${esc(excluded ? i.excludedReason ?? "combined" : `${i.category} · ${i.cardLabel}`)}</span></td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:bold;white-space:nowrap;">SGD ${i.amount.toFixed(2)}</td></tr>`,
    )
    .join("");
}

const H = (t: string) => `<div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin:20px 0 8px;">${t}</div>`;
const small = (lines: string[]) => lines.map((l) => `<div style="font-size:12px;color:#94a3b8;margin:2px 0;">${esc(l)}</div>`).join("");

export function buildReport(r: ReportInput): { subject: string; text: string; html: string } {
  const total = r.charges.reduce((s, c) => s + c.amount, 0);
  const none = r.charges.length === 0 && r.excluded.length === 0;
  const subject = `Daily Expense Log — ${r.dateLabel.replace(/^\w+, /, "")}${none ? " — No New Charges" : ""}`;
  const pct = r.budget ? (r.spent / r.budget) * 100 : 0;
  const over = r.budget != null && r.spent > r.budget;

  const text = [
    `Daily Expense Log — ${r.dateLabel}`,
    "",
    `New charges: ${r.charges.length} · ${money(total)}`,
    ...r.charges.map((c) => `  ${money(c.amount)}  ${c.merchant} — ${c.category} · ${c.cardLabel}`),
    ...(r.excluded.length ? ["", "Combined / excluded:", ...r.excluded.map((c) => `  ${money(c.amount)}  ${c.merchant} — ${c.excludedReason}`)] : []),
    ...(r.incoming.length ? ["", "Incoming PayNow (tap the Telegram prompt if any offsets a charge):", ...r.incoming.map((l) => `  ${l}`)] : []),
    ...(r.review.length ? ["", "Needs your attention (sent to Telegram):", ...r.review.map((l) => `  ${l}`)] : []),
    ...(r.skipped.length ? ["", "Skipped:", ...r.skipped.map((l) => `  ${l}`)] : []),
    "",
    r.budget != null ? `This month: ${money(r.spent)} of ${money(r.budget)} (${Math.round(pct)}%) — ${money(r.budget - r.spent)} remaining` : `This month: ${money(r.spent)}`,
    "",
    "Card caps:",
    ...r.caps.map((c) => `  ${c.name}: ${money(c.spent)} / ${money(c.cap)}${c.spent > c.cap ? ` — OVER by ${money(c.spent - c.cap)}` : ""}`),
  ].join("\n");

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<tr><td style="background:#0f766e;padding:20px 24px;border-radius:8px 8px 0 0;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">Daily Expense Log</span><br><span style="color:#ccfbf1;font-size:13px;">${esc(r.dateLabel)}</span></td></tr>
<tr><td style="background:#ffffff;padding:20px 24px;border:1px solid #e2e8f0;border-top:none;">
<div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">New Charges &mdash; ${r.charges.length} &middot; SGD ${total.toFixed(2)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">${r.charges.length ? rows(r.charges, false) : '<tr><td style="color:#94a3b8;font-size:14px;padding:6px 0;">No new charges</td></tr>'}</table>
${r.excluded.length ? `${H("Combined / Excluded")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(r.excluded, true)}</table>` : ""}
${r.incoming.length ? `${H("Incoming PayNow to Review")}${small(r.incoming)}${small(["Tap the Telegram prompt if any of these offsets a charge."])}` : ""}
${r.review.length ? `${H("Needs Your Attention")}${small(r.review)}` : ""}
${r.skipped.length ? `${H("Skipped")}${small(r.skipped)}` : ""}
${H("This Month")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;">SGD ${r.spent.toFixed(2)}${r.budget != null ? ` of SGD ${r.budget.toFixed(2)} spent` : " spent"}</td><td style="text-align:right;font-size:14px;color:${over ? "#dc2626" : "#64748b"};">${r.budget != null ? `${Math.round(pct)}%` : ""}</td></tr></table>
${r.budget != null ? `<div style="margin-top:6px;">${bar(pct, over ? "#dc2626" : "#0f766e", 10)}</div><div style="font-size:12px;color:#64748b;margin-top:4px;">SGD ${(r.budget - r.spent).toFixed(2)} remaining</div>` : ""}
${r.caps.length ? H("Card Caps") : ""}
${r.caps
  .map(
    (c) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr><td style="font-size:13px;font-weight:bold;">${esc(c.name)}</td><td style="text-align:right;font-size:12px;color:#64748b;">SGD ${c.spent.toFixed(2)} / ${c.cap.toFixed(0)}</td></tr></table>${bar((c.spent / c.cap) * 100, c.spent > c.cap ? "#dc2626" : "#3b82f6", 7)}${c.spent > c.cap ? `<div style="font-size:12px;color:#dc2626;">Over cap by SGD ${(c.spent - c.cap).toFixed(2)}</div>` : ""}`,
  )
  .join("")}
</td></tr>
<tr><td style="padding:12px 24px;font-size:11px;color:#94a3b8;">Auto-generated by expense-email-sync.</td></tr>
</table>`;
  return { subject, text, html };
}
