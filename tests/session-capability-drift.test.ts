/**
 * #1624: Session capability fingerprint & drift classification.
 *
 * Contract under test:
 *  - computeSessionCapabilityFingerprint is order-insensitive for tools and
 *    clock-insensitive for the system prompt (the trailing
 *    "Current date and time: ..." line buildSystemPrompt appends).
 *  - buildSessionCapabilityDrift classifies added / removed / invalid tools and
 *    prompt change, and hasDrift is the union of those signals.
 *  - repairRestoredToolSnapshotDetailed reports the silently filtered names so
 *    the restore path can surface them instead of dropping them invisibly.
 */
import { describe, it, expect } from "vitest";
import {
  computeSessionCapabilityFingerprint,
  buildSessionCapabilityDrift,
  normalizeSystemPromptForFingerprint,
} from "../core/session-capability-drift.ts";
import {
  repairRestoredToolSnapshot,
  repairRestoredToolSnapshotDetailed,
} from "../core/tool-snapshot-repair.ts";

describe("computeSessionCapabilityFingerprint", () => {
  it("is insensitive to tool name ordering and duplicates", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read", "bash", "edit"],
      systemPrompt: "p",
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["edit", "read", "bash", "read"],
      systemPrompt: "p",
    });
    expect(a).toBe(b);
  });

  it("changes when the tool set actually changes", () => {
    const a = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: "p" });
    const b = computeSessionCapabilityFingerprint({ toolNames: ["read", "browser"], systemPrompt: "p" });
    expect(a).not.toBe(b);
  });

  it("ignores the volatile current-date line in the system prompt", () => {
    const promptA = "You are Hana.\nCurrent date and time: Monday, June 8, 2026, 10:00 CST\nYour day starts at 04:00.";
    const promptB = "You are Hana.\nCurrent date and time: Thursday, June 11, 2026, 23:59 CST\nYour day starts at 04:00.";
    const a = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: promptA });
    const b = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: promptB });
    expect(a).toBe(b);
  });

  it("still changes when non-clock prompt content changes", () => {
    const a = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: "v1 persona" });
    const b = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: "v2 persona" });
    expect(a).not.toBe(b);
  });
});

describe("normalizeSystemPromptForFingerprint", () => {
  it("replaces only the date line, leaving the rest intact", () => {
    const prompt = "head\nCurrent date and time: Monday, June 8, 2026\ntail";
    const normalized = normalizeSystemPromptForFingerprint(prompt);
    expect(normalized).toContain("head");
    expect(normalized).toContain("tail");
    expect(normalized).not.toContain("June 8, 2026");
  });

  it("passes through non-string values as strings without throwing", () => {
    expect(normalizeSystemPromptForFingerprint(null)).toBe("");
    expect(normalizeSystemPromptForFingerprint(undefined)).toBe("");
  });
});

/**
 * Mirrors the exact join shape of agent.buildSystemPrompt() around the dynamic
 * segments (memory block, appearance summary, clock line). The fingerprint
 * must treat background-compiled memory content and appearance summaries as
 * non-capability state, while persona/config text still counts.
 */
function buildPromptFixture({
  persona = "You are Hana. v1 persona.",
  appearance = "",
  pinned = "",
  memory = "",
  date = "Monday, June 8, 2026, 10:00 CST",
  locale = "zh",
}: {
  persona?: string;
  appearance?: string;
  pinned?: string;
  memory?: string;
  date?: string;
  locale?: string;
} = {}) {
  const isZh = locale.startsWith("zh");
  const parts: string[] = [persona];
  if (appearance) {
    parts.push(`## ${isZh ? "你的样子" : "Your Appearance"}\n\n${appearance}`);
  }
  parts.push(isZh
    ? "\n## 工作台\n\n用户所说的「工作台」指的是当前工作目录（cwd）。\n当前工作目录：/tmp/ws\n用户提到的文件、目录默认在当前工作目录下查找。"
    : "\n## Workspace\n\nWhen the user says \"workspace\", they mean the current working directory (cwd).\nCurrent working directory: /tmp/ws\nFiles and directories mentioned by the user should be searched in the current working directory first.");
  parts.push(isZh
    ? "\n## 文件与命令工具使用\n\n查看文件和目录时优先用 read/grep/find/ls。"
    : "\n## Tool Use For Files And Commands\n\nUse read/grep/find/ls to inspect files.");
  if (pinned || memory) {
    const memParts = [
      ["", isZh ? "## 记忆使用规则" : "## Memory Rules", "", "记忆和用户档案是你内化的背景知识。"].join("\n"),
    ];
    if (pinned) {
      memParts.push("", "---", "", isZh ? "# 置顶记忆" : "# Pinned Memories", "", pinned);
    }
    if (memory) {
      memParts.push("", "---", "", isZh ? "# 记忆" : "# Memory", "", `以下这些是从过往对话积累的记忆。\n\n${memory}`);
    }
    parts.push(...memParts);
  }
  parts.push(`\nCurrent date and time: ${date}`);
  parts.push(isZh
    ? "你的一天从 04:00 开始。04:00 之前的对话属于前一天。"
    : "Your day starts at 04:00. Conversations before 04:00 belong to the previous day.");
  return parts.join("\n");
}

