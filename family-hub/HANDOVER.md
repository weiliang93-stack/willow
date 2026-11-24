# Loh Family Hub — handover

This note is for Muse (or any later assistant) editing the family hub.
The app is a normal phone page in this repo. It is not a mockup.

## What it is

Wei Liang and Zhen Ling's shared home screen: the week ahead, a simple
calendar, money, the kids (Anya and Yuna), and baby #2 plus household
document links.

After this branch is merged to `main`, the live page is:

https://weiliang93-stack.github.io/willow/family-hub/

Sign in with the existing willow Supabase account (the same email and
password as the expense tracker and the other apps). Zhen Ling does not
have her own login yet. See the end of this note before adding her.

## Files

- `index.html` — page shell, sign-in slot, bottom tabs. CSS and JS use
  `?v=YYYYMMDD`. Bump that query on every change to `style.css` or any
  script, or a phone will keep the old file.
- `style.css` — layout. Warm linen page, Fraunces for titles, Outfit for
  the rest.
- `script.js` — screen rendering, sign-in boot, and saves.
- `logic.js` — dates, the week agenda, and the money maths. No network.
- `seed.js` — the starting hub document. Same object as the SQL below.
- `logic.test.cjs` — checks the dates, the money rules, and the kids
  migration. Run from the repo root: `node --test family-hub/logic.test.cjs`
- `supabase/functions/family-calendar/` — on-demand Family calendar
  read. `parse.ts` turns the iCal feed into events;
  `node --experimental-strip-types --test supabase/functions/family-calendar/parse.test.ts`
- `supabase/functions/sync-fixed-costs/` — daily one-way read of the
  TeoLoh Fixed Monthly Expense table into `familyhub.state.fixedCosts`,
  and of the Insurance tab into `familyhub.state.insurance`. Same run,
  two keys. `node --experimental-strip-types --test supabase/functions/sync-fixed-costs/parse.test.ts supabase/functions/sync-fixed-costs/insurance.test.ts`
- `shared/sync-fixed-costs.sql` — one-time `jsonb_set` helpers for those
  two keys. No cron and no secrets.

Shared code, unchanged by this app: `shared/supabase-config.js` and
`shared/supabase-sync.js`. The public anon key in the config file is
meant to be public. Row Level Security is what keeps each person's rows
private. Do not add a service-role key, an OAuth secret, or a `.env`.

## The data

One new `app_state` row, `app = 'familyhub'`. The `state` column is a
JSON document. The app does not write any other `app` value.

Shape, shortened:

```json
{
  "version": 1,
  "family": { "name": "Loh Family Hub", "members": [] },
  "trips": [{ "id": "japan-2026", "title": "Japan trip", "start": "2026-11-29", "end": "2026-12-11", "notes": "" }],
  "keyDates": [{ "id": "mcst-dec", "title": "MCST bill due", "date": "2026-12-01", "kind": "bill", "notes": "" }],
  "recurring": [{ "id": "clinic-sun", "title": "Clinic at Inspire Medical", "rruleNote": "Sundays", "skipDates": ["2026-11-29"] }],
  "lists": [{ "id": "shopping", "title": "Shopping list", "shared": true, "items": [{ "id": "s1", "text": "Birthday candles and cake", "done": false }] }],
  "anya": {
    "born": "2025-11-27",
    "sleep": { "napsPerDay": 2, "napNote": "Morning and afternoon", "bedtime": "19:00", "bedtimeNote": "About 7 pm, wind-down first" },
    "milestones": [{ "id": "m1", "text": "Sits steadily on her own", "done": false }],
    "vaccines": [{ "id": "v1", "name": "MMR, 1st dose", "status": "due", "notes": "Per NCIS schedule, around 12 months" }],
    "notes": "Milestone ticks are a starter checklist, not a clinical record."
  },
  "kids": [
    { "id": "anya", "name": "Anya", "bornDate": "2025-11-27", "milestones": [], "vaccines": [], "notes": "", "prep": [] },
    { "id": "yuna", "name": "Yuna", "dueDate": "2027-05-10", "bornDate": null, "prep": [] }
  ],
  "baby2": { "due": "2027-05-10", "prep": [{ "id": "p1", "text": "Move crib to Bedroom 3", "done": false }] },
  "docs": [{ "id": "d-car", "title": "Car", "subtitle": "Add the Drive folder link", "url": "" }]
}
```

