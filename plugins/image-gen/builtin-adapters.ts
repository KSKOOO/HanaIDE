import { agnesImageAdapter, agnesVideoAdapter } from "./adapters/agnes.ts";
import { dashscopeImageAdapter } from "./adapters/dashscope.ts";
import { geminiImageAdapter } from "./adapters/gemini.ts";
import { minimaxImageAdapter } from "./adapters/minimax.ts";
import { openaiCodexImageAdapter } from "./adapters/openai-codex.ts";
import { openaiImageAdapter } from "./adapters/openai.ts";
import { volcengineImageAdapter } from "./adapters/volcengine.ts";

export const builtinImageGenAdapters = Object.freeze([
  volcengineImageAdapter,
  openaiImageAdapter,
  openaiCodexImageAdapter,
  minimaxImageAdapter,
  dashscopeImageAdapter,
  geminiImageAdapter,
  agnesImageAdapter,
  agnesVideoAdapter,
]);
