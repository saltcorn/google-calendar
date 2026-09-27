const test = require("node:test");
const assert = require("node:assert");
const {
  EVENT_FIELDS,
  eventToRow,
  rowToEvent,
  calendarToRow,
} = require("../lib/fields");

const timedEvent = {
  id: "ev1",
  status: "confirmed",
  summary: "Standup",
  htmlLink: "https://calendar.google.com/event?eid=1",
  created: "2026-09-01T08:00:00.000Z",
  updated: "2026-09-02T08:00:00.000Z",
  start: { dateTime: "2026-09-23T09:00:00+02:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-09-23T09:15:00+02:00", timeZone: "Europe/Berlin" },
  organizer: { email: "lead@example.com" },
  creator: { email: "lead@example.com" },
  attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  hangoutLink: "https://meet.google.com/abc",
  iCalUID: "ev1@google.com",
};

const allDayEvent = {
  id: "ev2",
  summary: "Company holiday",
  start: { date: "2026-12-25" },
  end: { date: "2026-12-26" },
};

test("exactly one primary key, and it is the Google event id", () => {
  const pks = EVENT_FIELDS.filter((f) => f.primary_key);
  assert.equal(pks.length, 1);
  assert.equal(pks[0].name, "id");
  assert.equal(pks[0].type, "String");
});

test("a timed event flattens to a row", () => {
  const row = eventToRow(timedEvent, "primary");
  assert.equal(row.id, "ev1");
  assert.equal(row.calendar_id, "primary");
  assert.equal(row.summary, "Standup");
  assert.equal(row.all_day, false);
  assert.equal(row.start.toISOString(), "2026-09-23T07:00:00.000Z");
  assert.equal(row.end.toISOString(), "2026-09-23T07:15:00.000Z");
  assert.equal(row.attendees, "a@example.com, b@example.com");
  assert.equal(row.attendee_count, 2);
  assert.equal(row.recurrence, "RRULE:FREQ=WEEKLY;BYDAY=MO");
  assert.equal(row.meet_link, "https://meet.google.com/abc");
  assert.ok(row.created instanceof Date);
});

test("an all-day event is flagged, and keeps Google's exclusive end", () => {
  const row = eventToRow(allDayEvent, "primary");
  assert.equal(row.all_day, true);
  assert.equal(row.start.toISOString(), "2026-12-25T00:00:00.000Z");
  assert.equal(row.end.toISOString(), "2026-12-26T00:00:00.000Z");
  assert.equal(row.attendee_count, 0);
  assert.equal(row.attendees, null);
});

test("missing optional properties become null, not undefined", () => {
  const row = eventToRow({ id: "bare" }, "primary");
  assert.equal(row.summary, null);
  assert.equal(row.location, null);
  assert.equal(row.start, null);
  assert.equal(row.all_day, false);
});

test("a write only sends the keys the row actually carries", () => {
  const body = rowToEvent({ summary: "New title" });
  assert.deepEqual(Object.keys(body), ["summary"]);
});

test("a timed write sends dateTime, an all-day write sends date", () => {
  const timed = rowToEvent({
    start: new Date("2026-09-23T09:00:00Z"),
    end: new Date("2026-09-23T10:00:00Z"),
  });
  assert.equal(timed.start.dateTime, "2026-09-23T09:00:00.000Z");
  assert.equal(timed.start.date, undefined);

  const allDay = rowToEvent({
    all_day: true,
    start: new Date("2026-12-25T00:00:00Z"),
    end: new Date("2026-12-26T00:00:00Z"),
  });
  assert.equal(allDay.start.date, "2026-12-25");
  assert.equal(allDay.start.dateTime, undefined);
});

test("a patch takes all-day from the stored row when it says nothing", () => {
  const existing = eventToRow(allDayEvent, "primary");
  const body = rowToEvent({ start: new Date("2026-12-28T00:00:00Z") }, existing);
  assert.equal(body.start.date, "2026-12-28");
});

test("attendees round-trip through the comma-separated column", () => {
  const row = eventToRow(timedEvent, "primary");
  const body = rowToEvent({ attendees: row.attendees });
  assert.deepEqual(body.attendees, [
    { email: "a@example.com" },
    { email: "b@example.com" },
  ]);
});

