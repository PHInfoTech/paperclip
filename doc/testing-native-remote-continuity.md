# Native remote continuity regression

The opt-in case in
`server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`
runs the real executor, PostgreSQL, TLS ingress, Rust runner, remote file transfer,
and backup validation against a deterministic fake Codex process in Linux. It
checks the same runner process identity and one provider process across three warm
turns, provider history reuse, and verified suspension at idle close. Separate
cases kill the actual controller process and recover the next turn. They reject
a still-live controller and a replacement sandbox before reconnecting. Legacy
checkpoints and changed process configuration require verified suspension and
replacement, while preserving the conversation and starting each turn once.
Recovery can restart a provider to refresh its tool contract; process reuse is
required for ordinary healthy follow-ups.
Each recovery case includes another healthy turn after the recovered turn and
asserts that it does not start another runner or provider process.
It does not qualify a live model or a sandbox provider API.

Use a disposable Linux container with Node.js, `sh`, `tar`, `base64`, `ps`, and
`setsid`. Build `paperclip-runnerd` and `fake-codex-app-server` from the checkout's
`packages/paperclip-runner/runner/Cargo.toml` for that container's architecture.
Keep the Linux runner binary on the host as well: the product hashes and stages
that artifact. Put the fake provider at `/opt/continuity/fake-codex-app-server`
inside the container. Do not put credentials in this container.

Start the container with `--init` and publish container port 43127 on localhost.
Read its assigned port with `docker port CONTAINER 43127`; an automatic host port
can change after a container restart. The test opens a local TLS tunnel to this
port. Create a test-only certificate and key:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/continuity-test.key -out /tmp/continuity-test.crt \
  -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```

Create an executable wrapper on the host at `/tmp/continuity-fake-codex`:

```sh
#!/bin/sh
if [ "$1" = '--version' ]; then
  echo 'codex-cli 0.999.0'
  exit 0
fi
exec /opt/continuity/fake-codex-app-server \
  --state-file-in-codex-home --durable-turn-ids --record-process-start \
  --call-log "$PWD/provider-calls.log" "$@"
```

Run the test with the container name, current host port, and Linux artifact path:

```sh
NODE_EXTRA_CA_CERTS=/tmp/continuity-test.crt \
PAPERCLIP_TEST_RUNNER_TLS_KEY=/tmp/continuity-test.key \
PAPERCLIP_TEST_RUNNER_CONTAINER=CONTAINER \
PAPERCLIP_TEST_RUNNER_PORT=HOST_PORT \
PAPERCLIP_TEST_LINUX_RUNNER_BINARY=/path/to/linux/paperclip-runnerd \
PAPERCLIP_TEST_FAKE_CODEX_WRAPPER=/tmp/continuity-fake-codex \
pnpm exec vitest run \
  server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts \
  -t 'preserves remote warm continuity' --maxWorkers=1
```

The caller owns the disposable container. Remove it after the run, including
after failure; failed cases can retain remote processes and files for inspection.
The test cleans up its database and host session directories.

## Replacing the main server

Remote native runners admitted with durable controller persistence tolerate up
to five minutes without the main server. The sandbox keeps its process, provider
turn and event outbox. Server-dependent tools wait for reconnection; work already
accepted into the queue resumes through normal admission. A single offline web
server cannot accept new HTTP requests during that interval.

Retain Postgres and the instance secret encryption key across deployments. The
private `native_runner_checkpoints` journal holds encrypted authentication state,
commands, and acknowledged event cursors. These records are company/run scoped
and are not part of public run projections. The replacement reconstructs its
local controller cache and authenticates the recorded running artifact, even
when its own installed runner binary differs. It does not stage a new binary
over the running process.

The runner package owns checkpoint encoding, validation, restoration, and command
classification. Its persistence callback exposes opaque records and explicit
ownership metadata. The server owns encryption and transactional lease checks;
heartbeat discovers eligible runs through the native runtime. Tool recovery uses
the current tool authority, including receipt decoding and read policy. Transport
adapters retain ownership of protocol response envelopes.

Remote execution leases expire after 60 seconds and renew every 20 seconds.
Graceful shutdown detaches and releases the lease. Startup and the existing
orphan sweep claim eligible expired owners; another container's PID is not
ownership proof. The runner reconnect window is seven minutes, providing margin
for the five-minute outage, lease expiry, and connection setup. Stop, company
scope and normal admission gates retain precedence. A completed tool receipt can
restore a lost response. Safe reads recheck current authority. An uncertain
external mutation is not executed again without outcome evidence.

The first rollout does not extend grace already configured in an old runner.
The contract starts with runners admitted by the updated server. Legacy stdio
adapters, database loss and destroyed sandboxes are outside this guarantee.

The empty-controller-cache test uses a real Rust runner and scripted provider
in separate directories, removes the controller directory, then restores solely
from Postgres. It checks unchanged runner/provider process identities and one
provider turn start. Build the host runner and fake provider first, then run:

```sh
PAPERCLIP_TEST_CONTROLLER_OUTAGE_MS=300000 pnpm exec vitest run \
  server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts \
  -t 'adopts the same runner from Postgres' --maxWorkers=1
```

This is protocol and persistence evidence. The separate
`everyday-workflows.runner-codex.daytona.recover-controller` Product E2E cell
qualifies the actual Daytona/provider path, including completion and workspace
finalization. Neither test substitutes for the other's failure boundary.
