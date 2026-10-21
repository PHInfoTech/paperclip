# Docker with PostgreSQL on a Named Network

Run Paperclip and PostgreSQL 17 as two Docker containers connected by a named
bridge network, `paperclip-net`. PostgreSQL is reachable only from that
network, not from the host.

All commands below run from the **project root**. See [DOCKER.md](DOCKER.md)
for the general Docker guide.

## How it is put together

| File | Role |
|------|------|
| `docker/docker-compose.yml` | Base stack: the `db` (PostgreSQL 17) and `server` (Paperclip) services, built from the `production` Dockerfile target |
| `docker/docker-compose.network.yml` | Override merged on top of the base: attaches both services to `paperclip-net`, removes PostgreSQL's host port, builds the `production-hermes` target and connects OpenCode and Hermes to Switchyard (see [Local models through Switchyard](#local-models-through-switchyard)) |
| `docker/hermes/config.yaml` | Hermes Agent provider configuration, copied into the container on start |
| `docker/switchyard-loopback.cjs` | Forwards `127.0.0.1:4000` in the server container to Switchyard, for Local endpoint connections |
| `docker/.env` | Signing secrets read by Compose (not committed, see below) |

Compose merges the files in the order given by `-f`. Pass both files and the
same project name (`-p paperclip`) to every command; otherwise Compose cannot
find the containers or skips the override.

The server connects to the database by service name over the network:
`postgres://paperclip:paperclip@db:5432/paperclip`.

## The `docker/.env` file

Compose reads `docker/.env` automatically, because it sits next to the first
Compose file. It holds two independent secrets:

```dotenv
BETTER_AUTH_SECRET=<64 hex characters>
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=<64 hex characters>
```

- `BETTER_AUTH_SECRET` signs login sessions. The server refuses to start
  without it.
- `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` signs approval-gated tool actions.
  Without it, those actions report `signing_secret_unconfigured`.

The file is ignored by Git (`.gitignore` matches `.env`) and is readable only
by its owner. If it is missing, create it once:

```sh
umask 077
printf 'BETTER_AUTH_SECRET=%s\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > docker/.env
```

Keep the values unchanged across restarts. Changing `BETTER_AUTH_SECRET` signs
everyone out. Change the tool-action secret only after pending approvals are
resolved, because their signatures use the old value. Back up the file
together with the data volumes.

The database password (`paperclip`) comes from `docker/docker-compose.yml`, not
from this file. It is acceptable while PostgreSQL is reachable only inside
`paperclip-net`.

## Start

```sh
docker compose -p paperclip \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.network.yml \
  up -d --build
```

The first build compiles the native Runner and takes several minutes; later
builds reuse the cache. The server waits until PostgreSQL is healthy, then
applies database migrations.

Check that it is up:

```sh
curl http://localhost:3100/api/health
```

Open <http://localhost:3100>. On a fresh install, create an account and choose
**Claim this instance** to become the administrator.

## Stop

```sh
# Stop and remove the containers; data is kept
docker compose -p paperclip -f docker/docker-compose.yml -f docker/docker-compose.network.yml down

# Stop the containers without removing them
docker compose -p paperclip -f docker/docker-compose.yml -f docker/docker-compose.network.yml stop
```

> `down -v` also deletes the data volumes, including the database. Use it only
> to start over from nothing.

## Everyday commands

```sh
alias pc-compose='docker compose -p paperclip -f docker/docker-compose.yml -f docker/docker-compose.network.yml'

pc-compose ps                 # Container status
pc-compose logs -f server     # Follow Paperclip logs
pc-compose logs -f db         # Follow PostgreSQL logs
pc-compose restart server     # Restart Paperclip only
pc-compose up -d --build      # Rebuild after pulling new code
```

The alias uses relative paths, so run it from the project root.

## Local models through Switchyard

The override also makes the host's local Switchyard router
(`http://localhost:4000/v1`, OpenAI-compatible) available to **OpenCode** and
**Hermes** agents.

### OpenCode agents


- `extra_hosts: host.docker.internal:host-gateway` lets the container reach
  services published on the host, as `http://host.docker.internal:<port>`.
- `OPENCODE_CONFIG_CONTENT` defines an OpenCode provider named `switchyard`
  with every Switchyard model. OpenCode reads it to list models in the agent
  model picker, and Paperclip merges it into each run's config. The default is
  `switchyard/deepseek-flash-qwen38`.

To use it, create or edit an agent, choose the **OpenCode** harness, and pick a
`switchyard/…` model. Switch models at any time by changing the agent's model.

