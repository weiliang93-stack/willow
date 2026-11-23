const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const logic = require("./logic.js");
const seed = require("./seed.js");

const TODAY = "2026-11-23";

test("Singapore calendar date, not UTC and not the machine zone", () => {
  assert.equal(logic.sgToday(new Date("2026-11-22T16:30:00Z")), "2026-11-23");
  assert.equal(logic.sgToday(new Date("2026-11-23T15:59:00Z")), "2026-11-23");
  assert.equal(logic.sgToday(new Date("2026-11-23T16:30:00Z")), "2026-11-24");
});

test("week starts Monday", () => {
  assert.equal(logic.weekStart("2026-11-23"), "2026-11-23");
  assert.equal(logic.weekStart("2026-11-29"), "2026-11-23");
  assert.equal(logic.formatWeekSpan("2026-11-23"), "23–29 Nov");
});

test("Anya age and 1st birthday countdown on 23 Nov 2026", () => {
  assert.equal(logic.ageParts("2025-11-27", TODAY).label, "11 months");
  assert.equal(logic.ageParts("2025-11-27", "2026-11-27").label, "1 year");
  const birthday = logic.nextBirthday("2025-11-27", TODAY);
  assert.equal(birthday.date, "2026-11-27");
  assert.equal(birthday.days, 4);
  assert.equal(birthday.turning, 1);
  assert.equal(birthday.label, "1st birthday");
  const after = logic.nextBirthday("2025-11-27", "2026-11-28");
  assert.equal(after.date, "2027-11-27");
  assert.equal(after.turning, 2);
});

test("baby #2 is week 16 with 24 weeks to go on 23 Nov 2026", () => {
  const pregnancy = logic.pregnancy("2027-05-10", TODAY);
  assert.equal(pregnancy.daysUntil, 168);
  assert.equal(pregnancy.week, 16);
  assert.equal(pregnancy.weeksToGo, 24);
  assert.equal(pregnancy.extraDays, 0);
  assert.equal(pregnancy.trimester, "Second");
});

test("home week skips Sunday clinic on the Japan departure and does not repeat childcare", () => {
  const sunday = logic.eventsOn(seed, "2026-11-29").map((event) => event.title);
  assert.ok(sunday.includes("Fly to Japan"));
  assert.equal(sunday.includes("Clinic at Inspire Medical"), false);

  const thursday = logic.eventsOn(seed, "2026-11-26").map((event) => event.title);
  assert.ok(thursday.includes("Childcare drop-off"));
  assert.ok(thursday.includes("Clinic at Inspire Medical"));

  const home = logic.homeAgenda(seed, TODAY);
  const childcare = home.filter((event) => event.sourceId === "childcare-dropoff");
  assert.equal(childcare.length, 1);
  assert.equal(childcare[0].date, TODAY);
  assert.equal(childcare[0].subtitle, "Morning");
  assert.ok(home.some((event) => event.date === "2026-11-26" && event.kind === "clinic"));
  assert.ok(home.some((event) => event.date === "2026-11-27" && event.kind === "birthday"));
  assert.ok(home.some((event) => event.id === "japan-2026:start"));
  assert.equal(home.some((event) => event.date === "2026-11-29" && event.kind === "clinic"), false);
});

test("Japan hero counts six days on the mockup week", () => {
  const trip = logic.featuredTrip(seed, TODAY);
  assert.equal(trip.id, "japan-2026");
  const hero = logic.tripHero(trip, TODAY);
  assert.equal(hero.headline, "Leaving in 6 days");
  assert.equal(hero.badge, "6");
  assert.equal(hero.range, "Sun 29 Nov – Fri 11 Dec");
  assert.equal(logic.featuredTrip(seed, "2026-12-12"), null);
});

