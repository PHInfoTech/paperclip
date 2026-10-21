import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, gt, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import type { DurablePrpCheckpoint, DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { localEncryptedProvider } from "../../secrets/local-encrypted-provider.js";

type Binding = { companyId: string; issueId: string; runId: string };
type Owner = Binding & { bootId: string; leaseOwner: string; generation: number; authorityRunId: string };
type Header = Omit<DurablePrpCheckpoint, "state"> & {
  state: Omit<DurablePrpCheckpoint["state"], "commands" | "committedEvents">;
  commands: string[];
  events: string[];
};

function checkpointRunId(state: DurablePrpCheckpoint["state"]): string {
  if (state.warmTransition) return state.warmTransition.receipt.newIdentity.runId;
  const attachment = state.commands.findLast(command => command.type === "run.attach");
  const next = attachment?.payload.paperclipNextAuthority as { identity?: { runId?: string } } | undefined;
  return next?.identity?.runId ?? state.identity.runId;
}

function checkpointParts(checkpoint: DurablePrpCheckpoint): Map<string, string> {
  const { commands, committedEvents, ...state } = checkpoint.state;
  const parts = new Map<string, string>();
  const commandKeys = commands.map(command => {
    const key = `command:${command.controllerSeq}`;
    parts.set(key, JSON.stringify(command));
    return key;
  });
  const eventKeys = committedEvents.map(event => {
    const key = `event:${event.sourceSeq}`;
    parts.set(key, JSON.stringify(event));
    return key;
  });
  const header: Header = { schema: checkpoint.schema, runnerVersion: checkpoint.runnerVersion,
    runnerDigest: checkpoint.runnerDigest, state, commands: commandKeys, events: eventKeys };
  parts.set("header", JSON.stringify(header));
  return parts;
}

/** The encrypted envelope binds ciphertext to its row, even if rows are copied. */
async function encryptPart(binding: Binding, part: string, contents: string) {
  return (await localEncryptedProvider.createVersion({ value: JSON.stringify({ ...binding, part, contents }) })).material;
}

async function decryptPart(binding: Binding, part: string, material: Record<string, unknown>): Promise<string> {
  const envelope = JSON.parse(await localEncryptedProvider.resolveVersion({ material, externalRef: null }));
  if (envelope.companyId !== binding.companyId || envelope.issueId !== binding.issueId
    || envelope.runId !== binding.runId || envelope.part !== part || typeof envelope.contents !== "string") {
    throw new Error("native_runner_checkpoint_binding_mismatch");
  }
  return envelope.contents;
}

/** Only changed journal entries are written; a new event never rewrites the event history. */
export function nativeRunnerCheckpointWriter(db: Db, owner: Owner) {
  let previous = new Map<string, string>();
  return async (checkpoint: DurablePrpCheckpoint): Promise<void> => {
    if (checkpointRunId(checkpoint.state) !== owner.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
    const parts = checkpointParts(checkpoint);
    const changed = await Promise.all([...parts].filter(([part, value]) => previous.get(part) !== value)
      .map(async ([part, value]) => ({ companyId: owner.companyId, issueId: owner.issueId,
        runId: owner.runId, part, material: await encryptPart(owner, part, value) })));
    await db.transaction(async tx => {
      // Same lock and generation as controller recovery. A stale writer cannot
      // publish credentials or commands after the successor has claimed the run.
      const [owned] = await tx.select({ current: nativeRunFinalizations, now: sql<Date>`clock_timestamp()` }).from(nativeRunFinalizations)
        .where(and(eq(nativeRunFinalizations.companyId, owner.companyId),
          eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.runId, owner.authorityRunId),
          eq(nativeRunFinalizations.controllerBootId, owner.bootId),
          eq(nativeRunFinalizations.controllerGeneration, owner.generation))).for("update");
      if (!owned) throw new Error("native_runner_checkpoint_owner_lost");
      const { current } = owned;
      const activeOwner = current.leaseOwner === owner.leaseOwner
        && current.leaseExpiresAt !== null && current.leaseExpiresAt > new Date(owned.now);
      if (!activeOwner) {
        // A completed warm session retains transport maintenance until it is
        // reused or retired. Its released execution lease cannot authorize a
        // new turn or attachment. The next run's writer owns that boundary.
        const maintenance = new Set(["runner.drain", "runner.suspend", "session.snapshot", "session.close"]);
        const newWork = checkpoint.state.commands.some(command =>
          !previous.has(`command:${command.controllerSeq}`) && !maintenance.has(command.type));
        const [task] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
          .where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId)));
        const [successor] = task?.executionRunId && task.executionRunId !== owner.runId
          ? await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
              eq(nativeRunFinalizations.runId, task.executionRunId), eq(nativeRunFinalizations.companyId, owner.companyId),
              eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.controllerBootId, owner.bootId),
              gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))) : [];
        // The same controller snapshots the old session before attaching the
        // next run. A successor on another server must first take ownership.
        if (!current.resultId || newWork || !task || (task.executionRunId && task.executionRunId !== owner.runId && !successor)) {
          throw new Error("native_runner_checkpoint_owner_lost");
        }
      }
      if (checkpoint.state.identity.runId !== owner.runId) {
        const [prior] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, checkpoint.state.identity.runId), eq(heartbeatRuns.companyId, owner.companyId),
          eq(heartbeatRuns.nativeIssueId, owner.issueId),
          eq(heartbeatRuns.nativeSessionId, checkpoint.state.identity.normalizedSessionId)));
        if (!prior) throw new Error("native_runner_checkpoint_binding_mismatch");
      }
      if (changed.length) await tx.insert(nativeRunnerCheckpoints).values(changed)
        .onConflictDoUpdate({ target: [nativeRunnerCheckpoints.runId, nativeRunnerCheckpoints.part],
          set: { material: sql`excluded.material`, updatedAt: sql`now()` } });
      if (previous.size === 0 || [...previous.keys()].some(part => !parts.has(part))) {
        await tx.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, owner.companyId),
          eq(nativeRunnerCheckpoints.runId, owner.runId), notInArray(nativeRunnerCheckpoints.part, [...parts.keys()])));
      }
    });
    previous = parts;
  };
}

