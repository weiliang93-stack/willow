# Loh Family Hub — handover

This note is for Muse (or any later assistant) editing the family hub.
The app is a normal phone page in this repo. It is not a mockup.

## What it is

Wei Liang and Zhen Ling's shared home screen: the week ahead, a simple
calendar, money, Anya, and baby #2 plus household document links.

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
- `logic.test.cjs` — checks the dates and the money rules.
  Run from the repo root: `node --test family-hub/logic.test.cjs`

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

The budget card is the personal monthly budget from `app = 'expenses'`:

- Budget: `state.monthlyBudget`. If it is null, the card says no budget
  is set. There is no stand-in figure.
- Spent: sum of `state.expenses` whose `date` falls in the current
  Singapore calendar month (`YYYY-MM`). This is the same sum as
  `monthlyTotalSpent()` in `expense-tracker/script.js`.
- Category bars: that same month's expenses, grouped by `category`.
  Width is relative to the largest category. There are no per-category
  budgets in the data, so the card does not invent them.

`expenses_automation.excludedExpenses` is not part of that bar. Shared
card spend (`type === "combined"`) is a footnote, with
`combinedMonthlyBudget` when that field is a number. It is labelled as
not included in the budget above.

Trip spend is its own card:

- Rows with `type === "trip"` on `excludedExpenses`.
- Any row on `expenses` that has `type === "trip"` or a `trip` label
  (in case one was logged on the personal list). A line says so when
  that happens, because those dollars are also inside the budget sum.
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

The footer says "Synced from Penny's expense app" and links to
https://weiliang93-stack.github.io/willow/money/ for editing.

## What not to touch

- Do not write `expenses`, `expenses_automation`, or any other app's row
  from this app or from a "helpful" SQL update.
- Do not add a cron job, an Edge Function, a secret, or a Google
  Calendar OAuth client. The free-tier function quota is already tight,
  and the calendar tab is deliberately just a link.
- Do not change Auth or Row Level Security in order to add Zhen Ling
  inside this piece of work. That is a later, separate change.
- `teleconsult-check-roster` reads the clinic roster. It is not a family
  calendar. Leave it alone.

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
- **Money has no figures.** He is signed out, the expense read failed, or
  this month really has no personal expenses. The copy on the card says
  which. Do not type sample numbers into the page.
- **Money looks smaller than "household" spend.** The main bar is the
  personal `expenses` budget, matching the expense app. Shared-card spend
  and trip spend are outside that bar on purpose.
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