Dates are `YYYY-MM-DD`. "Today" is always the Asia/Singapore calendar
day, including near midnight. Do not use UTC or the phone's zone.

Do not store policy numbers, account numbers, NRICs, card numbers,
booking codes, or unit addresses in this document. The Car, Insurance,
and Home links start blank so Wei Liang can paste a Drive folder URL
in the app. Life Archive already has its folder and index-sheet URLs.

Milestones start unticked. They are a checklist, not a clinical record.

### Kids

The bottom tab is labelled Kids. A switch at the top chooses Anya or
Yuna, and the last choice is remembered on the phone
(`familyhub.activeChild`).

`state.kids` is the list of children. On load, if Anya is missing from
that list, she is copied from the older `state.anya` object (`born`
becomes `bornDate`, and sleep, milestones, vaccines, and notes come
across). Those arrays stay shared with `state.anya`, so an older reader
still sees her. Nothing already stored on a child is overwritten.
Yuna is added if she is missing: due 10 May 2027, `bornDate` null, and
`prep` empty. Her prep list is not the Docs "baby #2" list. Do not
invent prep items for her.

While `bornDate` is null she shows a due-date countdown, antenatal
appointments, and that prep checklist (add, tick, edit, delete). An
appointment is hers when a key date has `child` or `person` set to
`yuna` or `Yuna`, or when a Family calendar event title contains her
name. Untagged dates stay where they are. Set a birth date and she gets
the same cards as Anya: age, birthday, childcare, milestones, vaccines,
sleep, and notes. Childcare still reads `state.childcare` for Anya.
Another child uses `kid.childcare` only, so Yuna does not inherit
Anya's centre.

The seed file stays on the older `anya` shape. The migration runs in
the page, so a phone that already has data does not lose it, and the
repo does not gain a second copy of her lists.

The Sunday clinic item has `skipDates: ["2026-11-29"]` because that
Sunday is the Japan departure. The words in `notes` say the same thing.
Add another date to `skipDates` if a later Sunday should be skipped too.

### First save

On the first signed-in open, the app reads `familyhub`. If the row is
there, it uses it and does not re-seed. If the read fails, it does not
guess: edits pause rather than overwrite a row it could not see. Only
when a direct read confirms there is no `familyhub` row does it write
`seed.js` once.

You can also insert that seed yourself. Replace `USER_ID_HERE` with
Wei Liang's Supabase user id (the `WILLOW_USER_ID` secret). This insert
does nothing if the row already exists. The JSON is `seed.js`.

