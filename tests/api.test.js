const test = require("node:test");
const assert = require("node:assert");
// required as a namespace, not destructured, so the token source can be
// substituted here without touching Google
const oauth = require("../lib/oauth");
const api = require("../lib/api");

const CFG = { oauth: { access_token: "tok", expires_at: Date.now() + 3.6e6 } };

/** Replace token fetching for the duration of one test. */
const withStubbedToken = async (fn) => {
  const real = oauth.getAccessToken;
  const forced = [];
  oauth.getAccessToken = async (cfg, force) => {
    forced.push(!!force);
    return "tok";
  };
  try {
    return await fn(forced);
  } finally {
    oauth.getAccessToken = real;
  }
};

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k] ?? null },
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

test("a 204 becomes an empty object rather than a parse error", async () => {
  await withStubbedToken(async () => {
    const out = await api.apiFetch("/x", {
      cfg: CFG,
      fetchImpl: async () => reply(204),
    });
    assert.deepEqual(out, {});
  });
});

test("undefined and empty query values are dropped", async () => {
  await withStubbedToken(async () => {
    let seen;
    await api.apiFetch("/x", {
      cfg: CFG,
      query: { a: 1, b: undefined, c: null, d: "" },
      fetchImpl: async (url) => {
        seen = new URL(url);
        return reply(200, {});
      },
    });
    assert.equal(seen.searchParams.get("a"), "1");
    assert.equal(seen.searchParams.has("b"), false);
    assert.equal(seen.searchParams.has("c"), false);
    assert.equal(seen.searchParams.has("d"), false);
  });
});

test("a 401 forces one token refresh and retries", async () => {
  await withStubbedToken(async (forced) => {
    let n = 0;
    const out = await api.apiFetch("/x", {
      cfg: CFG,
      fetchImpl: async () => (++n === 1 ? reply(401, { error: { message: "bad" } }) : reply(200, { ok: 1 })),
    });
    assert.deepEqual(out, { ok: 1 });
    assert.equal(n, 2);
    assert.deepEqual(forced, [false, true], "second attempt forces a refresh");
  });
});

test("a second 401 gives up instead of looping", async () => {
  await withStubbedToken(async () => {
    let n = 0;
    await assert.rejects(
      api.apiFetch("/x", {
        cfg: CFG,
        fetchImpl: async () => {
          n++;
          return reply(401, { error: { message: "still bad" } });
        },
      }),
      /still bad/,
    );
    assert.equal(n, 2);
  });
});

test("a 429 is retried, honouring Retry-After", async () => {
  await withStubbedToken(async () => {
    let n = 0;
    const out = await api.apiFetch("/x", {
      cfg: CFG,
      fetchImpl: async () =>
        ++n === 1
          ? reply(429, { error: { message: "slow down" } }, { "retry-after": "0" })
          : reply(200, { ok: 2 }),
    });
    assert.deepEqual(out, { ok: 2 });
    assert.equal(n, 2);
  });
});

test("a quota 403 is retried but a permissions 403 is not", async () => {
  await withStubbedToken(async () => {
    let n = 0;
    await api.apiFetch("/x", {
      cfg: CFG,
      fetchImpl: async () =>
        ++n === 1
          ? reply(
              403,
              { error: { message: "quota", errors: [{ reason: "rateLimitExceeded" }] } },
              { "retry-after": "0" },
            )
          : reply(200, { ok: 3 }),
    });
    assert.equal(n, 2, "rate-limit 403 retries");
  });

  await withStubbedToken(async () => {
    let n = 0;
    await assert.rejects(
      api.apiFetch("/x", {
        cfg: CFG,
        fetchImpl: async () => {
          n++;
          return reply(403, {
            error: { message: "no", errors: [{ reason: "insufficientPermissions" }] },
          });
        },
      }),
      /Read only/,
    );
    assert.equal(n, 1, "a scope problem is not retried");
  });
});

test("a 404 explains which thing is missing", async () => {
  await withStubbedToken(async () => {
    await assert.rejects(
      api.apiFetch("/calendars/x/events/y", {
        cfg: CFG,
        fetchImpl: async () => reply(404, { error: { message: "Not Found" } }),
      }),
      /no longer exists/,
    );
  });
});

test("eachPage stops when the callback returns false", async () => {
  await withStubbedToken(async () => {
    let n = 0;
    const seen = [];
    await api.eachPage(
      "/x",
      {},
      (items) => {
        seen.push(...items);
        return false;
      },
      {
        cfg: CFG,
        fetchImpl: async () => {
          n++;
          return reply(200, { items: [{ id: n }], nextPageToken: "more" });
        },
      },
    );
    assert.equal(n, 1);
    assert.equal(seen.length, 1);
  });
});

test("a 400 surfaces the per-property errors, not just 'Bad Request'", async () => {
  await withStubbedToken(async () => {
    await assert.rejects(
      api.apiFetch("/calendars/x/events", {
        cfg: CFG,
        method: "POST",
        body: {},
        fetchImpl: async () =>
          reply(400, {
            error: {
              message: "Bad Request",
              errors: [{ reason: "invalid", message: "Invalid value for: visibility" }],
            },
          }),
      }),
      /Invalid value for: visibility/,
    );
  });
});
