/**
 * The key list and the two doors.
 *
 * The HTTP end of this is in `server.test.js`; here is the part that decides
 * what a key even is. The failures worth catching are the quiet ones — a list
 * that loses an entry, a comparison that leaks through the clock, a secret that
 * ends up somewhere readable — because a noisy one is a 401 somebody fixes in a
 * minute.
 */

"use strict";

const auth = require("../auth.js");

const KEY = "a-long-enough-key-0123456789";
const KEY2 = "another-long-enough-key-0123";

describe("reading a key list", () => {
  test("names and secrets, comma or semicolon separated", () => {
    const keys = auth.parseKeys(" ballisticvector:" + KEY + " ; ops:" + KEY2 + " ");
    expect(keys.map((k) => k.name)).toEqual(["ballisticvector", "ops"]);
    expect(keys[0].secret).toBe(KEY);
  });

  test("nothing configured is no keys, not an error", () => {
    // This is the default the service ships with, and it has to be the quiet
    // one: authentication is opt-in.
    expect(auth.parseKeys(undefined)).toEqual([]);
    expect(auth.parseKeys("")).toEqual([]);
    expect(auth.parseKeys("   ")).toEqual([]);
  });

  test("a secret containing a colon survives, because generators emit them", () => {
    const keys = auth.parseKeys("ops:" + KEY + ":tail");
    expect(keys[0].name).toBe("ops");
    expect(keys[0].secret).toBe(KEY + ":tail");
  });

  test("a malformed entry is refused rather than dropped", () => {
    // Dropping one entry is a consumer that 401s for a typo nobody can see;
    // dropping every entry is an open service that believes it is closed.
    expect(() => auth.parseKeys("justasecretwithnoname")).toThrow(/name:secret/);
    expect(() => auth.parseKeys("bad name:" + KEY)).toThrow(/name must be/);
  });

  test("a short secret is refused, and is not quoted in the message", () => {
    let message = "";
    try {
      auth.parseKeys("ops:hunter2");
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/24 is the minimum/);
    expect(message).not.toContain("hunter2");
  });

  test("two names sharing a secret is refused", () => {
    // Otherwise revoking one consumer silently revokes the other, which is
    // discovered in production by the consumer that was not being revoked.
    expect(() => auth.parseKeys("a:" + KEY + ",b:" + KEY)).toThrow(/revoking either/);
    expect(() => auth.parseKeys("a:" + KEY + ",a:" + KEY2)).toThrow(/both named/);
  });
});

describe("finding the key on a request", () => {
  test("Bearer, in any case, with any run of spaces", () => {
    expect(auth.presentedKey({ authorization: "Bearer " + KEY })).toBe(KEY);
    expect(auth.presentedKey({ authorization: "bearer\t" + KEY })).toBe(KEY);
    expect(auth.presentedKey({ authorization: "  BEARER   " + KEY + "  " })).toBe(KEY);
  });

  test("X-API-Key, for a client whose Authorization is spoken for", () => {
    expect(auth.presentedKey({ "x-api-key": " " + KEY + " " })).toBe(KEY);
  });

  test("an Authorization that is not a Bearer is an empty presentation, not absence", () => {
    expect(auth.presentedKey({ authorization: "Basic abc" })).toBe("");
    expect(auth.presentedKey({ authorization: "Bearer" })).toBe("");
  });

  test("no header at all is absence", () => {
    expect(auth.presentedKey({})).toBe(null);
    expect(auth.presentedKey(undefined)).toBe(null);
  });
});

describe("the decision", () => {
  test("no keys configured lets everything through, under a name", () => {
    const gate = auth.createAuth({ keys: "" });
    expect(gate.enabled).toBe(false);
    expect(gate.check({})).toEqual({ ok: true, caller: "anonymous" });
  });

  test("a matching key names the caller", () => {
    const gate = auth.createAuth({ keys: "ops:" + KEY });
    expect(gate.check({ authorization: "Bearer " + KEY })).toEqual({ ok: true, caller: "ops" });
  });

  test("a prefix of a real key is not a key", () => {
    const gate = auth.createAuth({ keys: "ops:" + KEY });
    expect(gate.check({ authorization: "Bearer " + KEY.slice(0, -1) }).ok).toBe(false);
  });

  test("the secrets cannot be read back off the gate", () => {
    // Whatever logs the startup line should not be able to print a key by
    // reaching for the obvious property.
    const gate = auth.createAuth({ keys: "ops:" + KEY });
    expect(gate.names).toEqual(["ops"]);
    expect(JSON.stringify(gate)).not.toContain(KEY);
  });

  test("the page door is the one header, and only when it is open", () => {
    const open = auth.createAuth({ keys: "ops:" + KEY });
    expect(open.check({ "sec-fetch-site": "same-origin" })).toEqual({ ok: true, caller: "page" });
    expect(open.check({ "sec-fetch-site": "cross-site" }).ok).toBe(false);
    // An Origin the operator allows for CORS is not a credential: a same-origin
    // GET does not even carry one.
    expect(open.check({ origin: "https://windsolver.com" }).ok).toBe(false);

    const shut = auth.createAuth({ keys: "ops:" + KEY, allowPage: false });
    expect(shut.check({ "sec-fetch-site": "same-origin" }).ok).toBe(false);
  });

  test("a wrong key stays wrong even from the page", () => {
    // Otherwise a consumer whose key has been revoked gets back in by sending
    // one browser header, and the revocation means nothing.
    const gate = auth.createAuth({ keys: "ops:" + KEY });
    const answer = gate.check({ authorization: "Bearer nope-nope-nope", "sec-fetch-site": "same-origin" });
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("bad-key");
  });

  test("every refusal is a 401 with a code and a sentence", () => {
    const gate = auth.createAuth({ keys: "ops:" + KEY });
    for (const headers of [{}, { authorization: "Basic x" }, { authorization: "Bearer wrong-key-here" }]) {
      const answer = gate.check(headers);
      expect(answer.status).toBe(401);
      expect(answer.code).toEqual(expect.any(String));
      expect(answer.error).toMatch(/[a-z]/);
      expect(answer.error).not.toContain(KEY);
    }
  });
});
