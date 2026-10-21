import { createHash } from "node:crypto";
import { pollUntil } from "./api.js";
type RunDeliveryBinding = { companyId: string; issueId: string; runId: string };

type Row = Record<string, any>;
export function inspectRunDelivery(input: { binding: RunDeliveryBinding; agentId: string; run: Row; comments: Row[] }) {
  const { run, binding } = input, presentation = run.resultJson?.presentationDecision;
  const replies = input.comments.filter(comment => comment.companyId === binding.companyId && comment.issueId === binding.issueId &&
    comment.authorAgentId === input.agentId && comment.createdByRunId === binding.runId && !comment.deletedAt);
  const receiptMatches = run.id === binding.runId && run.companyId === binding.companyId && run.nativeIssueId === binding.issueId &&
    run.agentId === input.agentId && run.issueCommentStatus === "satisfied" && replies.length === 1 &&
    typeof replies[0]!.body === "string" && Boolean(replies[0]!.body.trim()) && run.issueCommentSatisfiedByCommentId === replies[0]!.id &&
    presentation?.schema === "paperclip.run_presentation_decision.v1" && presentation.commentId === replies[0]!.id &&
    ["create", "reuse"].includes(presentation.commentAction) &&
    ["existing_issue_comment", "final_agent_message", "semantic_result_summary", "adapter_final_response"].includes(presentation.chosenSource);
  return { finalDeliveryCount: replies.length, deliveryReceiptMatches: receiptMatches,
    presentation: { commentId: typeof presentation?.commentId === "string" ? presentation.commentId : null,
      chosenSource: typeof presentation?.chosenSource === "string" ? presentation.chosenSource : null },
    replies: replies.map(comment => ({ id: comment.id, authorAgentId: comment.authorAgentId, createdByRunId: comment.createdByRunId,
      bodySha256: createHash("sha256").update(String(comment.body ?? "").trim()).digest("hex") })) };
}

export async function waitForRunDelivery(input: {
  binding: RunDeliveryBinding; agentId: string; deadlineAt: number; intervalMs?: number;
  load(): Promise<{ run: Row; comments: Row[]; runCount: number }>;
}) {
  return pollUntil({ label: "one persisted final reply and its matching delivery receipt", deadlineAt: input.deadlineAt,
    intervalMs: input.intervalMs ?? 500,
    load: async () => {
      const state = await input.load();
      return { ...state, delivery: inspectRunDelivery({ ...input, ...state }) };
    },
    accept: state => state.runCount === 1 && state.delivery.deliveryReceiptMatches,
    reject: state => state.runCount !== 1 ? "Final delivery repeated provider admission" :
      state.delivery.finalDeliveryCount > 1 ? "Recovery produced duplicate final replies" :
        ["failed", "cancelled", "timed_out"].includes(state.run.status) ? "Recovered run failed before delivery" : undefined });
}
