// Initial Loh Family Hub state. Seeded once, only when app_state has no
// "familyhub" row. Do not put policy numbers, account numbers, NRICs,
// card numbers, booking codes, or unit addresses in here.
const FAMILY_HUB_SEED = {
  version: 1,
  family: {
    name: "Loh Family Hub",
    members: [
      { id: "wl", name: "Wei Liang", short: "WL" },
      { id: "zl", name: "Zhen Ling", short: "ZL" },
      { id: "anya", name: "Anya", short: "A", born: "2025-11-27" },
    ],
  },
  trips: [
    {
      id: "japan-2026",
      title: "Japan trip",
      start: "2026-11-29",
      end: "2026-12-11",
      notes: "Leaves Sunday 29 Nov, back Friday 11 Dec.",
    },
    {
      id: "korea-2027",
      title: "Korea trip",
      start: "2027-02-26",
      end: "2027-03-04",
      notes: "Zhen Ling will be about 7 months along.",
    },
  ],
  keyDates: [
    {
      id: "car-cover-check",
      title: "Confirm car insurance and road tax were renewed",
      date: "2026-10-27",
      kind: "task",
      notes: "Cover period ended 27 Oct 2026. Confirm renewal — do not store plate, policy or account numbers here.",
    },
    { id: "anya-birthday-1", title: "Anya's 1st birthday", date: "2026-11-27", kind: "birthday" },
    { id: "geneco-switch", title: "Geneco electricity switch takes effect", date: "2026-11-27", kind: "home" },
    { id: "mcst-dec", title: "MCST bill due", date: "2026-12-01", kind: "bill", notes: "Approximate due date for the Nov–Jan quarter." },
    { id: "empress-renew", title: "Empress Family Feast auto-renew (approx.)", date: "2026-12-06", kind: "subscription" },
    { id: "icloud-renew", title: "iCloud+ renews", date: "2026-12-07", kind: "subscription" },
    { id: "grok-renew", title: "Grok Bot Premium renews — cancel before if unused", date: "2026-12-13", kind: "subscription" },
    { id: "instarem-useby", title: "Instarem amaze card — use by, to stay active", date: "2026-12-14", kind: "task" },
    {
      id: "anya-cancer-renew",
      title: "Anya's Singlife Cancer Cover Plus II renewal",
      date: "2026-12-24",
      kind: "renewal",
      notes: "Paid by cash, so it will not auto-deduct.",
    },
    { id: "anya-shield-renew", title: "Anya's Singlife Shield + Health Plus renewal", date: "2026-12-29", kind: "renewal" },
    { id: "baby2-due", title: "Baby #2 due", date: "2027-05-10", kind: "family" },
    { id: "bcls-expiry", title: "BCLS+AED certification expires", date: "2027-08-09", kind: "professional" },
    { id: "smc-pc-expiry", title: "SMC Practising Certificate expires", date: "2027-12-31", kind: "professional" },
    { id: "anya-passport", title: "Anya's passport expires", date: "2031-01-26", kind: "document" },
    { id: "wl-passport", title: "Wei Liang's passport expires", date: "2033-06-14", kind: "document" },
    { id: "coe-expiry", title: "Car COE expires", date: "2034-10-27", kind: "car" },
  ],
  recurring: [
    { id: "childcare-dropoff", title: "Childcare drop-off", where: "Skool4Kidz", rruleNote: "Weekday mornings (typical school day)" },
    { id: "clinic-thu", title: "Clinic at Inspire Medical", where: "Inspire Medical", rruleNote: "Thursdays", notes: "Lina taxi" },
    {
      id: "clinic-sun",
      title: "Clinic at Inspire Medical",
      where: "Inspire Medical",
      rruleNote: "Sundays",
      notes: "Lina taxi. Skip 29 Nov 2026 — Japan departure.",
      skipDates: ["2026-11-29"],
    },
    { id: "geneco-monthly", title: "Geneco electricity", rruleNote: "Monthly", kind: "bill" },
    { id: "simba-monthly", title: "Simba mobile", rruleNote: "Monthly", kind: "bill" },
  ],
  lists: [
    {
      id: "shopping",
      title: "Shopping list",
      shared: true,
      items: [
        { id: "s1", text: "Birthday candles and cake", done: false },
        { id: "s2", text: "Toddler snacks for the flight", done: false },
        { id: "s3", text: "Household restock before Japan", done: false },
      ],
    },
  ],
  anya: {
    born: "2025-11-27",
    sleep: {
      napsPerDay: 2,
      napNote: "Morning and afternoon",
      bedtime: "19:00",
      bedtimeNote: "About 7 pm, wind-down first",
    },
    milestones: [
      { id: "m1", text: "Sits steadily on her own", done: false },
      { id: "m2", text: "Crawls and cruises furniture", done: false },
      { id: "m3", text: "Pulls to stand", done: false },
      { id: "m4", text: "First clear words", done: false },
      { id: "m5", text: "Walking independently", done: false },
    ],
    vaccines: [
      { id: "v1", name: "MMR, 1st dose", status: "due", notes: "Per NCIS schedule, around 12 months" },
      { id: "v2", name: "PCV booster", status: "due", notes: "Per NCIS schedule, around 12 months" },
      { id: "v3", name: "Varicella", status: "due", notes: "Per NCIS schedule, around 12 months" },
    ],
    notes: "Milestone ticks are a starter checklist to edit in the app — not a clinical record.",
  },
  baby2: {
    due: "2027-05-10",
    prep: [
      { id: "p1", text: "Move crib to Bedroom 3", done: false },
      { id: "p2", text: "Anya's floor bed with guards, Bedroom 2", done: false },
      { id: "p3", text: "Set up the new nursery corner", done: false },
      { id: "p4", text: "Pack a hospital bag", done: false },
    ],
  },
  docs: [
    {
      id: "d-archive",
      title: "Life Archive",
      subtitle: "Index in Drive",
      url: "https://drive.google.com/drive/folders/1uyYPUYcuo660kKGcsuFerNRQJ8hAakF1",
    },
    {
      id: "d-archive-sheet",
      title: "Life Archive Index",
      subtitle: "Spreadsheet",
      url: "https://docs.google.com/spreadsheets/d/1nCBPVav25q-qCoDG38b6gfDgACcDBzz0WjX4I-skfhc/edit",
    },
    { id: "d-car", title: "Car", subtitle: "Insurance and road tax — add the Drive folder link", url: "" },
    { id: "d-insurance", title: "Insurance", subtitle: "Family cover — add the Drive folder link", url: "" },
    { id: "d-home", title: "Home", subtitle: "Loan and MCST — add the Drive folder link", url: "" },
  ],
};

if (typeof window !== "undefined") window.FAMILY_HUB_SEED = FAMILY_HUB_SEED;
if (typeof module !== "undefined") module.exports = FAMILY_HUB_SEED;
