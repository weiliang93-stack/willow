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

test("money uses the combined household budget and keeps trip spend separate", () => {
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
      { id: "groceries", date: "2026-11-18", amount: 42.5, type: "combined", category: "Food", note: "fairprice" },
      { id: "last-month", date: "2026-10-18", amount: 500, type: "combined", category: "Food", note: "old" },
      { id: "mcst", date: "2026-11-01", amount: 70, type: "fixed", category: "Bills", note: "MCST quarterly" },
      { id: "wife", date: "2026-11-03", amount: 40, type: "wife_personal", category: "Shopping", note: "personal" },
    ],
  };

  const summary = logic.summarizeMoney(expenses, automation, TODAY, seed);
  assert.equal(summary.budget, 3502.78);
  assert.notEqual(summary.budget, 6319.19);
  assert.equal(summary.spent, 425.5);
  assert.equal(summary.remaining, 3077.28);
  assert.deepEqual(
    summary.categories.map((row) => [row.name, row.amount]),
    [["Food", 425.5]]
  );
  assert.equal(summary.trip.total, 75.5);
  assert.equal(summary.trip.title, "Japan trip spend");
  assert.equal(summary.trip.lines.some((line) => line.inPersonalBudget), true);
  assert.deepEqual(
    summary.otherTrips.map((row) => row.label),
    ["Korea Feb 2027"]
  );

  const byTitle = Object.fromEntries(summary.bills.map((bill) => [bill.id, bill]));
  assert.equal(byTitle["empress-renew"].charge.amount, 383);
  assert.equal(byTitle["mcst-dec"].charge.amount, 70);
  assert.equal(byTitle["grok-renew"].charge.amount, 31.98);
  assert.equal(byTitle["anya-cancer-renew"].charge, null);
  assert.equal(byTitle["anya-shield-renew"].charge, null);
  assert.equal(byTitle["icloud-renew"].charge, null);
  assert.equal(byTitle["geneco-monthly"].charge, null);
  assert.equal(byTitle["simba-monthly"].charge, null);
  assert.equal(logic.formatMoney(summary.budget), "S$3,502.78");
  assert.equal(logic.formatMoney(-2), "−S$2.00");
});

test("empty trip data stays empty instead of inventing a figure", () => {
  const summary = logic.summarizeMoney({ monthlyBudget: 1000, expenses: [{ id: "p", date: "2026-11-02", amount: 80, category: "Food" }] }, { excludedExpenses: [], tripRules: [] }, TODAY, seed);
  assert.equal(summary.budget, null);
  assert.equal(summary.spent, 0);
  assert.deepEqual(summary.categories, []);
  assert.equal(summary.trip.emptyMessage, "No trip-type entries found in expenses_automation.");
  assert.equal(summary.trip.total, 0);
  assert.equal(summary.bills.every((bill) => bill.charge === null), true);
});

test("family calendar events join this week without replacing hub items", () => {
  const extras = [
    { id: "swim", title: "Swimming", date: "2026-11-25", allDay: false, start: "16:00", end: "17:00" },
    { id: "later", title: "Too far", date: "2026-12-20", allDay: true },
  ];
  const home = logic.homeAgenda(seed, TODAY, extras);
  const swim = home.find((event) => event.title === "Swimming");
  assert.ok(swim);
  assert.equal(swim.date, "2026-11-25");
  assert.equal(swim.kind, "family");
  assert.equal(swim.subtitle, "16:00–17:00");
  assert.equal(home.some((event) => event.title === "Too far"), false);
  assert.equal(home.filter((event) => event.sourceId === "childcare-dropoff").length, 1);
});

test("doc links only allow http(s)", () => {
  assert.equal(logic.safeUrl("https://drive.google.com/drive/folders/abc"), "https://drive.google.com/drive/folders/abc");
  assert.equal(logic.safeUrl("javascript:alert(1)"), "");
  assert.equal(logic.safeUrl(""), "");
});