test("money uses the personal monthly budget and keeps trip spend separate", () => {
  const expenses = {
    monthlyBudget: 6319.189999999999,
    expenses: [
      { id: "food", date: "2026-11-02", amount: 100.1, category: "Food", note: "lunch" },
      { id: "grok", date: "2026-11-22", amount: "31.98", category: "Shopping", note: "Grok Bot Premium" },
      { id: "old", date: "2026-10-02", amount: 999, category: "Food", note: "last month" },
      { id: "slipped", date: "2026-11-20", amount: 15, category: "Travel", type: "trip", trip: "Japan Dec 2026", note: "pocket wifi" },
    ],
  };
  const automation = {
    combinedMonthlyBudget: 3502.7825,
    tripRules: [
      { from: "2026-11-28", to: "2026-12-12", label: "Japan Dec 2026", active: true },
      { from: "2027-02-26", to: "2027-03-04", label: "Korea Feb 2027", active: true },
    ],
    excludedExpenses: [
      { id: "j1", date: "2026-11-11", amount: 50.5, type: "trip", trip: "Japan Dec 2026", category: "Restaurant", note: "dinner" },
      { id: "j2", date: "2026-11-14", amount: 10, type: "trip", trip: "Japan Dec 2026", category: "Travel", note: "SINGLIFE booking 5D4K3Y" },
      { id: "k1", date: "2026-11-14", amount: 80, type: "trip", trip: "Korea Feb 2027", category: "Travel", note: "hotel" },
      { id: "empress", date: "2026-11-09", amount: 383, type: "combined", category: "Food", note: "EMPRESS porridge" },
      { id: "mcst", date: "2026-11-01", amount: 70, type: "fixed", category: "Bills", note: "MCST quarterly" },
      { id: "wife", date: "2026-11-03", amount: 40, type: "wife_personal", category: "Shopping", note: "personal" },
    ],
  };

  const summary = logic.summarizeMoney(expenses, automation, TODAY, seed);
  assert.equal(summary.budget, 6319.19);
  assert.equal(summary.spent, 147.08);
  assert.equal(summary.remaining, 6172.11);
  assert.deepEqual(
    summary.categories.map((row) => row.name),
    ["Food", "Shopping", "Travel"]
  );
  assert.equal(summary.trip.total, 75.5);
  assert.equal(summary.trip.title, "Japan trip spend");
  assert.equal(summary.trip.lines.some((line) => line.inPersonalBudget), true);
  assert.deepEqual(
    summary.otherTrips.map((row) => row.label),
    ["Korea Feb 2027"]
  );
  assert.equal(summary.shared.spent, 383);
  assert.equal(summary.shared.budget, 3502.78);

  const byTitle = Object.fromEntries(summary.bills.map((bill) => [bill.id, bill]));
  assert.equal(byTitle["empress-renew"].charge.amount, 383);
  assert.equal(byTitle["mcst-dec"].charge.amount, 70);
  assert.equal(byTitle["grok-renew"].charge.amount, 31.98);
  assert.equal(byTitle["anya-cancer-renew"].charge, null);
  assert.equal(byTitle["anya-shield-renew"].charge, null);
  assert.equal(byTitle["icloud-renew"].charge, null);
  assert.equal(byTitle["geneco-monthly"].charge, null);
  assert.equal(byTitle["simba-monthly"].charge, null);
  assert.equal(logic.formatMoney(summary.budget), "S$6,319.19");
  assert.equal(logic.formatMoney(-2), "−S$2.00");
});

test("empty trip data stays empty instead of inventing a figure", () => {
  const summary = logic.summarizeMoney({ monthlyBudget: null, expenses: [] }, { excludedExpenses: [], tripRules: [] }, TODAY, seed);
  assert.equal(summary.budget, null);
  assert.equal(summary.spent, 0);
  assert.equal(summary.trip.emptyMessage, "No trip-type entries found in expenses_automation.");
  assert.equal(summary.trip.total, 0);
  assert.equal(summary.bills.every((bill) => bill.charge === null), true);
});

test("doc links only allow http(s)", () => {
  assert.equal(logic.safeUrl("https://drive.google.com/drive/folders/abc"), "https://drive.google.com/drive/folders/abc");
  assert.equal(logic.safeUrl("javascript:alert(1)"), "");
  assert.equal(logic.safeUrl(""), "");
});

test("the app script only pulls expense rows and only pushes familyhub", () => {
  const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
  assert.match(src, /pullState\(\s*["']expenses["']\s*\)/);
  assert.match(src, /pullState\(\s*["']expenses_automation["']\s*\)/);
  assert.match(src, /pushStateNow\(\s*["']familyhub["']/);
  assert.equal(/pushState(?:Now)?\(\s*["']expenses/.test(src), false);
  assert.equal(/pushState(?:Now)?\(\s*["']expenses_automation/.test(src), false);
});