```sql
insert into app_state (user_id, app, state, updated_at)
select 'USER_ID_HERE', 'familyhub', $hub$
{
  "version": 1,
  "family": {
    "name": "Loh Family Hub",
    "members": [
      {
        "id": "wl",
        "name": "Wei Liang",
        "short": "WL"
      },
      {
        "id": "zl",
        "name": "Zhen Ling",
        "short": "ZL"
      },
      {
        "id": "anya",
        "name": "Anya",
        "short": "A",
        "born": "2025-11-27"
      }
    ]
  },
  "trips": [
    {
      "id": "japan-2026",
      "title": "Japan trip",
      "start": "2026-11-29",
      "end": "2026-12-11",
      "notes": "Leaves Sunday 29 Nov, back Friday 11 Dec."
    },
    {
      "id": "korea-2027",
      "title": "Korea trip",
      "start": "2027-02-26",
      "end": "2027-03-04",
      "notes": "Zhen Ling will be about 7 months along."
    }
  ],
  "keyDates": [
    {
      "id": "car-cover-check",
      "title": "Confirm car insurance and road tax were renewed",
      "date": "2026-10-27",
      "kind": "task",
      "notes": "Cover period ended 27 Oct 2026. Confirm renewal — do not store plate, policy or account numbers here."
    },
    {
      "id": "anya-birthday-1",
      "title": "Anya's 1st birthday",
      "date": "2026-11-27",
      "kind": "birthday"
    },
    {
      "id": "geneco-switch",
      "title": "Geneco electricity switch takes effect",
      "date": "2026-11-27",
      "kind": "home"
    },
    {
      "id": "mcst-dec",
      "title": "MCST bill due",
      "date": "2026-12-01",
      "kind": "bill",
      "notes": "Approximate due date for the Nov–Jan quarter."
    },
    {
      "id": "empress-renew",
      "title": "Empress Family Feast auto-renew (approx.)",
      "date": "2026-12-06",
      "kind": "subscription"
    },
    {
      "id": "icloud-renew",
      "title": "iCloud+ renews",
      "date": "2026-12-07",
      "kind": "subscription"
    },
    {
      "id": "grok-renew",
      "title": "Grok Bot Premium renews — cancel before if unused",
      "date": "2026-12-13",
      "kind": "subscription"
    },
    {
      "id": "instarem-useby",
      "title": "Instarem amaze card — use by, to stay active",
      "date": "2026-12-14",
      "kind": "task"
    },
    {
      "id": "anya-cancer-renew",
      "title": "Anya's Singlife Cancer Cover Plus II renewal",
      "date": "2026-12-24",
      "kind": "renewal",
      "notes": "Paid by cash, so it will not auto-deduct."
    },
    {
      "id": "anya-shield-renew",
      "title": "Anya's Singlife Shield + Health Plus renewal",
      "date": "2026-12-29",
      "kind": "renewal"
    },
    {
      "id": "baby2-due",
      "title": "Baby #2 due",
      "date": "2027-05-10",
      "kind": "family"
    },
    {
      "id": "bcls-expiry",
      "title": "BCLS+AED certification expires",
      "date": "2027-08-09",
      "kind": "professional"
    },
    {
      "id": "smc-pc-expiry",
      "title": "SMC Practising Certificate expires",
      "date": "2027-12-31",
      "kind": "professional"
    },
    {
      "id": "anya-passport",
      "title": "Anya's passport expires",
      "date": "2031-01-26",
      "kind": "document"
    },
    {
      "id": "wl-passport",
      "title": "Wei Liang's passport expires",
      "date": "2033-06-14",
      "kind": "document"
    },
    {
      "id": "coe-expiry",
      "title": "Car COE expires",
      "date": "2034-10-27",
      "kind": "car"
    }
  ],
  "recurring": [
    {
      "id": "childcare-dropoff",
      "title": "Childcare drop-off",
      "where": "Skool4Kidz",
      "rruleNote": "Weekday mornings (typical school day)"
    },
    {
      "id": "clinic-thu",
      "title": "Clinic at Inspire Medical",
      "where": "Inspire Medical",
      "rruleNote": "Thursdays",
      "notes": "Lina taxi"
    },
    {
      "id": "clinic-sun",
      "title": "Clinic at Inspire Medical",
      "where": "Inspire Medical",
      "rruleNote": "Sundays",
      "notes": "Lina taxi. Skip 29 Nov 2026 — Japan departure.",
      "skipDates": [
        "2026-11-29"
      ]
    },
    {
      "id": "geneco-monthly",
      "title": "Geneco electricity",
      "rruleNote": "Monthly",
      "kind": "bill"
    },
    {
      "id": "simba-monthly",
      "title": "Simba mobile",
      "rruleNote": "Monthly",
      "kind": "bill"
    }
  ],
  "lists": [
    {
      "id": "shopping",
      "title": "Shopping list",
      "shared": true,
      "items": [
        {
          "id": "s1",
          "text": "Birthday candles and cake",
          "done": false
        },
        {
          "id": "s2",
          "text": "Toddler snacks for the flight",
          "done": false
        },
        {
          "id": "s3",
          "text": "Household restock before Japan",
          "done": false
        }
      ]
    }
  ],
  "anya": {
    "born": "2025-11-27",
    "sleep": {
      "napsPerDay": 2,
      "napNote": "Morning and afternoon",
      "bedtime": "19:00",
      "bedtimeNote": "About 7 pm, wind-down first"
    },
    "milestones": [
      {
        "id": "m1",
        "text": "Sits steadily on her own",
        "done": false
      },
      {
        "id": "m2",
        "text": "Crawls and cruises furniture",
        "done": false
      },
      {
        "id": "m3",
        "text": "Pulls to stand",
        "done": false
      },
      {
        "id": "m4",
        "text": "First clear words",
        "done": false
      },
      {
        "id": "m5",
        "text": "Walking independently",
        "done": false
      }
    ],
    "vaccines": [
      {
        "id": "v1",
        "name": "MMR, 1st dose",
        "status": "due",
        "notes": "Per NCIS schedule, around 12 months"
      },
      {
        "id": "v2",
        "name": "PCV booster",
        "status": "due",
        "notes": "Per NCIS schedule, around 12 months"
      },
      {
        "id": "v3",
        "name": "Varicella",
        "status": "due",
        "notes": "Per NCIS schedule, around 12 months"
      }
    ],
    "notes": "Milestone ticks are a starter checklist to edit in the app — not a clinical record."
  },
  "baby2": {
    "due": "2027-05-10",
    "prep": [
      {
        "id": "p1",
        "text": "Move crib to Bedroom 3",
        "done": false
      },
      {
        "id": "p2",
        "text": "Anya's floor bed with guards, Bedroom 2",
        "done": false
      },
      {
        "id": "p3",
        "text": "Set up the new nursery corner",
        "done": false
      },
      {
        "id": "p4",
        "text": "Pack a hospital bag",
        "done": false
      }
    ]
  },
  "docs": [
    {
      "id": "d-archive",
      "title": "Life Archive",
      "subtitle": "Index in Drive",
      "url": "https://drive.google.com/drive/folders/1uyYPUYcuo660kKGcsuFerNRQJ8hAakF1"
    },
    {
      "id": "d-archive-sheet",
      "title": "Life Archive Index",
      "subtitle": "Spreadsheet",
      "url": "https://docs.google.com/spreadsheets/d/1nCBPVav25q-qCoDG38b6gfDgACcDBzz0WjX4I-skfhc/edit"
    },
    {
      "id": "d-car",
      "title": "Car",
      "subtitle": "Insurance and road tax — add the Drive folder link",
      "url": ""
    },
    {
      "id": "d-insurance",
      "title": "Insurance",
      "subtitle": "Family cover — add the Drive folder link",
      "url": ""
    },
    {
      "id": "d-home",
      "title": "Home",
      "subtitle": "Loan and MCST — add the Drive folder link",
      "url": ""
    }
  ]
}
$hub$::jsonb, now()
where not exists (
  select 1 from app_state
  where user_id = 'USER_ID_HERE' and app = 'familyhub'
);
```

