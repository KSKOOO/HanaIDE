/**
 * #1624: Session capability fingerprint & drift detection.
 *
 * A desktop session deliberately freezes its tool snapshot and system prompt
 * snapshot at creation time to protect the provider prompt-prefix cache. After
 * a version update the live agent config may expose new tools (or retire old
 * ones) and ship an updated system prompt — the frozen session keeps running
 * on its old capabilities by design, but the user should be able to *see* the
 * gap and explicitly upgrade (fresh compact).
 *
 * This module is the single source for the capability fingerprint. Hashing
 * delegates to lib/llm/cache-prefix-contract.ts (same primitive that backs the
 * session cache snapshot hashes) — do not introduce a second hash
 * implementation.
 */
import { hashCacheContractValue } from "../lib/llm/cache-prefix-contract.ts";
import { uniqueToolNames } from "../shared/tool-categories.ts";

export const SESSION_CAPABILITY_FINGERPRINT_VERSION = 1;

/**
 * agent.buildSystemPrompt() embeds three kinds of *non-configuration* state
 * that mutates on its own between restores. The capability fingerprint must
 * capture configuration identity only — otherwise every restore of an active
 * user looks like prompt drift, the dismissed-fingerprint semantics can never
 * hold, and the banner nags users into needless lossy compacts.
 *
 * Stripped segments (markers are the literal section headings buildSystemPrompt
 * emits, zh + en — see core/agent.ts buildSystemPrompt):
 *  - Memory block: from the "## 记忆使用规则" / "## Memory Rules" heading
 *    (includes "# 置顶记忆" / "# Pinned Memories" and "# 记忆" / "# Memory"
 *    sections) up to the trailing "Current date and time:" clock line.
 *    memory.md is recompiled in the background and pinned.md is writable by
 *    the agent mid-conversation.
 *  - Appearance summary: "## 你的样子" / "## Your Appearance" up to the
 *    "## 工作台" / "## Workspace" heading that always follows it. The summary
 *    is refreshed asynchronously from the avatar. The end anchor requires a
 *    newline right after the heading so "## Workspace Instructions" (the
 *    AGENTS.md block, which IS user-managed config) can never match.
 *  - Clock line: "Current date and time: ..." (every occurrence).
 *
 * Each segment pattern matches the newline seam in front of its stable end
 * anchor with the dynamic block itself optional, and rewrites the whole seam
 * to a canonical "\n\n". This makes "segment absent" and "segment present"
 * normalize to byte-identical text regardless of how many blank lines the
 * surrounding parts contribute (template files often end with a trailing
 * newline) — memory accumulating from empty is not drift.
 *
 * Deliberately KEPT in the comparison (user-managed configuration): persona /
 * identity / ishiki text, user profile (user.md, only writable via settings),
 * team roster, workspace instruction files (AGENTS.md / CLAUDE.md), and
 * feature-gated behavior sections.
 */
const MEMORY_SEAM_PATTERN = /\n+(?:## (?:记忆使用规则|Memory Rules)\n[\s\S]*?\n+)?(?=Current date and time: )/g;
const APPEARANCE_SEAM_PATTERN = /\n+(?:## (?:你的样子|Your Appearance)\n[\s\S]*?\n+)?(?=## (?:工作台|Workspace)\n)/g;
const CLOCK_LINE_PATTERN = /^Current date and time: .*$/gm;

export function normalizeSystemPromptForFingerprint(systemPrompt) {
  const text = typeof systemPrompt === "string" ? systemPrompt : String(systemPrompt ?? "");
  return text
    .replace(MEMORY_SEAM_PATTERN, "\n\n")
    .replace(APPEARANCE_SEAM_PATTERN, "\n\n")
    .replace(CLOCK_LINE_PATTERN, "Current date and time: <normalized>");
}

/**
 * Order-insensitive, clock-insensitive fingerprint over a session's tool set
 * and system prompt. Used both for the frozen snapshot side and the live
 * config side; equality means "same capability identity".
 */
export function computeSessionCapabilityFingerprint({ toolNames = [], systemPrompt = "" } = {}) {
  return hashCacheContractValue({
    version: SESSION_CAPABILITY_FINGERPRINT_VERSION,
    toolNames: [...uniqueToolNames(toolNames)].sort(),
    systemPrompt: normalizeSystemPromptForFingerprint(systemPrompt),
  });
}

/**
 * Classify the drift between a session's frozen capability snapshot and the
 * live capability a freshly created session would get from the current agent
 * config.
 *
 * @param {object} input
 * @param {string[]} input.frozenToolNames   repaired tool snapshot the session runs on
 * @param {string[]} input.liveToolNames     tool set a fresh session would compute now
 * @param {string[]} [input.invalidToolNames] frozen names dropped by repair because
 *                                            they are no longer registered at all
 * @param {string}   input.frozenSystemPrompt frozen system prompt snapshot
 * @param {string}   input.liveSystemPrompt   freshly built system prompt
 */
export function buildSessionCapabilityDrift({
  frozenToolNames = [],
  liveToolNames = [],
  invalidToolNames = [],
  frozenSystemPrompt = "",
  liveSystemPrompt = "",
} = {}) {
  const frozen = new Set(uniqueToolNames(frozenToolNames));
  const live = new Set(uniqueToolNames(liveToolNames));
  const addedToolNames = [...live].filter((name) => !frozen.has(name)).sort();
  const removedToolNames = [...frozen].filter((name) => !live.has(name)).sort();
  const invalid = [...uniqueToolNames(invalidToolNames)].sort();
  const promptChanged = normalizeSystemPromptForFingerprint(frozenSystemPrompt)
    !== normalizeSystemPromptForFingerprint(liveSystemPrompt);
  const frozenFingerprint = computeSessionCapabilityFingerprint({
    toolNames: frozenToolNames,
    systemPrompt: frozenSystemPrompt,
  });
  const fingerprint = computeSessionCapabilityFingerprint({
    toolNames: liveToolNames,
    systemPrompt: liveSystemPrompt,
  });
  return {
    version: SESSION_CAPABILITY_FINGERPRINT_VERSION,
    fingerprint,
    frozenFingerprint,
    addedToolNames,
    removedToolNames,
    invalidToolNames: invalid,
    promptChanged,
    hasDrift: addedToolNames.length > 0
      || removedToolNames.length > 0
      || invalid.length > 0
      || promptChanged,
  };
}
