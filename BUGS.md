# Bugs Found

Bugs found while running Paperclip in Docker with PostgreSQL on a named
network (see [doc/DOCKER-POSTGRES-NETWORK.md](doc/DOCKER-POSTGRES-NETWORK.md)).
Fixes are on the `development-jani` branch.

| # | Bug | Status | Fix |
|---|-----|--------|-----|
| 1 | Claude environment test fails: "ACPX provider package … resolves outside the selected provider root" | Fixed | `6263763b1` |
| 2 | Compose files build the `cloud` image stage instead of `production` | Fixed | `31fbd7271` |
| 3 | 10 warm-attach tests fail in `runnerd-codex-transport.test.ts` | Open, not investigated | — |
| 4 | Onboarding: "Paperclip Runner is unavailable for this harness and environment" before a model source is chosen | Open, diagnosed | — |

## 1. Claude environment test fails in Docker and source builds

**Symptom.** In **Connect a model → Claude → Subscription**, the environment
test fails with:

```text
error·ACPX provider package @agentclientprotocol/claude-agent-acp resolves outside the selected provider root
```

**Cause.** Before it starts an ACPX provider, the Runner checks that every
provider package resolves inside a trusted *provider root*. Two code paths
choose that root, and they disagreed:

- The Runner daemon (`acpxProviderPackageAuthority` in
  `packages/paperclip-runner/src/live/runnerd-codex-transport.ts`) recognised
  the source/Docker layout, where the server lives inside the pnpm workspace,
  and used the workspace root (`/app` in the image).
- The in-process check (`resolveInstalledProviderAuthority` in
  `packages/paperclip-runner/src/drivers/acpx/installed-provider-authority.ts`),
  used when `PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT` is not set, always used the
  server package (`/app/server`).

In the image, `/app/server/node_modules/@agentclientprotocol/claude-agent-acp`
is a pnpm symlink into `/app/node_modules/.pnpm/…`. That target is outside
`/app/server/node_modules`, so the in-process check rejected it.

Reproduced inside the container by calling `createAcpxPackageJsonResolver`
with both roots: `/app/server` raised the error, `/app` resolved the package.

**Fix.** The daemon's workspace rule moved into a shared helper,
`sourceWorkspaceProviderRoot`, which both paths now use. It adopts the
workspace root only when all of these hold:

- the server directory is named `server` and has no `node_modules/.pnpm` of
  its own;
- the parent directory has `node_modules/.pnpm`, `pnpm-workspace.yaml` and a
  `package.json` named `paperclip` with `private: true`;
- the server manifest is named `@paperclipai/server`.

Otherwise, as in published npm bundles, the server keeps its own root.

**Verification.**

- New regression test in `installed-provider-authority.test.ts` covers the
  workspace layout, and a server with its own virtual store keeping its root.
- `installed-provider-authority.test.ts` and `installation-integrity.test.ts`:
  86 passed, 1 skipped.
- `pnpm --filter @paperclipai/paperclip-runner typecheck` passes.
- In the rebuilt container, `resolveInstalledProviderAuthority` returns root
  `/app` with manifest `/app/server/package.json`, and
  `@agentclientprotocol/claude-agent-acp` resolves without error.
- After the rebuild, the user got past the Claude environment test in the
  onboarding flow.

**Review note.** This code decides which installed packages the Runner trusts.
The change reuses a rule the daemon already applied rather than adding a new
one, but a reviewer should confirm the in-process path may share it.

## 2. Compose files build the `cloud` stage

**Symptom.** `docker/docker-compose.yml` and
`docker/docker-compose.quickstart.yml` set no build `target`. Compose then
builds the Dockerfile's last stage, `cloud`, which is meant for managed
deployments, rather than the standard `production` image.

The `cloud` stage copies a standalone `@sentry/node` install into
`/app/server/node_modules`, including its own `.pnpm` directory. Because the
workspace rule in bug 1 requires the server to have no `.pnpm` of its own,
this also makes the server keep its own provider root and so triggers the
bug 1 error.

**Fix.** Both Compose files set `target: production`, with a comment
explaining why.

**Verification.** `docker compose config` resolves `target: production` for
both files, alone and with the network override. The rebuilt container has no
`/app/server/node_modules/.pnpm`. `scripts/docker-compose-secrets.test.mjs`
passes, 2 of 2.

Fixing this alone did not clear the error; bug 1 was the remaining cause.

## 3. Failing warm-attach tests (open)

**Symptom.** Running
`vitest run src/live/runnerd-codex-transport.test.ts -t "authority|provider package|root"`
in `packages/paperclip-runner` gives 10 failed and 14 passed, for example
"preserves old warm-attach authority and event ownership across held-ack" and
"adopts a live runner on the same durable authority without spawning a
duplicate".

**Status.** The same 10 tests fail with the bug 1 change removed, so that
change does not cause them. The cause has not been investigated; it may be
environmental, such as a missing native Runner binary.

## 4. Onboarding sends the Runner choice with the placeholder agent (open)

**Symptom.** In onboarding, the web page shows "Paperclip Runner is
unavailable for this harness and environment. Select Legacy runner in
Advanced." The server log shows repeated `POST /api/companies/:id/agents`
returning 422.

**Cause.** Before a model source is chosen, `ui/src/components/OnboardingWizard.tsx`
creates a placeholder agent with `adapterType: "process"` and
`metadata.setupAdapterPending: true`. It still sends the wizard's `runner`
state, which can be `"paperclip"` (for example restored from saved onboarding
state). In `server/src/services/agent-runner-selection.ts`,
`resolveNewAgentRunner` treats an explicit `"paperclip"` choice as a request
for the native Runner, which supports only the Claude and Codex harnesses, so
the `process` placeholder is rejected with `agent_runner_unavailable`.

Request body seen in the log (abridged):
`{"adapterType":"process","runner":"paperclip","adapterConfig":{},"metadata":{"setupAdapterPending":true},"onboardingFirstAgent":true}`

**Status.** The error went away without a code change once the wizard state
changed (for example after choosing a model source, which resets the runner to
`auto`). The underlying bug remains.

**Proposed fix (not applied).** Send the runner choice only when a source is
selected, e.g. `runner: sourceSelected ? runner : undefined` in the
placeholder `agentsApi.create` call, and add a wizard test for a restored
`"paperclip"` runner with no source selected.
