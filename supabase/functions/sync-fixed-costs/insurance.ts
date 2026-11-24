// Reads the TeoLoh "Insurance" tab into the familyhub insurance shape.
// Layout, confirmed against the live tab: a person name, then a header
// row (Type, Cover, Monthly, Yearly, Bought date, Policy No, Remarks,
// Verified), then LIFE / HEALTH / EXTRAS bands of policy rows. The same
// header repeats for the next person. Columns are found by their labels,
// not by a fixed letter, so a shifted grid still maps the same way.
//
// Policy No is never copied. A parenthetical policy token in the name is
// removed. Remarks are not stored; they are only used to read an explicit
// next-due date, a cancelled flag, a payment label, and — when both
// Monthly and Yearly are filled — which of those two sheet cells is the
// one being paid. Nothing is multiplied or divided. If the remarks name
// one frequency, that cell is stored alone. If they do not, frequency is
// "both" and premium is { monthly, yearly } with both cells unchanged.

export type InsurancePolicy = {
  person: string;
  category: "Life" | "Health" | "Extras";
  name: string;
  cover: string;
  premium: number | { monthly: number; yearly: number };
  frequency: "monthly" | "yearly" | "both";
  payment: string;
  nextDue: string | null;
  status: "active" | "cancelled";
};

export type InsuranceSnapshot = {
  asOf: string;
  policies: InsurancePolicy[];
};

const PEOPLE: Record<string, string> = {
  "wei liang": "Wei Liang",
  "zhen ling": "Zhen Ling",
  anya: "Anya",
  yuna: "Yuna",
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "—") return null;
  const normalised = trimmed.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;
  return Number(normalised);
}

function headerIndexes(row: unknown[]): { type: number; cover: number; monthly: number; yearly: number; remarks: number; policy?: number } | null {
  const indexes: Record<string, number> = {};
  for (let i = 0; i < row.length; i++) {
    const label = cellText(row[i]).toLowerCase().replace(/\s+/g, " ");
    if (label === "type") indexes.type = i;
    else if (label === "cover") indexes.cover = i;
    else if (label === "monthly") indexes.monthly = i;
    else if (label === "yearly") indexes.yearly = i;
    else if (label === "remarks") indexes.remarks = i;
    else if (label === "policy no" || label === "policy no." || label === "policy number" || label === "policy #") indexes.policy = i;
  }
  const required = ["type", "cover", "monthly", "yearly", "remarks"];
  const hits = required.filter((key) => typeof indexes[key] === "number");
  if (hits.length === 0) return null;
  if (hits.length < required.length) throw new Error("Insurance header is missing a required column");
  return indexes as { type: number; cover: number; monthly: number; yearly: number; remarks: number; policy?: number };
}

function personName(raw: string): string {
  const known = PEOPLE[raw.trim().toLowerCase()];
  if (!known) throw new Error(`Unknown insurance person "${raw.trim()}"`);
  return known;
}

function categoryName(raw: string): InsurancePolicy["category"] | null {
  const key = raw.trim().toLowerCase();
  if (key === "life") return "Life";
  if (key === "health") return "Health";
  if (key === "extras" || key === "extra") return "Extras";
  return null;
}

function banTokens(value: unknown): string[] {
  const text = cellText(value);
  if (!text) return [];
  const tokens = new Set<string>();
  if (text.length >= 5) tokens.add(text);
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 5) tokens.add(digits);
  for (const run of text.match(/\d{5,}/g) || []) tokens.add(run);
  return [...tokens];
}

function isPolicyToken(text: string): boolean {
  const trimmed = text.trim();
  if (/^[A-Za-z]{0,3}\d[\d\s-]{4,}$/.test(trimmed)) return true;
  return trimmed.replace(/\D/g, "").length >= 5 && !/[A-Za-z]{4,}/.test(trimmed);
}

function stripBans(value: string, bans: string[]): string {
  let out = value;
  for (const ban of bans) {
    if (ban.length >= 5) out = out.split(ban).join("");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function cleanName(name: string, bans: string[]): string {
  const withoutTokens = name.replace(/\s*\(([^)]*)\)/g, (full, inner) => {
    if (isPolicyToken(String(inner)) || bans.some((ban) => ban.length >= 5 && String(inner).includes(ban))) return "";
    return full;
  });
  return stripBans(withoutTokens, bans).replace(/\s+([,.)])/g, "$1").trim();
}

function coverText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return cellText(value);
}

