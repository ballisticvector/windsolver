/**
 * Who is allowed to call `/v1/`.
 *
 * WindSolver's callers are machines — BallisticVector's server today, whoever
 * else tomorrow — so this is API keys, not accounts. There is no user table, no
 * password, no session and no JWT, because there is nobody to log in. A key is
 * a named, long-lived, individually revocable string that identifies a program.
 *
 * **Off unless configured.** No keys means no authentication, which is what a
 * checkout, the suite and a laptop want. Turning it on is one `Environment=`
 * line in the unit, and there is no default key to forget to change: the
 * failure mode where a service ships with `changeme` in it cannot happen if
 * there is nothing to ship.
 *
 * ## What a key cannot do
 *
 * windsolver.com serves a public map page, and that page calls `/v1/field` from
 * a stranger's browser. Any key the page could use would be in view-source, so
 * **an API key cannot protect an endpoint a public page calls.** Pretending
 * otherwise is the interesting mistake here.
 *
 * So there are two doors and they are different doors:
 *
 * - **A named key** — `Authorization: Bearer <key>` or `X-API-Key: <key>` —
 *   which is what every programmatic caller uses, and what a quota, a log line
 *   and a revocation can attach to.
 * - **The page's own fetch**, recognised by `Sec-Fetch-Site: same-origin` — a
 *   header the browser sets and page script cannot. This is *not* a security
 *   boundary: it is one word of `curl`. It is the door that keeps the demo
 *   working, and what actually limits it is the rate limit at the edge. It is
 *   allowed only when `allowPage` is on, so an operator who wants `/v1/`
 *   genuinely closed turns it off and accepts that the page goes with it.
 *
 * Note that a same-origin `GET` does **not** carry `Origin` — browsers send
 * that for CORS and for writes — so the CORS allow-list cannot be reused here;
 * a check written against `Origin` would 401 the very page it was meant to let
 * through, and only in a browser, which is where nobody is running the tests.
 *
 * `/healthz` and the page itself are never gated: a monitor that needs a
 * credential is a monitor that stops being run.
 */

"use strict";

const crypto = require("crypto");

// Short enough to type, long enough that guessing is not the attack. 32 random
// base64url characters is 192 bits; the floor is well under that so a key from
// a password manager's default still fits, but "hunter2" does not.
const MIN_KEY_LENGTH = 24;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * `name:secret` pairs, comma or semicolon separated.
 *
 *   WINDSOLVER_API_KEYS=ballisticvector:8f3c…,ops:2b91…
 *
 * The name is not decoration. A bare list of secrets can only be revoked by
 * revoking all of them, and a log line can only say "a key", which is useless
 * the first time one of two consumers is hammering the box.
 *
 * Anything malformed throws rather than being dropped. A key list that silently
 * loses an entry is a consumer that gets 401 at 3 a.m. for a typo nobody can
 * see, and a key list that silently loses *every* entry is an open service that
 * believes it is closed.
 */
function parseKeys(raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return [];

  const keys = [];
  const seenNames = new Set();
  const seenSecrets = new Set();

  for (const entry of text.split(/[,;]/)) {
    const item = entry.trim();
    if (!item) continue;

    const colon = item.indexOf(":");
    if (colon < 0) {
      throw badConfig("an API key must be written name:secret; got an entry with no colon");
    }
    const name = item.slice(0, colon).trim();
    const secret = item.slice(colon + 1).trim();

    if (!NAME_PATTERN.test(name)) {
      throw badConfig("an API key name must be letters, digits, dot, dash or underscore; got " +
        JSON.stringify(name));
    }
    if (secret.length < MIN_KEY_LENGTH) {
      // The secret is never quoted back, here or anywhere else.
      throw badConfig("the API key for " + name + " is " + secret.length + " characters; " +
        MIN_KEY_LENGTH + " is the minimum");
    }
    if (seenNames.has(name)) {
      throw badConfig("two API keys are both named " + name + "; a name is how one of them is revoked");
    }
    if (seenSecrets.has(secret)) {
      throw badConfig("two API key names share one secret; revoking either would revoke both");
    }

    seenNames.add(name);
    seenSecrets.add(secret);
    keys.push({ name: name, secret: secret, digest: sha256(secret) });
  }

  return keys;
}

function badConfig(message) {
  const err = new Error(message);
  err.code = "bad-api-keys";
  return err;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

/**
 * The presented key, or `null`.
 *
 * Headers only, never the query string: a URL is logged by this service, by
 * nginx, and by every proxy in between, and a secret in a log is a secret.
 */
function presentedKey(headers) {
  const h = headers || {};
  const authorization = h.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
    if (match) return match[1];
    // A header that is present and not a Bearer — Basic, a bare key, a
    // mangled prefix — is a mistake worth naming rather than treating as
    // absent, so it comes back as an empty presentation.
    if (authorization.trim()) return "";
  }
  const direct = h["x-api-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return null;
}

/** Compare without letting the clock say how much of the key was right. */
function secretMatches(key, presented) {
  const a = key.digest;
  const b = sha256(presented);
  return crypto.timingSafeEqual(a, b);
}

/**
 * A request from the page this service serves, rather than from a program.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by page script, so
 * it distinguishes the page's own fetch from a cross-site one — in a browser.
 * It says nothing at all about `curl`, which is why the doc comment at the top
 * of this file calls this a door and not a wall.
 */
function looksLikeThePage(headers) {
  return (headers || {})["sec-fetch-site"] === "same-origin";
}

/**
 * Decide whether a request may have `/v1/`.
 *
 * Returns `{ ok: true, caller }` where `caller` is a key name, `"page"`, or
 * `"anonymous"` when authentication is off — a name for the log line either
 * way, so "who is spending the USGS budget" has an answer.
 */
function createAuth(options) {
  const o = options || {};
  const keys = Array.isArray(o.keys) ? o.keys : parseKeys(o.keys);
  const allowPage = o.allowPage === undefined ? true : Boolean(o.allowPage);
  const enabled = keys.length > 0;

  return {
    enabled: enabled,
    // Names only. The secrets are not exposed from here, so no caller of this
    // module can log them by accident.
    names: keys.map(function (k) { return k.name; }),
    allowPage: allowPage,

    check: function (headers) {
      if (!enabled) return { ok: true, caller: "anonymous" };

      const presented = presentedKey(headers);
      if (presented !== null && presented !== "") {
        for (const key of keys) {
          if (secretMatches(key, presented)) return { ok: true, caller: key.name };
        }
        return {
          ok: false,
          status: 401,
          code: "bad-key",
          error: "that API key is not one this service knows"
        };
      }

      if (allowPage && looksLikeThePage(headers)) {
        return { ok: true, caller: "page" };
      }

      if (presented === "") {
        return {
          ok: false,
          status: 401,
          code: "bad-authorization",
          error: "Authorization must read: Bearer <key>; or send X-API-Key instead"
        };
      }

      return {
        ok: false,
        status: 401,
        code: "no-key",
        error: "this service needs an API key: send Authorization: Bearer <key> or X-API-Key: <key>"
      };
    }
  };
}

module.exports = {
  MIN_KEY_LENGTH,
  parseKeys,
  presentedKey,
  createAuth
};