describe("normalizeSystemPromptForFingerprint — dynamic segments (#1624 C1)", () => {
  it("yields equal fingerprints for same config but different memory.md content", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ memory: "用户喜欢喝乌龙茶。" }),
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ memory: "用户上周开始学小提琴。\n\n用户喜欢雨天。", date: "Thursday, June 11, 2026, 23:59 CST" }),
    });
    expect(a).toBe(b);
  });

  it("treats memory block absence vs presence as the same capability", () => {
    const absent = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture(),
    });
    const present = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ pinned: "记住周五交房租。", memory: "新积累的记忆。" }),
    });
    expect(absent).toBe(present);
  });

  it("ignores pinned-memory-only changes", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ pinned: "置顶 A" }),
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ pinned: "置顶 B，内容完全不同" }),
    });
    expect(a).toBe(b);
  });

  it("ignores appearance summary changes and absence vs presence", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ appearance: "银白色长发，深蓝色眼睛。" }),
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ appearance: "黑色短发，戴细框眼镜。" }),
    });
    const c = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture(),
    });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("keeps appearance absence vs presence equal when the persona ends with a trailing newline", () => {
    // ishiki templates are markdown files that typically end with "\n"; the
    // seam in front of the workspace heading then carries an extra blank line
    // in the "absent" case. Normalization must canonicalize the seam, not just
    // delete the block.
    const persona = "You are Hana. v1 persona.\n";
    const present = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ persona, appearance: "银白色长发。" }),
    });
    const absent = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ persona }),
    });
    expect(present).toBe(absent);
  });

  it("normalizes English-locale memory and appearance segments the same way", () => {
    const a = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ locale: "en", appearance: "Silver hair.", memory: "Likes tea.", pinned: "Rent due Friday." }),
    });
    const b = computeSessionCapabilityFingerprint({
      toolNames: ["read"],
      systemPrompt: buildPromptFixture({ locale: "en" }),
    });
    expect(a).toBe(b);
  });

  it("does not strip the Workspace Instructions section (heading prefix collision)", () => {
    const withInstructions = (agentsMd: string) => buildPromptFixture({ appearance: "银发。" })
      .replace("\n## 文件与命令工具使用", `\n## Workspace Instructions\n\n### AGENTS.md\n\n${agentsMd}\n\n## 文件与命令工具使用`);
    const a = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: withInstructions("Rule v1") });
    const b = computeSessionCapabilityFingerprint({ toolNames: ["read"], systemPrompt: withInstructions("Rule v2") });
    expect(a).not.toBe(b);
  });

  it("still flags persona/config prompt changes even when memory also changed", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read"],
      frozenSystemPrompt: buildPromptFixture({ persona: "You are Hana. v1 persona.", memory: "旧记忆" }),
      liveSystemPrompt: buildPromptFixture({ persona: "You are Hana. v2 persona, rewritten.", memory: "新记忆" }),
    });
    expect(drift.promptChanged).toBe(true);
    expect(drift.hasDrift).toBe(true);
  });

  it("still flags tool changes when only memory content differs on the prompt side", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read", "browser"],
      frozenSystemPrompt: buildPromptFixture({ memory: "旧记忆" }),
      liveSystemPrompt: buildPromptFixture({ memory: "新记忆" }),
    });
    expect(drift.promptChanged).toBe(false);
    expect(drift.addedToolNames).toEqual(["browser"]);
    expect(drift.hasDrift).toBe(true);
  });

  it("reports no drift across a memory-only recompile (end-to-end shape)", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read", "bash"],
      liveToolNames: ["bash", "read"],
      frozenSystemPrompt: buildPromptFixture({ memory: "旧记忆", pinned: "旧置顶", appearance: "银发。" }),
      liveSystemPrompt: buildPromptFixture({ memory: "后台 compile 后的新记忆", pinned: "新置顶", appearance: "黑发。", date: "Friday, June 12, 2026, 08:00 CST" }),
    });
    expect(drift.promptChanged).toBe(false);
    expect(drift.hasDrift).toBe(false);
    expect(drift.fingerprint).toBe(drift.frozenFingerprint);
  });

  it("normalizes every clock line, not just the first (M4)", () => {
    const normalized = normalizeSystemPromptForFingerprint(
      "Current date and time: Monday, June 8, 2026\nmiddle\nCurrent date and time: Thursday, June 11, 2026",
    );
    expect(normalized).not.toContain("June 8, 2026");
    expect(normalized).not.toContain("June 11, 2026");
  });
});

