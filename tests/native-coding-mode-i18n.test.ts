import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const localeFiles = ["en", "zh", "zh-TW", "ja", "ko"];

const stringKeys = [
  "coding.title",
  "coding.activityRail",
  "coding.labels.explorer",
  "coding.labels.editor",
  "coding.labels.panel",
  "coding.labels.hanaPanel",
  "coding.labels.assistantPanel",
  "coding.noWorkspace",
  "coding.activity.explorer",
  "coding.activity.search",
  "coding.activity.sourceControl",
  "coding.activity.run",
  "coding.activity.extensions",
  "coding.activity.settings",
  "coding.editor.unsupported",
  "coding.editor.welcomeTitle",
  "coding.editor.welcomeContent",
  "coding.editor.openFailed",
  "coding.explorer.empty",
  "coding.search.label",
  "coding.search.placeholder",
  "coding.search.empty",
  "coding.search.hint",
  "coding.sourceControl.description",
  "coding.sourceControl.gitStatus",
  "coding.sourceControl.refresh",
  "coding.run.description",
  "coding.run.startTerminal",
  "coding.run.gitStatus",
  "coding.run.npmTest",
  "coding.run.npmBuild",
  "coding.extensions.description",
  "coding.extensions.nativeTools",
  "coding.extensions.installed",
  "coding.extensions.empty",
  "coding.extensions.loading",
  "coding.extensions.installVsix",
  "coding.extensions.installPathLabel",
  "coding.extensions.installPathPlaceholder",
  "coding.extensions.startRuntime",
  "coding.extensions.enable",
  "coding.extensions.disable",
  "coding.extensions.runtime",
  "coding.extensions.unsupported",
  "coding.extensions.enabled",
  "coding.extensions.disabled",
  "coding.extensions.activated",
  "coding.extensions.noCommands",
  "coding.extensions.gallerySearch",
  "coding.extensions.galleryPlaceholder",
  "coding.extensions.galleryResults",
  "coding.extensions.search",
  "coding.settings.workspace",
  "coding.settings.terminal",
  "coding.settings.chat",
  "coding.chat.context",
  "coding.panel.terminal",
  "coding.panel.problems",
  "coding.panel.output",
  "coding.panel.logs",
  "coding.panel.problemsEmpty",
  "coding.panel.outputEmpty",
  "coding.panel.logsEmpty",
  "coding.terminal.workspace",
  "coding.terminal.empty",
  "coding.terminal.placeholder",
  "coding.terminal.noSession",
  "coding.terminal.read",
  "coding.terminal.start",
  "coding.terminal.close",
  "coding.context.workspace",
  "coding.context.activeFile",
  "coding.context.noFile",
  "coding.context.terminal",
  "coding.context.noTerminal",
];

function readLocale(locale: string): Record<string, unknown> {
  const file = path.join(root, "desktop", "src", "locales", `${locale}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getPath(value: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((cursor, part) => {
    if (!cursor || typeof cursor !== "object") return undefined;
    return (cursor as Record<string, unknown>)[part];
  }, value);
}

describe("native Coding Mode i18n", () => {
  it.each(localeFiles)("keeps every rendered Coding Mode key string-valued in %s", (locale) => {
    const messages = readLocale(locale);

    for (const key of stringKeys) {
      expect(getPath(messages, key), `${locale}:${key}`).toEqual(expect.any(String));
    }
  });
});