function paymentLabel(remarks: string): string {
  const parts: string[] = [];
  if (/\bmedisave\b/i.test(remarks)) parts.push("MediSave");
  if (/\bcpf\b/i.test(remarks)) parts.push("CPF");
  if (/\bgiro\b/i.test(remarks)) parts.push("GIRO");
  if (/\bamex\b/i.test(remarks)) parts.push("AMEX");
  if (/\bcash\b/i.test(remarks)) parts.push("Cash");
  if (/\bcard\b/i.test(remarks) && !parts.includes("AMEX")) parts.push("Card");
  return parts.join(" · ");
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function iso(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Bad date ${year}-${month}-${day}`);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`Bad date ${year}-${month}-${day}`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDateToken(token: string): string {
  const spoken = token.trim().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{2,4})$/);
  if (spoken) {
    const month = MONTHS[spoken[2].toLowerCase()];
    if (!month) throw new Error(`Bad date ${token}`);
    return iso(expandYear(Number(spoken[3])), month, Number(spoken[1]));
  }
  const numeric = token.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (numeric) return iso(expandYear(Number(numeric[3])), Number(numeric[2]), Number(numeric[1]));
  throw new Error(`Bad date ${token}`);
}

function nextDueFromRemarks(remarks: string, plan: string): string | null {
  const pattern = /(?:next\s+due|renewal\s+due|(?:^|[,;]\s*|\b)due)(?!\s+to\b)\s*(~|approx(?:imately)?\.?|about|around)?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{2,4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/gi;
  const dates = new Set<string>();
  for (const match of remarks.matchAll(pattern)) {
    if (match[1]) continue;
    dates.add(parseDateToken(match[2]));
  }
  if (dates.size > 1) throw new Error(`${plan} has more than one next due date`);
  return dates.size === 1 ? [...dates][0] : null;
}

function paidFrequency(remarks: string): "monthly" | "yearly" | null {
  const stripped = remarks.replace(/\([^)]*\)/g, " ");
  const monthly = /\bmonthly\b|\bper month\b|\/mo\b|\ba month\b/i.test(stripped);
  const yearly = /\byearly\b|\bannually\b|\bannual\b|\bper year\b|\/yr\b|\ba year\b/i.test(stripped);
  if (monthly && yearly) return null;
  if (monthly) return "monthly";
  if (yearly) return "yearly";
  return null;
}

export function parseInsurance(grid: unknown[][], asOf: string): InsuranceSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("asOf must be YYYY-MM-DD");
  const policies: InsurancePolicy[] = [];
  const banned: string[] = [];
  let columns: ReturnType<typeof headerIndexes> = null;
  let person = "";
  let category: InsurancePolicy["category"] | "" = "";

  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] || [];
    const header = headerIndexes(row);
    if (header) {
      columns = header;
      let found = "";
      for (let above = rowIndex - 1; above >= 0; above--) {
        const label = cellText((grid[above] || [])[header.type]);
        if (!label || label.toLowerCase() === "insurance") continue;
        found = personName(label);
        break;
      }
      if (!found) throw new Error("Insurance section is missing a person");
      person = found;
      category = "";
      continue;
    }
    if (!columns) continue;
    const label = cellText(row[columns.type]);
    if (!label) continue;
    const monthly = asNumber(row[columns.monthly]);
    const yearly = asNumber(row[columns.yearly]);
    const coverRaw = row[columns.cover];
    const coverEmpty = cellText(coverRaw) === "" && asNumber(coverRaw) === null;
    const band = categoryName(label);
    if (band && monthly === null && yearly === null && coverEmpty) {
      category = band;
      continue;
    }
    if (PEOPLE[label.toLowerCase()] && monthly === null && yearly === null && coverEmpty) {
      person = "";
      category = "";
      continue;
    }
    if (!person || !category) throw new Error(`Policy "${label}" is outside a person and category`);

    const tokens = columns.policy == null ? [] : banTokens(row[columns.policy]);
    banned.push(...tokens);
    const name = cleanName(label, tokens);
    if (!name) throw new Error("Insurance policy name is missing");
    if (monthly === null && yearly === null) throw new Error(`Premium missing for ${person} · ${name}`);

    let frequency: InsurancePolicy["frequency"];
    let premium: InsurancePolicy["premium"];
    if (monthly !== null && yearly === null) {
      frequency = "monthly";
      premium = monthly;
    } else if (yearly !== null && monthly === null) {
      frequency = "yearly";
      premium = yearly;
    } else {
      const stated = paidFrequency(cellText(row[columns.remarks]));
      if (!stated) {
        frequency = "both";
        premium = { monthly: monthly as number, yearly: yearly as number };
      } else {
        frequency = stated;
        premium = stated === "monthly" ? (monthly as number) : (yearly as number);
      }
    }

    const remarks = cellText(row[columns.remarks]);
    const cover = stripBans(coverText(coverRaw), tokens);
    policies.push({
      person,
      category,
      name,
      cover,
      premium,
      frequency,
      payment: paymentLabel(remarks),
      nextDue: nextDueFromRemarks(remarks, `${person} · ${name}`),
      status: /\bcancelled\b/i.test(remarks) ? "cancelled" : "active",
    });
  }

  if (!policies.length) throw new Error("Insurance tab has no policies");
  const snapshot: InsuranceSnapshot = { asOf, policies };
  const encoded = JSON.stringify(snapshot);
  for (const token of banned) {
    if (token.length >= 5 && encoded.includes(token)) throw new Error("Policy number leaked into the insurance snapshot");
  }
  return snapshot;
}
