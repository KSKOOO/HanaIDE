import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  COMPACTION_MODE_EXPERIMENT_ID,
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  getExperimentDefinitions,
  getResolvedExperimentValue,
  setExperimentValue,
} from "../lib/experiments/registry.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-experiments-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), "{}\n");
  return { root, prefs: new PreferencesManager({ userDir, agentsDir }) };
}

describe("experiment registry", () => {
  it("defines cache snapshot as a paired-toggle enum defaulting to off", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === CACHE_SNAPSHOT_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: CACHE_SNAPSHOT_EXPERIMENT_ID,
      owner: "memory",
      scope: "global",
      defaultValue: "off",
      valueSchema: {
        type: "enum",
        presentation: { type: "paired_toggles" },
      },
    });
    expect(entry.valueSchema.options.map((opt) => opt.value)).toEqual(["off", "shadow", "write"]);
  });

  it("defines compaction mode as a three-option select defaulting to auto", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === COMPACTION_MODE_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: COMPACTION_MODE_EXPERIMENT_ID,
      owner: "session",
      scope: "global",
      defaultValue: "auto",
      valueSchema: {
        type: "enum",
        presentation: { type: "select" },
      },
    });
    expect(entry.valueSchema.options.map((opt) => opt.value)).toEqual([
      "auto",
      "cache_preserving",
      "pi_compatible",
    ]);
  });

  it("defines the DeepSeek roleplay reasoning patch as a boolean toggle defaulting to off", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
      owner: "provider",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
  });

  it("rejects unknown experiment ids without writing preferences", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, "unknown.flag", true)).toThrow("unknown experiment id");
    expect(prefs.getPreferences().experiments).toBeUndefined();
  });

  it("persists and resolves valid global enum values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "shadow")).toBe("shadow");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("shadow");
    expect(prefs.getPreferences().experiments[CACHE_SNAPSHOT_EXPERIMENT_ID]).toBe("shadow");

    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("auto");
    expect(setExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID, "pi_compatible")).toBe("pi_compatible");
    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("pi_compatible");
    expect(prefs.getPreferences().experiments[COMPACTION_MODE_EXPERIMENT_ID]).toBe("pi_compatible");
  });

  it("persists and resolves valid global boolean values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, true)).toBe(true);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(true);
    expect(prefs.getPreferences().experiments[DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]).toBe(true);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, false)).toBe(false);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
  });

  it("rejects invalid enum values", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "maybe")).toThrow("invalid experiment value");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
  });
});
