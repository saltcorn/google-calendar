/**
 * Field definitions for the provider, and the mapping between a Google
 * Calendar resource and a flat Saltcorn row.
 */

/**
 * Columns exposed for the Events entity.
 *
 * `id` is the Google event id: stable for the life of the event, which is
 * what sync_table_from_external needs to match rows across runs. A recurring
 * event expanded into instances yields ids like "<base>_20260923T090000Z",
 * still stable per instance.
 */
const EVENT_FIELDS = [
  { name: "id", label: "ID", type: "String", primary_key: true },
  { name: "calendar_id", label: "Calendar", type: "String" },
  { name: "summary", label: "Title", type: "String" },
  { name: "description", label: "Description", type: "String" },
  { name: "location", label: "Location", type: "String" },
  { name: "start", label: "Start", type: "Date" },
  { name: "end", label: "End", type: "Date" },
  { name: "all_day", label: "All day", type: "Bool" },
  { name: "status", label: "Status", type: "String" },
  { name: "organizer_email", label: "Organizer", type: "String" },
  { name: "creator_email", label: "Creator", type: "String" },
  { name: "attendees", label: "Attendees", type: "String" },
  { name: "attendee_count", label: "Attendee count", type: "Integer" },
  { name: "recurring_event_id", label: "Recurring event ID", type: "String" },
  { name: "recurrence", label: "Recurrence", type: "String" },
  { name: "transparency", label: "Transparency", type: "String" },
  { name: "visibility", label: "Visibility", type: "String" },
  { name: "color_id", label: "Colour ID", type: "String" },
  { name: "meet_link", label: "Meet link", type: "String" },
  { name: "html_link", label: "Link", type: "String" },
  { name: "ical_uid", label: "iCal UID", type: "String" },
  { name: "created", label: "Created", type: "Date" },
  { name: "updated", label: "Updated", type: "Date" },
];

/** Columns exposed for the Calendars entity. */
const CALENDAR_FIELDS = [
  { name: "id", label: "ID", type: "String", primary_key: true },
  { name: "summary", label: "Name", type: "String" },
  { name: "description", label: "Description", type: "String" },
  { name: "location", label: "Location", type: "String" },
  { name: "time_zone", label: "Time zone", type: "String" },
  { name: "access_role", label: "Access role", type: "String" },
  { name: "primary", label: "Primary", type: "Bool" },
  { name: "selected", label: "Selected", type: "Bool" },
  { name: "background_color", label: "Background colour", type: "String" },
];

/**
 * Properties Google validates against a fixed set of values, where an empty
 * string is rejected rather than ignored. A blank form field means "leave this
 * alone", so these are omitted when empty instead of being sent as "".
 */
const ENUM_EVENT_FIELDS = ["status", "transparency", "visibility", "color_id"];

/** `YYYY-MM-DD` as UTC midnight, anything else by the usual parse. */
const toDate = (v) => (v ? new Date(v) : null);

