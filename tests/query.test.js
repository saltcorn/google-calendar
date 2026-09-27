const test = require("node:test");
const assert = require("node:assert");
const {
  matches,
  cmp,
  pushdownEvents,
  applyLocal,
  earlyStopAt,
} = require("../lib/query");

const row = {
  id: "abc",
  summary: "Team Meeting",
  start: new Date("2026-09-23T09:00:00Z"),
  end: new Date("2026-09-23T10:00:00Z"),
  status: "confirmed",
  attendee_count: 3,
  all_day: false,
  location: null,
};

test("equality, null and date matching", () => {
  assert.equal(matches(row, { id: "abc" }), true);
  assert.equal(matches(row, { id: "other" }), false);
  assert.equal(matches(row, { location: null }), true);
  assert.equal(matches(row, { summary: null }), false);
  assert.equal(matches(row, { start: new Date("2026-09-23T09:00:00Z") }), true);
  assert.equal(matches(row, {}), true);
});

test("ilike is case-insensitive, unlike core's fallback", () => {
  assert.equal(matches(row, { summary: { ilike: "team" } }), true);
  assert.equal(matches(row, { summary: { ilike: "MEETING" } }), true);
  assert.equal(matches(row, { summary: { ilike: "absent" } }), false);
});

test("lt/gt with and without equal, on dates and numbers", () => {
  const at = new Date("2026-09-23T09:00:00Z");
  assert.equal(matches(row, { start: { gt: at } }), false);
  assert.equal(matches(row, { start: { gt: at, equal: true } }), true);
  assert.equal(matches(row, { start: { lt: "2026-09-24" } }), true);
  assert.equal(matches(row, { attendee_count: { gt: 2 } }), true);
  assert.equal(matches(row, { attendee_count: { lt: 2 } }), false);
});

test("in, arrays of conditions, or, and not", () => {
  assert.equal(matches(row, { status: { in: ["confirmed", "tentative"] } }), true);
  assert.equal(matches(row, { status: { in: ["cancelled"] } }), false);
  assert.equal(
    matches(row, { attendee_count: [{ gt: 1 }, { lt: 5 }] }),
    true,
  );
  assert.equal(matches(row, { or: [{ id: "nope" }, { id: "abc" }] }), true);
  assert.equal(matches(row, { or: [{ id: "nope" }, { id: "neither" }] }), false);
  assert.equal(matches(row, { not: { id: "nope" } }), true);
});

test("an unsupported operator throws rather than filtering everything out", () => {
  assert.throws(
    () => matches(row, { id: { inSelect: { table: "x" } } }),
    /not supported/,
  );
});

test("string ordering works, where core's numeric comparator returns NaN", () => {
  const rows = [{ summary: "Charlie" }, { summary: "alpha" }, { summary: "Bravo" }];
  const asc = applyLocal(rows, {}, { orderBy: "summary" });
  assert.deepEqual(asc.map((r) => r.summary), ["alpha", "Bravo", "Charlie"]);
  const desc = applyLocal(rows, {}, { orderBy: "summary", orderDesc: true });
  assert.deepEqual(desc.map((r) => r.summary), ["Charlie", "Bravo", "alpha"]);
});

test("nulls sort last either way", () => {
  assert.equal(cmp(null, "a") > 0, true);
  assert.equal(cmp("a", null) < 0, true);
  assert.equal(cmp(null, null), 0);
});

test("limit and offset page the filtered rows", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ n, keep: n !== 3 }));
  const page = applyLocal(rows, { keep: true }, {
    orderBy: "n",
    limit: 2,
    offset: 1,
  });
  assert.deepEqual(page.map((r) => r.n), [2, 4]);
});

test("date bounds push down to timeMin/timeMax", () => {
  const { params } = pushdownEvents({
    start: { gt: new Date("2026-01-01T00:00:00Z") },
    end: { lt: new Date("2026-02-01T00:00:00Z") },
  });
  assert.equal(params.timeMin, "2026-01-01T00:00:00.000Z");
  assert.equal(params.timeMax, "2026-02-01T00:00:00.000Z");
});

test("the widest bound wins, so the query stays a superset", () => {
  const { params } = pushdownEvents({
    start: { gt: new Date("2026-03-01T00:00:00Z") },
    end: { gt: new Date("2026-01-01T00:00:00Z") },
  });
  assert.equal(params.timeMin, "2026-01-01T00:00:00.000Z");
});

test("_fts becomes q and is dropped from the residual", () => {
  const { params, residual } = pushdownEvents({
    _fts: { searchTerm: "standup" },
    status: "confirmed",
  });
  assert.equal(params.q, "standup");
  assert.equal(residual._fts, undefined);
  assert.equal(residual.status, "confirmed");
});

test("every other condition stays in the residual, even when pushed down", () => {
  const { residual } = pushdownEvents({ start: { gt: new Date(0) } });
  assert.ok(residual.start, "pushdown widens; the local check still runs");
});

test("an id equality is routed to events.get", () => {
  assert.equal(pushdownEvents({ id: "xyz" }).byId, "xyz");
  assert.equal(pushdownEvents({ id: { in: ["a", "b"] } }).byId, null);
});

test("cancelled events are only requested when asked for", () => {
  assert.equal(pushdownEvents({}).params.showDeleted, undefined);
  assert.equal(pushdownEvents({ status: "cancelled" }).params.showDeleted, "true");
  assert.equal(
    pushdownEvents({ status: { in: ["cancelled"] } }).params.showDeleted,
    "true",
  );
});

test("singleEvents turns on start-time ordering", () => {
  const { params } = pushdownEvents({}, { singleEvents: true });
  assert.equal(params.singleEvents, "true");
  assert.equal(params.orderBy, "startTime");
});

test("early stop only when the API order already matches", () => {
  const opts = { singleEvents: true };
  assert.equal(earlyStopAt({ limit: 10, offset: 5 }, opts), 15);
  assert.equal(earlyStopAt({ limit: 10, orderBy: "start" }, opts), 10);
  // a different sort key means every candidate must be in hand first
  assert.equal(earlyStopAt({ limit: 10, orderBy: "summary" }, opts), null);
  assert.equal(earlyStopAt({ limit: 10, orderBy: "start", orderDesc: true }, opts), null);
  assert.equal(earlyStopAt({}, opts), null);
});
