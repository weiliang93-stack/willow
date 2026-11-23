import assert from "node:assert/strict";
import test from "node:test";
import { parseIcs } from "./parse.ts";

const FROM = "2026-11-23";

test("UTC times land on the Singapore day", () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:late
DTSTART:20261122T180000Z
DTEND:20261122T190000Z
SUMMARY:Late flight
END:VEVENT
BEGIN:VEVENT
UID:morning
DTSTART:20261123T010000Z
SUMMARY:Morning call
END:VEVENT
END:VCALENDAR`;
  const events = parseIcs(ics, FROM, 14);
  assert.deepEqual(
    events.map((event) => [event.title, event.date, event.start]),
    [
      ["Late flight", "2026-11-23", "02:00"],
      ["Morning call", "2026-11-23", "09:00"],
    ],
  );
});

test("all-day, weekly, exdate, cancelled, and folded lines", () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:swim
DTSTART;TZID=Asia/Singapore:20261102T160000
DTEND;TZID=Asia/Singapore:20261102T170000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=Asia/Singapore:20261125T160000
SUMMARY:Swimming
END:VEVENT
BEGIN:VEVENT
UID:party
DTSTART;VALUE=DATE:20261127
SUMMARY:Anya's party
END:VEVENT
BEGIN:VEVENT
UID:gone
DTSTART;VALUE=DATE:20261124
STATUS:CANCELLED
SUMMARY:Cancelled picnic
END:VEVENT
BEGIN:VEVENT
UID:fold
DTSTART;VALUE=DATE:20261126
SUMMARY:Family 
 dinner
END:VEVENT
END:VCALENDAR`;
  const events = parseIcs(ics, FROM, 14);
  const titles = events.map((event) => `${event.date} ${event.title} ${event.allDay ? "all" : event.start}`);
  assert.deepEqual(titles, [
    "2026-11-23 Swimming 16:00",
    "2026-11-26 Family dinner all",
    "2026-11-27 Anya's party all",
    "2026-11-30 Swimming 16:00",
    "2026-12-02 Swimming 16:00",
  ]);
});

test("events outside the window are left out", () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:far
DTSTART;VALUE=DATE:20261220
SUMMARY:Too far
END:VEVENT
END:VCALENDAR`;
  assert.deepEqual(parseIcs(ics, FROM, 14), []);
});
