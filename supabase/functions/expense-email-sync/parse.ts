// Pure parsers for bank alert emails -> structured events. No I/O here, so
// this file is unit-tested directly (see parse.test.ts) against the real
// formats each bank sends. Every parser works on `normalizeText` output: tags
// stripped, entities decoded, table pipes removed, whitespace collapsed to
// single spaces - so it doesn't matter whether the text came from a
// text/plain part, an HTML part, or Gmail's own snippet.

export type ParsedEvent =
  | { kind: "card_charge"; bank: string; last4: string; currency: string; amount: number; merchant: string; date: string }
  | { kind: "reversal"; bank: string; last4: string; currency: string; amount: number; merchant: string; date: string }
  | { kind: "transfer_out"; bank: string; amount: number; recipient: string; sourceAcct: string | null; destAcct: string | null; date: string; format: "paynow" | "funds_transfer" }
  | { kind: "transfer_in"; bank: string; amount: number; destAcct: string | null; date: string }
  | { kind: "bill_payment"; bank: string; amount: number; payee: string; sourceAcct: string | null; billRef: string; date: string }
  | { kind: "cdg_receipt"; amount: number; payment: string; date: string; pickup: string | null; dropoff: string | null }
  | { kind: "info"; reason: string }
  | { kind: "unknown"; reason: string };

