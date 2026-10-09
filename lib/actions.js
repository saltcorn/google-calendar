const {
  get_async_expression_function,
} = require("@saltcorn/data/models/expression");
const api = require("./api");
const { rowToEvent, eventToRow } = require("./fields");

const enc = encodeURIComponent;
const NAMESPACE = "Google Calendar";

/**
 * Evaluate one of the action's JavaScript expressions against the row.
 *
 * Uses the same evaluator as the built-in row actions, so the bindings a user
 * already knows - the row's own fields, `user`, `$`-prefixed state - all work.
 *
 * @param {string} expr - the expression source
 * @param {object} ctx - { row, table, user }
 * @returns {Promise<*>} whatever the expression evaluates to
 */
const evalExpr = async (expr, { row, table, user }) => {
  if (!expr) return undefined;
  const fields =
    (table && table.fields) ||
    Object.keys(row || {}).map((k) => ({ name: k }));
  const f = get_async_expression_function(expr, fields, { user, console });
  return await f(row || {}, user);
};

const sendUpdatesField = {
  name: "send_updates",
  label: "Notify attendees",
  sublabel: "Whether Google emails the attendees about this change.",
  type: "String",
  required: true,
  attributes: { options: ["none", "externalOnly", "all"] },
  default: "none",
};

const calendarField = {
  name: "calendar_id",
  label: "Calendar ID",
  sublabel: '"primary" is the connected account\'s own calendar.',
  type: "String",
  default: "primary",
};

const codeField = (name, label, sublabel, table) => ({
  name,
  label,
  sublabel,
  input_type: "code",
  attributes: {
    mode: "application/javascript",
    compact: true,
    expression_type: "row",
    table: table && table.name,
    nojoins: true,
    user: true,
  },
});

const resultVariable = (mode, sublabel) =>
  mode === "workflow"
    ? [
        {
          name: "result_variable",
          label: "Result variable",
          sublabel,
          type: "String",
        },
      ]
    : [];

/**
 * Create an event.
 *
 * The event expression returns the same shape the provider's rows use -
 * `{summary, start, end, all_day, attendees, ...}` - so a row read from a
 * Google Calendar table can be written straight back out.
 */
const create_event = {
  description: "Create an event in Google Calendar",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    calendarField,
    codeField(
      "event_expr",
      "Event expression",
      "JavaScript object. Example: <code>{summary: title, start: starts_at, " +
        "end: ends_at, attendees: contact_email}</code>",
      table,
    ),
    sendUpdatesField,
    ...resultVariable(mode, "Context variable to fill with the new event ID"),
  ],
  run: async ({ row, table, user, configuration, ...rest }) => {
    const { calendar_id, event_expr, send_updates, result_variable } =
      configuration;
    const spec = await evalExpr(event_expr, { row, table, user });
    if (!spec || typeof spec !== "object")
      throw new Error(
        "google-calendar: the event expression did not evaluate to an object.",
      );
    const body = rowToEvent(spec);
    if (!body.start || !body.end)
      throw new Error(
        "google-calendar: the event expression must supply both start and end.",
      );
    const ev = await api.apiFetch(
      `/calendars/${enc(calendar_id || "primary")}/events`,
      { method: "POST", body, query: { sendUpdates: send_updates || "none" } },
    );
    if (result_variable) return { [result_variable]: ev.id };
    return { notify: `Created "${ev.summary || ev.id}" in Google Calendar` };
  },
};

/** Update an existing event, leaving unmentioned properties alone. */
const update_event = {
  description: "Update an event in Google Calendar",
  namespace: NAMESPACE,
  configFields: async ({ table }) => [
    calendarField,
    codeField(
      "event_id_expr",
      "Event ID expression",
      "JavaScript expression for the Google event ID. Example: <code>gcal_id</code>",
      table,
    ),
    codeField(
      "event_expr",
      "Changes expression",
      "JavaScript object of the properties to change. Example: " +
        "<code>{summary: title, location: venue}</code>",
      table,
    ),
    sendUpdatesField,
  ],
  run: async ({ row, table, user, configuration }) => {
    const { calendar_id, event_id_expr, event_expr, send_updates } =
      configuration;
    const id = await evalExpr(event_id_expr, { row, table, user });
    if (!id)
      throw new Error(
        "google-calendar: the event ID expression produced no ID.",
      );
    const spec = await evalExpr(event_expr, { row, table, user });
    const cal = enc(calendar_id || "primary");
    // The current event decides whether a supplied start/end is written as a
    // date or a date-time, so it is read before patching.
    const current = await api.apiFetch(`/calendars/${cal}/events/${enc(id)}`);
    const body = rowToEvent(spec || {}, eventToRow(current, calendar_id));
    if (!Object.keys(body).length)
      return { notify: "Nothing to change in Google Calendar" };
    await api.apiFetch(`/calendars/${cal}/events/${enc(id)}`, {
      method: "PATCH",
      body,
      query: { sendUpdates: send_updates || "none" },
    });
    return { notify: "Google Calendar event updated" };
  },
};

