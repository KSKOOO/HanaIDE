import { describe, expect, it, vi } from "vitest";
import { createApprovalGateway, createModelApprovalReviewer } from "../lib/approval-gateway.ts";

function request(overrides = {}) {
  return {
    id: "approval-1",
    kind: "tool_action",
    sessionPath: "/tmp/hana/session.jsonl",
    agentId: "hana",
    toolName: "write",
    actionName: "execute",
    params: { path: "notes.md" },
    target: { type: "file", label: "notes.md" },
    blastRadius: "workspace",
    reversibility: "easy",
    ...overrides,
  };
}

describe("ApprovalGateway", () => {
  it("hard-denies git push before model reviewers can approve it", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "looks fine" }));
    const largeToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "explicitly authorized" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "git push origin main" },
      target: { type: "command", label: "git push origin main" },
      blastRadius: "external",
      reversibility: "hard",
    }));

    expect(decision).toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      risk: "critical",
    });
    expect(decision.reason).toContain("/privacy-push");
    expect(smallToolModelReviewer).not.toHaveBeenCalled();
    expect(largeToolModelReviewer).not.toHaveBeenCalled();
  });

  it("hard-denies git push with global git options before model reviewers can approve it", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "looks fine" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git -C /repo push origin main" },
      target: { type: "command", label: "git -C /repo push origin main" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["privacy-push-required"],
    });
    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git --git-dir /repo/.git push origin --tags" },
      target: { type: "command", label: "git --git-dir /repo/.git push origin --tags" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["push-tags-blocked"],
    });
    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git -c user.name=hana push --force-with-lease origin main" },
      target: { type: "command", label: "git -c user.name=hana push --force-with-lease origin main" },
    }))).resolves.toMatchObject({
      action: "hard_deny",
      reviewer: "policy",
      ruleIds: ["force-push-blocked"],
    });

    expect(smallToolModelReviewer).not.toHaveBeenCalled();
  });

  it("does not hard-deny unrelated commands that happen to use --force", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "not a git push", risk: "medium" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "npm install left-pad@1.3.0 --force" },
      target: { type: "command", label: "npm install left-pad@1.3.0 --force" },
    }));

    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "not a git push",
    });
    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
  });

  it("uses the small tool-model reviewer for ordinary gray-area approvals", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "workspace edit is in scope",
      risk: "low",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ id: "approval-1" }) }),
    );
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "workspace edit is in scope",
      risk: "low",
    });
  });

  it("lets the large tool-model reviewer approve when the small reviewer would ask the user", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "small reviewer is unsure about the target",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "target and intent are specific enough",
      risk: "medium",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reason: "target and intent are specific enough",
      risk: "medium",
    });
  });

  it("lets the large tool-model reviewer approve when the small reviewer would deny and continue", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "deny_and_continue",
      reason: "small reviewer prefers a safer path",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "bounded workspace edit is acceptable",
      risk: "medium",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reason: "bounded workspace edit is acceptable",
      risk: "medium",
    });
  });

  it("escalates from the small tool-model reviewer to the large tool-model reviewer", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "escalate",
      reason: "needs blast-radius review",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "folder access is too broad",
      risk: "high",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request({
      kind: "session_folder",
      params: { action: "add", folder: "/Users/test/Desktop" },
      target: { type: "directory", label: "/Users/test/Desktop", path: "/Users/test/Desktop" },
      blastRadius: "device",
      reversibility: "moderate",
    }));

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "large_tool_model",
      reason: "folder access is too broad",
      risk: "high",
    });
  });

  it("allows automation create and update draft generation by policy", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "ask_user", reason: "should not be called" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "automation",
      actionName: "create",
      params: {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      target: { type: "tool", label: "Morning Review" },
      sideEffect: {
        kind: "deferred_mutation_draft",
        commit: "requires_user_confirmation",
        summary: "Automation draft writes only after the card is confirmed.",
      },
    }))).resolves.toMatchObject({
      action: "allow",
      reviewer: "policy",
      risk: "low",
      ruleIds: ["automation-draft-no-write"],
    });

    await expect(gateway.review(request({
      toolName: "automation",
      actionName: "update",
      params: {
        action: "update",
        id: "studio_job_1",
        scheduleType: "cron",
        schedule: "0 10 * * *",
      },
      target: { type: "tool", label: "automation" },
      sideEffect: {
        kind: "deferred_mutation_draft",
        commit: "requires_user_confirmation",
        summary: "Automation draft writes only after the card is confirmed.",
      },
    }))).resolves.toMatchObject({
      action: "allow",
      reviewer: "policy",
      risk: "low",
      ruleIds: ["automation-draft-no-write"],
    });

    expect(smallToolModelReviewer).not.toHaveBeenCalled();
  });

  it("fails closed to ask_user when no reviewer can decide", async () => {
    const gateway = createApprovalGateway();

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      risk: "medium",
    });
    expect(decision.reason).toContain("reviewer unavailable");
  });

  it("builds a utility-model reviewer that returns a normalized JSON decision", async () => {
    const resolveUtilityConfig = vi.fn(() => ({
      utility: { id: "small-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.test",
    }));
    const callText = vi.fn(async () => JSON.stringify({
      action: "allow",
      reason: "workspace edit matches the user request",
      risk: "low",
    }));
    const reviewer = createModelApprovalReviewer({
      role: "utility",
      resolveUtilityConfig,
      callText,
    });

    const decision = await reviewer({
      request: request(),
      userIntentSummary: "Edit notes.md",
      explicitUserAuthorization: "",
      sessionPermissionMode: "auto",
      trustEnvironment: { cwd: "/tmp/hana", workspaceFolders: ["/tmp/hana"] },
      recentApprovalHistory: [],
    });

    expect(resolveUtilityConfig).toHaveBeenCalledOnce();
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: { id: "small-reviewer", provider: "test" },
      maxTokens: 220,
      temperature: 0,
    }));
    expect(decision).toMatchObject({
      action: "allow",
      reason: "workspace edit matches the user request",
      risk: "low",
    });
  });
});