test("fixed costs and insurance use the hub snapshot, with fake figures only", () => {
  assert.equal(logic.fixedCostView(null), null);
  assert.equal(logic.insuranceView(null, TODAY, false), null);
  const fixed = logic.fixedCostView({
    source: "TeoLoh Financial Planning",
    asOf: "2026-01-15",
    items: [
      { name: "Example rent", amount: 1 },
      { name: "Example levy", amount: 2, note: "fake" },
    ],
    total: 3,
    monthlyContribution: 4,
    householdFixedCosts: 5,
    variableAllocations: { "Example groceries": 6 },
  });
  assert.equal(fixed.total, 3);
  assert.equal(fixed.items[1].note, "fake");
  assert.deepEqual(fixed.allocations, [{ name: "Example groceries", amount: 6 }]);

  const hub = {
    ...seed,
    insurance: {
      asOf: "2026-01-01",
      policies: [
        { person: "Wei Liang", category: "Life", name: "Example life", cover: "Sample sum", premium: 2, frequency: "monthly", payment: "Card", nextDue: "2026-11-30", status: "active" },
        { person: "Anya", category: "Health", name: "Example cover", cover: "Sample ward", premium: 1, frequency: "yearly", payment: "Cash", nextDue: "2026-12-20", status: "active" },
        { person: "Zhen Ling", category: "Extras", name: "Old example", cover: "Sample", premium: 3, frequency: "yearly", payment: "Cash", nextDue: "2026-12-01", status: "cancelled" },
        { person: "Zhen Ling", category: "Health", name: "Far example", cover: "Sample", premium: 4, frequency: "yearly", payment: "Cash", nextDue: "2027-06-01", status: "active" },
      ],
    },
  };
  const view = logic.insuranceView(hub.insurance, TODAY, false);
  assert.deepEqual(view.renewals.map((item) => item.title), ["Wei Liang · Example life", "Anya · Example cover"]);
  assert.equal(view.groups.some((group) => group.policies.some((policy) => policy.status === "cancelled")), false);
  assert.equal(view.cancelledCount, 1);
  const shown = logic.insuranceView(hub.insurance, TODAY, true);
  assert.equal(shown.groups.some((group) => group.person === "Zhen Ling"), true);
  const onDue = logic.eventsOn(hub, "2026-11-30").find((event) => event.source === "insurance");
  assert.equal(onDue.title, "Wei Liang · Example life");
  const upcoming = logic.upcomingKeyDates(hub, TODAY, 6);
  assert.equal(upcoming[0].title, "Wei Liang · Example life");
  assert.equal(JSON.stringify(view).includes("policyNumber"), false);
});