test("clearing attendees sends an empty list, not a dropped key", () => {
  const body = rowToEvent({ attendees: "" });
  assert.deepEqual(body.attendees, []);
});

test("a calendarList entry flattens, preferring the user's override name", () => {
  const row = calendarToRow({
    id: "c1",
    summary: "Shared room",
    summaryOverride: "Room A",
    accessRole: "writer",
    primary: true,
    timeZone: "Europe/Berlin",
  });
  assert.equal(row.summary, "Room A");
  assert.equal(row.access_role, "writer");
  assert.equal(row.primary, true);
  assert.equal(row.selected, false);
});

test("constrained properties are omitted when empty, not sent as ''", () => {
  const body = rowToEvent({
    summary: "x",
    status: "",
    transparency: "",
    visibility: "",
    color_id: "",
  });
  for (const k of ["status", "transparency", "visibility", "colorId"])
    assert.equal(k in body, false, `${k} must not be sent empty`);
});

test("constrained properties are still sent when set", () => {
  const body = rowToEvent({
    status: "tentative",
    transparency: "transparent",
    visibility: "private",
    color_id: "5",
  });
  assert.equal(body.status, "tentative");
  assert.equal(body.transparency, "transparent");
  assert.equal(body.visibility, "private");
  assert.equal(body.colorId, "5");
});

test("free text may be cleared with an empty string", () => {
  const body = rowToEvent({ description: "", location: "" });
  assert.equal(body.description, "");
  assert.equal(body.location, "");
});

test("a same-day all-day event ends on the following day", () => {
  // Google reads an all-day end as exclusive and rejects a zero-length event.
  const body = rowToEvent({
    all_day: true,
    start: new Date("2026-09-28T12:00:00Z"),
    end: new Date("2026-09-28T13:00:00Z"),
  });
  assert.equal(body.start.date, "2026-09-28");
  assert.equal(body.end.date, "2026-09-29");
});

test("a multi-day all-day span is left exactly as given", () => {
  const body = rowToEvent({
    all_day: true,
    start: new Date("2026-09-28T00:00:00Z"),
    end: new Date("2026-09-30T00:00:00Z"),
  });
  assert.equal(body.end.date, "2026-09-30");
});

test("the end of a month rolls over correctly", () => {
  const body = rowToEvent({
    all_day: true,
    start: new Date("2026-12-31T09:00:00Z"),
    end: new Date("2026-12-31T10:00:00Z"),
  });
  assert.equal(body.end.date, "2027-01-01");
});

test("a timed same-day event is untouched", () => {
  const body = rowToEvent({
    all_day: false,
    start: new Date("2026-09-28T12:00:00Z"),
    end: new Date("2026-09-28T13:00:00Z"),
  });
  assert.equal(body.end.dateTime, "2026-09-28T13:00:00.000Z");
});

test("patching only the end of a stored all-day event still lands after start", () => {
  const existing = eventToRow(
    { id: "e", start: { date: "2026-09-28" }, end: { date: "2026-09-29" } },
    "primary",
  );
  const body = rowToEvent({ end: new Date("2026-09-28T00:00:00Z") }, existing);
  assert.equal(body.end.date, "2026-09-29");
});

test("the row that produced the 400 now yields a body Google accepts", () => {
  const body = rowToEvent({
    summary: "SALTCORN EVENT",
    description: "This is an event created from ",
    location: "Kigali",
    start: new Date("2026-09-28T12:00:00Z"),
    end: new Date("2026-09-28T13:00:00Z"),
    all_day: true,
    status: "confirmed",
    attendees: "",
    recurrence: "",
    transparency: "",
    visibility: "",
    color_id: "5",
  });
  assert.deepEqual(body, {
    summary: "SALTCORN EVENT",
    description: "This is an event created from ",
    location: "Kigali",
    status: "confirmed",
    colorId: "5",
    start: { date: "2026-09-28" },
    end: { date: "2026-09-29" },
    attendees: [],
  });
});