That JSON is the object in `seed.js`. If you change the seed, change this statement too.

## Editing

### In the app

- Shopping, milestones, and the baby prep list: tick the box. Tap the
  pencil to rename or delete. Type in the box underneath and press Add.
- Vaccinations: the icon marks done or due. The pencil edits the name
  and the note. Add is the + on the heading. Notes stay labelled as the
  NCIS schedule.
- Anya's note and the sleep tiles: tap the note, or Edit on Sleep.
- Key dates: tap the row. Add is the + on Key dates (Home, Calendar, or
  Money). Kinds include bill, renewal, subscription, birthday, home,
  family, task, professional, document, car, and trip.
- Documents: a card with a link opens it. The pencil edits the title,
  subtitle, and URL. Only `http` and `https` links are opened. An empty
  URL asks you to add one.
- Calendar has week arrows and a link to https://calendar.google.com.
  There is no Google Calendar login in this app. The week list is the
  hub's own trips, key dates, and recurring items.

Every save reads `familyhub` again, applies that one change to the fresh
copy, then writes it back with `pushStateNow`. A tab left open does not
push a stale copy over an edit made on the other phone.

### In SQL

Prefer the app. If you use SQL:

1. `select state, updated_at from app_state where app = 'familyhub' and user_id = 'USER_ID_HERE';`
2. Change only paths inside that JSON.
3. Set `updated_at` to `now()` in the same update.
4. Do not `insert` or `update` a row whose `app` is anything other than
   `familyhub`. In particular, do not touch `expenses` or
   `expenses_automation`.

Example: mark shopping item `s1` done, without depending on array order.

```sql
update app_state
set state = jsonb_set(
      state,
      '{lists}',
      (
        select jsonb_agg(
          case
            when list->>'id' <> 'shopping' then list
            else jsonb_set(
              list,
              '{items}',
              (
                select jsonb_agg(
                  case
                    when item->>'id' <> 's1' then item
                    else jsonb_set(item, '{done}', 'true'::jsonb, false)
                  end
                )
                from jsonb_array_elements(list->'items') item
              ),
              false
            )
          end
        )
        from jsonb_array_elements(state->'lists') list
      ),
      false
    ),
    updated_at = now()
where app = 'familyhub'
  and user_id = 'USER_ID_HERE';
```

If the phone has the hub open, its next edit pulls this version first
and then applies the tap. Close the page first if you need the SQL to
be the last write with no further taps.

`jsonb_set` on a guessed index such as `{lists,0,items,0,done}` is easy
to aim at the wrong item. Look up the id, as above.

