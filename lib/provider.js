const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const api = require("./api");
const { liveCfg } = require("./config");
const {
  EVENT_FIELDS,
  CALENDAR_FIELDS,
  eventToRow,
  rowToEvent,
  calendarToRow,
} = require("./fields");
const { pushdownEvents, applyLocal, earlyStopAt, matches } = require("./query");

const enc = encodeURIComponent;

/**
 * A table's provider_cfg is `null`, not `undefined`, on a provider table that
 * has never been configured - and a default parameter only fires for
 * `undefined`. Table.find builds every provider table up front, so this is
 * reached before anyone has chosen a calendar.
 */
const asCfg = (cfgTable) => cfgTable || {};

/** calendarList, for the picker in the configuration workflow. */
const listCalendars = async (cfg) =>
  await api.listAll("/users/me/calendarList", { maxResults: 250 }, { cfg });

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Entity",
        form: async () =>
          new Form({
            fields: [
              {
                name: "entity_type",
                label: "Entity",
                sublabel:
                  "Events exposes one calendar's events. Calendars lists the " +
                  "calendars the connected account can see.",
                type: "String",
                required: true,
                attributes: { options: ["Events", "Calendars"] },
              },
            ],
          }),
      },
      {
        name: "Calendar",
        onlyWhen: (context) => context.entity_type === "Events",
        form: async () => {
          let options = [];
          let err = null;
          try {
            const cals = await listCalendars(liveCfg());
            options = cals.map((c) => c.id);
          } catch (e) {
            err = e.message;
          }
          return new Form({
            fields: [
              {
                name: "calendar_id",
                label: "Calendar",
                sublabel: err
                  ? `Could not list calendars: ${err} Enter the calendar ID manually.`
                  : 'The calendar to expose. "primary" is the connected account\'s own calendar.',
                type: "String",
                required: true,
                default: "primary",
                attributes: options.length ? { options } : {},
              },
              {
                name: "single_events",
                label: "Expand recurring events",
                sublabel:
                  "Return each occurrence as its own row rather than one row " +
                  "per recurrence rule. Required for ordering by start time.",
                type: "Bool",
                default: true,
              },
              {
                name: "window_days",
                label: "Default window (days)",
                sublabel:
                  "When a query carries no date filter, fetch this many days " +
                  "either side of now. 0 fetches the whole calendar, which on " +
                  "a large one is slow and burns quota.",
                type: "Integer",
                default: 365,
              },
              {
                name: "max_pages",
                label: "Maximum pages per query",
                sublabel: "250 events per page. Guards against runaway queries.",
                type: "Integer",
                default: 20,
              },
            ],
          });
        },
      },
    ],
  });

/**
 * Apply the configured default window when a query bounds neither end.
 *
 * Without this, the first render of an unfiltered list view walks the whole
 * calendar - every event since the account was created.
 */
const withDefaultWindow = (params, cfgTable0) => {
  const cfgTable = asCfg(cfgTable0);
  const days = cfgTable.window_days === 0 ? 0 : cfgTable.window_days || 365;
  if (!days) return params;
  if (params.timeMin || params.timeMax || params.iCalUID || params.updatedMin)
    return params;
  const ms = days * 24 * 60 * 60 * 1000;
  return {
    ...params,
    timeMin: new Date(Date.now() - ms).toISOString(),
    timeMax: new Date(Date.now() + ms).toISOString(),
  };
};

const eventsPath = (cfgTable) =>
  `/calendars/${enc(asCfg(cfgTable).calendar_id || "primary")}/events`;

/**
 * Fetch event rows for a where-object, pushing down what Google can do.
 *
 * @param {object} cfgTable - the provider configuration for this table
 * @param {object} where - a Saltcorn where-object
 * @param {object} selopts - { orderBy, orderDesc, limit, offset }
 * @param {object} [opts] - { cfg, fetchImpl } for tests
 * @returns {Promise<object[]>} rows, already filtered, sorted and paged
 */
