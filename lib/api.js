const { API_BASE, liveCfg } = require("./config");
const oauth = require("./oauth");

/** Status codes worth trying again. 403 is handled separately - see below. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * Google signals per-minute quota exhaustion as 403 with a `reason` of
 * rateLimitExceeded or userRateLimitExceeded. A plain 403 means the caller
 * lacks the scope, which retrying will never fix.
 */
const isRateLimit403 = (body) => {
  const errs = (body && body.error && body.error.errors) || [];
  return errs.some((e) =>
    ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.reason),
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, honouring Retry-After when Google sets it. */
const backoffMs = (attempt, res) => {
  const header = res && res.headers && res.headers.get("retry-after");
  if (header) {
    const secs = parseInt(header, 10);
    if (!isNaN(secs)) return secs * 1000;
  }
  return Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 250);
};

/**
 * Turn a Google error body into a message that says what to fix.
 */
const describeError = (status, body, path) => {
  const err = (body && body.error) || {};
  const reason = (err.errors && err.errors[0] && err.errors[0].reason) || "";
  const top = err.message || `HTTP ${status}`;
  // Google puts the useful part of a 400 in error.errors[], not error.message,
  // which is often just "Bad Request". Without these the caller cannot tell
  // which property it got wrong.
  const subs = (err.errors || [])
    .map((e) => e.message || e.reason)
    .filter((m) => m && !top.includes(m));
  const detail = subs.length ? `${top}: ${subs.join("; ")}` : top;
  if (status === 400)
    return (
      `${detail} (${path}). Google rejected the request body - usually a ` +
      `property set to an empty string, or an all-day event whose end does ` +
      `not fall after its start.`
    );
  if (status === 404)
    return (
      `${detail} (${path}). The calendar or event no longer exists, or the ` +
      `connected Google account cannot see it.`
    );
  if (status === 403 && reason === "insufficientPermissions")
    return (
      `${detail} The plugin is connected read-only. Turn off "Read only" in ` +
      `the plugin configuration and reconnect the Google account.`
    );
  if (status === 403)
    return `${detail} (${reason || "forbidden"}) calling ${path}`;
  return `${detail} (HTTP ${status}) calling ${path}`;
};

/**
 * One authenticated Calendar API call, with token refresh and retries.
 *
 * @param {string} path - path below the v3 base, e.g. "/calendars/x/events"
 * @param {object} [opts]
 * @param {string} [opts.method] - HTTP method, default GET
 * @param {object} [opts.query] - query parameters; undefined values are dropped
 * @param {object} [opts.body] - JSON request body
 * @param {object} [opts.cfg] - plugin configuration override, for tests
 * @param {Function} [opts.fetchImpl] - fetch override, for tests
 * @returns {Promise<object>} the parsed response, or {} for 204
 */
const apiFetch = async (path, opts = {}) => {
  const {
    method = "GET",
    query = {},
    body,
    cfg = liveCfg(),
    fetchImpl = fetch,
  } = opts;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
  const qs = params.toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;

  let forceRefresh = false;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await oauth.getAccessToken(cfg, forceRefresh);
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 204) return {};
    const text = await res.text();
    let json = {};
    if (text)
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = {};
      }

    if (res.ok) return json;

    // A token that the stored expiry said was still good. Refresh and retry
    // once; if it fails again the credentials are genuinely bad.
    if (res.status === 401 && !forceRefresh) {
      forceRefresh = true;
      continue;
    }

    const retryable = RETRY_STATUS.has(res.status) || isRateLimit403(json);
    lastErr = new Error(describeError(res.status, json, path));
    // callers branch on this rather than matching on the message text
    lastErr.status = res.status;
    if (!retryable || attempt === MAX_ATTEMPTS - 1) throw lastErr;
    await sleep(backoffMs(attempt, res));
  }
  throw lastErr;
};

/**
 * Walk a paginated collection, calling `onPage` with each page of items.
 *
 * Stops when `onPage` returns false, when Google runs out of pages, or at
 * `maxPages` - a guard so a mis-specified filter cannot walk a decade of
 * history one page at a time.
 *
 * @param {string} path - collection path
 * @param {object} query - query parameters, without pageToken
 * @param {Function} onPage - (items, raw) => boolean|void; false stops the walk
 * @param {object} [opts] - { cfg, fetchImpl, maxPages }
 * @returns {Promise<object>} { pages, nextPageToken, syncToken }
 */
const eachPage = async (path, query, onPage, opts = {}) => {
  const maxPages = opts.maxPages || 20;
  let pageToken;
  let pages = 0;
  let raw = {};
  do {
    raw = await apiFetch(path, { ...opts, query: { ...query, pageToken } });
    pages += 1;
    const items = raw.items || [];
    if (onPage(items, raw) === false)
      return { pages, nextPageToken: raw.nextPageToken, syncToken: raw.nextSyncToken };
    pageToken = raw.nextPageToken;
  } while (pageToken && pages < maxPages);
  return {
    pages,
    nextPageToken: pageToken,
    syncToken: raw.nextSyncToken,
  };
};

/**
 * Every item in a collection, up to the page guard.
 *
 * @param {string} path - collection path
 * @param {object} [query] - query parameters
 * @param {object} [opts] - { cfg, fetchImpl, maxPages }
 * @returns {Promise<object[]>} the concatenated items
 */
const listAll = async (path, query = {}, opts = {}) => {
  const out = [];
  await eachPage(path, query, (items) => {
    out.push(...items);
  }, opts);
  return out;
};

module.exports = { apiFetch, eachPage, listAll, describeError, isRateLimit403 };