## How Money gets its numbers

Money never writes. It only reads.

The variable-spend card is labelled **Variable household spend**. It is
the combined household month, the same numbers as expense-tracker's
Combined tab plus the household budget figure `sheet-budget-sync`
stores. Open the Household Expenses sheet from the card:
https://docs.google.com/spreadsheets/d/13JBXgENPoin92lAHq7BAHTcvV2YMqEY9a-_wtywoLY0/edit
Its Summary tab shows Household Budget (Monthly) and Spent This Month.
The hub still computes those live rather than typing them in:

- Spent: sum of `expenses_automation.excludedExpenses` whose `type` is
  `"combined"` and whose `date` falls in the current Singapore calendar
  month (`YYYY-MM`). That is the Combined tab's "this month" total
  (`renderCombinedExpenseList`). Personal `expenses`, `type: "fixed"`,
  `type: "wife_personal"`, and `type: "trip"` are not in this sum.
  `expenses.monthlyBudget` is not shown.
- Budget: `expenses_automation.combinedMonthlyBudget`. That field is
  filled from Household Expenses sheet Summary!B1. If it is null or
  missing, the card says no combined budget is set and still shows the
  spent figure. It does not copy the personal budget across and it does
  not estimate one.
- Category bars: those same combined rows, grouped by `category`. Width
  is relative to the largest category. There are no per-category
  budgets, so the card does not invent them.
- If the automation row cannot be read, the card says so. It does not
  show S$0 as if that were a real month.

Trip spend is its own card, still outside the household total:

- Rows with `type === "trip"` on `excludedExpenses`.
- Any row on `expenses` that has `type === "trip"` or a `trip` label
  (in case one was logged on the personal list). A line says so. Those
  dollars are not part of the household budget above.
- The current trip is the hub trip that has not ended and starts within
  45 days (Japan, while that trip is close).
- `expenses_automation.tripRules` has `{ from, to, label }`. The rule
  whose dates overlap the hub trip supplies the label (for Japan,
  `Japan Dec 2026`). Every trip row with that `trip` label is included,
  including deposits paid before departure. Trip-type rows whose `date`
  falls inside the hub trip are included too.
- The card states which window it used. Other trip labels (Korea,
  Shanghai, and so on) are listed underneath and are not added into the
  Japan total.
- If there are no trip-type rows at all, the card says
  "No trip-type entries found in expenses_automation." If the label
  window is empty, it says no trip-type entries were found for that
  window. It does not estimate a trip budget or a "set aside" amount.
  There is no such field.

Bills and renewals are hub key dates of kind `bill`, `renewal`, or
`subscription` in the next 70 days, plus monthly recurring items of kind
`bill` (Geneco, Simba) when a dated row does not already cover that
name. An amount is shown only when a charge in `expenses` or
`excludedExpenses` has that brand in its note or category: mcst, geneco,
simba, grok, icloud, empress, singlife, instarem, amaze. The amount is
the latest matching charge, with the date it was charged. Rows with
`type === "trip"` are ignored for this match, so a trip-tagged Singlife
charge is not shown as Anya's renewal premium. If nothing matches, the
row has a name and a date and no amount.

The footer says "Figures synced from the household expense log" and
links to https://weiliang93-stack.github.io/willow/money/ to edit the
variable spend. Do not put a person's or a bot's name on that line.

### Fixed monthly costs

These are not computed. They live on the `familyhub` row as
`state.fixedCosts`, copied from TeoLoh Financial Planning, tab
Saving/Spending, table Fixed Monthly Expense. The card links to
https://docs.google.com/spreadsheets/d/1JboHp21d8kCjBpLLxrCV0Q1Ok5hgbrSLYlxK3yb4tkY/edit

```json
{
  "source": "TeoLoh Financial Planning",
  "asOf": "2026-01-15",
  "items": [
    { "name": "Example rent", "amount": 1, "note": "fake" },
    { "name": "Example levy", "amount": 2 }
  ],
  "total": 3,
  "monthlyContribution": 4,
  "householdFixedCosts": 5,
  "variableAllocations": { "Example groceries": 6 }
}
```

`variableAllocations` may be a number or an object of name to amount.
If `fixedCosts` is missing, the card says "Fixed costs not loaded yet"
and still shows the sheet link. The seed does not include this object.
Do not commit real amounts.

