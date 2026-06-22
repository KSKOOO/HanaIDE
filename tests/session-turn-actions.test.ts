import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { replayLatestUserTurn } from "../core/session-turn-actions.ts";

function makeNavigableSession(manager) {
  return {
    sessionManager: manager,
    navigateTree: vi.fn(async (entryId) => {
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    }),
  };
}

describe("replayLatestUserTurn", () => {
  it("branches before the latest user message and replays the original prompt", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "try again" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      clientMessageId: "client-user",
      displayMessage: { text: "try again" },
    }, { submit });

    expect(session.navigateTree).not.toHaveBeenCalled();
    expect(manager.getBranch().map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "session_branch_reset",
      messageId: latestUserId,
      clientMessageId: "client-user",
    }, "/tmp/main.jsonl");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      sessionPath: "/tmp/main.jsonl",
      text: "try again",
      displayMessage: expect.objectContaining({ text: "try again" }),
    }));
  });

  it("replaces only the visible text when editing and preserves attachment markers", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new text",
      displayMessage: { text: "new text" },
    }, { submit, readFile });

    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nnew text",
      images: [{ type: "image", data: Buffer.from("png-by-filename").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
      displayMessage: expect.objectContaining({ text: "new text" }),
    }));
  });

  it("branches before the latest user when editing a leaf user message", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "context" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "context answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old leaf text" }] } as any);
    const session = makeNavigableSession(manager);
    session.navigateTree = vi.fn(async (entryId) => {
      if (entryId === manager.getLeafId?.()) return { cancelled: false };
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    });
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new leaf text",
      displayMessage: { text: "new leaf text" },
    }, { submit });

    expect(manager.getBranch().map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "new leaf text",
      displayMessage: expect.objectContaining({ text: "new leaf text" }),
    }));
  });

  it("rehydrates pruned attached image markers when replaying a turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).toHaveBeenCalledWith("/tmp/a.png");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: [{ type: "image", data: Buffer.from("png-by-filename").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("keeps existing inline image payloads on replay without rereading the path", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "[attached_image: /tmp/a.png]\nold text" },
        { type: "image", data: "BASE64_A", mimeType: "image/png" },
      ],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: [{ type: "image", data: "BASE64_A", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("rejects a stale source entry instead of replaying the wrong turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const staleUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }] } as any);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "latest" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: staleUserId,
    }, { submit })).rejects.toThrow("latest user message");

    expect(submit).not.toHaveBeenCalled();
  });
});
