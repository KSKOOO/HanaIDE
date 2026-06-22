import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSessionEntries,
  repairOversizedSessionEntriesInFile,
} from "../core/session-jsonl-file.ts";

describe("session-jsonl-file guards", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("projects oversized write tool-call args instead of dropping the whole session", () => {
    const hugeContent = "x".repeat(16 * 1024);
    const raw = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-06-04T00:00:00.000Z", cwd: "/work" }),
      JSON.stringify({
        id: "u1",
        parentId: null,
        type: "message",
        message: { role: "user", content: "write a file" },
      }),
      JSON.stringify({
        id: "a1",
        parentId: "u1",
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "报告2026.txt", content: hugeContent },
          }],
        },
      }),
    ].join("\n");

    const entries = parseSessionEntries(raw, { maxLineBytes: 1024 });

    expect(entries).toHaveLength(3);
    const args = entries[2].message.content[0].arguments;
    expect(args.path).toBe("报告2026.txt");
    expect(args.content).toMatch(/omitted/);
    expect(JSON.stringify(entries[2])).not.toContain(hugeContent);
  });

  it("repairs oversized JSONL lines in place and keeps a repair artifact", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-jsonl-guard-"));
    const sessionPath = path.join(tempRoot, "session.jsonl");
    const hugeContent = "y".repeat(16 * 1024);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-06-04T00:00:00.000Z", cwd: "/work" }),
      JSON.stringify({
        id: "a1",
        parentId: null,
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "报告2026.txt", content: hugeContent },
          }],
        },
      }),
      "",
    ].join("\n"));

    const result = repairOversizedSessionEntriesInFile(sessionPath, { maxLineBytes: 1024 });

    expect(result.repaired).toBe(true);
    expect(result.projected).toBe(1);
    expect(fs.existsSync(`${sessionPath}.repair.jsonl`)).toBe(true);
    const repairedRaw = fs.readFileSync(sessionPath, "utf-8");
    expect(repairedRaw).not.toContain(hugeContent);
    expect(repairedRaw).toContain("报告2026.txt");
    expect(parseSessionEntries(repairedRaw)).toHaveLength(2);
  });
});
