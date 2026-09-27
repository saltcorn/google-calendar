const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const { getState } = require("@saltcorn/data/db/state");
const {
  a,
  div,
  p,
  code,
  form,
  button,
  ol,
  li,
  span,
  strong,
} = require("@saltcorn/markup/tags");

const provider = require("./lib/provider");
const actions = require("./lib/actions");
const routes = require("./lib/routes");
const oauth = require("./lib/oauth");
const { CALLBACK_PATH } = require("./lib/config");

console.log("*****", getState().getConfig("base_url"));

/** Saltcorn's own base URL, so the redirect URI does not have to be retyped. */
const defaultBaseUrl = () => {
  try {
    return getState().getConfig("base_url", "") || "";
  } catch (e) {
    return "";
  }
};

const CONSOLE_URL =
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";
const PLACEHOLDER_HOST = "https://your-saltcorn-host";

/**
 * Whether the redirect URI on screen is the real one.
 *
 * Without a base URL the shown URI carries PLACEHOLDER_HOST, and calling that
 * "exact" tells people to register a value that cannot work.
 */
const haveBaseUrl = (context) => !!(context.base_url || defaultBaseUrl());

/** The redirect URI for a base URL, or a placeholder showing its shape. */
const uriFor = (baseUrl) => {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return `${base || PLACEHOLDER_HOST}${CALLBACK_PATH}`;
};

/**
 * Keep the shown redirect URI in step with the base URL field as it is typed.
 *
 * Without this the URI only appears once the base URL has been saved, which
 * means leaving the step and coming back. Most people don't, and meet
 * `Error 400: redirect_uri_mismatch` instead.
 *
 * Written without a regex literal: this is a template literal, so a `\/`
 * inside it would be unescaped to `/` before the browser ever saw it.
 */
const liveUriScript = () =>
  `<script>
(function () {
  var inp = document.getElementById("inputbase_url");
  var out = document.getElementById("gcal-redirect-uri");
  var exact = document.getElementById("gcal-uri-exact");
  var provisional = document.getElementById("gcal-uri-provisional");
  if (!inp || !out) return;
  function update() {
    var b = inp.value || "";
    while (b.charAt(b.length - 1) === "/") b = b.slice(0, -1);
    out.textContent = (b || "${PLACEHOLDER_HOST}") + "${CALLBACK_PATH}";
    if (!exact || !provisional) return;
    exact.classList.toggle("d-none", !b);
    provisional.classList.toggle("d-none", !!b);
  }
  inp.addEventListener("input", update);
  update();
})();
</script>`;

/**
 * The Google Cloud side of the setup. Shown in full on the first step, so
 * nothing here depends on having saved anything yet.
 *
 * Returned as an array: Form renders an array blurb verbatim, where a single
 * string is wrapped in a <p>.
 */
const setupBlurb = (context) => [
  div(
    { class: "mb-3" },
    p(
      "In the ",
      a({ href: CONSOLE_URL, target: "_blank" }, "Google Cloud console"),
      ":",
    ),
    ol(
      li(
        "Enable the ",
        strong("Google Calendar API"),
        " for your project. Nothing below works until this is on.",
      ),
      li(
        "Under ",
        strong("APIs & Services → Credentials"),
        ", create an ",
        strong("OAuth 2.0 Client ID"),
        " of type ",
        strong("Web application"),
        ".",
      ),
      li(
        "Add this URI under ",
        strong("Authorised redirect URIs"),
        ":",
        div(
          { class: "my-2" },
          code(
            { id: "gcal-redirect-uri", class: "user-select-all" },
            uriFor(context.base_url || defaultBaseUrl()),
          ),
        ),
        span(
          {
            id: "gcal-uri-exact",
            class: `text-muted${haveBaseUrl(context) ? "" : " d-none"}`,
          },
          "Register it exactly as shown - character for character, including " +
            "scheme and port.",
        ),
        span(
          {
            id: "gcal-uri-provisional",
            class: `text-muted${haveBaseUrl(context) ? " d-none" : ""}`,
          },
          "The host shown is a placeholder. Fill in the base URL below and " +
            "this becomes the exact URI to register.",
        ),
      ),
      li("Paste the client ID and secret below."),
    ),
  ),
  liveUriScript(),
];

/** Shown on the Connect step, where the base URL is already saved. */
const connectBlurb = (context) => {
  const connected = oauth.isConnected(context);
  const uri = uriFor(context.base_url || defaultBaseUrl());
  return [
    div(
      { class: "mb-3" },
      p(
        connected
          ? `Connected${
              context.connected_at
                ? ` since ${new Date(context.connected_at).toLocaleString()}`
                : ""
            }.`
          : "Not connected yet.",
      ),
      p(
        { class: "text-muted mb-1" },
        haveBaseUrl(context)
          ? "The redirect URI registered with Google must be exactly:"
          : "No base URL is set, so this is not the URI to register - the " +
              "host is a placeholder. Set the base URL on the previous step:",
      ),
      p(code({ class: "user-select-all" }, uri)),
      p(
        { class: "text-muted" },
        "If Google reports ",
        code("access_denied"),
        " and mentions approved testers, add your Google account under ",
        strong("Audience → Test users"),
        ". Note that a Testing-status app with an external user type gets a " +
          "refresh token that expires after 7 days; publish the app, or use " +
          "an Internal user type, to avoid reconnecting weekly.",
      ),
      a(
        {
          href: "/google-calendar/oauth2/authorize",
          class: `btn btn-${connected ? "outline-primary" : "primary"}`,
        },
        connected ? "Reconnect Google account" : "Connect Google account",
      ),
      connected
        ? form(
            {
              action: "/google-calendar/oauth2/disconnect",
              method: "post",
              class: "d-inline ms-2",
            },
            button(
              { type: "submit", class: "btn btn-outline-danger" },
              "Disconnect",
            ),
          )
        : "",
    ),
  ];
};

const configuration_workflow = () => {
  console.log(defaultBaseUrl());
  return new Workflow({
    steps: [
      {
        name: "Google OAuth client",
        form: async (context) =>
          new Form({
            blurb: setupBlurb(context),
            fields: [
              {
                name: "base_url",
                label: "Base URL",
                sublabel:
                  "This Saltcorn instance's public URL. Defaults to the one " +
                  "in the site settings.",
                type: "String",
                required: true,
                default: defaultBaseUrl(),
              },
              {
                name: "client_id",
                label: "Client ID",
                type: "String",
                required: true,
              },
              {
                name: "client_secret",
                label: "Client secret",
                type: "String",
                required: true,
                input_type: "password",
              },
              {
                name: "read_only",
                label: "Read only",
                sublabel:
                  "Request read-only access. Provider tables and actions can " +
                  "then read events but not create, change or delete them.",
                type: "Bool",
                default: false,
              },
              {
                name: "send_updates",
                label: "Notify attendees by default",
                sublabel:
                  "Used by provider table writes. The actions ask per action.",
                type: "String",
                attributes: { options: ["none", "externalOnly", "all"] },
                default: "none",
              },
            ],
          }),
      },
      {
        name: "Connect",
        form: async (context) =>
          new Form({ blurb: connectBlurb(context), fields: [] }),
      },
    ],
  });
};

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "google-calendar",
  configuration_workflow,
  table_providers: () => ({ "Google Calendar": provider["Google Calendar"] }),
  actions: () => actions,
  routes: () => routes,
};
