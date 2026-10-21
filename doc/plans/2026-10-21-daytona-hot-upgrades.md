# Daytona agents across server upgrades

## Goal and boundary

Upgrade the main Paperclip server while native agents keep running in their
existing Daytona sandboxes. A server outage of up to five minutes may delay
server-dependent tools and queued launches, but must not interrupt the provider
turn, create a replacement run, repeat completed effects, or require an operator
to pause admission. This chat delivers implementation and a tested, reviewable
PR. Production rollout is a separate endpoint.

The server is replaceable; Postgres retains coordination authority. The sandbox
retains the running process, provider session, and local event outbox. Durable
reconnection does not mean uninterrupted HTTP service while the only web server
is offline. Database loss, destroyed sandboxes, incompatible protocol changes,
and legacy server-owned stdio adapters are outside this first contract.

## Acceptance matrix

| Case | Required result | Evidence |
| --- | --- | --- |
| Active Daytona run, graceful server replacement | Same run, sandbox, runner PID/start identity, provider session and turn | Before/after identity and independently read receipts |
| Controller crash and empty replacement controller disk | Recover authenticated authority from Postgres; no duplicate provider start | Separate controller generations and unavailable original files |
| Five-minute outage during computation | Runner and provider stay alive; output retained and replayed | Real-process outage test plus persisted ordered events |
| Server-dependent tool pending across disconnect | Wait/reconcile without replaying an uncertain external effect | Tool receipt and invocation count |
| Completion during outage | Final result and workspace commit once after reconnect | Postgres result/finalization records and saved output |
| New work before/after replacement | Accepted queued work resumes automatically; no global pause required | Second run reaches useful completion |
| Concurrent old/new controllers | Only the current fenced owner may issue commands/ACK events | Postgres lease race and stale-writer tests |
| Existing runs and differing server/runner artifacts | Preserve admitted execution and runner identity; unsupported historical state remains explicit | Compatibility and artifact-identity tests |
| Explicit Stop and changed authority | Recovery cannot undo cancellation or bypass company/budget controls | Stop/reconnect and cross-company negative cases |

## Findings at kickoff

Base: `eaacadeba3`; worktree `/Users/dotta/.codex/worktrees/a2c4/paperclip`;
branch `codex/daytona-hot-upgrades`.

- Native graceful shutdown already detaches instead of cancelling provider work.
- `native_run_finalizations` stores controller ownership and recovery generations;
  `heartbeat_runs` stores admitted execution and session checkpoints.
- The actual runner transport's authentication leases, command journal and event
  cursor live in `control-plane-state.json` on the controller. Recovery explicitly
  rejects a remote run when that root is missing. Existing same-directory tests
  do not prove replacement-container survival.
- Remote runner and outbound ingress recovery windows are 120 seconds.
- Transport recovery constructs expected runner identity from the current binary;
  an upgrade must retain the admitted running artifact's identity instead.
- Controller takeover currently probes controller PIDs locally; this is not
  sufficient ownership proof across different containers.

## Architecture and delivery sequence

1. Retain the native execution lifecycle and PRP protocol. Add durable controller
   persistence at the transport's effect boundary: authentication, commands and
   event acknowledgements must be recoverable before becoming visible to the peer.
   Use a company/run-bound, versioned Postgres record with controller fencing;
   keep connection credentials encrypted with the instance secret provider.
   Local files become a materialized cache for existing parsers and diagnostics.
2. Restore that state before remote reattachment; retain the admitted runner
   artifact and execution input. Prove remote PID/boot/start identity through the
   existing sandbox probe. Never infer remote liveness from controller-local PIDs.
3. Give remote runners a recovery window covering the agreed outage plus bounded
   reconnection. Release controller authority on graceful detach and use bounded
   expiring authority after crashes. Preserve Stop and terminal-result precedence.
4. Qualify reconnect, command/event replay, empty-disk recovery and overlapping
   owners at the narrowest faithful layer. Then exercise the assembled server and
   a disposable Daytona run, followed by required repository checks and PR review.

First experiment: existing real-runner restart coverage with the controller state
directory unavailable to its successor. A same-PID assertion plus exactly one
provider `turn/start` distinguishes adoption from interruption-and-resume.

## State

Implementation is in progress on the branch above; no PR or deployment yet.

Verified locally with real PostgreSQL and the Rust runner, using a scripted Codex
provider (not a live model):
- 125 controller protocol tests passed (`/tmp/daytona-core-final.log`).
- 84 affected server ownership/transport/shutdown tests passed
  (`/tmp/daytona-focused-server-tests.log`).
- Encrypted journal restore and stale-owner rejection passed
  (`/tmp/daytona-db-checkpoint-test.log`).
- Empty controller filesystem recovery passed, including a real 300-second
  outage, identical runner/provider PIDs and start identity, identical active
  session/turn, and exactly one provider turn start. The replacement did not have
  the old runner executable (`/tmp/daytona-five-minute-test.log`, 326.34 seconds).
  The fixture's initial missing simulated provider-home failure was corrected;
  that failed attempt remains in `/tmp/daytona-empty-disk-test.log`.
- Full workspace typecheck and production build passed.
- Real remote executor warm continuity and actual controller SIGKILL recovery
  passed against isolated Linux/Postgres, including three turns and idle close
  (`/tmp/daytona-remote-warm-final.log`, `/tmp/daytona-remote-hard-final.log`).
  Qualification found and fixed two journal ownership defects: the pre-attachment
  snapshot needs the current controller's successor lease, and each attachment
  must bind its writer to the new run. The first idle-close attempt also exposed
  the missing `runner.suspend` maintenance command. Those failed attempts remain
  in the preceding `/tmp/daytona-remote-*.log` files. A separate stale Docker
  port attempt was a test setup failure; the port is re-read after reset.
- 36 heartbeat recovery tests passed, including delayed lease expiry, Stop,
  and foreign-server shutdown (`/tmp/daytona-reaper-tests-final.log`). The first
  added-test attempt failed fixture FK cleanup after the assertions; cleanup
  now removes the finalization row before its run.

Next gates: finish the full repository suite, repeat five-minute recovery on the
final ownership implementation, then run one exact Daytona
Product E2E cell via the existing trusted hosted workflow. Local provider/Daytona
credentials are absent; hosted qualification is available. Required repository
checks and PR review remain. The hosted restart case now discards the old
controller runtime cache before starting the replacement and requires an
acknowledgement of that fault.

Operational prerequisites: retain the same Postgres database and instance secret
master key across replacement. A first rollout cannot extend the reconnect grace
already baked into a runner launched by the previous release; the new contract
applies to runners admitted with durable controller persistence and the new grace.
