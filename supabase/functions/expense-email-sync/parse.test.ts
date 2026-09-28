// Run: node --experimental-strip-types --test supabase/functions/expense-email-sync/*.test.ts
// Samples are the real alert formats (Sep 2026), with names/addresses genericised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, parseEmail } from "./parse.ts";

function p(from: string, subject: string, body: string, receivedDate = "2026-09-25") {
  return parseEmail({ from, subject, text: normalizeText(body), receivedDate });
}

test("UOB card charge", () => {
  const ev = p("unialerts@uobgroup.com", "UOB - Transaction Alert",
    "A transaction of SGD 35.01 was made with your UOB Card ending 3051 on 25/09/26 at KrisPay*LeNu Chef Wai. If unauthorised, call 24/7 Fraud Hotline now UOB EMAIL DISCLAIMER: Any person");
  assert.deepEqual(ev, { kind: "card_charge", bank: "UOB", currency: "SGD", amount: 35.01, last4: "3051", date: "2026-09-25", merchant: "KrisPay*LeNu Chef Wai" });
});

test("UOB foreign-currency charge keeps its currency", () => {
  const ev = p("unialerts@uobgroup.com", "UOB - Transaction Alert",
    "A transaction of USD 1,204.50 was made with your UOB Card ending 4828 on 02/10/26 at AMAZON.COM. If unauthorised, call");
  assert.equal(ev.kind, "card_charge");
  if (ev.kind === "card_charge") {
    assert.equal(ev.currency, "USD");
    assert.equal(ev.amount, 1204.5);
  }
});

test("UOB reversal", () => {
  const ev = p("unialerts@uobgroup.com", "Your transaction has been reversed",
    "A transaction of 27.90 SGD made with your UOB card ending 8959 on 24 Sep 26, 6:34PM at Gopay-Gojek has been reversed. UOB EMAIL DISCLAIMER");
  assert.deepEqual(ev, { kind: "reversal", bank: "UOB", amount: 27.9, currency: "SGD", last4: "8959", date: "2026-09-24", merchant: "Gopay-Gojek" });
});

test("UOB PayNow out (UEN and masked mobile recipients)", () => {
  const a = p("unialerts@uobgroup.com", "UOB Personal Internet Banking Notification Alerts",
    "You made a PayNow transfer of SGD 140.00 to PESTOPIA PTE. LTD. (UEN ending 942R) on your a/c ending 7831 at 3:59PM SGT, 25 Sep 26. If unauthorised, call UOB 24/7 Fraud Hotline.");
  assert.deepEqual(a, { kind: "transfer_out", bank: "UOB", format: "paynow", amount: 140, recipient: "PESTOPIA PTE. LTD. (UEN ending 942R)", sourceAcct: "7831", destAcct: null, date: "2026-09-25" });
  const b = p("unialerts@uobgroup.com", "UOB Personal Internet Banking Notification Alerts",
    "You made a PayNow transfer of SGD 37.30 to MX HAHXXX BIX MANXX (Mobile ending 5066) on your a/c ending 7831 at 8:07AM SGT, 24 Sep 26. If unauthorised");
  assert.equal(b.kind === "transfer_out" && b.recipient, "MX HAHXXX BIX MANXX (Mobile ending 5066)");
});

test("UOB PayNow success follow-up is info, not a second transfer", () => {
  const ev = p("unialerts@uobgroup.com", "UOB Personal Internet Banking Notification Alerts",
    "UOB - Your PayNow transfer to PESTOPIA PTE. LTD. on 25-Sep-2026 is successful. UOB EMAIL DISCLAIMER");
  assert.equal(ev.kind, "info");
  const fast = p("unialerts@uobgroup.com", "UOB-FAST Funds Transfer Status",
    "UOB-Your FAST funds transfer to Wei Liang DBS Acc on 01-Sep-2026 is successful UOB EMAIL DISCLAIMER");
  assert.equal(fast.kind, "info");
});

