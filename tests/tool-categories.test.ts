import { describe, it, expect } from "vitest";
import {
  CORE_TOOL_NAMES,
  GLOBAL_TOOL_NAMES,
  STANDARD_TOOL_NAMES,
  OPTIONAL_TOOL_NAMES,
  assertAllToolsCategorized,
  computeSettingsAvailableToolNames,
  computeToolSnapshot,
} from "../shared/tool-categories.ts";

describe("tool-categories constants", () => {
  it("three categories are pairwise disjoint", () => {
    const core = new Set(CORE_TOOL_NAMES);
    const standard = new Set(STANDARD_TOOL_NAMES);
    const global = new Set(GLOBAL_TOOL_NAMES);
    const optional = new Set(OPTIONAL_TOOL_NAMES);
    for (const name of core) {
      expect(standard.has(name)).toBe(false);
      expect(global.has(name)).toBe(false);
      expect(optional.has(name)).toBe(false);
    }
    for (const name of standard) {
      expect(global.has(name)).toBe(false);
      expect(optional.has(name)).toBe(false);
    }
    for (const name of global) {
      expect(optional.has(name)).toBe(false);
    }
  });

  it("OPTIONAL_TOOL_NAMES is exactly the user-toggleable whitelist", () => {
    expect(new Set(OPTIONAL_TOOL_NAMES)).toEqual(
      new Set(["automation", "beautify", "browser", "dm", "install_skill", "office", "update_settings", "workflow"])
    );
  });

  it("does not keep the removed legacy cron Agent tool in any category", () => {
    const all = new Set([
      ...CORE_TOOL_NAMES,
      ...STANDARD_TOOL_NAMES,
      ...GLOBAL_TOOL_NAMES,
      ...OPTIONAL_TOOL_NAMES,
    ]);
    expect(all.has("cron")).toBe(false);
  });

  it("GLOBAL_TOOL_NAMES is exactly the global setting governed whitelist", () => {
    expect(new Set(GLOBAL_TOOL_NAMES)).toEqual(new Set(["computer"]));
  });
});

describe("assertAllToolsCategorized", () => {
  it("passes on empty list", () => {
    expect(() => assertAllToolsCategorized([])).not.toThrow();
  });

  it("passes when all names are categorized", () => {
    expect(() => assertAllToolsCategorized(["read", "browser", "todo_write"])).not.toThrow();
  });

  it("throws with the uncategorized name and fix instructions", () => {
    expect(() => assertAllToolsCategorized(["read", "some_new_unknown_tool"]))
      .toThrow(/some_new_unknown_tool/);
    expect(() => assertAllToolsCategorized(["read", "some_new_unknown_tool"]))
      .toThrow(/shared\/tool-categories\.js/);
  });

  it("throws listing all uncategorized names when multiple are missing", () => {
    expect(() => assertAllToolsCategorized(["tool_a", "tool_b"]))
      .toThrow(/tool_a/);
    expect(() => assertAllToolsCategorized(["tool_a", "tool_b"]))
      .toThrow(/tool_b/);
  });
});

describe("computeSettingsAvailableToolNames", () => {
  it("adds built-in optional tool categories to runtime tool names", () => {
    expect(computeSettingsAvailableToolNames(["current_status"], {
      pluginTools: [{ _pluginId: "beautify" }, { _pluginId: "office" }],
    })).toEqual(expect.arrayContaining([
      "current_status",
      "automation",
      "beautify",
      "browser",
      "dm",
      "install_skill",
      "office",
      "update_settings",
    ]));
  });

  it("hides plugin-backed optional categories when the plugin is not registered", () => {
    const result = computeSettingsAvailableToolNames(["current_status"], { pluginTools: [] });

    expect(result).toContain("browser");
    expect(result).not.toContain("beautify");
    expect(result).not.toContain("office");
  });
});

describe("computeToolSnapshot", () => {
  const allNames = ["read", "bash", "browser", "automation", "todo_write", "web_fetch"];

  it("returns all names when disabled is empty", () => {
    expect(computeToolSnapshot(allNames, [])).toEqual(allNames);
  });

  it("removes optional tools that are in disabled list", () => {
    expect(computeToolSnapshot(allNames, ["browser"])).toEqual(
      ["read", "bash", "automation", "todo_write", "web_fetch"]
    );
  });

  it("keeps core tools even when disabled list contains them (tampering protection)", () => {
    const result = computeToolSnapshot(allNames, ["read", "browser"]);
    expect(result).toContain("read");
    expect(result).not.toContain("browser");
  });

  it("keeps standard tools even when disabled list contains them (tampering protection)", () => {
    const result = computeToolSnapshot(allNames, ["todo_write"]);
    expect(result).toContain("todo_write");
  });

  it("is order-preserving (follows allNames order)", () => {
    const result = computeToolSnapshot(["a", "b", "browser", "c"], ["browser"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("deduplicates tool names while preserving the first occurrence", () => {
    const result = computeToolSnapshot(
      ["read", "bash", "read", "browser", "browser", "todo_write"],
      [],
    );

    expect(result).toEqual(["read", "bash", "browser", "todo_write"]);
  });

  it("treats null disabled as empty (no tools removed)", () => {
    expect(computeToolSnapshot(["read", "browser"], null)).toEqual(["read", "browser"]);
  });

  it("treats undefined disabled as empty (no tools removed)", () => {
    expect(computeToolSnapshot(["read", "browser"], undefined)).toEqual(["read", "browser"]);
  });

  it("removes explicitly runtime-disabled plugin tools without categorizing them as built-ins", () => {
    const result = computeToolSnapshot(
      ["read", "mcp_github_search", "browser"],
      [],
      { extraDisabled: ["mcp_github_search"] },
    );

    expect(result).toEqual(["read", "browser"]);
  });
});