The sheet is the master. The card is read-only. It shows
"Synced from sheet" plus the `asOf` date (Asia/Singapore). There is no
pencil and no "Add an item". A save from an old copy of the page cannot
rewrite the list: the editor ignores `fixedItem`, and the page no longer
recomputes `total` as the sum of the rows. `total` stays the Total cell
from the sheet, even when that cell is a cent off the item sum.

`sync-fixed-costs` reads tab Saving/Spending
(`valueRenderOption=UNFORMATTED_VALUE`), finds the Fixed Monthly Expense
header wherever it sits in the grid, and copies the name and amount rows
until Total. It then reads Monthly contribution, Household fixed costs,
and Variable allocations. Buffer is skipped. If any of those three
summaries or Total is missing, the run fails and writes nothing. It
updates only `state.fixedCosts` on `app = 'familyhub'` for
`WILLOW_USER_ID`, via `set_familyhub_fixed_costs` in
`shared/sync-fixed-costs.sql` (`jsonb_set` on `{fixedCosts}`, and it
bumps `updated_at`). The same run then updates `state.insurance` through
`set_familyhub_insurance`. It does not write to Google and it does not
touch any other table or any other key. If one of the two parses fails,
the other is still written, and the call returns an error.

Apply that SQL once in the SQL editor before the first run. Then schedule
the function the same way as the other sheet jobs: `POST` to
`/functions/v1/sync-fixed-costs` with the existing webhook header, cron
`0 21 * * *` UTC (about 05:00 Asia/Singapore). Add that cron in the
dashboard or the SQL editor. Do not commit the statement or the secret.
Deploy with `verify_jwt` off, same as the other sheet crons. This note
does not deploy it.

Replace the whole object (fake numbers only):

```sql
update app_state
set state = jsonb_set(
      state,
      '{fixedCosts}',
      '{
        "source": "TeoLoh Financial Planning",
        "asOf": "2026-01-15",
        "items": [
          {"name": "Example rent", "amount": 1, "note": "fake"},
          {"name": "Example levy", "amount": 2}
        ],
        "total": 3,
        "monthlyContribution": 4,
        "householdFixedCosts": 5,
        "variableAllocations": {"Example groceries": 6}
      }'::jsonb,
      true
    ),
    updated_at = now()
where app = 'familyhub'
  and user_id = 'USER_ID_HERE';
```

Read the row first. Change the path and the numbers to the real snapshot
only in the database, not in git.

### Insurance

Also on the Money tab. The sheet is the master. The same daily
`sync-fixed-costs` run reads the Insurance tab and writes
`state.insurance` through `set_familyhub_insurance`. The card is
read-only. It shows "Synced from sheet" plus the `asOf` date. There is
no pencil and no "Add a cover". "Show cancelled" stays. Renewals in the
next 60 days still feed Home and Calendar. No policy numbers, in the
app or in this file.

The live tab is one block per person (Wei Liang, Zhen Ling, Anya).
Under each name the header is Type, Cover, Monthly, Yearly, Bought
date, Policy No, Remarks, Verified. Then LIFE, HEALTH, and EXTRAS
bands. The parser finds those columns by their labels. Policy No is
dropped, including a policy token written in brackets in the name.
Remarks are not stored. They are read only for an explicit next-due
date, the word cancelled, a payment label (MediSave, CPF, GIRO, AMEX,
Cash, Card), and, when both Monthly and Yearly are filled, which of
those two cells is the one being paid. A date marked with a tilde stays
null. A blank next due stays null. The run does not multiply a monthly
figure to make a yearly one. If both amounts are filled and the remarks
do not say which is paid, the insurance half of the run fails and
writes nothing.

```json
{
  "asOf": "2026-01-01",
  "policies": [
    {
      "person": "Wei Liang",
      "category": "Life",
      "name": "Example life",
      "cover": "Sample sum",
      "premium": 2,
      "frequency": "monthly",
      "payment": "Card",
      "nextDue": "2026-11-30",
      "status": "active"
    }
  ]
}
```

`person` is Wei Liang, Zhen Ling, Anya, or Yuna. `category` is Life, Health,
or Extras. `frequency` is monthly or yearly. `status` is active or
cancelled. `nextDue` is `YYYY-MM-DD` or null. `cover` is the Cover cell,
not a policy number. `premium` is the Monthly or Yearly cell that the
sheet says is being paid.

The card groups active policies by person and hides cancelled ones
until "Show cancelled". "Renewals in next 60 days" lists active
policies with a `nextDue` in that window, soonest first. If `insurance`
is missing, the card says "Insurance not loaded yet".

