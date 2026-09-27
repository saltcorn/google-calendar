const crypto = require("crypto");
const oauth = require("./oauth");
const { liveCfg, NPM_NAME, CALLBACK_PATH } = require("./config");

const CONFIGURE_URL = `/plugins/configure/${encodeURIComponent(NPM_NAME)}`;

/** Only an admin may connect or disconnect the instance's Google account. */
const isAdmin = (req) => !!(req && req.user && req.user.role_id === 1);

const denyNonAdmin = (req, res) => {
  if (isAdmin(req)) return false;
  res.status(403).send("Not authorized");
  return true;
};

/**
 * Start the consent flow.
 *
 * The `state` nonce is kept in the session and checked on the way back, so a
 * callback forged by another site cannot bind its own Google account to this
 * Saltcorn instance.
 */
const authorize = {
  url: "/google-calendar/oauth2/authorize",
  method: "get",
  callback: async (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const cfg = liveCfg();
    const state = crypto.randomBytes(24).toString("hex");
    if (req.session) req.session.google_calendar_oauth_state = state;
    res.redirect(oauth.authorizeUrl(cfg, state));
  },
};

/**
 * Where Google sends the browser back. Registered with noCsrf because the
 * request comes from Google, which has no Saltcorn CSRF token to send.
 */
const callback = {
  url: CALLBACK_PATH,
  method: "get",
  noCsrf: true,
  callback: async (req, res) => {
    if (denyNonAdmin(req, res)) return;
    const { code, state, error } = req.query || {};

    const expected = req.session && req.session.google_calendar_oauth_state;
    if (req.session) delete req.session.google_calendar_oauth_state;

    if (error) {
      req.flash("error", `Google declined the connection: ${error}`);
      return res.redirect(CONFIGURE_URL);
    }
    if (!expected || !state || state !== expected) {
      req.flash(
        "error",
        "Google Calendar: the authorisation did not match the one this " +
          "browser started. Try connecting again.",
      );
      return res.redirect(CONFIGURE_URL);
    }
    if (!code) {
      req.flash("error", "Google Calendar: no authorisation code was returned.");
      return res.redirect(CONFIGURE_URL);
    }

    try {
      await oauth.exchangeCode(liveCfg(), code);
      req.flash("success", "Connected to Google Calendar");
    } catch (e) {
      req.flash("error", e.message);
    }
    res.redirect(CONFIGURE_URL);
  },
};

/** Revoke the tokens and forget them. */
const disconnect = {
  url: "/google-calendar/oauth2/disconnect",
  method: "post",
  callback: async (req, res) => {
    if (denyNonAdmin(req, res)) return;
    try {
      await oauth.disconnect(liveCfg());
      req.flash("success", "Disconnected from Google Calendar");
    } catch (e) {
      req.flash("error", e.message);
    }
    res.redirect(CONFIGURE_URL);
  },
};

module.exports = [authorize, callback, disconnect];
