# Deploying windsolver.com

The public service is one systemd unit and one nginx vhost on the droplet that
already carries ballisticvector.com and its staging site. Nothing here touches
those two.

```
windsolver.com          nginx vhost, TLS by certbot, apex + www
  /                     proxied to the service, which serves public/
  /healthz              proxied
  /v1/*                 proxied, 20 req/min and 4 connections per IP

127.0.0.1:8099          systemd unit `windsolver`, user `deploy`
/home/deploy/windsolver the tree that runs
```

**The page and the API are the same process.** `tools/serve.js` serves `public/`
through the same static handler the API route lives behind, so nginx has nothing
to serve off disk and there is no second copy of the page to drift out of step
with the service it talks to. A deploy is one tree.

## Releasing

`.github/workflows/deploy.yml`, run by hand from the Actions tab on `main`.
It runs CI, builds a tarball of the tree (no `.git`, `node_modules`, `tests` or
`.agents`), copies it over SSH, installs production dependencies, restarts the
unit, checks `/healthz` on the box and then checks the page and the API through
nginx and TLS. On success it force-moves a `production` tag to the deployed
commit, so the next release can show what it would add.

There is no staging tier and therefore no staged-commit gate like
BallisticVector's. The button is the whole ceremony. Add one before there are
users who would notice a bad minute.

### The unit is in the repository; installing it is not the deploy's job

`deploy/windsolver.service` is the source of truth, and the first thing the
deploy does on the box is `diff` it against `/etc/systemd/system/windsolver.service`
and refuse the release if they differ — before unpacking, so a refusal leaves
the droplet exactly as it was. `tests/unit-file.test.js` grades the file itself:
hardening that closes `~/.cache` has to name a cache directory systemd creates,
`ExecStart` has to name a file this repository ships, and so on. Both of those
exist because the configuration that broke the listing cache lived in one place,
had no history, and could not be reviewed.

Installing a change is deliberately a person's job:

```
sudo install -m 0644 deploy/windsolver.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart windsolver
```

A deploy that could write a unit and restart it could write any `ExecStart` it
liked — that is root on the droplet wearing a service account's name, handed to
anyone who can read one GitHub secret. Refusing to release is the safe half of
the loop: drift becomes impossible to miss without widening what the key can do.

### What the repository needs before it can run

Three secrets on the `production` environment, the same values BallisticVector
already uses for the same droplet:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | the droplet's IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the private key whose public half is in `deploy`'s `authorized_keys` |

The droplet also needs `deploy` to be able to restart the unit without a
password. That is one file, already in place:

```
# /etc/sudoers.d/windsolver-deploy, mode 0440
deploy ALL=(root) NOPASSWD: /bin/systemctl restart windsolver, \
                            /bin/systemctl status windsolver, \
                            /bin/systemctl is-active windsolver
```

Scoped to those three commands: a deploy key that can restart one service is a
smaller thing to lose than one that can run anything.

## Keeping the demo warm

A cold field over new ground is a 3DEP product search, COG window reads and an
HRRR pull — 23–33 s measured on a good minute, and past the service's own 45 s
ceiling when The National Map is having a bad one. Warm, it is about 0.6 s. So
the unit names the places worth keeping warm:

```
Environment=WINDSOLVER_PREWARM=40.0150,-105.2705
```

Semicolon-separated `lat,lon[,radiusMiles]`. The service warms them one at a
time through its own port after it starts listening, then every 30 minutes,
because a new HRRR cycle gives every cached field a new valid time. A place that
times out is retried in a minute rather than in half an hour: the service
abandons the wait at 45 s, not the work, so the solve is usually in the cache by
then. `prewarm.js` has the reasoning.

**This does not make a cold solve faster.** It moves who waits for it from a
visitor to a timer, and only for the places that are named. The first request
over ground nobody listed is still a cold one.

## Where the product listing is cached

The National Map's product search — the 29 s that is not data — is kept on disk
across restarts. The default is `~/.cache/windsolver/tnm` for the user the unit
runs as, **and on this droplet that default cannot work**: the unit carries
`ProtectHome=read-only`, so every write into `deploy`'s home fails and the cache
does nothing at all while looking exactly like one that is working. Two lines
fix it, and they are in the unit:

```
CacheDirectory=windsolver
Environment=WINDSOLVER_CACHE_DIR=/var/cache/windsolver
```

`CacheDirectory=` is what creates `/var/cache/windsolver` owned by the service
user; `ProtectSystem=full` leaves `/var` writable, so no hardening has to be
given up to get a cache. Measured on the box afterwards, with the in-memory
terrain cache emptied by a restart each time: 3.7 s for a box whose listing was
already on disk against 23–45 s cold, a pin moved 40 m reused the same entry
because the listing query is snapped to 0.05°, and a repeat is 0.06 s.

If a future unit loses the cache directory the service now says so once, on
stderr, naming the directory and the errno — a silent cache is the failure that
cost a deployment here. It is also the reason the unit is in the repository and
graded by a test: one stderr line nobody is watching for is a poor last line of
defence against a config nobody can review.

Losing the directory costs one slow solve per box, not correctness: an entry
that cannot be read is a miss, and failures were never written in the first
place. Deleting it is the way to pick up a project that has just been re-flown
sooner than the 14-day expiry.

## Who may call `/v1/`

Off unless configured. One line in the unit turns it on:

```
Environment=WINDSOLVER_API_KEYS=ballisticvector:<secret>,ops:<secret>
```

Pairs are `name:secret`, comma or semicolon separated, and the name is how one
consumer is revoked without revoking the others and how a log line says who
spent the USGS budget. Generate a secret with `openssl rand -base64 32`; under
24 characters is refused, and so is a malformed list — the service exits rather
than starting open while an operator believes it is closed. **The secret goes in
the unit on the droplet and nowhere in this repository**, which is the one place
`deploy/windsolver.service` is deliberately not the whole truth: the tracked copy
carries the line commented out, and the deploy's drift check compares the file
ignoring `WINDSOLVER_API_KEYS`.

A caller sends `Authorization: Bearer <key>` or `X-API-Key: <key>`. Never a
query parameter — this service's log, nginx's log and every proxy in between
keep URLs — and one sent that way is redacted on the way to the log and refused.

`/healthz` and the page stay open. A monitor that needs a credential is a
monitor that stops being run.

### The map page is the awkward part, and it is not solved by a key

windsolver.com serves a public map page that calls `/v1/field` **from a
stranger's browser**. Any key that page could use would be in view-source, so an
API key cannot protect an endpoint a public page calls. What the service does
instead is let through a request carrying `Sec-Fetch-Site: same-origin`, a
header the browser sets and page script cannot.

**That is a door, not a wall** — it is one header of `curl`. It keeps the demo
working; what limits abuse through it is still nginx's 20 requests a minute.
Closing it is `Environment=WINDSOLVER_PAGE_NEEDS_KEY=1`, and the map page stops
working for everyone at the same moment, which is the honest trade and the
reason it is a separate switch. A browser too old to send `Sec-Fetch-*` (Safari
before 16.4) is treated as a program and refused.

## What is not here

- **No per-caller quota and no key issuance.** Keys are a list in the unit:
  adding or revoking one is an edit and a restart, there is no dashboard, and
  the rate limit is per IP at the edge rather than per key. That is the right
  size for one consumer; a second one, or a paid tier, is when it stops being.
- **No rollback step.** Re-running the workflow on an earlier commit is the
  rollback, which is fine while a release is a tarball and a restart.
- **No comparison with a measured wind**, which is why the page says
  "Modelled, not measured" and why nothing here claims accuracy.