Re-apply `shared/sync-fixed-costs.sql` once so `set_familyhub_insurance`
exists, then redeploy `sync-fixed-costs` with `verify_jwt` off. The cron
already pointed at that function does not need a second schedule. The
SQL file has no secret.

### Condo, car, childcare, net worth, annual dates, folder links

These also live only on the `familyhub` row. The seed does not include them. If a block is missing, the card says it is not loaded yet. Do not commit real amounts, unit numbers, plate numbers, or policy numbers. The examples below are fake.

Condo card on Home, `state.home`:

```json
{
  "mcst": {
    "agent": "Example agent",
    "mcstNo": "0000",
    "quarterlyTotal": 9,
    "breakdown": { "management": 4, "sinking": 4, "gst": 1 },
    "currentPeriod": { "start": "2026-11-01", "end": "2027-01-31" },
    "nextDue": "2026-12-03",
    "folderUrl": "https://drive.google.com/drive/folders/example-home"
  },
  "warranties": [
    { "item": "Example fridge", "until": null, "note": "Show this note" }
  ],
  "facts": [{ "label": "Example floor", "value": "Sample" }]
}
```

`nextDue` is added to key dates. Warranties with `until` in the past are hidden. `until: null` shows the note.

Car card on Docs. There are no plate, chassis, or policy-number fields. If `roadTax.end` or `insurance.end` is before today, the card shows "Renewal not on file — check". `coeExpiry`, `roadTax.end`, and `insurance.end` join key dates when they are still ahead.

```json
{
  "model": "Example hatch",
  "registered": "2020-01-01",
  "owner": "Example owner",
  "coeExpiry": "2027-02-01",
  "loan": { "lender": "Example bank", "monthly": 7, "method": "GIRO" },
  "roadTax": { "amount": 8, "start": "2025-10-01", "end": "2026-10-01" },
  "insurance": { "insurer": "Example insurer", "premium": 5, "start": "2026-03-01", "end": "2027-03-01", "ncd": "10%" },
  "folderUrl": "https://drive.google.com/drive/folders/example-car"
}
```

Anya's childcare, `state.childcare`. Upcoming closures join key dates.

```json
{
  "centre": "Example centre",
  "className": "Sample class",
  "monthlyFee": 3,
  "closures": [{ "date": "2026-12-04", "reason": "Example holiday" }],
  "folderUrl": "https://drive.google.com/drive/folders/example-care"
}
```

Household net worth on Money, `state.netWorth`. The link text is "Open Household Ledger Data".

```json
{
  "asOf": "2026-01-15",
  "total": 10,
  "byPerson": [{ "name": "Example person", "amount": 10 }],
  "sourceUrl": "https://docs.google.com/spreadsheets/d/example"
}
```

Annual dates, `state.annualDates`: `{ "label", "month", "day", "sinceYear" }`. The hub shows the next occurrence on or after today, and not before `sinceYear`.

```json
[{ "label": "Example anniversary", "month": 1, "day": 2, "sinceYear": 2020 }]
```

Docs folder list, `state.docLinks`: `{ "group", "label", "url" }`. Links only. No previews.

```json
[{ "group": "Home", "label": "Example folder", "url": "https://drive.google.com/drive/folders/example" }]
```

One fake write for the condo block. Repeat the same shape for the other keys (`car`, `childcare`, `netWorth`, `annualDates`, `docLinks`), and read the row first.

```sql
update app_state
set state = jsonb_set(
      state,
      '{home}',
      '{
        "mcst": {
          "agent": "Example agent",
          "mcstNo": "0000",
          "quarterlyTotal": 9,
          "breakdown": {"management": 4, "sinking": 4, "gst": 1},
          "currentPeriod": {"start": "2026-11-01", "end": "2027-01-31"},
          "nextDue": "2026-12-03",
          "folderUrl": "https://drive.google.com/drive/folders/example-home"
        },
        "warranties": [{"item": "Example fridge", "until": null, "note": "Show this note"}],
        "facts": [{"label": "Example floor", "value": "Sample"}]
      }'::jsonb,
      true
    ),
    updated_at = now()
where app = 'familyhub'
  and user_id = 'USER_ID_HERE';
```

## What not to touch

- Do not write `expenses`, `expenses_automation`, or any other app's row
  from this app or from a "helpful" SQL update.
