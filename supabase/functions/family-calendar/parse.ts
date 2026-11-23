// Turns a Google Calendar iCal feed into dated events. No network.
// Times are reported as Asia/Singapore calendar days. Recurring events
// are expanded only for the requested window.

export type FamilyEvent = {
  id: string;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
};

type Stamp = {
  allDay: boolean;
  iso: string;
  time: string | null;
  utc: boolean;
};

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const dt = parseISO(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return isoOf(dt);
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round((parseISO(toIso).getTime() - parseISO(fromIso).getTime()) / 86400000);
}

function weekdayCode(iso: string): string {
  return DAY_CODES[parseISO(iso).getUTCDay()];
}

function unfold(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function parseProp(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [rawName, ...paramParts] = left.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value };
}

function parseStamp(prop: { params: Record<string, string>; value: string } | undefined): Stamp | null {
  if (!prop) return null;
  const raw = prop.value.trim();
  const allDay = prop.params.VALUE === "DATE" || /^\d{8}$/.test(raw);
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  if (allDay || !match[4]) return { allDay: true, iso, time: null, utc: false };
  return { allDay: false, iso, time: `${match[4]}:${match[5]}`, utc: match[7] === "Z" };
}

function singaporeFromUtc(iso: string, time: string): { date: string; time: string } {
  const [y, m, d] = iso.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d, hh, mm) + 8 * 60 * 60 * 1000);
  return {
    date: isoOf(shifted),
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

function place(stamp: Stamp | null): { date: string; time: string | null; allDay: boolean } | null {
  if (!stamp) return null;
  if (stamp.allDay || !stamp.time) return { date: stamp.iso, time: null, allDay: true };
  if (stamp.utc) {
    const local = singaporeFromUtc(stamp.iso, stamp.time);
    return { date: local.date, time: local.time, allDay: false };
  }
  return { date: stamp.iso, time: stamp.time, allDay: false };
}

type Rule = { freq: string; interval: number; byday: string[] | null; bymonthday: number | null; until: string | null; count: number | null };

function parseRule(value: string | undefined): Rule | null {
  if (!value) return null;
  const bits = Object.fromEntries(value.split(";").map((part) => {
    const eq = part.indexOf("=");
    return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)];
  }));
  const freq = bits.FREQ;
  if (!freq) return null;
  const untilStamp = bits.UNTIL ? place(parseStamp({ params: {}, value: bits.UNTIL })) : null;
  return {
    freq,
    interval: Math.max(1, Number(bits.INTERVAL) || 1),
    byday: bits.BYDAY ? bits.BYDAY.split(",") : null,
    bymonthday: bits.BYMONTHDAY ? Number(bits.BYMONTHDAY) : null,
    until: untilStamp ? untilStamp.date : null,
    count: bits.COUNT ? Number(bits.COUNT) : null,
  };
}

function matches(iso: string, start: string, rule: Rule): boolean {
  const delta = diffDays(start, iso);
  if (delta < 0) return false;
  if (rule.freq === "DAILY") return delta % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const allowed = rule.byday || [weekdayCode(start)];
    if (!allowed.includes(weekdayCode(iso))) return false;
    return Math.floor(delta / 7) % rule.interval === 0;
  }
  if (rule.freq === "MONTHLY") {
    const day = rule.bymonthday || Number(start.slice(8, 10));
    if (Number(iso.slice(8, 10)) !== day) return false;
    const months = (Number(iso.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(iso.slice(5, 7)) - Number(start.slice(5, 7)));
    return months >= 0 && months % rule.interval === 0;
  }
  return false;
}

function exdates(value: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const part of value.split(",")) {
    const stamp = parseStamp({ params: /^\d{8}$/.test(part.trim()) ? { VALUE: "DATE" } : {}, value: part.trim() });
    const placed = place(stamp);
    if (placed) out.add(placed.date);
  }
  return out;
}

export function parseIcs(ics: string, fromIso: string, dayCount = 14): FamilyEvent[] {
  const days = Math.max(1, Math.min(dayCount, 31));
  const until = addDays(fromIso, days - 1);
  const events: FamilyEvent[] = [];
  const blocks = unfold(ics).split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const props = new Map<string, { params: Record<string, string>; value: string }>();
    const extras = new Map<string, string[]>();
    for (const line of body.split("\n")) {
      const prop = parseProp(line.trim());
      if (!prop) continue;
      if (props.has(prop.name)) {
        const list = extras.get(prop.name) || [];
        list.push(prop.value);
        extras.set(prop.name, list);
      } else {
        props.set(prop.name, prop);
      }
    }
    if ((props.get("STATUS")?.value || "").toUpperCase() === "CANCELLED") continue;
    const title = unescapeText(props.get("SUMMARY")?.value || "");
    if (!title) continue;
    const start = place(parseStamp(props.get("DTSTART")));
    if (!start) continue;
    const end = place(parseStamp(props.get("DTEND")));
    const rule = parseRule(props.get("RRULE")?.value);
    const skip = exdates([props.get("EXDATE")?.value, ...(extras.get("EXDATE") || [])].filter(Boolean).join(","));
    const uid = props.get("UID")?.value || title;
    const dates: string[] = [];
    if (!rule) {
      if (start.date >= fromIso && start.date <= until) dates.push(start.date);
    } else {
      let seen = 0;
      const cap = rule.count || 800;
      for (let iso = start.date, steps = 0; iso <= until && seen < cap && steps < 20000; iso = addDays(iso, 1), steps += 1) {
        if (rule.until && iso > rule.until) break;
        if (!matches(iso, start.date, rule)) continue;
        seen += 1;
        if (iso < fromIso || skip.has(iso)) continue;
        dates.push(iso);
      }
    }
    for (const date of dates) {
      events.push({
        id: `${uid}:${date}`,
        title,
        date,
        start: start.allDay ? null : start.time,
        end: end && !end.allDay ? end.time : null,
        allDay: start.allDay,
      });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || String(a.start || "").localeCompare(String(b.start || "")) || a.title.localeCompare(b.title));
  return events;
}
