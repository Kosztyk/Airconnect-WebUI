# AirConnect Admin

AirConnect Admin is a lightweight sidecar web UI for managing airconnect service.

## What it does

- shows runtime status for the target AirConnect container
- edits `AIRCAST_VAR` and `AIRUPNP_VAR` separately
- recreates the target container with updated env values
- manages separate `/config/aircast.xml` and `/config/airupnp.xml` files
- keeps legacy `/config/config.xml` visible for migration purposes
- validates referenced `-x` config file paths before restart or apply
- warns when logs show `no config file, using defaults`
- warns when `-l 1000:2000` is misplaced on AirCast or missing from AirUPnP-oriented setups
- shows recent AirConnect logs
- infers discovered renderers from container logs
- exports a matching compose snippet

## Preferred runtime layout

This app now assumes the cleaner split below:

- `AIRCAST_VAR=-x /config/aircast.xml`
- `AIRUPNP_VAR=-x /config/airupnp.xml -l 1000:2000`

## What it expects

- Docker socket mounted at `/var/run/docker.sock`
- AirConnect config directory mounted at `/config`
- the target container name set with `TARGET_CONTAINER`

## Build

```bash
docker build -t airconnect-admin:latest .
```

## Run

```bash
docker compose up -d --build
```

Then open:

```text
http://<host-ip>:8089
```

## Important notes

- updating service args recreates the target AirConnect container so the new environment takes effect
- restart and start operations are blocked if an enabled service references a missing `-x` config file
- the app ships starter XML templates with an `<aircast>` root for AirCast and an `<airupnp>` root for AirUPnP; common settings live under `<common>` and per-device overrides can be added later in `<device>` blocks
- discovery is log-based in this version; it does not perform direct mDNS scanning itself
