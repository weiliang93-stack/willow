// Pure date, agenda, and money helpers for the Loh Family Hub.
// Every "today" is Asia/Singapore. Money figures are computed from the
// expenses rows the caller passes in — this file never invents amounts.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FamilyHubLogic = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const TZ = "Asia/Singapore";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const BRANDS = ["mcst", "geneco", "simba", "grok", "icloud", "empress", "singlife", "instarem", "amaze"];
  const BILL_KINDS = new Set(["bill", "renewal", "subscription"]);

  function sgToday(now) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now instanceof Date ? now : new Date());
  }

  function parseISO(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function isoOf(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    const dt = parseISO(iso);
    dt.setUTCDate(dt.getUTCDate() + n);
    return isoOf(dt);
  }

  function diffDays(fromIso, toIso) {
    return Math.round((parseISO(toIso).getTime() - parseISO(fromIso).getTime()) / 86400000);
  }

  function weekdayMon0(iso) {
    return (parseISO(iso).getUTCDay() + 6) % 7;
  }

  function weekStart(iso) {
    return addDays(iso, -weekdayMon0(iso));
  }

  function monthKey(iso) {
    return String(iso || "").slice(0, 7);
  }

  function formatDayMonth(iso) {
    const dt = parseISO(iso);
    return `${dt.getUTCDate()} ${MONTHS_SHORT[dt.getUTCMonth()]}`;
  }

  function formatDayMonthYear(iso) {
    const dt = parseISO(iso);
    return `${dt.getUTCDate()} ${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  }

  function formatWeekdayDayMonth(iso) {
    const dt = parseISO(iso);
    return `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS_SHORT[dt.getUTCMonth()]}`;
  }

  function formatLong(iso) {
    const dt = parseISO(iso);
    return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  }

  function monthTitle(iso) {
    const dt = parseISO(iso.length === 7 ? `${iso}-01` : iso);
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  }

  function formatWeekSpan(startIso) {
    const end = addDays(startIso, 6);
    const a = parseISO(startIso);
    const b = parseISO(end);
    if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
      return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_SHORT[a.getUTCMonth()]}`;
    }
    return `${formatDayMonth(startIso)} – ${formatDayMonth(end)}`;
  }

  function ordinal(n) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
    return `${n}${suffix}`;
  }

  function ageParts(born, today) {
    const b = parseISO(born);
    const t = parseISO(today);
    let months = (t.getUTCFullYear() - b.getUTCFullYear()) * 12 + (t.getUTCMonth() - b.getUTCMonth());
    if (t.getUTCDate() < b.getUTCDate()) months -= 1;
    if (months < 0) months = 0;
    const years = Math.floor(months / 12);
    const rem = months % 12;
    let label;
    if (years <= 0) label = `${months} month${months === 1 ? "" : "s"}`;
    else if (rem === 0) label = `${years} year${years === 1 ? "" : "s"}`;
    else label = `${years} year${years === 1 ? "" : "s"} ${rem} month${rem === 1 ? "" : "s"}`;
    return { months, years, rem, label };
  }

  function nextBirthday(born, today) {
    const b = parseISO(born);
    const t = parseISO(today);
    let year = t.getUTCFullYear();
    let date = isoOf(new Date(Date.UTC(year, b.getUTCMonth(), b.getUTCDate())));
    if (date < today) {
      year += 1;
      date = isoOf(new Date(Date.UTC(year, b.getUTCMonth(), b.getUTCDate())));
    }
    const turning = year - b.getUTCFullYear();
    const days = diffDays(today, date);
    return { date, turning, days, label: `${ordinal(turning)} birthday` };
  }

  function pregnancy(due, today) {
    const daysUntil = diffDays(today, due);
    const gestationalDays = 280 - daysUntil;
    const week = Math.floor(gestationalDays / 7);
    const weeksToGo = Math.floor(Math.max(daysUntil, 0) / 7);
    const extraDays = Math.max(daysUntil, 0) % 7;
    let trimester = "First";
    if (week >= 28) trimester = "Third";
    else if (week >= 13) trimester = "Second";
    const progress = Math.max(0, Math.min(1, gestationalDays / 280));
    return { daysUntil, gestationalDays, week, weeksToGo, extraDays, trimester, progress, due };
  }

  function tripPlace(trip) {
    return String(trip.title || "Trip").replace(/\s*trip\s*$/i, "").trim() || "Trip";
  }

  function featuredTrip(state, today) {
    const trips = (state.trips || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    for (const trip of trips) {
      if (!trip.end || trip.end < today) continue;
      if (diffDays(today, trip.start) <= 45) return trip;
    }
    return null;
  }

  function tripHero(trip, today) {
    if (!trip) return null;
    const untilStart = diffDays(today, trip.start);
    const untilEnd = diffDays(today, trip.end);
    if (untilEnd < 0) return null;
    if (untilStart > 0) {
      return {
        kicker: `${tripPlace(trip)} trip`,
        headline: `Leaving in ${untilStart} day${untilStart === 1 ? "" : "s"}`,
        badge: String(untilStart),
        badgeLabel: untilStart === 1 ? "Day" : "Days",
        range: `${formatWeekdayDayMonth(trip.start)} – ${formatWeekdayDayMonth(trip.end)}`,
      };
    }
    if (untilStart === 0) {
      return {
        kicker: `${tripPlace(trip)} trip`,
        headline: "Leaving today",
        badge: "0",
        badgeLabel: "Days",
        range: `${formatWeekdayDayMonth(trip.start)} – ${formatWeekdayDayMonth(trip.end)}`,
      };
    }
    const dayNum = diffDays(trip.start, today) + 1;
    return {
      kicker: `${tripPlace(trip)} trip`,
      headline: untilEnd === 0 ? "Flying home today" : `Day ${dayNum} · back in ${untilEnd} day${untilEnd === 1 ? "" : "s"}`,
      badge: String(Math.max(untilEnd, 0)),
      badgeLabel: untilEnd === 1 ? "Day" : "Days",
      range: `${formatWeekdayDayMonth(trip.start)} – ${formatWeekdayDayMonth(trip.end)}`,
    };
  }

  function occursOn(item, iso) {
    if (!item) return false;
    if (Array.isArray(item.skipDates) && item.skipDates.includes(iso)) return false;
    const note = `${item.rruleNote || ""}`.toLowerCase();
    const wd = parseISO(iso).getUTCDay(); // 0 Sun
    if (/\bweekdays?\b/.test(note) && wd >= 1 && wd <= 5) return true;
    if (/\bthursdays?\b/.test(note) && wd === 4) return true;
    if (/\bsundays?\b/.test(note) && wd === 0) return true;
    if (/\bmondays?\b/.test(note) && wd === 1) return true;
    if (/\btuesdays?\b/.test(note) && wd === 2) return true;
    if (/\bwednesdays?\b/.test(note) && wd === 3) return true;
    if (/\bfridays?\b/.test(note) && wd === 5) return true;
    if (/\bsaturdays?\b/.test(note) && wd === 6) return true;
    return false;
  }

  function recurringSubtitle(item) {
    const note = `${item.rruleNote || ""}`.toLowerCase();
    if (/\bmornings?\b/.test(note)) return "Morning";
    if (item.notes) return String(item.notes).split(".")[0];
    return item.where || item.rruleNote || "";
  }

  function eventsOn(state, iso, extras) {
    const events = [];
    for (const item of state.recurring || []) {
      if (!occursOn(item, iso)) continue;
      const clinic = /clinic/i.test(item.title || "");
      events.push({
        id: `${item.id}:${iso}`,
        source: "recurring",
        sourceId: item.id,
        title: item.title,
        subtitle: recurringSubtitle(item),
        kind: item.kind || (clinic ? "clinic" : "routine"),
        date: iso,
      });
    }
    for (const item of state.keyDates || []) {
      if (item.date !== iso) continue;
      let subtitle = item.notes || "";
      if (item.kind === "birthday" && state.anya && state.anya.born) {
        subtitle = `Born ${formatDayMonthYear(state.anya.born)}`;
      }
      events.push({
        id: item.id,
        source: "keyDate",
        sourceId: item.id,
        title: item.title,
        subtitle,
        kind: item.kind || "date",
        date: iso,
      });
    }
    for (const trip of state.trips || []) {
      if (trip.start === iso) {
        events.push({
          id: `${trip.id}:start`,
          source: "trip",
          sourceId: trip.id,
          title: `Fly to ${tripPlace(trip)}`,
          subtitle: trip.end ? `Back ${formatWeekdayDayMonth(trip.end)}` : trip.notes || "",
          kind: "trip",
          date: iso,
        });
      } else if (trip.end === iso) {
        events.push({
          id: `${trip.id}:end`,
          source: "trip",
          sourceId: trip.id,
          title: `Back from ${tripPlace(trip)}`,
          subtitle: trip.title || "",
          kind: "trip",
          date: iso,
        });
      }
    }
    for (const item of insuranceOnDate(state.insurance, iso)) {
      events.push(item);
    }
    for (const extra of extras || []) {
      if (!extra || extra.date !== iso || !extra.title) continue;
      const when = extra.allDay || !extra.start ? "All day" : extra.end ? `${extra.start}–${extra.end}` : String(extra.start);
      events.push({
        id: extra.id || `family:${iso}:${extra.title}`,
        source: "family",
        sourceId: extra.id || extra.title,
        title: extra.title,
        subtitle: when,
        kind: "family",
        date: iso,
      });
    }
    return events;
  }

  function homeAgenda(state, today, extras) {
    const end = addDays(weekStart(today), 6);
    const out = [];
    for (let iso = today; iso <= end; iso = addDays(iso, 1)) {
      for (const ev of eventsOn(state, iso, extras)) {
        const rec = (state.recurring || []).find((r) => r.id === ev.sourceId);
        if (ev.source === "recurring" && rec && /\bweekdays?\b/i.test(rec.rruleNote || "") && iso !== today) continue;
        out.push(ev);
      }
    }
    return out;
  }

  function insuranceOnDate(insurance, iso) {
    return insuranceReminders(insurance, iso, 0).map((item) => ({
      id: item.id,
      source: "insurance",
      sourceId: item.id,
      title: item.title,
      subtitle: item.subtitle,
      kind: "renewal",
      date: iso,
    }));
  }

  function upcomingKeyDates(state, today, limit) {
    const agendaIds = new Set(homeAgenda(state, today).filter((ev) => ev.source === "keyDate").map((ev) => ev.sourceId));
    const hub = (state.keyDates || [])
      .filter((item) => item.date >= today && diffDays(today, item.date) <= 120 && !agendaIds.has(item.id))
      .map((item) => ({ ...item, source: "keyDate" }));
    const renewals = insuranceReminders(state.insurance, today, 60).filter((item) => !agendaIds.has(item.id));
    return hub
      .concat(renewals)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.title).localeCompare(String(b.title)))
      .slice(0, limit || 6);
  }

  function remindersAfter(state, afterDate) {
    const hub = (state.keyDates || [])
      .filter((item) => item.date > afterDate)
      .map((item) => ({ id: item.id, title: item.title, date: item.date, kind: item.kind || "date", source: "keyDate" }));
    const renewals = insuranceReminders(state.insurance, afterDate, 800).filter((item) => item.date > afterDate);
    return hub
      .concat(renewals)
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function asAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function formatMoney(n) {
    const value = round2(n);
    const sign = value < 0 ? "−" : "";
    const formatted = Math.abs(value).toLocaleString("en-SG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sign}S$${formatted}`;
  }

  function formatBedtime(hhmm) {
    const match = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
    if (!match) return hhmm || "";
    let hour = Number(match[1]);
    const minutes = match[2];
    const suffix = hour >= 12 ? "pm" : "am";
    hour %= 12;
    if (hour === 0) hour = 12;
    return `~${hour}${minutes === "00" ? "" : `:${minutes}`} ${suffix}`;
  }

  function brandsIn(text) {
    const hay = String(text || "").toLowerCase();
    return BRANDS.filter((brand) => hay.includes(brand));
  }

  function expenseRows(expensesState) {
    return ((expensesState && expensesState.expenses) || []).map((row) => ({ ...row, amount: asAmount(row.amount) }));
  }

  function excludedRows(autoState) {
    return ((autoState && autoState.excludedExpenses) || []).map((row) => ({ ...row, amount: asAmount(row.amount) }));
  }

  function lastChargeFor(item, expensesState, autoState) {
    const brands = brandsIn(`${item.title || ""} ${item.notes || ""}`);
    if (!brands.length) return null;
    const rows = expenseRows(expensesState).concat(excludedRows(autoState).filter((row) => row.type !== "trip"));
    const hits = rows.filter((row) => {
      const hay = `${row.note || ""} ${row.category || ""}`.toLowerCase();
      return brands.some((brand) => hay.includes(brand));
    });
    if (!hits.length) return null;
    hits.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const latest = hits[0];
    if (!Number.isFinite(latest.amount)) return null;
    return { amount: round2(latest.amount), date: latest.date || "", count: hits.length };
  }

  function dedupeRows(rows) {
    const seen = new Map();
    for (const row of rows) {
      const key = row.id || `${row.date}|${row.amount}|${row.note || ""}`;
      if (!seen.has(key)) seen.set(key, row);
    }
    return [...seen.values()];
  }

  function matchingTripRule(rules, trip) {
    if (!trip) return null;
    const list = Array.isArray(rules) ? rules : [];
    return (
      list.find((rule) => rule && rule.from && rule.to && rule.from <= trip.end && rule.to >= trip.start) || null
    );
  }

  function summarizeMoney(expensesState, autoState, today, hub) {
    const source = hub || { trips: [], keyDates: [], recurring: [] };
    const personal = expenseRows(expensesState);
    const excluded = excludedRows(autoState);
    const month = monthKey(today);
    // Household budget card mirrors expense-tracker's Combined tab month
    // total: excludedExpenses with type "combined" in this calendar month.
    // The budget figure is combinedMonthlyBudget (Household Expenses
    // Summary!B1), not the personal monthlyBudget.
    const combinedRows = excluded.filter((row) => row.type === "combined" && monthKey(row.date) === month);
    const spent = round2(combinedRows.reduce((sum, row) => sum + row.amount, 0));
    const budgetRaw = autoState ? autoState.combinedMonthlyBudget : null;
    const budget = budgetRaw === null || budgetRaw === undefined || budgetRaw === "" ? null : round2(asAmount(budgetRaw));
    const totals = new Map();
    for (const row of combinedRows) {
      const name = row.category || "Uncategorised";
      totals.set(name, (totals.get(name) || 0) + row.amount);
    }
    const categories = [...totals.entries()]
      .map(([name, amount]) => ({ name, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    const maxCategory = categories.reduce((max, row) => Math.max(max, row.amount), 0);

    const tripTagged = dedupeRows(
      excluded.filter((row) => row.type === "trip").concat(personal.filter((row) => row.type === "trip" || row.trip))
    );
    const featured = featuredTrip(source, today);
    const rule = matchingTripRule(autoState && autoState.tripRules, featured);
    let included = [];
    let windowNote = "";
    if (featured) {
      const start = featured.start;
      const end = featured.end;
      included = tripTagged.filter((row) => (rule && row.trip === rule.label) || (row.type === "trip" && row.date >= start && row.date <= end));
        windowNote = rule
        ? `Tagged “${rule.label}” in the household expense log, plus any trip-type charge dated ${formatDayMonth(start)}–${formatDayMonth(end)}.`
        : `Trip-type charges dated ${formatDayMonth(start)}–${formatDayMonth(end)}.`;
    } else {
      included = tripTagged.filter((row) => monthKey(row.date) === month);
      windowNote = `Trip-type charges dated in ${monthTitle(today)}.`;
    }
    included.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const includedIds = new Set(included.map((row) => row.id));
    const otherMap = new Map();
    for (const row of tripTagged) {
      if (includedIds.has(row.id)) continue;
      const label = row.trip || "Untagged";
      const bucket = otherMap.get(label) || { label, total: 0, count: 0 };
      bucket.total = round2(bucket.total + row.amount);
      bucket.count += 1;
      otherMap.set(label, bucket);
    }

    let emptyMessage = null;
    if (!included.length) {
      emptyMessage = tripTagged.length
        ? "No trip-type entries found for this window."
        : "No trip-type entries found in expenses_automation.";
    }

    const personalIds = new Set(personal.filter((row) => row.type === "trip" || row.trip).map((row) => row.id));
    const lines = included.map((row) => ({
      date: row.date,
      category: row.category || "Trip",
      amount: round2(row.amount),
      inPersonalBudget: personalIds.has(row.id),
    }));

    const datedBills = (source.keyDates || [])
      .filter((item) => BILL_KINDS.has(item.kind) && item.date >= today && diffDays(today, item.date) <= 70)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({
        id: item.id,
        title: item.title,
        date: item.date,
        kind: item.kind,
        charge: lastChargeFor(item, expensesState, autoState),
      }));
    const covered = new Set(datedBills.flatMap((item) => brandsIn(item.title)));
    const monthlyBills = (source.recurring || [])
      .filter((item) => item.kind === "bill" && !brandsIn(item.title).some((brand) => covered.has(brand)))
      .map((item) => ({
        id: item.id,
        title: item.title,
        date: null,
        kind: "bill",
        note: item.rruleNote || "Monthly",
        charge: lastChargeFor(item, expensesState, autoState),
      }));

    return {
      month,
      monthTitle: monthTitle(today),
      budget,
      spent,
      remaining: budget === null ? null : round2(budget - spent),
      categories: categories.map((row) => ({ ...row, width: maxCategory > 0 ? row.amount / maxCategory : 0 })),
      trip: {
        title: featured ? `${tripPlace(featured)} trip spend` : "Trip spend",
        total: round2(included.reduce((sum, row) => sum + row.amount, 0)),
        count: included.length,
        note: windowNote,
        emptyMessage,
        lines,
        place: featured ? tripPlace(featured) : "Trip",
      },
      otherTrips: [...otherMap.values()].sort((a, b) => b.total - a.total),
      bills: datedBills.concat(monthlyBills),
      foundExpenses: Boolean(expensesState),
      foundAutomation: Boolean(autoState),
    };
  }

  function moneyOrNull(value) {
    if (typeof value === "number" && Number.isFinite(value)) return round2(value);
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return round2(n);
    }
    return null;
  }

  function allocationLines(value) {
    if (typeof value === "number" || typeof value === "string") {
      const amount = moneyOrNull(value);
      return amount === null ? [] : [{ name: "Variable allocations", amount }];
    }
    if (Array.isArray(value)) {
      return value
        .filter((item) => item && item.name)
        .map((item) => ({ name: String(item.name), amount: moneyOrNull(item.amount) }))
        .filter((item) => item.amount !== null);
    }
    if (value && typeof value === "object") {
      return Object.keys(value)
        .map((name) => ({ name, amount: moneyOrNull(value[name]) }))
        .filter((item) => item.amount !== null);
    }
    return [];
  }

  function fixedCostView(raw) {
    if (!raw || typeof raw !== "object") return null;
    const items = (Array.isArray(raw.items) ? raw.items : []).map((item, index) => ({
      id: item && item.id ? String(item.id) : `fc${index}`,
      name: (item && item.name) || "Item",
      amount: moneyOrNull(item && item.amount),
      note: (item && item.note) || "",
    }));
    const stored = moneyOrNull(raw.total);
    const summed = round2(items.reduce((sum, item) => sum + (item.amount || 0), 0));
    return {
      source: raw.source || "TeoLoh Financial Planning",
      asOf: raw.asOf || "",
      items,
      total: stored === null ? summed : stored,
      monthlyContribution: moneyOrNull(raw.monthlyContribution),
      householdFixedCosts: moneyOrNull(raw.householdFixedCosts),
      allocations: allocationLines(raw.variableAllocations),
    };
  }

  function policyIdentity(policy, index) {
    if (policy && policy.id) return String(policy.id);
    return `ins:${index}:${policy.person || ""}:${policy.name || ""}:${policy.nextDue || ""}`;
  }

  function insurancePolicies(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.policies)) return [];
    return raw.policies
      .filter((policy) => policy && typeof policy === "object")
      .map((policy, index) => ({
        id: policyIdentity(policy, index),
        person: policy.person || "Family",
        category: policy.category || "",
        name: policy.name || "Cover",
        cover: policy.cover || "",
        premium: moneyOrNull(policy.premium),
        frequency: policy.frequency || "",
        payment: policy.payment || "",
        nextDue: policy.nextDue || null,
        status: policy.status === "cancelled" ? "cancelled" : "active",
      }));
  }

  function insuranceReminders(insurance, today, withinDays) {
    return insurancePolicies(insurance)
      .filter((policy) => policy.status !== "cancelled" && policy.nextDue && policy.nextDue >= today && diffDays(today, policy.nextDue) <= withinDays)
      .map((policy) => ({
        id: policy.id,
        title: `${policy.person} · ${policy.name}`,
        date: policy.nextDue,
        kind: "renewal",
        source: "insurance",
        subtitle: [policy.category, policy.frequency].filter(Boolean).join(" · "),
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }

  function insuranceView(raw, today, showCancelled) {
    const policies = insurancePolicies(raw);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.policies)) return null;
    const visible = policies.filter((policy) => showCancelled || policy.status !== "cancelled");
    const preferred = ["Wei Liang", "Zhen Ling", "Anya"];
    const people = preferred.concat(visible.map((policy) => policy.person).filter((person) => !preferred.includes(person)));
    const groups = [];
    for (const person of people) {
      const rows = visible.filter((policy) => policy.person === person);
      if (rows.length) groups.push({ person, policies: rows });
    }
    return {
      asOf: raw.asOf || "",
      groups,
      renewals: insuranceReminders(raw, today, 60),
      cancelledCount: policies.filter((policy) => policy.status === "cancelled").length,
    };
  }

  function safeUrl(url) {
    try {
      const parsed = new URL(String(url || "").trim());
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch (err) {
      return "";
    }
    return "";
  }

  function shoppingList(state) {
    const lists = state.lists || [];
    return lists.find((list) => list.id === "shopping") || lists.find((list) => list.shared) || lists[0] || null;
  }

  return {
    TZ,
    sgToday,
    parseISO,
    addDays,
    diffDays,
    weekStart,
    weekdayMon0,
    monthKey,
    formatDayMonth,
    formatDayMonthYear,
    formatWeekdayDayMonth,
    formatLong,
    formatWeekSpan,
    monthTitle,
    ordinal,
    ageParts,
    nextBirthday,
    pregnancy,
    tripPlace,
    featuredTrip,
    tripHero,
    occursOn,
    eventsOn,
    homeAgenda,
    upcomingKeyDates,
    round2,
    formatMoney,
    formatBedtime,
    brandsIn,
    lastChargeFor,
    summarizeMoney,
    fixedCostView,
    insuranceView,
    insuranceReminders,
    remindersAfter,
    safeUrl,
    shoppingList,
    WEEKDAYS,
    MONTHS,
    MONTHS_SHORT,
  };
});
