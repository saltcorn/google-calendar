const test = require("node:test");
const assert = require("node:assert");
const plugin = require("../index.js");
const routes = require("../lib/routes");
const { CALLBACK_PATH, redirectUri } = require("../lib/config");

const blurbOf = async (stepIx, context) => {
  const step = plugin.configuration_workflow().steps[stepIx];
  const form = await step.form(context);
  return Array.isArray(form.blurb) ? form.blurb.join("") : form.blurb;
};

test("the advertised redirect URI and the registered route cannot drift", () => {
  // These are what a redirect_uri_mismatch is: the URI we tell people to
  // register, and the path we actually listen on, disagreeing.
  const registered = routes.map((r) => r.url);
  assert.ok(
    registered.includes(CALLBACK_PATH),
    `no route serves ${CALLBACK_PATH}; registered: ${registered.join(", ")}`,
  );
  assert.equal(
    redirectUri({ base_url: "https://example.com" }),
    `https://example.com${CALLBACK_PATH}`,
  );
});

test("step 1 says to enable the Calendar API", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /Google Calendar API/);
  assert.match(b, /calendar-json\.googleapis\.com/, "links to the right console page");
});

test("step 1 shows the redirect URI before anything has been saved", async () => {
  // The whole point: no round trip through the next step to see it.
  const b = await blurbOf(0, {});
  assert.match(b, new RegExp(CALLBACK_PATH.replace(/\//g, "\\/")));
  assert.match(b, /your-saltcorn-host/, "shows the shape when the host is unknown");
});

test("step 1 shows the real URI once a base URL is known", async () => {
  const b = await blurbOf(0, { base_url: "http://localhost:3000/" });
  assert.match(b, /http:\/\/localhost:3000\/google-calendar\/oauth2\/callback/);
  assert.equal(
    /your-saltcorn-host\/google-calendar/.test(b),
    false,
    "the placeholder should be replaced, not shown alongside",
  );
});

test("a trailing slash on the base URL does not double up", async () => {
  const b = await blurbOf(0, { base_url: "http://localhost:3000///" });
  assert.equal(/3000\/\/+google-calendar/.test(b), false);
});

test("step 1 ships the script that keeps the URI live while typing", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /getElementById\("inputbase_url"\)/);
  assert.match(b, /addEventListener\("input"/);
  // a regex literal in the generating template would have been unescaped
  assert.equal(/replace\(\/\/\+\$\//.test(b), false, "no mangled regex reached the browser");
});

test("step 2 repeats the URI and offers the connect button", async () => {
  const b = await blurbOf(1, { base_url: "http://localhost:3000" });
  assert.match(b, /http:\/\/localhost:3000\/google-calendar\/oauth2\/callback/);
  assert.match(b, /oauth2\/authorize/);
  assert.match(b, /Connect Google account/);
  assert.match(b, /Not connected yet/);
});

test("step 2 reflects an existing connection and offers disconnect", async () => {
  const b = await blurbOf(1, {
    base_url: "http://localhost:3000",
    oauth: { refresh_token: "r" },
    connected_at: "2026-09-27T10:00:00.000Z",
  });
  assert.match(b, /Connected since/);
  assert.match(b, /Reconnect Google account/);
  assert.match(b, /oauth2\/disconnect/);
});

test("step 2 warns about the two things that actually block people", async () => {
  const b = await blurbOf(1, { base_url: "http://localhost:3000" });
  assert.match(b, /Test users/, "the access_denied cause");
  assert.match(b, /7 days/, "the Testing-mode refresh token expiry");
});

/** Is the element with this id rendered visible, i.e. without d-none? */
const visible = (html, id) => {
  const m = html.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`));
  assert.ok(m, `no element with id ${id}`);
  return !/\bd-none\b/.test(m[1]);
};

test("the instruction does not call the URI exact on its own", async () => {
  // "this exact URI" was a claim about whatever happened to be on screen,
  // including the placeholder. The precision now lives in the note below,
  // which knows which of the two is showing.
  const b = await blurbOf(0, {});
  assert.equal(/exact URI under/.test(b), false);
  assert.match(b, /Add this URI under/);
});

test("with no base URL, the URI is labelled a placeholder, not exact", async () => {
  const b = await blurbOf(0, {});
  assert.equal(visible(b, "gcal-uri-exact"), false, "must not promise exactness");
  assert.equal(visible(b, "gcal-uri-provisional"), true);
});

test("with a base URL, the URI is labelled exact", async () => {
  const b = await blurbOf(0, { base_url: "http://localhost:3000" });
  assert.equal(visible(b, "gcal-uri-exact"), true);
  assert.equal(visible(b, "gcal-uri-provisional"), false);
});

test("the live script swaps the two notes as well as the URI", async () => {
  const b = await blurbOf(0, {});
  assert.match(b, /getElementById\("gcal-uri-exact"\)/);
  assert.match(b, /getElementById\("gcal-uri-provisional"\)/);
  assert.match(b, /classList\.toggle\("d-none"/);
});

test("the Connect step only promises exactness when it can", async () => {
  const known = await blurbOf(1, { base_url: "http://localhost:3000" });
  assert.match(known, /must be exactly/);

  const unknown = await blurbOf(1, {});
  assert.equal(/must be exactly/.test(unknown), false);
  assert.match(unknown, /is not the URI to register/);
  assert.match(unknown, /placeholder/);
});
