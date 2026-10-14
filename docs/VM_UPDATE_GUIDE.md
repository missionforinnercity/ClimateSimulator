# Updating the VM deployment

This guide updates the Conditions checkout and Docker services on the VM. The
deployment checkout used in the recent session is `~/ClimateSimulator`; it is
not `/srv/climateExplorer`.

## 1. Connect and check the checkout

SSH to the VM, then run:

```bash
cd ~/ClimateSimulator
git status --short --branch
git log --oneline --decorate -5
git stash list
```

If `git status` lists edits you still need, stash them before pulling:

```bash
git stash push -u -m "VM work before update"
```

The `-u` option includes untracked files, but not ignored files. Large thermal
and CFD deployment artifacts are kept outside Git; retain those directories
and follow [thermal deployment](THERMAL_DEPLOYMENT.md) if they need updating.

If you already have a stash containing a local fix, inspect it before applying
it:

```bash
git stash list
git stash show --stat 'stash@{0}'
git stash show -p 'stash@{0}'
```

Use the correct stash number if the relevant entry is not `stash@{0}`. Apply a
stash only when its changes are needed on the pulled revision:

```bash
git stash apply 'stash@{0}'
git status --short
```

Resolve any conflicts, then review the resulting diff. `git stash apply` keeps
the stash as a backup; do not drop it until the deployment is verified.

## 2. Pull the latest revision

```bash
git pull --ff-only
git status --short --branch
```

`--ff-only` stops rather than creating a merge if the VM branch has diverged.
If it stops, keep the checkout and stash intact and inspect the reported
commits before deciding how to reconcile them. Do not use `git reset --hard`
to force the update.

## 3. Build and restart the services

The thermal worker image builds the SOLWEIG surface rasters and SUEWS
configuration from the checked-out source. Rebuild both application images
after pulling, then start the services:

```bash
docker compose build app thermal-worker
docker compose up -d
```

Recreate the web proxy after the app container is replaced. This refreshes its
connection to the app service:

```bash
docker compose up -d --force-recreate web
```

The Compose web service listens on `127.0.0.1:18081` by default. The VM's host
Nginx can continue serving the public site on port 8000 and proxying to that
port.

## 4. Check the deployment and UTCI forecast

Check the service state and recent startup logs:

```bash
docker compose ps -a
docker compose logs --tail=100 app thermal-worker web
```

Summarize the thermal endpoint without printing the full forecast manifest:

```bash
curl -fsS http://127.0.0.1:18081/api/thermal/forecast \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("available", "status", "generated_at", "stale", "refresh", "worker")}, indent=2))'
```

When a previous forecast exists, it stays available while the worker computes
the next one. A response with `available: true`, `status: ready`, and
`stale: false` means UTCI data is available. `refresh.phase: solweig` means a
new forecast is still being calculated; it does not mean the published one
has failed. The worker logs `published thermal run ...` when the new forecast
is complete.

On a cold start, no forecast is available until the first full run finishes.
SOLWEIG processes a 1040 by 902 grid across 25 forecast times. The VM may have
no usable GPU, in which case the worker falls back to CPU; the initial run can
take several minutes. Follow progress with:

```bash
docker compose logs -f thermal-worker
```

Pressing Ctrl+C stops following the logs, not the worker. The status file can
also be read while the worker is running:

```bash
docker compose exec thermal-worker cat /var/lib/conditions-thermal/STATUS.json
```

The status timestamp changes when the worker changes phase, not continuously
during a long SOLWEIG calculation. If the forecast endpoint reports
`available: false` with `status: failed`, inspect the `phase` and
`error_code` in the status file and the thermal-worker logs.

If the local curl returns a 502 or connection error, check `docker compose
ps -a` and the `web` and `app` logs. Confirm the web container is up; after
recreating the app, recreate `web` as shown above and retry the curl.

## 5. Open the app

Reload the public site after the local forecast endpoint reports an available
forecast. If the endpoint is ready but UTCI is still unavailable in the
browser, do a hard refresh so the browser loads the current app files.

For heavyweight artifacts that are prepared outside the VM, such as the CFD
browser fields, pedestrian wind atlas, and historical thermal climatology,
use the transfer and verification steps in
[thermal deployment](THERMAL_DEPLOYMENT.md). A source pull alone does not
transfer files that are excluded from Git.
