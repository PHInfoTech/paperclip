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
| `docker/docker-compose.network.yml` | Override merged on top of the base: attaches both services to `paperclip-net` and removes PostgreSQL's host port |
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

## Where data lives

| Volume | Contents |
|--------|----------|
| `paperclip_pgdata` | PostgreSQL data |
| `paperclip_paperclip-data` | Paperclip home (`/paperclip`): config, uploaded files, local secrets key, agent workspaces, hourly database backups |

## Troubleshooting

- **"ACPX provider package … resolves outside the selected provider root"**
  when testing a Claude or Codex model: the image was built from the
  Dockerfile's `cloud` stage. The Compose files pin `target: production`;
  rebuild with `up -d --build` and test again.
- **Connecting to PostgreSQL from the host:** the override removes the host
  port on purpose. Use `pc-compose exec db psql -U paperclip paperclip`, or add
  a `127.0.0.1:5432:5432` port mapping to the `db` service in the override.
- **"No recent database backup" warning:** expected on first start; it clears
  after the first hourly backup.
