const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const { getState } = require("@saltcorn/data/db/state");
const { a, div, p, code, form, button } = require("@saltcorn/markup/tags");

const provider = require("./lib/provider");
const actions = require("./lib/actions");
const routes = require("./lib/routes");
const oauth = require("./lib/oauth");
const { redirectUri } = require("./lib/config");

/** Saltcorn's own base URL, so the redirect URI does not have to be retyped. */
const defaultBaseUrl = () => {
  try {
    return getState().getConfig("base_url", "") || "";
  } catch (e) {
    return "";
  }
};

/** The redirect URI, or the reason it cannot be shown yet. */
const redirectUriBlurb = (context) => {
  let uri;
  try {
    uri = redirectUri({ base_url: context.base_url || defaultBaseUrl() });
  } catch (e) {
    return p(
      "Set the base URL above, then save, to see the redirect URI to " +
        "register with Google.",
    );
  }
  return div(
    p(
      "In the Google Cloud console, create an OAuth 2.0 Client ID of type " +
        "Web application, enable the Google Calendar API, and add this exact " +
        "redirect URI:",
    ),
    p(code(uri)),
  );
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Google OAuth client",
        form: async (context) =>
          new Form({
            blurb: redirectUriBlurb(context),
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
        form: async (context) => {
          const connected = oauth.isConnected(context);
          const status = connected
            ? p(
                `Connected${
                  context.connected_at
                    ? ` since ${new Date(context.connected_at).toLocaleString()}`
                    : ""
                }.`,
              )
            : p("Not connected yet.");
          const connectBtn = a(
            {
              href: "/google-calendar/oauth2/authorize",
              class: `btn btn-${connected ? "outline-primary" : "primary"}`,
            },
            connected ? "Reconnect Google account" : "Connect Google account",
          );
          const disconnectBtn = connected
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
            : "";
          return new Form({
            blurb: div(status, connectBtn, disconnectBtn),
            fields: [],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "google-calendar",
  configuration_workflow,
  table_providers: () => ({ "Google Calendar": provider["Google Calendar"] }),
  actions: () => actions,
  routes: () => routes,
};
