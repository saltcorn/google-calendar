/**
 * Translating a Saltcorn `where` into Google Calendar query parameters, and
 * evaluating whatever is left over locally.
 *
 * The provider sets `disableFiltering`, so core does no filtering, ordering or
 * paging of its own - all three happen here. Core's own fallback could not be
 * used: its `ilike` is a case-sensitive `includes`, and its comparator is
 * `a.x-b.x`, which returns NaN for every string column.
 *
 * The contract for pushdown: parameters sent to Google must only ever widen
 * the result set. Everything is re-checked locally, so a superset is safe and
 * a subset silently loses rows.
 */

const ISO = (v) => (v instanceof Date ? v : new Date(v)).toISOString();

/** Compare two cell values of any type, nulls last. */
const cmp = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};

const numeric = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.getTime();
  return Number(v);
};

/**
 * Does `row` satisfy one `key: value` condition?
 *
 * Supports the operators core's external-table fallback supports - equality,
 * `in`, `or`, `not`, `ilike`, `lt`/`gt` with optional `equal`, arrays of
 * conditions and null tests. Anything else throws: a view filtering a Google
 * Calendar table through `inSelect` is a misconfiguration, and an error that
 * names the operator beats a view that silently renders no rows.
 */
const satisfies = (row, key, val) => {
  if (key === "or" && Array.isArray(val))
    return val.some((sub) => matches(row, sub));
  if (key === "not" && val && typeof val === "object")
    return !matches(row, val);
  if (Array.isArray(val)) return val.every((v) => satisfies(row, key, v));

  const cell = row[key];
  if (val === null) return cell === null || cell === undefined;
  if (val instanceof Date) return numeric(cell) === val.getTime();

  if (val && typeof val === "object") {
    if ("in" in val) return (val.in || []).some((v) => cell == v);
    if ("ilike" in val)
      return String(cell ?? "")
        .toLowerCase()
        .includes(String(val.ilike ?? "").toLowerCase());
    if ("lt" in val) {
      const l = numeric(cell), r = numeric(val.lt);
      return val.equal ? l <= r : l < r;
    }
    if ("gt" in val) {
      const l = numeric(cell), r = numeric(val.gt);
      return val.equal ? l >= r : l > r;
    }
    const op = Object.keys(val)[0];
    throw new Error(
      `google-calendar: the "${op}" filter is not supported against the ` +
        `Google Calendar API. Filter on a synced copy of this table instead.`,
    );
  }
  if (cell instanceof Date) return cell.getTime() === numeric(val);
  return cell == val;
};

/**
 * Evaluate a whole where-object against a row.
 *
 * @param {object} row - a flattened row
 * @param {object} where - a Saltcorn where-object
 * @returns {boolean} true when every condition holds
 */
const matches = (row, where = {}) =>
  Object.entries(where).every(([k, v]) => satisfies(row, k, v));

/**
 * Pick the top-level conditions that map onto events.list parameters.
 *
 * Only top-level conjuncts are considered: a condition inside an `or` does not
 * constrain the result set on its own, so pushing it down would narrow the
 * query below what the `or` actually asks for.
 *
 * @param {object} where - a Saltcorn where-object
 * @param {object} [opts] - { singleEvents }
 * @returns {object} { params, residual, byId }
 */
const pushdownEvents = (where = {}, opts = {}) => {
  const params = {};
  const residual = { ...where };
  let byId = null;

  // events.get by id: one request instead of walking the calendar.
  if (typeof where.id === "string") byId = where.id;

  const lower = (k, v) => {
    // A lower bound on start or end widens to Google's timeMin, which selects
    // events whose end is at or after it - a superset of both.
    const at = v.gt !== undefined ? v.gt : v.ge;
    if (at === undefined) return;
    const iso = ISO(at);
    if (!params.timeMin || new Date(iso) < new Date(params.timeMin))
      params.timeMin = iso;
  };
  const upper = (k, v) => {
    const at = v.lt !== undefined ? v.lt : v.le;
    if (at === undefined) return;
    const iso = ISO(at);
    if (!params.timeMax || new Date(iso) > new Date(params.timeMax))
      params.timeMax = iso;
  };

  for (const [k, v] of Object.entries(where)) {
    if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof Date) {
      if (k === "ical_uid" && typeof v === "string") params.iCalUID = v;
      continue;
    }
    if (k === "start" || k === "end") {
      lower(k, v);
      upper(k, v);
    }
    if (k === "updated" && (v.gt !== undefined || v.ge !== undefined))
      params.updatedMin = ISO(v.gt !== undefined ? v.gt : v.ge);
  }

  // Free-text search. Google's `q` covers summary, description, location and
  // attendees; core's `_fts` stringifies the whole row. Google's is the more
  // useful reading for a calendar, so it replaces the local check rather than
  // supplementing it - hence the delete.
  if (where._fts && where._fts.searchTerm) {
    params.q = where._fts.searchTerm;
    delete residual._fts;
  }

  // Cancelled events are hidden unless something asks for them.
  const wantsCancelled =
    where.status === "cancelled" ||
    (where.status && where.status.in && where.status.in.includes("cancelled"));
  if (wantsCancelled || params.updatedMin) params.showDeleted = "true";

  if (opts.singleEvents) {
    params.singleEvents = "true";
    params.orderBy = "startTime";
  }

  return { params, residual, byId };
};

/** Does the API's natural order already match what was asked for? */
const apiOrderMatches = (selopts, opts) =>
  !selopts.orderBy ||
  (opts.singleEvents && selopts.orderBy === "start" && !selopts.orderDesc);

/**
 * Filter, sort and page rows locally.
 *
 * @param {object[]} rows - rows fetched from the API
 * @param {object} where - the residual where-object
 * @param {object} [selopts] - { orderBy, orderDesc, limit, offset }
 * @returns {object[]} the rows core asked for
 */
const applyLocal = (rows, where = {}, selopts = {}) => {
  let out = rows.filter((r) => matches(r, where));
  if (selopts.orderBy && typeof selopts.orderBy === "string") {
    const key = selopts.orderBy;
    out.sort((a, b) => (selopts.orderDesc ? cmp(b[key], a[key]) : cmp(a[key], b[key])));
  }
  const offset = selopts.offset || 0;
  if (selopts.limit) return out.slice(offset, offset + selopts.limit);
  return offset ? out.slice(offset) : out;
};

/**
 * How many rows must be collected before paging can stop early.
 *
 * Returns null when the walk cannot stop early - either nothing bounds it, or
 * a sort is wanted that the API does not already provide, in which case every
 * candidate row has to be in hand before the first one can be chosen.
 */
const earlyStopAt = (selopts, opts) => {
  if (!selopts.limit) return null;
  if (!apiOrderMatches(selopts, opts)) return null;
  return (selopts.offset || 0) + selopts.limit;
};

module.exports = {
  matches,
  satisfies,
  cmp,
  pushdownEvents,
  applyLocal,
  earlyStopAt,
  apiOrderMatches,
};
