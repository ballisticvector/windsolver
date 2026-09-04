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
cost a deployment here.

Losing the directory costs one slow solve per box, not correctness: an entry
that cannot be read is a miss, and failures were never written in the first
place. Deleting it is the way to pick up a project that has just been re-flown
sooner than the 14-day expiry.

## What is not here

- **No authentication and no per-caller quota.** The edge limits above are all
  that stands between the service and a stranger spending your USGS and NOMADS
  bandwidth, and the page is `noindex`. Machine API keys before the URL is
  advertised; see the README.
- **No rollback step.** Re-running the workflow on an earlier commit is the
  rollback, which is fine while a release is a tarball and a restart.
- **No comparison with a measured wind**, which is why the page says
  "Modelled, not measured" and why nothing here claims accuracy.