test("UOB funds transfer, scheduled own-account transfer, scheduled FAST", () => {
  const a = p("unialerts@uobgroup.com", "UOB Personal Internet Banking Notification Alerts",
    "You made/scheduled a funds transfer(s) of SGD 766.00 to UOB a/c ending 3561 from your a/c ending 7831 at 6:30AM SGT, 6 Sep 26. If unauthorised");
  assert.deepEqual(a, { kind: "transfer_out", bank: "UOB", format: "funds_transfer", amount: 766, recipient: "UOB a/c ending 3561", destAcct: "3561", sourceAcct: "7831", date: "2026-09-06" });
  const b = p("unialerts@uobgroup.com", "UOB-Funds Transfer Status",
    "Your scheduled transfer of SGD 1400.00 to own a/c ending 7831 from your a/c ending 3561 at 7:37AM SGT, 28 Aug 26, was successful. If unauthorised");
  assert.equal(b.kind === "transfer_out" && `${b.sourceAcct}->${b.destAcct} ${b.amount} ${b.date}`, "3561->7831 1400 2026-08-28");
  const c = p("unialerts@uobgroup.com", "UOB-Scheduled FAST Transfer Status",
    "Your scheduled FAST transfer of SGD 10000.00 to Interactive Brokers DBS BANK LTD a/c ending 0775 from your a/c ending 3561 at 9:08AM SGT, 10 Sep 26, was successful. If unauthorised");
  assert.equal(c.kind === "transfer_out" && c.recipient, "Interactive Brokers DBS BANK LTD a/c ending 0775");
});

test("UOB bill payment", () => {
  const ev = p("unialerts@uobgroup.com", "UOB Personal Internet Banking Notification Alerts",
    "You made/scheduled a bill payment(s) of SGD 1606.70 to Citi CC on your a/c ending 7831 at 6:33AM SGT, 6 Sep 26. Bill ref: ending 3902. If unauthorised");
  assert.deepEqual(ev, { kind: "bill_payment", bank: "UOB", amount: 1606.7, payee: "Citi CC", sourceAcct: "7831", date: "2026-09-06", billRef: "3902" });
});

test("UOB incoming PayNow", () => {
  const ev = p("unialerts@uobgroup.com", "UOB-PayNow transfer received",
    "You have received SGD 146.00 in your PayNow-linked account ending 3561 on 13-SEP-2026 09:56PM. UOB EMAIL DISCLAIMER");
  assert.deepEqual(ev, { kind: "transfer_in", bank: "UOB", amount: 146, destAcct: "3561", date: "2026-09-13" });
});

test("UOB statement notice is info", () => {
  const ev = p("unialerts@uobgroup.com", "Your eStatement/eAdvice is ready for viewing", "Dear Customer, your UNIPLUS eStatement is ready for viewing.");
  assert.equal(ev.kind, "info");
});

test("DBS card charge (markdown-table plain text)", () => {
  const ev = p("ibanking.alert@dbs.com", "Card Transaction Alert",
    " Card Transaction Alert\n\n| Card Transaction Alert |\n\n| |\n| Transaction Ref: SP1400799080000000092038 Dear Sir / Madam, We refer to your card transaction request dated 18/09/26. We are pleased to confirm that the transaction was completed. Date & Time: 18 SEP 09:20 (SGT) Amount: SGD20.00 From: DBS/POSB card ending 3014 To: GP MEDILIST SINGAPORE SGP If unauthorised, please login", "2026-09-18");
  assert.deepEqual(ev, { kind: "card_charge", bank: "DBS", currency: "SGD", amount: 20, last4: "3014", merchant: "GP MEDILIST", date: "2026-09-18" });
});

test("DBS card charge from HTML body", () => {
  const html = "<table><tr><td>Date &amp; Time:</td><td>18 SEP 09:20 (SGT)</td></tr><tr><td>Amount:</td><td>SGD20.00</td></tr><tr><td>From:</td><td>DBS/POSB card ending 3014</td></tr><tr><td>To:</td><td>GP MEDILIST SINGAPORE SGP</td></tr></table><p>If unauthorised, please</p>";
  const ev = p("ibanking.alert@dbs.com", "Card Transaction Alert", html, "2026-09-18");
  assert.equal(ev.kind === "card_charge" && ev.merchant, "GP MEDILIST");
});

test("DBS yearless date near new year steps back a year", () => {
  const ev = p("ibanking.alert@dbs.com", "Card Transaction Alert",
    "Date & Time: 31 DEC 23:50 (SGT) Amount: SGD5.00 From: DBS/POSB card ending 3014 To: SHOP SINGAPORE SGP If unauthorised", "2027-01-01");
  assert.equal(ev.kind === "card_charge" && ev.date, "2026-12-31");
});