const authorities = new WeakMap<DurablePrpControlPlane, Map<string, ReturnType<typeof nativeRunnerCheckpointWriter>>>();

/** Called for each run attachment, including the same live authority's warm handoff. */
export async function registerNativeRunnerCheckpoint(input: {
  db: Db; binding: Binding; bootId: string; authority: DurablePrpControlPlane;
  authorityRunId?: string;
  onFailure?: (runId: string) => Promise<void>;
}): Promise<void> {
  const authorityRunId = input.authorityRunId ?? input.binding.runId;
  const [owner] = await input.db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.binding.companyId),
    eq(nativeRunFinalizations.issueId, input.binding.issueId),
    eq(nativeRunFinalizations.runId, authorityRunId),
    eq(nativeRunFinalizations.controllerBootId, input.bootId),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`)));
  if (!owner?.leaseOwner) throw new Error("native_runner_checkpoint_owner_lost");
  let writers = authorities.get(input.authority);
  if (!writers) {
    writers = new Map();
    const boundWriters = writers;
    input.authority.setCheckpointPersistence(async snapshot => {
      const writer = boundWriters.get(checkpointRunId(snapshot.state));
      if (!writer) throw new Error("native_runner_checkpoint_owner_lost");
      await writer(snapshot);
    });
    authorities.set(input.authority, writers);
  }
  if (!writers.has(input.binding.runId)) {
    const write = nativeRunnerCheckpointWriter(input.db, {
      ...input.binding, authorityRunId, bootId: input.bootId, generation: owner.controllerGeneration, leaseOwner: owner.leaseOwner,
    });
    writers.set(input.binding.runId, async checkpoint => {
      try { await write(checkpoint); }
      catch (error) {
        // Do not retain a live execution lease on a poisoned journal. Detach
        // asynchronously so startup and persistence cannot wait on each other.
        void input.onFailure?.(authorityRunId).catch(() => undefined);
        throw error;
      }
    });
  }
  await input.authority.flushCheckpoint();
}

export async function loadNativeRunnerCheckpoint(db: Db, binding: Binding): Promise<DurablePrpCheckpoint | null> {
  const rows = await db.select().from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, binding.companyId), eq(nativeRunnerCheckpoints.issueId, binding.issueId),
    eq(nativeRunnerCheckpoints.runId, binding.runId)));
  if (!rows.length) return null;
  const parts = new Map(await Promise.all(rows.map(async row =>
    [row.part, await decryptPart(binding, row.part, row.material)] as const)));
  const header = JSON.parse(parts.get("header") ?? "null") as Header | null;
  if (header?.schema !== "paperclip.runner.controller-checkpoint.v1" || !header.state?.identity?.runId
    || typeof header.runnerVersion !== "string" || !header.runnerVersion
    || typeof header.runnerDigest !== "string" || !header.runnerDigest
    || !Array.isArray(header.commands) || !Array.isArray(header.events)
    || header.commands.some(key => typeof key !== "string" || !/^command:\d+$/.test(key))
    || header.events.some(key => typeof key !== "string" || !/^event:\d+$/.test(key))
    || new Set(header.commands).size !== header.commands.length
    || new Set(header.events).size !== header.events.length) throw new Error("native_runner_checkpoint_invalid");
  const read = (part: string) => {
    const value = parts.get(part);
    if (!value) throw new Error("native_runner_checkpoint_incomplete");
    return JSON.parse(value);
  };
  const checkpoint: DurablePrpCheckpoint = { schema: header.schema, runnerVersion: header.runnerVersion, runnerDigest: header.runnerDigest,
    state: { ...header.state, commands: header.commands.map(read), committedEvents: header.events.map(read) } };
  if (checkpointRunId(checkpoint.state) !== binding.runId) throw new Error("native_runner_checkpoint_binding_mismatch");
  return checkpoint;
}

/** Rebuild only the controller cache. Provider files and the running process remain in Daytona. */
export async function restoreNativeRunnerCheckpoint(db: Db, binding: Binding, root: string) {
  const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
  if (!checkpoint) return null;
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("native_runner_checkpoint_directory_unsafe");
  const directory = resolve(root, "control-plane");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("native_runner_checkpoint_directory_unsafe");
  const path = resolve(directory, "control-plane-state.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(checkpoint.state), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return checkpoint;
}
