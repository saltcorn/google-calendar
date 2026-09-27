const test = require("node:test");
const assert = require("node:assert");
const { getEventRows, withDefaultWindow } = require("../lib/provider");

/** A plugin config with a token that has not expired, so nothing refreshes. */
const CFG = {
  client_id: "id",
  client_secret: "secret",
  oauth: { access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3.6e6 },
};

const ev = (id, startIso, summary, extra = {}) => ({
  id,
  summary,
  status: "confirmed",
  start: { dateTime: startIso },
  end: { dateTime: startIso },
  ...extra,
});

/**
 * A fetch that serves canned pages and records every URL it was called with.
 */
const fakeFetch = (pages) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const token = u.searchParams.get("pageToken");
    const ix = token ? Number(token) : 0;
    const page = pages[ix] || { items: [] };
    const body = {
      items: page.items || page,
      ...(ix + 1 < pages.length ? { nextPageToken: String(ix + 1) } : {}),
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  impl.calls = calls;
  return impl;
};

const cfgTable = { entity_type: "Events", calendar_id: "primary", window_days: 0 };

test("rows come back mapped, from the configured calendar", async () => {
  const fetchImpl = fakeFetch([[ev("a", "2026-09-23T09:00:00Z", "Standup")]]);
  const rows = await getEventRows(cfgTable, {}, {}, { cfg: CFG, fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, "Standup");
  assert.equal(rows[0].calendar_id, "primary");
  assert.match(fetchImpl.calls[0], /\/calendars\/primary\/events/);
});

test("date filters are sent as timeMin and timeMax", async () => {
  const fetchImpl = fakeFetch([[]]);
  await getEventRows(
    cfgTable,
    { start: { gt: new Date("2026-01-01T00:00:00Z") }, end: { lt: new Date("2026-02-01T00:00:00Z") } },
    {},
    { cfg: CFG, fetchImpl },
  );
  const u = new URL(fetchImpl.calls[0]);
  assert.equal(u.searchParams.get("timeMin"), "2026-01-01T00:00:00.000Z");
  assert.equal(u.searchParams.get("timeMax"), "2026-02-01T00:00:00.000Z");
});

test("a filter Google cannot express is still applied locally", async () => {
  // Google has no parameter for "location contains", so it returns both and
  // the provider must drop the one that does not match.
  const fetchImpl = fakeFetch([
    [
      ev("a", "2026-09-23T09:00:00Z", "One", { location: "Room A" }),
      ev("b", "2026-09-23T10:00:00Z", "Two", { location: "Room B" }),
    ],
  ]);
  const rows = await getEventRows(
    cfgTable,
    { location: { ilike: "room a" } },
    {},
    { cfg: CFG, fetchImpl },
  );
  assert.deepEqual(rows.map((r) => r.id), ["a"]);
});

test("paging walks every page when nothing bounds the query", async () => {
  const fetchImpl = fakeFetch([
    [ev("a", "2026-09-23T09:00:00Z", "One")],
    [ev("b", "2026-09-24T09:00:00Z", "Two")],
    [ev("c", "2026-09-25T09:00:00Z", "Three")],
  ]);
  const rows = await getEventRows(cfgTable, {}, {}, { cfg: CFG, fetchImpl });
  assert.equal(rows.length, 3);
  assert.equal(fetchImpl.calls.length, 3);
});

test("a limit in the API's own order stops paging early", async () => {
  const fetchImpl = fakeFetch([
    [ev("a", "2026-09-23T09:00:00Z", "One"), ev("b", "2026-09-24T09:00:00Z", "Two")],
    [ev("c", "2026-09-25T09:00:00Z", "Three")],
    [ev("d", "2026-09-26T09:00:00Z", "Four")],
  ]);
  const rows = await getEventRows(cfgTable, {}, { limit: 2 }, { cfg: CFG, fetchImpl });
  assert.equal(rows.length, 2);
  assert.equal(fetchImpl.calls.length, 1, "should not fetch pages it cannot need");
});

test("a sort the API does not provide forces the full walk", async () => {
  const fetchImpl = fakeFetch([
    [ev("a", "2026-09-23T09:00:00Z", "Zebra")],
    [ev("b", "2026-09-24T09:00:00Z", "Alpha")],
  ]);
  const rows = await getEventRows(
    cfgTable,
    {},
    { orderBy: "summary", limit: 1 },
    { cfg: CFG, fetchImpl },
  );
  assert.equal(fetchImpl.calls.length, 2, "both pages are needed to sort");
  assert.equal(rows[0].summary, "Alpha");
});

test("maxPages bounds a runaway query", async () => {
  const pages = Array.from({ length: 10 }, (_, i) => [
    ev(`e${i}`, "2026-09-23T09:00:00Z", `E${i}`),
  ]);
  const fetchImpl = fakeFetch(pages);
  const rows = await getEventRows(
    { ...cfgTable, max_pages: 3 },
    {},
    {},
    { cfg: CFG, fetchImpl },
  );
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(rows.length, 3);
});

test("a query pinned to one id is a single GET, not a walk", async () => {
  const fetchImpl = async (url) => {
    fetchImpl.calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(ev("xyz", "2026-09-23T09:00:00Z", "Pinned")),
    };
  };
  fetchImpl.calls = [];
  const rows = await getEventRows(cfgTable, { id: "xyz" }, {}, { cfg: CFG, fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, "Pinned");
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0], /\/events\/xyz/);
});

test("an unfiltered query gets the configured default window", () => {
  const params = withDefaultWindow({}, { window_days: 30 });
  assert.ok(params.timeMin && params.timeMax);
  const span = new Date(params.timeMax) - new Date(params.timeMin);
  assert.equal(Math.round(span / 86400000), 60);
});

test("the default window never overrides an explicit filter", () => {
  const params = withDefaultWindow({ timeMin: "2020-01-01T00:00:00Z" }, { window_days: 30 });
  assert.equal(params.timeMin, "2020-01-01T00:00:00Z");
  assert.equal(params.timeMax, undefined);
});

test("window_days 0 means no window at all", () => {
  assert.deepEqual(withDefaultWindow({}, { window_days: 0 }), {});
});

test("an unconfigured provider table builds instead of throwing", async () => {
  // Table.find calls get_table for every provider table before anyone has
  // configured one, and provider_cfg is null at that point.
  for (const cfg of [null, undefined, {}]) {
    const { "Google Calendar": p } = require("../lib/provider");
    const t = p.get_table(cfg);
    assert.equal(t.disableFiltering, true);
    assert.deepEqual(await t.getRows({}), [], "nothing to read until configured");
    assert.equal(await t.countRows({}), 0);
  }
});

test("fields survives a null configuration too", () => {
  const { "Google Calendar": p } = require("../lib/provider");
  assert.ok(p.fields(null).length > 0);
  assert.ok(p.fields(undefined).length > 0);
  assert.equal(p.fields({ entity_type: "Calendars" }).length, 9);
});

test("withDefaultWindow tolerates a null configuration", () => {
  assert.ok(withDefaultWindow({}, null).timeMin, "falls back to the 365d default");
  assert.ok(withDefaultWindow({}, undefined).timeMin);
});

test("an unconfigured table makes no API call at all", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
  };
  const rows = await getEventRows(null, {}, {}, { cfg: CFG, fetchImpl });
  assert.deepEqual(rows, []);
  assert.equal(called, 0);
});
