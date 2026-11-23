// Reads the Fixed Monthly Expense table out of a Saving/Spending grid.
// The table sits in the middle of the sheet, not in column A. Names and
// amounts are taken from the cells as read. The Total cell is stored as
// shown, even when it disagrees with the sum of the rows by a cent.

export type FixedCostItem = { name: string; amount: number };

export type FixedCostsSnapshot = {
  source: "TeoLoh Financial Planning";
  asOf: string;
  items: FixedCostItem[];
  total: number;
  monthlyContribution: number;
  householdFixedCosts: number;
  variableAllocations: number;
};

const HEADER = "fixed monthly expense";
const SUMMARY_KEYS = {
  "monthly contribution": "monthlyContribution",
  "household fixed costs": "householdFixedCosts",
  "variable allocations": "variableAllocations",
} as const;

type SummaryKey = (typeof SUMMARY_KEYS)[keyof typeof SUMMARY_KEYS];

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function amountToTheRight(row: unknown[], nameCol: number): number | null {
  for (let col = nameCol + 1; col < row.length; col++) {
    const amount = asNumber(row[col]);
    if (amount !== null) return amount;
  }
  return null;
}

export function parseFixedMonthlyExpense(grid: unknown[][], asOf: string): FixedCostsSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("asOf must be YYYY-MM-DD");
  let headerRow = -1;
  let headerCol = -1;
  for (let row = 0; row < grid.length; row++) {
    const cells = grid[row] || [];
    for (let col = 0; col < cells.length; col++) {
      if (cellText(cells[col]).toLowerCase() === HEADER) {
        headerRow = row;
        headerCol = col;
        break;
      }
    }
    if (headerRow >= 0) break;
  }
  if (headerRow < 0) throw new Error("Fixed Monthly Expense header not found");

  const items: FixedCostItem[] = [];
  let total: number | null = null;
  let seenTotal = false;
  const summaries: Partial<Record<SummaryKey, number>> = {};

  for (let row = headerRow + 1; row < grid.length; row++) {
    const cells = grid[row] || [];
    const label = cellText(cells[headerCol]);
    if (!label) continue;
    const key = label.toLowerCase();
    if (key === HEADER) continue;
    const amount = amountToTheRight(cells, headerCol);
    if (key === "total" && !seenTotal) {
      if (amount === null) throw new Error("Total amount is missing");
      total = amount;
      seenTotal = true;
      continue;
    }
    if (key === "buffer") continue;
    if (key in SUMMARY_KEYS) {
      if (amount === null) throw new Error(`${label} amount is missing`);
      summaries[SUMMARY_KEYS[key as keyof typeof SUMMARY_KEYS]] = amount;
      continue;
    }
    if (seenTotal) continue;
    if (amount === null) throw new Error(`Amount missing for ${label}`);
    items.push({ name: label, amount });
  }

  if (total === null) throw new Error("Total row is missing");
  if (!items.length) throw new Error("Fixed Monthly Expense has no items");
  for (const name of ["monthlyContribution", "householdFixedCosts", "variableAllocations"] as const) {
    if (typeof summaries[name] !== "number") throw new Error(`${name} is missing`);
  }

  return {
    source: "TeoLoh Financial Planning",
    asOf,
    items,
    total,
    monthlyContribution: summaries.monthlyContribution as number,
    householdFixedCosts: summaries.householdFixedCosts as number,
    variableAllocations: summaries.variableAllocations as number,
  };
}