/** The calendar day after a `YYYY-MM-DD`, as `YYYY-MM-DD`. */
const nextDay = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** A Date (or parseable string) as `YYYY-MM-DD` in UTC. */
const toDateOnly = (v) => {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

/**
 * Flatten a Google event resource into a row.
 *
 * All-day events carry `start.date`/`end.date` where the end is *exclusive*,
 * per the API. That is left as Google reports it: it is what FullCalendar
 * expects, and quietly shifting it by a day would make the row disagree with
 * the same event read through any other client.
 *
 * @param {object} ev - an event resource
 * @param {string} calendarId - the calendar it came from
 * @returns {object} a flat row matching EVENT_FIELDS
 */
const eventToRow = (ev, calendarId) => {
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const attendees = ev.attendees || [];
  return {
    id: ev.id,
    calendar_id: calendarId,
    summary: ev.summary || null,
    description: ev.description || null,
    location: ev.location || null,
    start: toDate(ev.start && (ev.start.dateTime || ev.start.date)),
    end: toDate(ev.end && (ev.end.dateTime || ev.end.date)),
    all_day: allDay,
    status: ev.status || null,
    organizer_email: (ev.organizer && ev.organizer.email) || null,
    creator_email: (ev.creator && ev.creator.email) || null,
    attendees: attendees.length
      ? attendees.map((a) => a.email).filter(Boolean).join(", ")
      : null,
    attendee_count: attendees.length,
    recurring_event_id: ev.recurringEventId || null,
    recurrence: (ev.recurrence || []).join("; ") || null,
    transparency: ev.transparency || null,
    visibility: ev.visibility || null,
    color_id: ev.colorId || null,
    meet_link: ev.hangoutLink || null,
    html_link: ev.htmlLink || null,
    ical_uid: ev.iCalUID || null,
    created: toDate(ev.created),
    updated: toDate(ev.updated),
  };
};

/**
 * Build the event resource for a write, from whichever row keys are present.
 *
 * Only keys actually supplied are included, so this doubles as the body for
 * a PATCH: a row carrying just `{summary}` moves the title and nothing else.
 *
 * @param {object} row - a row, possibly partial
 * @param {object} [existing] - the current row, for deciding all-day on a patch
 * @returns {object} an event resource
 */
const rowToEvent = (row, existing = {}) => {
  const ev = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(row, k);

  // Free text: an empty string is a legitimate value, and clears the property.
  if (has("summary")) ev.summary = row.summary;
  if (has("description")) ev.description = row.description;
  if (has("location")) ev.location = row.location;

  // Constrained sets: an empty string is not a value Google accepts.
  if (row.status) ev.status = row.status;
  if (row.transparency) ev.transparency = row.transparency;
  if (row.visibility) ev.visibility = row.visibility;
  if (row.color_id) ev.colorId = row.color_id;
  if (has("recurrence") && row.recurrence)
    ev.recurrence = String(row.recurrence)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

  // all_day decides the shape of start/end, so it is read from the patch when
  // given and from the stored row otherwise.
  const allDay = has("all_day") ? !!row.all_day : !!existing.all_day;
  const timeOrDate = (v) =>
    allDay
      ? { date: toDateOnly(v) }
      : { dateTime: (v instanceof Date ? v : new Date(v)).toISOString() };
  if (has("start") && row.start) ev.start = timeOrDate(row.start);
  if (has("end") && row.end) ev.end = timeOrDate(row.end);

  if (allDay && (ev.start || ev.end)) {
    // Google reads an all-day end as *exclusive*, so a one-day event ends on
    // the following day. A form that puts start and end on the same date means
    // one day, not none, and Google rejects a zero-length all-day event
    // outright. Multi-day spans are left as given, matching how eventToRow
    // reports them.
    const startDay =
      (ev.start && ev.start.date) ||
      (existing.start ? toDateOnly(existing.start) : null);
    const endDay =
      (ev.end && ev.end.date) ||
      (existing.end ? toDateOnly(existing.end) : null);
    if (startDay && endDay && endDay <= startDay)
      ev.end = { date: nextDay(startDay) };
  }

  if (has("attendees"))
    ev.attendees = String(row.attendees || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email }));

  return ev;
};

/**
 * Flatten a calendarList entry into a row.
 *
 * @param {object} cal - a calendarList resource
 * @returns {object} a flat row matching CALENDAR_FIELDS
 */
const calendarToRow = (cal) => ({
  id: cal.id,
  summary: cal.summaryOverride || cal.summary || null,
  description: cal.description || null,
  location: cal.location || null,
  time_zone: cal.timeZone || null,
  access_role: cal.accessRole || null,
  primary: !!cal.primary,
  selected: !!cal.selected,
  background_color: cal.backgroundColor || null,
});

module.exports = {
  EVENT_FIELDS,
  CALENDAR_FIELDS,
  ENUM_EVENT_FIELDS,
  eventToRow,
  rowToEvent,
  calendarToRow,
  toDateOnly,
};