- Do not commit a cron statement or a webhook secret. `family-calendar`
  runs only when the app asks, and its iCal secret stays in Supabase.
  `sync-fixed-costs` is the scheduled reader for the fixed-cost card and
  the insurance card. Its cron is created by hand, not in git. Do not add a Google
  Calendar OAuth client.
- Do not change Auth or Row Level Security in order to add Zhen Ling
  inside this piece of work. That is a later, separate change.
- `teleconsult-check-roster` reads the clinic roster. It is not the
  Family calendar. Leave it alone.

## Family calendar

Home and Calendar show hub items (childcare, clinic, trips, key dates)
and, when connected, events from the Google calendar named Family.

The browser never sees the calendar address. It calls the Edge Function
`family-calendar` with the signed-in session. The function reads the
secret `FAMILY_CAL_ICS_URL`, fetches that iCal feed, and returns the
next 14 days in Asia/Singapore. Hub items stay. Family events are extra
rows tagged Family.

Until the secret is set, the page says "Family calendar not connected
yet." The "Open Google Calendar" link stays.

### What to do by hand

1. On the phone or computer, open Google Calendar → Settings → the
   calendar named **Family** (not the main account calendar, and not
   the clinic calendar).
2. Under **Integrate calendar**, copy **Secret address in iCal format**.
   It looks like `https://calendar.google.com/calendar/ical/.../basic.ics`.
   Treat it like a password. Anyone with it can read that calendar.
   Do not paste it into git, this file, or a chat.
3. The function is already deployed with `verify_jwt` on. If you ever
   need to deploy it again:

   ```bash
   supabase functions deploy family-calendar --project-ref fozipnpmmjmmlthkdplf
   ```

   Leave `verify_jwt` on. The function also checks the caller is
   `WILLOW_USER_ID`, which is already set for the other functions.
4. In the Supabase dashboard, Edge Functions → Secrets, add
   `FAMILY_CAL_ICS_URL` with that secret address. There is no MCP or
   repo path for secrets. Do not put it in `.env` in this repo.
5. Open the hub, signed in, and pull to refresh. Family events for the
   next 14 days should appear on Home and Calendar. Moving further than
   that in the calendar asks for the next 14 days.

The feed URL must be `https://calendar.google.com/...`. The function
refuses anything else and does not echo the address back.

## Deploy

GitHub Pages publishes on push to `main` (`.github/workflows/deploy-pages.yml`).
Merge the pull request. Do not commit straight to `main`.

After the workflow is green, open the live URL on the phone while signed
in. If the phone shows an old page, the `?v=` on the stylesheet and
scripts in `index.html` was not bumped. Bump it to today's date and merge
again.

## Troubleshooting

- **Sign-in card.** Expected until he signs in. Use the existing willow
  account. Sign up would create a different empty user; don't.
- **Edits are paused.** The app could not read `familyhub` and refused
  to write the seed over a row it might have missed. Reload on a working
  connection. If it keeps happening, read the row in SQL before doing
  anything else.
- **Money has no figures.** He is signed out, the automation row could
  not be read, or this month has no combined expenses. If the card says
  no combined budget is set, `combinedMonthlyBudget` is null. Do not
  type sample numbers into the page, and do not substitute
  `monthlyBudget`.
- **Family calendar not connected yet.** The function is not deployed,
  or `FAMILY_CAL_ICS_URL` is not set. Hub items still show. Follow the
  steps above. "Couldn't reach the Family calendar" means the fetch
  failed after the secret was set.
- **A SQL edit vanished.** An open phone saved afterwards. It does pull
  first, so this only happens if that save started from an older read.
  Edit again, or edit in the app.
- **RLS.** A signed-in user only sees their own `app_state` rows. A second
  account would see no hub and the app would seed a separate row for
  them. That is why Zhen Ling should not get a new user until the policy
  below is actually built.

## Adding Zhen Ling later

Not part of the current app. Two options when you do it:

1. She uses the existing login. One row, no database change. Simplest.
   Share the password only if you are both comfortable with that.
2. Give her a second Supabase Auth user, then change the `app_state`
   policy so both user ids can read and write the same `familyhub` row
   (a small allow-list, or a shared family id). Do that for `familyhub`
   only, and decide separately whether she should also see `expenses`.
   Test with both accounts before relying on it. Until that policy
   exists, a second user gets a blank hub of her own.

Either way, do not put her NRIC or policy numbers into the hub.