const getEventRows = async (cfgTable0, where = {}, selopts = {}, opts = {}) => {
  const cfgTable = asCfg(cfgTable0);
  // Not configured yet: no calendar has been chosen, so there is nothing to
  // read. Guessing "primary" here would quietly query the wrong calendar.
  if (!cfgTable.calendar_id) return [];
  const cfg = opts.cfg || liveCfg();
  const singleEvents = cfgTable.single_events !== false;
  const { params, residual, byId } = pushdownEvents(where, { singleEvents });
  const calendarId = cfgTable.calendar_id || "primary";

  // A query pinned to one event id is a single GET, not a walk.
  if (byId) {
    let ev;
    try {
      ev = await api.apiFetch(`${eventsPath(cfgTable)}/${enc(byId)}`, {
        ...opts,
        cfg,
      });
    } catch (e) {
      // a row that has since been deleted is an empty result, not an error
      if (e.status === 404) return [];
      throw e;
    }
    return applyLocal([eventToRow(ev, calendarId)], residual, selopts);
  }

  const stopAt = earlyStopAt(selopts, { singleEvents });
  const rows = [];
  await api.eachPage(
    eventsPath(cfgTable),
    { ...withDefaultWindow(params, cfgTable), maxResults: 250 },
    (items) => {
      for (const ev of items) {
        const row = eventToRow(ev, calendarId);
        if (matches(row, residual)) rows.push(row);
      }
      // Only safe when the API is already returning rows in the wanted order.
      if (stopAt && rows.length >= stopAt) return false;
    },
    { ...opts, cfg, maxPages: cfgTable.max_pages || 20 },
  );
  return applyLocal(rows, {}, selopts);
};

/**
 * Fetch calendar rows. calendarList has no server-side filtering worth using,
 * so everything is evaluated locally.
 */
const getCalendarRows = async (where = {}, selopts = {}, opts = {}) => {
  const cfg = opts.cfg || liveCfg();
  const cals = await api.listAll(
    "/users/me/calendarList",
    { maxResults: 250 },
    { ...opts, cfg },
  );
  return applyLocal(cals.map(calendarToRow), where, selopts);
};

/**
 * The provider's table object. Every method core may override is supplied,
 * because `disableFiltering` turns off the in-memory fallback wholesale.
 */
const get_table = (cfgTable0) => {
  const cfgTable = asCfg(cfgTable0);
  const isEvents = (cfgTable.entity_type || "Events") === "Events";
  const calendarId = cfgTable.calendar_id || "primary";

  const getRows = async (where = {}, selopts = {}) =>
    isEvents
      ? await getEventRows(cfgTable, where, selopts)
      : await getCalendarRows(where, selopts);

  const table = {
    disableFiltering: true,
    getRows,

    async countRows(where = {}) {
      // The Calendar API has no count endpoint, so this is a full fetch of
      // the matching rows. Pagers therefore cost two walks of the window,
      // which is the main reason the default window exists.
      const rows = await getRows(where, {});
      return rows.length;
    },

    async distinctValues(fldNm, where = {}) {
      const rows = await getRows(where, {});
      return [...new Set(rows.map((r) => r[fldNm]))];
    },
  };

  if (!isEvents) return table;

  const readOnly = () => {
    if (liveCfg().read_only)
      throw new Error(
        'google-calendar: the plugin is connected read-only. Turn off "Read ' +
          'only" in the plugin configuration and reconnect to write events.',
      );
  };

  table.insertRow = async (row) => {
    readOnly();
    const body = rowToEvent(row || {});
    if (!body.start || !body.end)
      throw new Error(
        "google-calendar: an event needs both a start and an end.",
      );
    const ev = await api.apiFetch(eventsPath(cfgTable), {
      method: "POST",
      body,
      query: { sendUpdates: liveCfg().send_updates || "none" },
    });
    return ev.id;
  };

  table.updateRow = async (row, id) => {
    readOnly();
    // PATCH, not PUT: a row carrying one changed column must not blank the
    // columns it does not mention.
    const [existing] = await getEventRows(cfgTable, { id }, {});
    if (!existing)
      throw new Error(`google-calendar: no event with id ${id} on ${calendarId}`);
    const body = rowToEvent(row || {}, existing);
    if (!Object.keys(body).length) return;
    await api.apiFetch(`${eventsPath(cfgTable)}/${enc(id)}`, {
      method: "PATCH",
      body,
      query: { sendUpdates: liveCfg().send_updates || "none" },
    });
  };

  table.deleteRows = async (where = {}) => {
    readOnly();
    if (!where || !Object.keys(where).length)
      throw new Error(
        "google-calendar: refusing to delete every event on " +
          `${calendarId}. Deleting from a Google Calendar cannot be undone ` +
          "from Saltcorn, so this needs a filter.",
      );
    const rows = await getEventRows(cfgTable, where, {});
    for (const row of rows)
      await api.apiFetch(`${eventsPath(cfgTable)}/${enc(row.id)}`, {
        method: "DELETE",
        query: { sendUpdates: liveCfg().send_updates || "none" },
      });
  };

  return table;
};

module.exports = {
  "Google Calendar": {
    configuration_workflow,
    fields: (cfgTable) =>
      (cfgTable || {}).entity_type === "Calendars"
        ? CALENDAR_FIELDS
        : EVENT_FIELDS,
    get_table,
  },
  // exported for tests
  getEventRows,
  getCalendarRows,
  withDefaultWindow,
  listCalendars,
};