test("condo, car, childcare, net worth, annual dates, and folder links stay on the hub row", () => {
  const today = "2026-11-23";
  assert.equal(logic.homeCondoView(null, today), null);
  assert.equal(logic.carView(null, today), null);
  assert.equal(logic.childcareView(null, today), null);
  assert.equal(logic.netWorthView(null), null);
  assert.deepEqual(logic.docLinkGroups(null), []);

  const hub = {
    keyDates: [],
    home: {
      mcst: {
        agent: "Example agent",
        mcstNo: "0000",
        quarterlyTotal: 9,
        breakdown: { management: 4, sinking: 4, gst: 1 },
        currentPeriod: { start: "2026-11-01", end: "2027-01-31" },
        nextDue: "2026-12-03",
        folderUrl: "https://drive.google.com/drive/folders/example-home",
      },
      warranties: [
        { item: "Example fridge", until: null, note: "Show this note" },
        { item: "Old example", until: "2020-01-01", note: "expired" },
      ],
      facts: [{ label: "Example floor", value: "Sample" }],
    },
    car: {
      model: "Example hatch",
      registered: "2020-01-01",
      owner: "Example owner",
      coeExpiry: "2027-02-01",
      loan: { lender: "Example bank", monthly: 7, method: "GIRO" },
      roadTax: { amount: 8, start: "2025-10-01", end: "2026-10-01" },
      insurance: { insurer: "Example insurer", premium: 5, start: "2026-03-01", end: "2027-03-01", ncd: "10%" },
      folderUrl: "https://drive.google.com/drive/folders/example-car",
      plate: "SHOULD-NOT-SHOW",
    },
    childcare: {
      centre: "Example centre",
      className: "Sample class",
      monthlyFee: 3,
      closures: [{ date: "2026-12-04", reason: "Example holiday" }, { date: "2026-01-01", reason: "Past" }],
      folderUrl: "https://drive.google.com/drive/folders/example-care",
    },
    netWorth: { asOf: "2026-01-15", total: 10, byPerson: [{ name: "Example person", amount: 10 }], sourceUrl: "https://docs.google.com/spreadsheets/d/example" },
    annualDates: [
      { label: "Example anniversary", month: 1, day: 2, sinceYear: 2020 },
      { label: "Too early", month: 6, day: 1, sinceYear: 2030 },
    ],
    docLinks: [
      { group: "Home", label: "Example folder", url: "https://drive.google.com/drive/folders/example" },
      { group: "Home", label: "Blocked", url: "javascript:alert(1)" },
    ],
    insurance: {
      asOf: "2026-01-01",
      policies: [{ person: "Anya", category: "Health", name: "Example cover", cover: "Sample ward", premium: 1, frequency: "yearly", payment: "Cash", nextDue: "2026-12-20", status: "active" }],
    },
  };

  const condo = logic.homeCondoView(hub.home, today);
  assert.equal(condo.quarterlyTotal, 9);
  assert.deepEqual(condo.warranties.map((item) => item.item), ["Example fridge"]);
  assert.equal(condo.warranties[0].note, "Show this note");
  const car = logic.carView(hub.car, today);
  assert.equal(car.roadTaxCheck, true);
  assert.equal(car.insuranceCheck, false);
  assert.equal(JSON.stringify(car).includes("SHOULD-NOT-SHOW"), false);
  assert.equal(JSON.stringify(car).includes("plate"), false);
  const care = logic.childcareView(hub.childcare, today);
  assert.deepEqual(care.closures.map((item) => item.reason), ["Example holiday"]);
  assert.equal(logic.netWorthView(hub.netWorth).total, 10);
  assert.equal(logic.docLinkGroups(hub.docLinks)[0].links[1].url, "");
  assert.equal(logic.nextAnnualDate(hub.annualDates[0], today), "2027-01-02");
  assert.equal(logic.nextAnnualDate(hub.annualDates[1], today), "2030-06-01");
  const titles = logic.upcomingKeyDates(hub, today, 20).map((item) => item.title);
  assert.ok(titles.includes("MCST bill due"));
  assert.ok(titles.includes("Car COE expires"));
  assert.equal(titles.includes("Road tax ends"), false);
  assert.ok(titles.includes("Childcare closed · Example holiday"));
  assert.ok(titles.includes("Example anniversary"));
  assert.ok(titles.includes("Anya · Example cover"));
  assert.equal(logic.insuranceView(hub.insurance, today, false).groups[0].person, "Anya");
});

