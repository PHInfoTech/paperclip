import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared";
import { localEncryptedProvider } from "../../secrets/local-encrypted-provider.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
// Re-execution of these reads still goes through the current tool authority.
// Unknown operations and external effects require a completed durable receipt.
const recoverableReads = new Set([
  "get_task_context", "get_task_history", "search_tasks", "list_documents", "read_document",
  "list_document_revisions", "list_agents", "get_agent", "list_projects", "list_approvals",
  "get_approval", "get_approval_context", "read_agent_instructions", "get_agent_instruction_history",
]);

export async function recoverNativeSemanticInput(input: {
  db: Db;
  binding: { companyId: string; issueId: string; agentId: string; runId: string };
  call: { callId: string; operationId: string; input: unknown };
  executeRead: () => Promise<unknown>;
}): Promise<{ result: unknown; isError?: boolean } | null> {
  const { db, binding, call } = input;
  const [run] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.agentId, binding.agentId),
    eq(heartbeatRuns.status, "running")));
  if (!run) return null;
  if (recoverableReads.has(call.operationId)) return { result: await input.executeRead() };
  const argumentsRecord = record(call.input);
  const key = typeof argumentsRecord.idempotencyKey === "string" ? argumentsRecord.idempotencyKey : null;
  const receipt = key ? record(record(run.result?.semanticToolReceipts)[key]) : {};
  if (receipt.operationId === call.operationId && canonicalJson(receipt.input) === canonicalJson(call.input)
    && Object.hasOwn(receipt, "result")) return { result: receipt.result };

  const callKey = createHash("sha256").update(call.callId).digest("hex");
  if (call.operationId === "call_api") {
    const api = record(record(run.result?.apiToolReceipts)[callKey]);
    if (api.state !== "completed" || api.digest !== digest(call.input)) return null;
    const result = api.encryptedResult
      ? JSON.parse(await localEncryptedProvider.resolveVersion({ material: record(api.encryptedResult), externalRef: null }))
      : api.result;
    if (result === undefined || record(result).outcome === "unknown") return null;
    return { result: { operationId: call.operationId,
      callId: call.callId, ok: true, result } };
  }
  if (call.operationId === "workspace_write" || call.operationId === "workspace_run") {
    const bridge = record(record(run.result?.bridgeToolReceipts)[callKey]);
    if (bridge.state === "completed" && bridge.tool === call.operationId
      && bridge.digest === digest({ tool: call.operationId, arguments: call.input })
      && Object.hasOwn(bridge, "result")) return { result: bridge.result };
  }
  return null;
}
