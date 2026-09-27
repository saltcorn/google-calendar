const { getState } = require("@saltcorn/data/db/state");

const PLUGIN_NAME = "google-calendar";
const NPM_NAME = "@saltcorn/google-calendar";

/** Google's OAuth2 and Calendar v3 endpoints. */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_BASE = "https://www.googleapis.com/calendar/v3";

/** The one place the callback path is spelled. Routes and the setup
 *  instructions both derive from it, so they cannot drift apart. */
const CALLBACK_PATH = "/google-calendar/oauth2/callback";

const SCOPE_READWRITE = "https://www.googleapis.com/auth/calendar";
const SCOPE_READONLY = "https://www.googleapis.com/auth/calendar.readonly";

/**
 * The plugin configuration as it stands *now*.
 *
 * `table_providers` and `actions` are evaluated once, when the plugin is
 * registered, so anything closing over that `cfg` holds a snapshot taken at
 * load time. The access token is refreshed and rewritten behind that
 * snapshot's back, so every call needing credentials reads through here
 * instead of trusting what it captured.
 *
 * @param {object} [fallback] - used when there is no state (unit tests)
 * @returns {object} the live plugin configuration
 */
const liveCfg = (fallback = {}) => {
  const state = getState();
  if (!state || !state.plugin_cfgs) return fallback;
  const cfgs = state.plugin_cfgs;
  if (cfgs[NPM_NAME]) return cfgs[NPM_NAME];
  if (cfgs[PLUGIN_NAME]) return cfgs[PLUGIN_NAME];
  // installed from a local directory or a fork, under some other key
  const key = Object.keys(cfgs).find((k) => k.endsWith(PLUGIN_NAME));
  return key ? cfgs[key] : fallback;
};

/**
 * The redirect URI Google will send the browser back to. Must match one of
 * the "Authorised redirect URIs" on the OAuth client in Google Cloud exactly,
 * including scheme, port and trailing path.
 */
const redirectUri = (cfg) => {
  const base = (cfg.base_url || "").replace(/\/+$/, "");
  if (!base)
    throw new Error(
      "google-calendar: no base URL configured. Set it on the plugin " +
        "configuration page so Google knows where to send the browser back to.",
    );
  return `${base}${CALLBACK_PATH}`;
};

const scopes = (cfg) => [cfg.read_only ? SCOPE_READONLY : SCOPE_READWRITE];

module.exports = {
  PLUGIN_NAME,
  NPM_NAME,
  AUTH_URL,
  TOKEN_URL,
  REVOKE_URL,
  API_BASE,
  CALLBACK_PATH,
  SCOPE_READWRITE,
  SCOPE_READONLY,
  liveCfg,
  redirectUri,
  scopes,
};