test("the app script only pulls expense rows and only pushes familyhub", () => {
  const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
  assert.match(src, /pullState\(\s*["']expenses["']\s*\)/);
  assert.match(src, /pullState\(\s*["']expenses_automation["']\s*\)/);
  assert.match(src, /pushStateNow\(\s*["']familyhub["']/);
  assert.equal(/pushState(?:Now)?\(\s*["']expenses/.test(src), false);
  assert.equal(/pushState(?:Now)?\(\s*["']expenses_automation/.test(src), false);
});

test("legacy Anya fields migrate into kids and Yuna starts with an empty prep list", () => {
  const raw = {
    anya: {
      born: "2025-11-27",
      notes: "Keep this note",
      milestones: [{ id: "m1", text: "Sits steadily", done: true }],
      vaccines: [{ id: "v1", name: "MMR, 1st dose", status: "due" }],
      sleep: { napsPerDay: 2, bedtime: "19:00" },
    },
    baby2: { due: "2027-05-10", prep: [{ id: "p1", text: "Move crib to Bedroom 3", done: false }] },
  };
  const state = logic.normalizeKids(raw);
  const anya = state.kids.find((kid) => kid.id === "anya");
  const yuna = state.kids.find((kid) => kid.id === "yuna");
  assert.equal(anya.bornDate, "2025-11-27");
  assert.equal(anya.notes, "Keep this note");
  assert.equal(anya.milestones[0].id, "m1");
  assert.equal(anya.milestones, state.anya.milestones);
  assert.equal(anya.vaccines[0].name, "MMR, 1st dose");
  assert.equal(state.anya.born, "2025-11-27");
  assert.equal(yuna.name, "Yuna");
  assert.equal(yuna.dueDate, "2027-05-10");
  assert.equal(yuna.bornDate, null);
  assert.deepEqual(yuna.prep, []);
  assert.equal(state.baby2.prep.length, 1);

  anya.milestones.push({ id: "m2", text: "Added later", done: false });
  assert.equal(state.anya.milestones.length, 2);

  const again = logic.normalizeKids(state);
  assert.equal(again.kids.filter((kid) => kid.id === "yuna").length, 1);
  assert.equal(again.kids.find((kid) => kid.id === "anya").milestones.length, 2);
});

test("an existing child entry is kept, including a prep item already saved for Yuna", () => {
  const state = logic.normalizeKids({
    anya: { born: "2025-11-27", milestones: [{ id: "old", text: "Legacy", done: false }] },
    kids: [
      { id: "anya", name: "Anya", bornDate: "2025-11-27", milestones: [{ id: "kept", text: "Already on the child", done: false }], vaccines: [], notes: "Kid note", prep: [] },
      { id: "yuna", name: "Yuna", dueDate: "2027-05-10", bornDate: null, prep: [{ id: "cloth", text: "Example muslin", done: false }] },
    ],
  });
  assert.equal(state.kids.find((kid) => kid.id === "anya").milestones[0].id, "kept");
  assert.equal(state.anya.notes, "Kid note");
  assert.equal(state.kids.find((kid) => kid.id === "yuna").prep[0].text, "Example muslin");
});

test("Yuna countdown and tagged antenatal rows, with untagged dates left out", () => {
  assert.equal(logic.dueCountdown("2027-05-10", TODAY), "168 days to go");
  assert.equal(logic.dueCountdown("2026-11-23", TODAY), "Due today");
  const state = {
    keyDates: [
      { id: "scan", title: "Example scan", date: "2026-12-15", child: "yuna" },
      { id: "other", title: "MCST bill due", date: "2026-12-01", kind: "bill" },
      { id: "person", title: "Example class", date: "2026-12-02", person: "Yuna" },
    ],
  };
  const rows = logic.antenatalFor(state, { id: "yuna", name: "Yuna" }, [
    { title: "Yuna midwife", date: "2026-12-20", where: "Clinic" },
    { title: "School meeting", date: "2026-12-03" },
  ]);
  assert.deepEqual(rows.map((row) => row.title), ["Example class", "Example scan", "Yuna midwife"]);
});

test("fixed cost card keeps the stored total when it differs from the item sum", () => {
  const view = logic.fixedCostView({
    asOf: "2026-01-15",
    items: [{ name: "Example rent", amount: 1 }, { name: "Example levy", amount: 2 }],
    total: 3.01,
    monthlyContribution: 4,
    householdFixedCosts: 5,
    variableAllocations: 6,
  });
  assert.equal(view.total, 3.01);
  assert.equal(view.allocations[0].amount, 6);
});

test("the fixed-cost card is read-only and the kids tab is labelled Kids", () => {
  const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(src, /Synced from sheet/);
  assert.equal(src.includes('data-add="fixedItem"'), false);
  assert.equal(src.includes("ensureFixed"), false);
  assert.match(html, /<span>Kids<\/span>/);
  assert.match(html, /script\.js\?v=20261124/);
});

test("hub copy does not name Penny", () => {
  const files = ["script.js", "logic.js", "HANDOVER.md", "seed.js"].map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"));
  files.push(fs.readFileSync(path.join(__dirname, "../AGENTS.md"), "utf8"));
  const claude = fs.readFileSync(path.join(__dirname, "../CLAUDE.md"), "utf8");
  const section = claude.slice(claude.indexOf("**family-hub/**"), claude.indexOf("## Sync architecture"));
  files.push(section);
  for (const text of files) assert.equal(/penny/i.test(text), false, text.slice(0, 80));
});
