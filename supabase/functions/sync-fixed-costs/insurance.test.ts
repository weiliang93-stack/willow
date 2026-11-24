import assert from "node:assert/strict";
import test from "node:test";
import { parseInsurance } from "./insurance.ts";

// Same shape as the live Insurance tab: person, repeated header, then
// LIFE / HEALTH / EXTRAS bands. Values here are examples. The Policy No
// column and any policy token in the name must not survive the parse.
const GRID: unknown[][] = [
  ["Notes", "", ""],
  ["", "INSURANCE"],
  ["", "WEI LIANG"],
  ["", "Type", "Cover", "Monthly", "Yearly", "Bought date", "Policy No", "Remarks", "Verified"],
  ["", "LIFE"],
  ["", "Example term (99887766)", "Sample sum", "", 120, "1 Jan 2020", "99887766", "Next due 15 Dec 2026, yearly GIRO. Call 5550100.", "1 Jan 2026"],
  ["", "Example cancelled", "Old sum", 10, 120, "1 Jan 2019", "11223344", "CANCELLED 1 Jan 2026. Previously $10/mo GIRO.", ""],
  ["", "HEALTH"],
  ["", "Example shield", "Private hospital", "", 80, "", "55667788", "Renewal due 20 Jan 2027 via MediSave.", ""],
  ["", "Example rider (Plan 1)", "Rider", 5, 60, "", "99880011", "Paid $5/mo ($60/yr) by GIRO. Next due 4 Dec 2026. Account 4455667788.", ""],
  ["", "EXTRAS"],
  ["", "ZHEN LING"],
  ["", "Type", "Cover", "Monthly", "Yearly", "Bought date", "Policy No", "Remarks", "Verified"],
  ["", "LIFE"],
  ["", "Example dps", 70000, "", 18, "", "24680135", "Paid by CPF. Next due ~11 Apr 2027.", ""],
  ["", "ANYA"],
  ["", "Type", "Cover", "Monthly", "Yearly", "Bought date", "Policy No", "Remarks", "Verified"],
  ["", "LIFE"],
  ["", "HEALTH"],
  ["", "Example ward", "Ward", "", "$424.18", "", "13579246", "Dec 2026 renewal: due 29 Dec 2026, MediSave.", ""],
  ["", "EXTRAS"],
];

test("parses person bands and drops policy numbers", () => {
  const parsed = parseInsurance(GRID, "2026-11-24");
  assert.equal(parsed.asOf, "2026-11-24");
  assert.deepEqual(
    parsed.policies.map((policy) => [policy.person, policy.category, policy.name, policy.premium, policy.frequency, policy.status, policy.nextDue, policy.payment]),
    [
      ["Wei Liang", "Life", "Example term", 120, "yearly", "active", "2026-12-15", "GIRO"],
      ["Wei Liang", "Life", "Example cancelled", 10, "monthly", "cancelled", null, "GIRO"],
      ["Wei Liang", "Health", "Example shield", 80, "yearly", "active", "2027-01-20", "MediSave"],
      ["Wei Liang", "Health", "Example rider (Plan 1)", 5, "monthly", "active", "2026-12-04", "GIRO"],
      ["Zhen Ling", "Life", "Example dps", 18, "yearly", "active", null, "CPF"],
      ["Anya", "Health", "Example ward", 424.18, "yearly", "active", "2026-12-29", "MediSave"],
    ],
  );
  assert.equal(parsed.policies[1].cover, "Old sum");
  assert.equal(parsed.policies[4].cover, "70000");
  const encoded = JSON.stringify(parsed);
  for (const secret of ["99887766", "11223344", "55667788", "99880011", "24680135", "13579246", "4455667788", "5550100"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(encoded.includes("policyNo"), false);
  assert.equal(encoded.includes("Policy No"), false);
});

test("fails instead of guessing when both premiums are filled and remarks do not say which is paid", () => {
  const grid = [
    ["WEI LIANG"],
    ["Type", "Cover", "Monthly", "Yearly", "Remarks"],
    ["HEALTH"],
    ["Example vague", "Ward", 9, 108, "Paid by GIRO."],
  ];
  assert.throws(() => parseInsurance(grid, "2026-11-24"), /both a monthly and a yearly amount/);
});

test("fails when the header is incomplete", () => {
  const grid = [
    ["WEI LIANG"],
    ["Type", "Cover", "Monthly", "Remarks"],
    ["LIFE"],
    ["Example term", "Sum", "", "Next due 1 Jan 2027"],
  ];
  assert.throws(() => parseInsurance(grid, "2026-11-24"), /missing a required column/);
});

test("fails when a policy has no premium", () => {
  const grid = [
    ["ANYA"],
    ["Type", "Cover", "Monthly", "Yearly", "Policy No", "Remarks"],
    ["HEALTH"],
    ["Example empty", "Ward", "", "", "99990000", ""],
  ];
  assert.throws(() => parseInsurance(grid, "2026-11-24"), /Premium missing/);
});
