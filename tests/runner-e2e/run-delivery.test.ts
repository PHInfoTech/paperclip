import { describe, expect, it, vi } from "vitest";
import { inspectRunDelivery, waitForRunDelivery } from "./run-delivery.js";

function fixture() {
  const binding = { companyId: "company", issueId: "task", runId: "run" };
  return { binding, agentId: "agent", runCount: 1,
    run: { id: "run", agentId: "agent", companyId: "company", nativeIssueId: "task", status: "succeeded", issueCommentStatus: "satisfied",
      issueCommentSatisfiedByCommentId: "reply", resultJson: { nativeResult: { summary: "Internal saved result." },
        presentationDecision: { schema: "paperclip.run_presentation_decision.v1", chosenSource: "final_agent_message", commentAction: "create", commentId: "reply" } } },
    comments: [{ id: "reply", companyId: "company", issueId: "task", authorAgentId: "agent", createdByRunId: "run",
      body: "Here is your downloadable proof.", deletedAt: null as string | null }] };
}

describe("finalization final delivery observation", () => {
  it("accepts the persisted final message through its receipt and presentation identity", () => {
    const observed = inspectRunDelivery(fixture());
    expect(observed.finalDeliveryCount).toBe(1);
    expect(observed.deliveryReceiptMatches).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("downloadable proof");
  });
  it("counts an extra current-run reply with different text instead of hiding it", () => {
    const state = fixture();
    state.comments[0]!.body = state.run.resultJson.nativeResult.summary;
    state.comments.push({ ...state.comments[0]!, id: "duplicate", body: "A second different final reply." });
    const observed = inspectRunDelivery(state);
    expect(observed.finalDeliveryCount).toBe(2);
    expect(observed.deliveryReceiptMatches).toBe(false);
  });
  it.each(["company", "task", "run", "presentation", "receipt", "deleted", "blank"] as const)("rejects a mismatched %s final delivery", kind => {
    const state = fixture();
    if (kind === "company") state.run.companyId = "foreign";
    if (kind === "task") state.comments[0]!.issueId = "foreign";
    if (kind === "run") state.run.id = "foreign";
    if (kind === "presentation") state.run.resultJson.presentationDecision.commentId = "foreign";
    if (kind === "receipt") state.run.issueCommentSatisfiedByCommentId = "foreign";
    if (kind === "deleted") state.comments[0]!.deletedAt = "2026-10-21T12:00:00Z";
    if (kind === "blank") state.comments[0]!.body = "  ";
    expect(inspectRunDelivery(state).deliveryReceiptMatches).toBe(false);
  });
  it("waits across commit, comment creation, and the later receipt write", async () => {
    const state = fixture();
    const load = vi.fn().mockResolvedValueOnce({ ...state, comments: [], run: { ...state.run, issueCommentStatus: "pending", issueCommentSatisfiedByCommentId: null } })
      .mockResolvedValueOnce({ ...state, run: { ...state.run, issueCommentStatus: "pending", issueCommentSatisfiedByCommentId: null } })
      .mockResolvedValue(state);
    const result = await waitForRunDelivery({ ...state, deadlineAt: Date.now() + 1000, intervalMs: 0, load });
    expect(load).toHaveBeenCalledTimes(3);
    expect(result.delivery.deliveryReceiptMatches).toBe(true);
    expect(result.run.issueCommentSatisfiedByCommentId).toBe("reply");
  });
  it.each(["duplicate", "new-admission"] as const)("fails promptly on %s during the delivery wait", async kind => {
    const state = fixture();
    if (kind === "duplicate") state.comments.push({ ...state.comments[0]!, id: "duplicate", body: "Second reply" });
    else state.runCount++;
    const load = vi.fn().mockResolvedValue(state);
    await expect(waitForRunDelivery({ ...state, deadlineAt: Date.now() + 1000, intervalMs: 0, load }))
      .rejects.toThrow(kind === "duplicate" ? "duplicate final replies" : "repeated provider admission");
    expect(load).toHaveBeenCalledOnce();
  });
});