test("DBS PayNow out", () => {
  const ev = p("ibanking.alert@dbs.com", "iBanking Alerts",
    "Dear Customer, We refer to your PAYNOW dated 25 Sep. We are pleased to confirm that the transaction was completed. |\n| Date & Time: | 25 Sep 14:27 (SGT) |\n| Amount: | SGD4132.95 |\n| From: | DBS Multiplier Account A/C ending 7272 |\n| To: | INSPIRE MEDICAL PTE. LTD. (UEN ending 080E) |\n\nIf unauthorised, please call");
  assert.deepEqual(ev, { kind: "transfer_out", bank: "DBS", format: "paynow", amount: 4132.95, sourceAcct: "7272", recipient: "INSPIRE MEDICAL PTE. LTD. (UEN ending 080E)", destAcct: null, date: "2026-09-25" });
});

test("DBS alert-settings notice is info", () => {
  const ev = p("ibanking.alert@dbs.com", "iBanking Alerts", "Transaction Ref: NPsg1789 Dear Customer, We refer to your request dated 18-Sep-2026 for Manage Alert, we are pleased to confirm");
  assert.equal(ev.kind, "info");
});

test("Citi charge and reversal", () => {
  const body = (w: string) => `Dear Customer,\nWe would like to inform you that there is a ${w} made on your Citi Rewards Card:\n\nAccount Number : XXXX-XXXX-XXXX-3902\nTransaction date : 24/09/26\nTransaction time : 18:28:16\nTransaction amount : SGD20.80\nTransaction details : Grab* A-9SGE8WSGWGVFAV Singapore SGP\n\nThank you for using Citi Alerts.`;
  const c = p("alerts@citibank.com.sg", "Citi Alerts - Credit Card/Ready Credit Transaction", body("charge"));
  assert.deepEqual(c, { kind: "card_charge", bank: "Citi", last4: "3902", date: "2026-09-24", currency: "SGD", amount: 20.8, merchant: "Grab* A-9SGE8WSGWGVFAV" });
  const r = p("alerts@citibank.com.sg", "Citi Alerts - Credit Card/Ready Credit Transaction", body("reversal"));
  assert.equal(r.kind, "reversal");
});

test("HSBC charge (.hk notification domain)", () => {
  const ev = p("HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk", "Transaction Alerts  (Credit Card)",
    "| |\n| Dear Customer Please note there was a transaction made on your HSBC credit card. |\n\n| |\n| Card Number | XXXX-XXXX-XXXX-2101 |\n| Transaction Date | 24/SEP/2026 |\n| Transaction Time | 11:19:15 |\n| Transaction Amount | SGD6.99 |\n| Description | Grab* A-9SF6ULKGWIA8AV |\n\n| You can also log on to the HSBC Singapore app");
  assert.deepEqual(ev, { kind: "card_charge", bank: "HSBC", last4: "2101", date: "2026-09-24", currency: "SGD", amount: 6.99, merchant: "Grab* A-9SF6ULKGWIA8AV" });
});

const cdg = (payment: string) => `| |\n| Hey Mr TEST! Thank you for booking CDG Zig Trip ID : 5679280180 |\n\n| $26.80 Amount Paid |\n| ### PAYMENT DETAILS |\n| Total Fare | $24.70 |\n| Balance Due | $26.80 |\n\n| You paid | $26.80 |\n| Payment | ${payment} |\n| Payment Date | 18 Sep 2026, 13:42 |\n| Trip Type | Personal |\n\n| ### TRIP DETAILS #### 18 Sep 2026, 13:42 |\n\n| |\n| | Home Block, 1 Example Crescent, Singapore 544602 |\n| |\n| | Nus Blk Md6, 14 Medical Drive, Singapore 117599 |\n\n| | You rode with DRIVER • Comfort |`;

test("CDG Zig receipt paid by wallet", () => {
  const ev = p("noreply@cdgtaxi.com.sg", "Your Car Ride E-Receipt", cdg("Apple Pay"));
  assert.deepEqual(ev, { kind: "cdg_receipt", amount: 26.8, payment: "Apple Pay", date: "2026-09-18", pickup: "Home Block", dropoff: "Nus Blk Md6" });
});

test("CDG Zig receipt paid by card number", () => {
  const ev = p("noreply@cdgtaxi.com.sg", "Your Car Ride E-Receipt", cdg("3014"));
  assert.equal(ev.kind === "cdg_receipt" && ev.payment, "3014");
});

test("unknown transaction-looking format is flagged, not guessed", () => {
  const ev = p("alerts.sg@sc.com", "Transaction Alert", "Your card ending 3399 was charged SGD 12.00 at SOMEWHERE on 01/10/26.");
  assert.equal(ev.kind, "unknown");
  const notice = p("alerts.sg@sc.com", "Keep your account safe", "Learn how eGIRO scams work.");
  assert.equal(notice.kind, "info");
});