export interface RawEmail {
  from: string;
  subject: string;
  text: string; // already normalized
  receivedDate: string; // YYYY-MM-DD (SGT) of the email itself, fallback for missing years
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function normalizeText(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] != null) return ENTITIES[k];
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    })
    .replace(/\[\]\([^)]*\)/g, " ") // markdown-ified empty links
    .replace(/[|#]/g, " ")
    .replace(/[ ​͏﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(y: number, m: number, d: number) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function year2(yy: string) {
  return 2000 + parseInt(yy, 10);
}
function mon(name: string) {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? 0;
}
function amt(s: string) {
  return Math.round(parseFloat(s.replace(/,/g, "")) * 100) / 100;
}
// Dates with no year (DBS "18 SEP"): take the email's own year, stepping back
// one year if that would put the transaction in the future (a Dec charge
// alerted in Jan).
function yearless(day: number, month: number, receivedDate: string) {
  let y = parseInt(receivedDate.slice(0, 4), 10);
  if (ymd(y, month, day) > receivedDate) y -= 1;
  return ymd(y, month, day);
}
function clean(s: string) {
  return s.replace(/\s+/g, " ").trim().replace(/[.,;]$/, "");
}

const AMOUNT_HINT = /\b(SGD|USD|EUR|GBP|MYR|JPY|AUD|S\$|\$)\s?\d[\d,]*\.\d{2}\b/;

export function parseEmail(e: RawEmail): ParsedEvent {
  const t = e.text;
  const from = e.from.toLowerCase();
  const subj = e.subject.toLowerCase();
  let m: RegExpMatchArray | null;

  // ---------------- UOB ----------------
  if (from.includes("uobgroup.com")) {
    if ((m = t.match(/A transaction of ([A-Z]{3}) ([\d,]+\.\d{2}) was made with your UOB Card ending (\d{4}) on (\d{2})\/(\d{2})\/(\d{2}) at (.+?)\. If unauthori[sz]ed/i))) {
      return { kind: "card_charge", bank: "UOB", currency: m[1].toUpperCase(), amount: amt(m[2]), last4: m[3], date: ymd(year2(m[6]), +m[5], +m[4]), merchant: clean(m[7]) };
    }
    if ((m = t.match(/A transaction of ([\d,]+\.\d{2}) ([A-Z]{3}) made with your UOB card ending (\d{4}) on (\d{1,2}) ([A-Za-z]{3}) (\d{2}),?.*? at (.+?) has been reversed/i))) {
      return { kind: "reversal", bank: "UOB", amount: amt(m[1]), currency: m[2].toUpperCase(), last4: m[3], date: ymd(year2(m[6]), mon(m[5]), +m[4]), merchant: clean(m[7]) };
    }
    if ((m = t.match(/You made a PayNow transfer of SGD ([\d,]+\.\d{2}) to (.+?) on your a\/c ending (\d{4}) at [\d:]+\s?[AP]M SGT, (\d{1,2}) ([A-Za-z]{3}) (\d{2})/i))) {
      return { kind: "transfer_out", bank: "UOB", format: "paynow", amount: amt(m[1]), recipient: clean(m[2]), sourceAcct: m[3], destAcct: null, date: ymd(year2(m[6]), mon(m[5]), +m[4]) };
    }
    if ((m = t.match(/You made\/scheduled a funds transfer\(s\) of SGD ([\d,]+\.\d{2}) to (.+?a\/c ending (\d{4})) from your a\/c ending (\d{4}) at [\d:]+\s?[AP]M SGT, (\d{1,2}) ([A-Za-z]{3}) (\d{2})/i))) {
      return { kind: "transfer_out", bank: "UOB", format: "funds_transfer", amount: amt(m[1]), recipient: clean(m[2]), destAcct: m[3], sourceAcct: m[4], date: ymd(year2(m[7]), mon(m[6]), +m[5]) };
    }
    if ((m = t.match(/Your scheduled (?:FAST )?transfer of SGD ([\d,]+\.\d{2}) to (.+?a\/c ending (\d{4})) from your a\/c ending (\d{4}) at [\d:]+\s?[AP]M SGT, (\d{1,2}) ([A-Za-z]{3}) (\d{2}),? was successful/i))) {
      return { kind: "transfer_out", bank: "UOB", format: "funds_transfer", amount: amt(m[1]), recipient: clean(m[2]), destAcct: m[3], sourceAcct: m[4], date: ymd(year2(m[7]), mon(m[6]), +m[5]) };
    }
    if ((m = t.match(/You made\/scheduled a bill payment\(s\) of SGD ([\d,]+\.\d{2}) to (.+?) on your a\/c ending (\d{4}) at [\d:]+\s?[AP]M SGT, (\d{1,2}) ([A-Za-z]{3}) (\d{2})\. Bill ref: ending (\w{4})/i))) {
      return { kind: "bill_payment", bank: "UOB", amount: amt(m[1]), payee: clean(m[2]), sourceAcct: m[3], date: ymd(year2(m[6]), mon(m[5]), +m[4]), billRef: m[7] };
    }
    if ((m = t.match(/You(?: have|'ve) received (?:a transfer of )?SGD ([\d,]+\.\d{2}) in(?:to)? your .*?(?:account|a\/c) ending (\d{4})(?: on (\d{1,2})-([A-Za-z]{3})-(\d{4}))?/i))) {
      const date = m[3] ? ymd(+m[5], mon(m[4]), +m[3]) : e.receivedDate;
      return { kind: "transfer_in", bank: "UOB", amount: amt(m[1]), destAcct: m[2], date };
    }
    // Confirmation-only follow-ups (no amount; the real record is the "You
    // made a ..." alert sent alongside), statements, and similar.
    if (/transfer to .+ (on .+ )?is successful/i.test(t) || /eStatement|eAdvice/i.test(t + " " + subj)) {
      return { kind: "info", reason: "UOB confirmation/statement without its own amount" };
    }
  }

  // ---------------- DBS ----------------
  if (from.includes("dbs.com")) {
    if ((m = t.match(/Date & Time: (\d{1,2}) ([A-Za-z]{3}) \d{1,2}:\d{2} \(SGT\) Amount: ([A-Z]{3}) ?([\d,]+\.\d{2}) From: DBS\/POSB card ending (\d{4}) To: (.+?) If unauthori[sz]ed/i))) {
      return { kind: "card_charge", bank: "DBS", currency: m[3].toUpperCase(), amount: amt(m[4]), last4: m[5], merchant: stripCountry(clean(m[6])), date: yearless(+m[1], mon(m[2]), e.receivedDate) };
    }
    if ((m = t.match(/refer to your (?:PAYNOW|FAST|funds transfer)[^.]*\. .*?Date & Time: (\d{1,2}) ([A-Za-z]{3}) \d{1,2}:\d{2} \(SGT\) Amount: SGD ?([\d,]+\.\d{2}) From: .*?A\/C ending (\d{4}) To: (.+?) If unauthori[sz]ed/i))) {
      return { kind: "transfer_out", bank: "DBS", format: "paynow", amount: amt(m[3]), sourceAcct: m[4], recipient: clean(m[5]), destAcct: null, date: yearless(+m[1], mon(m[2]), e.receivedDate) };
    }
    if (/Manage Alert|eDocument|ready for viewing/i.test(t + " " + subj)) {
      return { kind: "info", reason: "DBS account notice" };
    }
  }

  // ---------------- Citibank ----------------
  if (from.includes("citibank.com.sg")) {
    if ((m = t.match(/there is a (charge|reversal) made on your Citi .*?Account Number ?: X{4}-X{4}-X{4}-(\d{4}) Transaction date ?: (\d{2})\/(\d{2})\/(\d{2}) Transaction time ?: [\d:]+ Transaction amount ?: ([A-Z]{3}) ?([\d,]+\.\d{2}) Transaction details ?: (.+?) Thank you/i))) {
      const kind = m[1].toLowerCase() === "reversal" ? "reversal" : "card_charge";
      return { kind, bank: "Citi", last4: m[2], date: ymd(year2(m[5]), +m[4], +m[3]), currency: m[6].toUpperCase(), amount: amt(m[7]), merchant: stripCountry(clean(m[8])) };
    }
  }

  // ---------------- HSBC ----------------
  if (from.includes("hsbc.com")) {
    if ((m = t.match(/Card Number X{4}-X{4}-X{4}-(\d{4}) Transaction Date (\d{1,2})\/([A-Za-z]{3})\/(\d{4}) Transaction Time [\d:]+ Transaction Amount ([A-Z]{3}) ?([\d,]+\.\d{2}) Description (.+?) (?:You can also|Please|\*)/i))) {
      const reversal = /reversal|refund/i.test(t.slice(0, 200));
      return { kind: reversal ? "reversal" : "card_charge", bank: "HSBC", last4: m[1], date: ymd(+m[4], mon(m[3]), +m[2]), currency: m[5].toUpperCase(), amount: amt(m[6]), merchant: clean(m[7]) };
    }
  }

  // ---------------- CDG Zig ----------------
  if (from.includes("cdgtaxi.com.sg") && /e-receipt/i.test(subj)) {
    if ((m = t.match(/You paid \$([\d,]+\.\d{2}) Payment (.+?) Payment Date (\d{1,2}) ([A-Za-z]{3}) (\d{4})/i))) {
      const trip = t.match(/TRIP DETAILS\s+\d{1,2} [A-Za-z]{3} \d{4}, [\d:]+ (.+? Singapore \d{6}) (.+? Singapore \d{6}) You rode/i);
      return {
        kind: "cdg_receipt",
        amount: amt(m[1]),
        payment: clean(m[2]),
        date: ymd(+m[5], mon(m[4]), +m[3]),
        pickup: trip ? shortPlace(trip[1]) : null,
        dropoff: trip ? shortPlace(trip[2]) : null,
      };
    }
  }

  // Anything else from an alert sender: if it looks like money moved, it's
  // an alert format we don't know yet (never guess - ask); otherwise a notice.
  if (AMOUNT_HINT.test(t) && /transaction|transfer|payment|charge|debit|spent|purchase/i.test(t)) {
    return { kind: "unknown", reason: "looks like a transaction but matches no known alert format" };
  }
  return { kind: "info", reason: "no transaction in this email" };
}

function stripCountry(merchant: string) {
  return merchant.replace(/\s+Singapore\s+SGP$/i, "").replace(/\s+SGP$/i, "");
}

function shortPlace(addr: string) {
  return clean(addr.split(",")[0]);
}