/** Delete an event. */
const delete_event = {
  description: "Delete an event from Google Calendar",
  namespace: NAMESPACE,
  configFields: async ({ table }) => [
    calendarField,
    codeField(
      "event_id_expr",
      "Event ID expression",
      "JavaScript expression for the Google event ID. Example: <code>gcal_id</code>",
      table,
    ),
    sendUpdatesField,
  ],
  run: async ({ row, table, user, configuration }) => {
    const { calendar_id, event_id_expr, send_updates } = configuration;
    const id = await evalExpr(event_id_expr, { row, table, user });
    if (!id)
      throw new Error(
        "google-calendar: the event ID expression produced no ID.",
      );
    await api.apiFetch(
      `/calendars/${enc(calendar_id || "primary")}/events/${enc(id)}`,
      { method: "DELETE", query: { sendUpdates: send_updates || "none" } },
    );
    return { notify: "Google Calendar event deleted" };
  },
};

/**
 * Read events into a workflow variable, without defining a provider table.
 * Useful when a workflow needs "what is on this calendar next week" once.
 */
const find_events = {
  description: "Read events from Google Calendar into a variable",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    calendarField,
    codeField(
      "time_min_expr",
      "From",
      "JavaScript expression for the earliest time. Example: <code>new Date()</code>",
      table,
    ),
    codeField(
      "time_max_expr",
      "To",
      "JavaScript expression for the latest time.",
      table,
    ),
    {
      name: "q",
      label: "Search text",
      sublabel: "Optional free-text search over title, description and location.",
      type: "String",
    },
    {
      name: "max_results",
      label: "Maximum events",
      type: "Integer",
      default: 250,
    },
    ...resultVariable(mode, "Context variable to fill with the array of events"),
  ],
  run: async ({ row, table, user, configuration }) => {
    const {
      calendar_id,
      time_min_expr,
      time_max_expr,
      q,
      max_results,
      result_variable,
    } = configuration;
    const asIso = async (expr) => {
      const v = await evalExpr(expr, { row, table, user });
      return v ? new Date(v).toISOString() : undefined;
    };
    const cal = calendar_id || "primary";
    const items = await api.listAll(`/calendars/${enc(cal)}/events`, {
      timeMin: await asIso(time_min_expr),
      timeMax: await asIso(time_max_expr),
      q: q || undefined,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: Math.min(max_results || 250, 250),
    });
    const rows = items
      .slice(0, max_results || 250)
      .map((ev) => eventToRow(ev, cal));
    if (result_variable) return { [result_variable]: rows };
    return { notify: `Found ${rows.length} events` };
  },
};

/**
 * Ask Google which of a set of calendars is busy in a window. This is the one
 * question the events collection answers badly - it needs every event, across
 * several calendars, only to reduce them to intervals.
 */
const free_busy = {
  description: "Check busy periods across Google calendars",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    {
      name: "calendar_ids",
      label: "Calendar IDs",
      sublabel: "Comma-separated. Example: <code>primary, room-a@example.com</code>",
      type: "String",
      required: true,
      default: "primary",
    },
    codeField(
      "time_min_expr",
      "From",
      "JavaScript expression for the start of the window.",
      table,
    ),
    codeField(
      "time_max_expr",
      "To",
      "JavaScript expression for the end of the window.",
      table,
    ),
    ...resultVariable(
      mode,
      "Context variable to fill with { calendar_id, start, end } busy periods",
    ),
  ],
  run: async ({ row, table, user, configuration }) => {
    const { calendar_ids, time_min_expr, time_max_expr, result_variable } =
      configuration;
    const asIso = async (expr, fallback) => {
      const v = await evalExpr(expr, { row, table, user });
      return v ? new Date(v).toISOString() : fallback;
    };
    const now = new Date();
    const timeMin = await asIso(time_min_expr, now.toISOString());
    const timeMax = await asIso(
      time_max_expr,
      new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    );
    const ids = String(calendar_ids || "primary")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await api.apiFetch("/freeBusy", {
      method: "POST",
      body: { timeMin, timeMax, items: ids.map((id) => ({ id })) },
    });
    const busy = [];
    for (const [id, cal] of Object.entries(res.calendars || {}))
      for (const period of cal.busy || [])
        busy.push({
          calendar_id: id,
          start: new Date(period.start),
          end: new Date(period.end),
        });
    busy.sort((a, b) => a.start - b.start);
    if (result_variable) return { [result_variable]: busy };
    return { notify: `${busy.length} busy periods` };
  },
};

module.exports = {
  google_calendar_create_event: create_event,
  google_calendar_update_event: update_event,
  google_calendar_delete_event: delete_event,
  google_calendar_find_events: find_events,
  google_calendar_free_busy: free_busy,
};
