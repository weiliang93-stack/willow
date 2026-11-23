import assert from "node:assert/strict";
import test from "node:test";
import { parseFixedMonthlyExpense } from "./parse.ts";

// Layout copied from the 22 Nov 2026 Saving/Spending tab: the table is
// mid-grid, Buffer sits between Total and the summaries, and the Total
// cell is 5899.22 while the item rows add to 5899.21. The parser must
// keep the sheet's Total.
const SNAPSHOT_ROWS: unknown[][] = [
  ["", "", "Other planning notes", ""],
  ["", "", "Fixed Monthly Expense", "Amount"],
  ["", "", "Car Loan (GIRO)", 1230],
  ["", "", "Car Insurance (Annual Paynow)", 122.8],
  ["", "", "Road Tax Annual Paynow ($586)", 48.83],
  ["", "", "Ola Maintenance (quarterly paynow)", 327],
  ["", "", "Ola Aircon Servicing (annual paynow)", 30.43],
  ["", "", "Property Tax (GIRO Monthly)", 69.62],
  ["", "", "Child Insurance (GIRO yearly)", 290.52],
  ["", "", "Childcare", 746.15],
  ["", "", "HouseKeeping (solitaire)", 226],
  ["", "", "Spotify (solitaire)", 16.98],
  ["", "", "Internet (solitaire)", 35.9],
  ["", "", "Netflix (solitaire)", 29.98],
  ["", "", "Petrol (solitaire)", 300],
  ["", "", "WL Clinic Taxi", 560],
  ["", "", "Car cashcard (solitaire)", 200],
  ["", "", "Electricity/Water (solitaire)", 350],
  ["", "", "Grocery (solitaire)", 500],
  ["", "", "Empress Porridge Dinner (WL Solitaire)", 766],
  ["", "", "Pest Control", 49],
  ["", "", "Total", 5899.22],
  ["", "", "Buffer", 100],
  ["", "", "Monthly contribution", 6500],
  ["", "", "Household fixed costs", 2997.22],
  ["", "", "Variable allocations", 2902],
  ["", "", "Something after the table", 1],
];

test("parses the mid-grid Fixed Monthly Expense table and keeps the sheet Total", () => {
  const parsed = parseFixedMonthlyExpense(SNAPSHOT_ROWS, "2026-11-22");
  assert.equal(parsed.source, "TeoLoh Financial Planning");
  assert.equal(parsed.asOf, "2026-11-22");
  assert.equal(parsed.items.length, 19);
  assert.deepEqual(parsed.items[0], { name: "Car Loan (GIRO)", amount: 1230 });
  assert.deepEqual(parsed.items[18], { name: "Pest Control", amount: 49 });
  assert.equal(parsed.items.some((item) => item.name === "Buffer"), false);
  assert.equal(parsed.items.some((item) => item.name === "Total"), false);
  const sumCents = parsed.items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  assert.equal(sumCents, 589921);
  assert.equal(parsed.total, 5899.22);
  assert.notEqual(parsed.total, sumCents / 100);
  assert.equal(parsed.monthlyContribution, 6500);
  assert.equal(parsed.householdFixedCosts, 2997.22);
  assert.equal(parsed.variableAllocations, 2902);
});

test("finds the header when it is not in column A and skips a blank row", () => {
  const grid = [
    ["Notes"],
    ["Fixed Monthly Expense", "", 10],
    ["Example rent", "SGD", 1],
    [],
    ["Example levy", 2],
    ["Total", 3.01],
    ["Monthly contribution", 4],
    ["Household fixed costs", 5],
    ["Variable allocations", 6],
  ];
  const parsed = parseFixedMonthlyExpense(grid, "2026-01-15");
  assert.deepEqual(parsed.items, [
    { name: "Example rent", amount: 1 },
    { name: "Example levy", amount: 2 },
  ]);
  assert.equal(parsed.total, 3.01);
});

test("fails when a required summary cell is missing", () => {
  const grid = [
    ["Fixed Monthly Expense"],
    ["Example rent", 1],
    ["Total", 1],
    ["Monthly contribution", 4],
    ["Household fixed costs", 5],
  ];
  assert.throws(() => parseFixedMonthlyExpense(grid, "2026-01-15"), /variableAllocations is missing/);
});

test("fails when an item has no amount", () => {
  const grid = [
    ["Fixed Monthly Expense"],
    ["Example rent"],
    ["Total", 1],
    ["Monthly contribution", 4],
    ["Household fixed costs", 5],
    ["Variable allocations", 6],
  ];
  assert.throws(() => parseFixedMonthlyExpense(grid, "2026-01-15"), /Amount missing for Example rent/);
});