describe("buildSessionCapabilityDrift", () => {
  it("reports no drift when frozen and live sets match", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read", "bash"],
      liveToolNames: ["bash", "read"],
      frozenSystemPrompt: "p",
      liveSystemPrompt: "p",
    });
    expect(drift.hasDrift).toBe(false);
    expect(drift.addedToolNames).toEqual([]);
    expect(drift.removedToolNames).toEqual([]);
    expect(drift.invalidToolNames).toEqual([]);
    expect(drift.promptChanged).toBe(false);
    expect(drift.fingerprint).toBe(drift.frozenFingerprint);
  });

  it("classifies newly available tools as added", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read", "office", "beautify"],
      frozenSystemPrompt: "p",
      liveSystemPrompt: "p",
    });
    expect(drift.hasDrift).toBe(true);
    expect(drift.addedToolNames).toEqual(["beautify", "office"]);
    expect(drift.removedToolNames).toEqual([]);
  });

  it("classifies tools missing from the live set as removed", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read", "browser"],
      liveToolNames: ["read"],
      frozenSystemPrompt: "p",
      liveSystemPrompt: "p",
    });
    expect(drift.hasDrift).toBe(true);
    expect(drift.removedToolNames).toEqual(["browser"]);
  });

  it("carries invalid (no-longer-registered) tool names from the repair step", () => {
    const drift = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read"],
      invalidToolNames: ["retired_tool"],
      frozenSystemPrompt: "p",
      liveSystemPrompt: "p",
    });
    expect(drift.hasDrift).toBe(true);
    expect(drift.invalidToolNames).toEqual(["retired_tool"]);
  });

  it("flags prompt drift via normalized comparison (clock line excluded)", () => {
    const same = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read"],
      frozenSystemPrompt: "p\nCurrent date and time: Monday, June 8, 2026",
      liveSystemPrompt: "p\nCurrent date and time: Thursday, June 11, 2026",
    });
    expect(same.promptChanged).toBe(false);
    expect(same.hasDrift).toBe(false);

    const changed = buildSessionCapabilityDrift({
      frozenToolNames: ["read"],
      liveToolNames: ["read"],
      frozenSystemPrompt: "old persona",
      liveSystemPrompt: "new persona",
    });
    expect(changed.promptChanged).toBe(true);
    expect(changed.hasDrift).toBe(true);
    expect(changed.fingerprint).not.toBe(changed.frozenFingerprint);
  });
});

describe("repairRestoredToolSnapshotDetailed", () => {
  it("returns the same kept list as repairRestoredToolSnapshot plus the dropped names", () => {
    const snapshot = ["read", "retired_tool", "bash", "another_dead"];
    const all = ["read", "bash", "edit"];
    const detailed = repairRestoredToolSnapshotDetailed(snapshot, all, { coreToolNames: [] });
    expect(detailed.toolNames).toEqual(repairRestoredToolSnapshot(snapshot, all, { coreToolNames: [] }));
    expect(detailed.droppedToolNames).toEqual(["retired_tool", "another_dead"]);
  });

  it("reports no drops for a fully valid snapshot", () => {
    const detailed = repairRestoredToolSnapshotDetailed(["read"], ["read", "bash"], { coreToolNames: [] });
    expect(detailed.toolNames).toEqual(["read"]);
    expect(detailed.droppedToolNames).toEqual([]);
  });

  it("does not double-report duplicated dead names", () => {
    const detailed = repairRestoredToolSnapshotDetailed(
      ["dead", "dead", "read"],
      ["read"],
      { coreToolNames: [] },
    );
    expect(detailed.droppedToolNames).toEqual(["dead"]);
  });
});
