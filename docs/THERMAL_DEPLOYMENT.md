# Thermal deployment inputs

The UTCI viewer uses three different sets of generated data. They are kept
outside Git and the Docker build context so a normal source checkout does not
carry roughly a gigabyte of CFD fields or operational forecast output.

| Input | Used by | How it is produced | VM path |
| --- | --- | --- | --- |
| Converted 16 direction CFD fields (~1.1 GB) | Browser wind layers | Convert solved OpenFOAM VTK cases with `scripts/convert_openfoam_vtk.py` | `public/assets/cfd/` |
| Pedestrian wind atlas (`manifest.json` + 16 `.npz`, ~36 MB) | Thermal worker and climatology builder | Build from converted fields with `scripts/build_openfoam_pedestrian_atlas.py` | `data/openfoam/atlas/` |
| 2016–2025 climate maps (~66 MB) | API historical UTCI profile | Build with `scripts/build_thermal_climatology.py` | `data/thermal/climatology/` |

The `thermal-worker` image builds the aligned SOLWEIG surfaces and SUEWS site
configuration from the scene and terrain inputs in the checkout. Those files
are baked into the image. Compose does not mount host copies over them. The
worker still needs the separately generated atlas mounted read-only. The
application API only needs the climate map directory mounted read-only. The
near-live hourly products are written to the named `thermal-products` volume;
they are not deployment artifacts and must not be copied from a developer's
stale run.

## Prepare artifacts away from the VM

Use the model workstation that has the converted direction fields and thermal
dependencies. The sixteen browser fields are required by the browser wind
views and as input to the pedestrian atlas. The worker image itself does not
need the native OpenFOAM case directories.

```bash
.venv/bin/python scripts/build_thermal_surfaces.py
.venv/bin/python scripts/build_openfoam_pedestrian_atlas.py \
  public/assets/cfd/cbd_*_full \
  --surfaces data/thermal/surfaces \
  --output data/openfoam/atlas
.venv/bin/python scripts/build_thermal_climatology.py \
  --start-year 2016 --end-year 2025
```

Transfer the browser fields, atlas and climatology to the matching checkout on
the VM. Keep their directory names intact:

```bash
rsync -a --delete public/assets/cfd/ vm:/srv/climateExplorer/public/assets/cfd/
rsync -a --delete data/openfoam/atlas/ vm:/srv/climateExplorer/data/openfoam/atlas/
rsync -a --delete data/thermal/climatology/ vm:/srv/climateExplorer/data/thermal/climatology/
```

Replace `vm` and `/srv/climateExplorer` with the deployment host and checkout
path. The first transfer is large; subsequent rsyncs transfer changed files.
Keep a copy of these directories in the team's artifact backup. Do not run
`--delete` if the source directory is incomplete.

On the VM checkout, verify the transferred directories before starting
Compose:

```bash
.venv/bin/python scripts/verify_thermal_deployment.py
```

## Build and start

On the VM, deploy the source revision and artifacts together. The worker image
installs the pinned model dependencies, builds the thermal surfaces and
generates `data/thermal/suews/config.yml`; it does not run the OpenFOAM solver
or download historical weather. Build and publish app and worker images in CI,
then set `CONDITIONS_APP_IMAGE` and `THERMAL_WORKER_IMAGE` on the VM to avoid
building there.

```bash
docker compose build thermal-worker app
docker compose up -d
docker compose logs -f thermal-worker
```

Set both image variables to published registry tags, then run
`docker compose pull app thermal-worker && docker compose up -d`. In CI, use
the project Compose file with those image tags set in the CI environment, then
run `docker compose build app thermal-worker` and push the two tags with your
registry client.
The browser's 1.1 GB direction fields remain a host artifact because Nginx
serves the read-only `./public` mount. They are not inside the worker image or
the API image. The atlas is mounted read-only from the host into the worker;
the forecast product volume is the only worker-writable data mount.

After startup, verify the deployment:

```bash
docker compose ps
docker compose logs --tail=200 thermal-worker
curl -fsS http://127.0.0.1:${WEB_HOST_PORT:-18080}/api/thermal/forecast
```

If the VM already runs host-level Nginx on public port 8000, keep that listener
and its authentication. Compose exposes its web container on loopback port
18080 by default (`WEB_HOST_PORT` can override this). Configure the existing
host Nginx server for port 8000 to proxy to `http://127.0.0.1:18080`, preserving
any current authentication directives. Confirm the chosen port is free before
starting the Compose `web` service. Do not publish the Compose web service on
port 8000 when host Nginx already owns it.

The API should report a new `generated_at`, `stale: false`, and all 25 frames.
The worker's volume contains `STATUS.json`; on a failure it now records the
short exception message there for diagnosis. The API only exposes the phase
and error type, not that internal message. Use
`docker compose exec thermal-worker cat /var/lib/conditions-thermal/STATUS.json`
to inspect it. A failure during `weather_forcing` points to provider/network
availability; a failure during `suews` means the weather window was assembled
and the failure is in the SUEWS input/run/output path.

## Evidence limits

Near-live UTCI and Tmrt are experimental model estimates. Annual and monthly
profiles use an ERA5 2016–2025 composite, not 10 years of street-level
observations. Keep the validation boundary described in
[`THERMAL_VALIDATION.md`](THERMAL_VALIDATION.md) visible in planning exports.