Switchyard routes need the full `switchyard/<route>` id, so each short model key
maps to it through `id`. When Switchyard's routes change, regenerate the list
from `curl http://localhost:4000/v1/models` and run `up -d` to apply it.

Check from inside the container:

```sh
pc-compose exec -u node server opencode models | grep '^switchyard/'
```

### Hermes agents

The override builds the `production-hermes` image target: the standard image
plus the Hermes Agent CLI (pinned `hermes-agent` release in
`/opt/hermes`, linked as `hermes`), which the built-in `hermes_local` adapter
launches.

Hermes reads its provider from `$HOME/.hermes/config.yaml`. The repository
copy, `docker/hermes/config.yaml`, points it at Switchyard with
`switchyard/deepseek-flash-qwen38` as the default. It is mounted read-only at
`/etc/paperclip/hermes/config.yaml` and copied to
`/paperclip/.hermes/config.yaml` on every start, so edit the repository file
and restart the server to apply a change. Hermes keeps its sessions and memory
in `/paperclip/.hermes`, inside the data volume.

To use it, choose the **Hermes** (local) harness and set the agent's model to
any full Switchyard id, such as `switchyard/qwen38`. Paperclip passes it as
`hermes chat -m <model>`, which overrides the default. An agent without a model
uses the default.

Do not mount files read-only anywhere under `/paperclip`: the entrypoint repairs
ownership of that tree on start and exits when it cannot change a file.

To upgrade Hermes, change `HERMES_AGENT_VERSION` in the Dockerfile's
`production-hermes` stage and rebuild with `up -d --build`.

### Local endpoint AI connection (recommended for new agents)

Paperclip's new-agent screen attaches an **AI connection** to OpenCode and
Hermes agents. Its default is an OpenRouter account, which only accepts
`openrouter/…` models, so pick a **Local endpoint** connection for Switchyard
instead. A local endpoint must use a loopback address, so the server command
also starts `docker/switchyard-loopback.cjs`, which forwards `127.0.0.1:4000`
inside the server container to Switchyard on the host. It restarts with the
server.

Create the connection from the agent's **Connection** field → connect →
**Local endpoint**:

| Field | Value |
|-------|-------|
| Provider URL | `http://localhost:4000/v1` |
| API format | Chat Completions · OpenCode, Hermes |
| Authentication | No authentication |
| Model IDs | the full `switchyard/…` ids, comma separated, e.g. `switchyard/deepseek-flash-qwen38, switchyard/qwen38, switchyard/ultra-qwen38` (`curl http://localhost:4000/v1/models` lists all) |

Then set the agent's **Model ID** to a single id, such as
`switchyard/deepseek-flash-qwen38`; Paperclip adds its own `paperclip/` prefix.
Do not paste the comma-separated list there: the whole list is then sent as one
model name and Switchyard answers "No route registered for model". To switch
models, edit the agent's Model ID. The connection's model list cannot be edited
after it is saved; create another connection to change it. With this connection Paperclip writes its own
provider config for each run (OpenCode provider `paperclip`, or a Hermes
`custom` provider), so the server-wide OpenCode provider and
`docker/hermes/config.yaml` below are not used for that agent.

Check the forwarder from inside the container:

```sh
pc-compose exec -u node server curl -s http://localhost:4000/v1/models
```

The "Custom gateway" connection type does not fit: it requires HTTPS for any
address other than localhost.

### Other harnesses

Codex and Pi can use custom OpenAI-compatible providers through
`PAPERCLIP_CODEX_PROVIDERS` and `PAPERCLIP_PI_PROVIDERS`; they are not
configured here. Codex would need a per-agent provider selection, because a
server-wide one would also redirect Codex subscription agents.

vLLM's `qwen38` (`http://localhost:8001/v1`) is reachable the same way, but
Switchyard already exposes it as `switchyard/qwen38`.

## Where data lives

| Volume | Contents |
|--------|----------|
| `paperclip_pgdata` | PostgreSQL data |
| `paperclip_paperclip-data` | Paperclip home (`/paperclip`): config, uploaded files, local secrets key, agent workspaces, hourly database backups |

## Troubleshooting

- **"ACPX provider package … resolves outside the selected provider root"**
  when testing a Claude or Codex model: the image predates the fixes recorded
  in [BUGS.md](../BUGS.md) (bugs 1 and 2). Rebuild from this branch with
  `up -d --build` and test again.
- **Connecting to PostgreSQL from the host:** the override removes the host
  port on purpose. Use `pc-compose exec db psql -U paperclip paperclip`, or add
  a `127.0.0.1:5432:5432` port mapping to the `db` service in the override.
- **"No recent database backup" warning:** expected on first start; it clears
  after the first hourly backup.
