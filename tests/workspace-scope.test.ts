import { describe, expect, it } from "vitest";
import path from "path";
import {
  formatWorkspaceScopePrompt,
  normalizeWorkspaceScope,
} from "../shared/workspace-scope.ts";

describe("workspace scope", () => {
  it("dedupes extra folders and excludes the primary cwd", () => {
    const primaryCwd = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const scope = normalizeWorkspaceScope({
      primaryCwd,
      workspaceFolders: [
        reference,
        primaryCwd,
        "",
        null,
        reference,
      ],
    });

    expect(scope).toEqual({
      primaryCwd,
      workspaceFolders: [reference],
    });
  });

  it("formats extra folders into the assistant workspace prompt", () => {
    const primaryCwd = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const prompt = formatWorkspaceScopePrompt({
      primaryCwd,
      workspaceFolders: [reference],
      locale: "zh-CN",
    });

    expect(prompt).toContain("当前工作目录");
    expect(prompt).toContain(primaryCwd);
    expect(prompt).toContain("额外文件夹");
    expect(prompt).toContain(reference);
  });
});
