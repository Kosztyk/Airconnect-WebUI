# AirConnect Admin

AirConnect Admin is a lightweight web interface and sidecar container for managing an existing [`1activegeek/airconnect`](https://hub.docker.com/r/1activegeek/airconnect) deployment.

It is designed for homelab and self-hosted environments where AirConnect is already running and you want a safer, easier way to:

- inspect the runtime state of the AirConnect container
- review recent AirConnect logs
- manage separate `aircast.xml` and `airupnp.xml` files from a browser
- update `AIRCAST_VAR` and `AIRUPNP_VAR` without manually editing container definitions
- restart, start, or stop the target container from the UI
- generate starter XML files for AirCast and AirUPnP
- view discovered devices inferred from runtime logs and config data
- export a ready-to-use Docker Compose snippet based on the active runtime settings

AirConnect Admin does **not** replace the AirConnect container. It works alongside it as a management layer.

---

## Why this project exists

AirConnect is extremely useful, but routine management can be inconvenient when you need to:

- remember the correct startup variables for AirCast and AirUPnP
- edit XML files inside a mounted config directory
- validate that the `-x` configuration paths actually exist
- detect when AirConnect has fallen back to defaults because a config file was missing
- review device discovery without manually parsing container logs

AirConnect Admin addresses those pain points by providing a focused browser-based control plane for a single target AirConnect container.

---

## Main features

### Runtime management

- Shows whether the target AirConnect container is running
- Displays the current image, container name, and start time
- Allows you to restart, start, or stop the AirConnect container from the UI
- Recreates the AirConnect container when service environment variables are updated, so changes take effect immediately
<img width="1902" height="659" alt="Screenshot 2026-03-30 at 14 03 22" src="https://github.com/user-attachments/assets/0d989656-323c-40eb-8c44-0297d9f671a3" />

### AirCast and AirUPnP service argument management

- Edits `AIRCAST_VAR` and `AIRUPNP_VAR` independently
- Supports enabling or disabling either service
- Applies recommended defaults when fields are empty
- Detects common mistakes such as:
  - AirCast pointing to `airupnp.xml`
  - AirUPnP pointing to `aircast.xml`
  - missing config files referenced with `-x`
  - AirUPnP missing the `-l` latency option in Sonos/HEOS-oriented setups
  - AirCast using the `-l` latency option unnecessarily

### Config file management

- Reads and writes:
  - `/config/aircast.xml`
  - `/config/airupnp.xml`
  - `/config/config.xml` (legacy visibility / migration support)
- Validates XML root elements before saving
- Generates starter AirCast and AirUPnP XML templates from the UI
- Can optionally restart the AirConnect container after saving a config file

### Discovery view

- Shows devices inferred from AirConnect runtime logs
- Merges what was seen in logs with devices defined in config files
- Helps identify renderer names, IPs, ports, MAC addresses, and origin source
- Intended as an operational visibility feature for your AirConnect environment
<img width="1902" height="659" alt="Screenshot 2026-03-30 at 14 03 32" src="https://github.com/user-attachments/assets/a1e515c4-ae91-43f1-af04-f63e0424cb44" />

### Logs and deployment helpers

- Displays recent container logs directly in the web UI
- Warns when logs indicate AirConnect started with defaults because a config file was not found
- Generates a Docker Compose example based on the currently active runtime values

---

## Architecture

Typical layout:

- **AirConnect container** runs the actual AirCast / AirUPnP bridge services
- **AirConnect Admin** runs as a separate container
- both containers share the same `/config` directory
- AirConnect Admin talks to Docker through `/var/run/docker.sock`
- AirConnect Admin targets one container, defined by `TARGET_CONTAINER`

This design keeps AirConnect itself simple while allowing the admin UI to manage runtime settings and config files externally.

---

## Recommended configuration layout

The preferred split configuration is:

- `AIRCAST_VAR=-x /config/aircast.xml`
- `AIRUPNP_VAR=-x /config/airupnp.xml -l 1000:2000`

This is cleaner than keeping everything in a legacy shared `config.xml`, and makes troubleshooting much easier.

---

## Requirements

Before deploying, make sure you have:

- Docker installed
- Docker Compose available (`docker compose`)
- an existing AirConnect image you want to manage
- a writable config directory that both containers can access
- permission to mount the Docker socket into AirConnect Admin

### Required mounts

AirConnect Admin expects:

- `CONFIG_DIR=/config`
- `/config` mounted to the same host directory used by the AirConnect container
- `/var/run/docker.sock:/var/run/docker.sock`

### Required environment variable

- `TARGET_CONTAINER` must match the name of the AirConnect container you want to control

---

## Example `docker-compose.yml`

The following example uses the exact service layout requested:

```yaml
services:
  airconnect:
    image: 1activegeek/airconnect
    container_name: airconnect
    network_mode: host
    volumes:
      - /root/airconnect:/config
    environment:
      - AIRCAST_VAR=-x /config/aircast.xml
      - AIRUPNP_VAR=-x /config/airupnp.xml -l 1000:2000
    restart: unless-stopped

  airconnect-admin:
    image: kosztyk/airconnect:latest
    container_name: airconnect-admin
    ports:
      - "8089:8080"
    volumes:
      - /root/airconnect:/config
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - TARGET_CONTAINER=airconnect
      - CONFIG_DIR=/config
      - PORT=8080
      - ADMIN_HOST_PORT=8089
    restart: unless-stopped
```

---

## What each Compose section does

### `airconnect`

- `image: 1activegeek/airconnect`  
  Runs the actual AirConnect bridge.

- `container_name: airconnect`  
  Important because AirConnect Admin will target this exact name via `TARGET_CONTAINER=airconnect`.

- `network_mode: host`  
  Recommended for AirConnect because discovery protocols and renderer communication are usually more reliable on host networking.

- `volumes: - /root/airconnect:/config`  
  Persists the AirConnect XML files and shares them with AirConnect Admin.

- `AIRCAST_VAR=-x /config/aircast.xml`  
  Tells AirCast to use the dedicated AirCast config file.

- `AIRUPNP_VAR=-x /config/airupnp.xml -l 1000:2000`  
  Tells AirUPnP to use the dedicated AirUPnP config file and applies the latency range commonly used in these deployments.

### `airconnect-admin`

- `image: kosztyk/airconnect:latest`  
  Runs the AirConnect Admin web interface.

- `ports: - "8089:8080"`  
  Exposes the admin UI on port `8089` on the Docker host.

- `- /root/airconnect:/config`  
  Gives the admin UI access to the same config files used by the AirConnect container.

- `- /var/run/docker.sock:/var/run/docker.sock`  
  Allows AirConnect Admin to inspect, restart, stop, start, and recreate the AirConnect container.

- `TARGET_CONTAINER=airconnect`  
  Must match the AirConnect container name exactly.

- `CONFIG_DIR=/config`  
  Tells AirConnect Admin where the mounted XML files live inside its own container.

- `PORT=8080`  
  Internal port used by the admin web server.

- `ADMIN_HOST_PORT=8089`  
  Used by the deployment page when generating a matching Compose snippet.

---

## Installation

### 1. Create a config directory on the host

Example:

```bash
mkdir -p /root/airconnect
```

### 2. Save your Compose file

Save the example above as `docker-compose.yml`.

### 3. Start the containers

```bash
docker compose up -d
```

### 4. Open the web UI

In your browser, open:

```text
http://<docker-host-ip>:8089
```

Example:

```text
http://192.168.68.110:8089
```

---

## First-time setup workflow

After opening the UI, a recommended setup sequence is:

1. Open **Config**
2. Generate starter XML files for both AirCast and AirUPnP
3. Review and adjust the generated content
4. Open **Services**
5. Confirm the service arguments are:
   - `-x /config/aircast.xml`
   - `-x /config/airupnp.xml -l 1000:2000`
6. Save the service settings
7. Restart the AirConnect container if needed
8. Open **Logs** and **Discovery** to confirm devices are being seen

---

## UI pages overview

### Dashboard

The dashboard provides a quick operational summary:

- current container state
- whether AirCast is enabled
- whether AirUPnP is enabled
- discovered device count
- runtime metadata
- config file presence indicators
- warning messages derived from runtime validation and recent logs

### Services

Use this page to manage runtime environment variables:

- enable or disable AirCast
- enable or disable AirUPnP
- edit raw argument strings
- apply recommended defaults
- save settings and recreate the target container

Important behavior:

- when service settings are saved, the target AirConnect container is **recreated** so updated environment variables are actually applied
- if validation fails, the change is blocked and an error is shown

### Discovery

Use this page to review devices inferred from the AirConnect environment.

Typical data shown includes:

- device name
- type
- IP address
- port
- MAC address
- source information

Discovery is intended to help you answer questions like:

- Is AirConnect seeing my Chromecast devices?
- Which renderer names are being detected?
- Did my XML config define devices that differ from live runtime discovery?

### Config

Use this page to manage XML files directly.

Supported files:

- `aircast.xml`
- `airupnp.xml`
- `config.xml` (legacy)

Capabilities:

- load the current file contents
- edit XML directly in the browser
- save changes
- optionally restart AirConnect after save
- generate starter templates when beginning from scratch

Validation rules:

- `aircast.xml` must use an `<aircast>` root element
- `airupnp.xml` must use an `<airupnp>` root element
- legacy `config.xml` is shown for visibility and migration purposes

### Logs

Shows recent container logs from the target AirConnect container.

This is useful for:

- checking whether AirConnect started correctly
- identifying config file errors
- seeing renderer discovery lines
- reviewing startup warnings

### Deployment

Displays a generated Compose snippet based on current runtime values. This makes it easy to convert a known-good live setup back into a persistent Compose configuration.

---

## Generated starter XML files

AirConnect Admin can generate a starter file for each service.

### AirCast starter file

The generated AirCast template includes:

- `<common>` defaults
- logging settings
- `max_players`
- `binding`
- `ports`

### AirUPnP starter file

The generated AirUPnP template includes:

- `<common>` defaults
- logging settings
- `latency`
- `http_length`
- `upnp_max`
- `max_players`
- `binding`
- `ports`

These templates are meant as sensible starting points, not universal final configurations.

---

## Environment variables reference

### AirConnect Admin container

| Variable | Required | Default | Description |
|---|---:|---|---|
| `TARGET_CONTAINER` | Yes | `airconnect` | Name of the AirConnect container to manage |
| `CONFIG_DIR` | Yes | `/config` | Shared config mount path inside the admin container |
| `PORT` | No | `8080` | Internal port used by the web server |
| `ADMIN_HOST_PORT` | No | `8089` | Host-side admin port used in generated compose output |

### AirConnect container

| Variable | Required | Recommended value | Description |
|---|---:|---|---|
| `AIRCAST_VAR` | Yes | `-x /config/aircast.xml` | AirCast startup arguments |
| `AIRUPNP_VAR` | Yes | `-x /config/airupnp.xml -l 1000:2000` | AirUPnP startup arguments |

---

## Validation and safeguards

AirConnect Admin includes guardrails to reduce common mistakes.

### Path validation

If a service argument includes `-x /config/...`, the app verifies that the referenced file exists in the shared config mount.

### Cross-reference validation

The app checks that:

- AirCast does not reference `airupnp.xml`
- AirUPnP does not reference `aircast.xml`

### Latency option guidance

The app warns when:

- AirCast includes `-l`
- AirUPnP does not include `-l`

### Start / restart protection

If an enabled service references a missing config file, the app blocks container start or restart actions instead of allowing a broken deployment to continue silently.

---

## Operational notes

### Container recreation behavior

When you save environment changes on the **Services** page, the AirConnect target container is recreated. This is required because Docker environment variables are fixed at container creation time.

### Shared config mount

Both containers must point to the same host directory for `/config`. If they do not, the admin UI may show or save files that the AirConnect container never actually uses.

### Docker socket access

AirConnect Admin requires access to `/var/run/docker.sock`. Without it, the app cannot inspect or control the target AirConnect container.

This is powerful access. Only expose the admin UI on networks you trust.

---

## Security considerations

This project is intended for trusted internal environments.

Because it has access to the Docker socket, AirConnect Admin effectively has elevated control over the Docker host. You should:

- avoid exposing the UI directly to the public internet
- place it behind a trusted reverse proxy if remote access is needed
- restrict access with network-level controls or authentication upstream
- treat the admin container as privileged from an operational security perspective

---

## Troubleshooting

### Discovery shows no devices

Check the following:

1. the AirConnect container is running
2. logs show renderer discovery lines such as `AddCastDevice`
3. the AirConnect container is on `network_mode: host`
4. your speakers / renderers are reachable on the same network
5. the shared `/config` path is correct

Also review the **Logs** page for startup warnings or config errors.

### AirConnect starts with defaults

If logs mention `no config file, using defaults`, then:

- the file referenced with `-x` does not exist
- the file path is wrong
- the shared mount path is incorrect
- the file is unreadable to the container

### Save works but AirConnect behavior does not change

Most likely causes:

- you edited the XML but did not restart AirConnect
- the AirConnect container is not using the same `/config` mount as the admin container
- the service argument still points to an unexpected config file

### AirConnect Admin cannot control the container

Check:

- `TARGET_CONTAINER` matches the real container name
- `/var/run/docker.sock` is mounted
- the Docker daemon is running

### Discovery is inconsistent

Discovery is derived from runtime logs and configuration context. If logs rotate, if the target container was recently restarted, or if network discovery is unstable, the visible device list may fluctuate. Use the Logs page together with the Discovery page to correlate what AirConnect is currently seeing.

---

## Health check

AirConnect Admin exposes a simple health endpoint:

```text
/healthz
```

Example:

```bash
curl http://127.0.0.1:8080/healthz
```

---

## Build from source

If you want to build the admin image yourself:

```bash
docker build -t airconnect-admin:latest .
```

Then update your Compose file accordingly.

---

## Suggested host directory layout

Example:

```text
/root/airconnect/
├── aircast.xml
├── airupnp.xml
└── config.xml
```

You do not need all three files, but this layout keeps migration simple.

---

## Best practices

- use separate `aircast.xml` and `airupnp.xml`
- keep AirConnect on host networking
- keep the admin UI on a private network
- use the generated starter XMLs as a baseline, then refine them gradually
- verify changes in Logs and Discovery after every major config update
- keep a backup of your `/root/airconnect` directory

---

## Limitations

- the app manages one target AirConnect container at a time
- the app depends on Docker socket access
- discovery is operationally useful, but it is not a replacement for native protocol debugging tools
- AirConnect Admin assumes a shared `/config` directory model

---

## Summary

AirConnect Admin gives you a practical browser-based control plane for an existing AirConnect deployment. It is especially useful if you want to standardize around:

- dedicated `aircast.xml` and `airupnp.xml` files
- safer runtime argument management
- fast troubleshooting through logs and discovery
- one-click operational control of the AirConnect container

For most homelab deployments, the recommended starting point is exactly this pair:

- AirConnect on host networking
- AirConnect Admin on a normal bridge network with access to `/config` and the Docker socket

