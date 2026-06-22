/**
 * 桌面 session 的统一提交入口。
 * 本地输入与 bridge /rc 接管都应通过这一层提交消息到桌面 session。
 */

/**
 * @param {object} engine
 * @param {object} opts
 * @param {string} opts.sessionPath
 * @param {string} opts.text
 * @param {Array<{type:'image', data:string, mimeType:string}>} [opts.images]
 * @param {string[]} [opts.imageAttachmentPaths]
 * @param {Array<{type:'video', data:string, mimeType:string}>} [opts.videos]
 * @param {string[]} [opts.videoAttachmentPaths]
 * @param {Array<{type:'audio', data:string, mimeType:string}>} [opts.audios]
 * @param {string[]} [opts.audioAttachmentPaths]
 * @param {Array<{type:string, filename?:string, mimeType?:string, buffer:Buffer|Uint8Array|string}>} [opts.inboundFiles]
 * @param {string} [opts.clientMessageId]
 * @param {(delta: string, accumulated: string) => void} [opts.onDelta]
 * @param {object} [opts.displayMessage]
 * @param {Array<{fileId?:string, sessionId?:string, sessionPath?:string, label?:string, kind?:string}>} [opts.sessionFileRefs]
 * @param {object|null|undefined} [opts.uiContext]
 * @param {object|null|undefined} [opts.context]
 * @returns {Promise<{ text: string | null, toolMedia: string[] }>}
 */
import path from "path";
import { extOfName, inferFileKind } from "../lib/file-metadata.ts";
import { collectMediaItems } from "../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.ts";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.ts";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";

/**
 * 非桌面来源（bridge /rc 等）用户消息的来源元信息持久化条目类型。
 *
 * jsonl 的 message 条目格式归 Pi SDK 所有，不能塞自定义字段；来源元信息
 * 走 SDK 的 custom entry 通道（与 hana-deferred-result 同一模式）。
 * 条目写在它所注释的 user message 之前，紧邻性尽力保证；interject 路径
 * 时，中间可能隔着在途 assistant 输出，消费方须以"其后第一条 user message"
 * 语义关联（跳过中间 assistant 条目）。未知 customType 的 custom 条目不进
 * 模型上下文、不进历史展示，老版本读取时自动跳过。
 *
 * 孤儿容忍规则：消费方必须容忍"origin 条目后没有紧随 user message"的孤儿
 * 条目（例如 steer 被拒绝、prompt 路径写入前抛错），遇到孤儿时跳过即可，
 * 禁止盲目前向关联到下一条消息。
 */
export const MESSAGE_ORIGIN_RECORD_TYPE = "hana-message-origin";

const pendingDesktopSessionSubmissions = new Set();

/**
 * 持久化非桌面来源的消息 origin。写失败只告警不阻断：来源标注是辅助
 * 元数据，不能因为它写不进去就丢掉用户消息本身。
 */
function recordMessageOriginEntry(session: any, sessionPath: string, displayMessage: any): void {
  const source = displayMessage?.source;
  if (!source || source === "desktop") return;
  try {
    if (typeof session?.sessionManager?.appendCustomEntry !== "function") {
      console.warn(`[desktop-session-submit] message origin not persisted (no appendCustomEntry): ${sessionPath}`);
      return;
    }
    session.sessionManager.appendCustomEntry(MESSAGE_ORIGIN_RECORD_TYPE, {
      source,
      bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn(`[desktop-session-submit] message origin write failed for ${sessionPath}: ${err?.message || err}`);
  }
}

export async function submitDesktopSessionMessage(engine: any, opts: {
  sessionPath?: string;
  text?: string;
  images?: Array<{ type: string; data: string; mimeType: string }>;
  imageAttachmentPaths?: string[];
  videos?: Array<{ type: string; data: string; mimeType: string }>;
  videoAttachmentPaths?: string[];
  audios?: Array<{ type: string; data: string; mimeType: string }>;
  audioAttachmentPaths?: string[];
  inboundFiles?: Array<{ type: string; filename?: string; mimeType?: string; buffer: any }>;
  clientMessageId?: string;
  onDelta?: (delta: string, accumulated: string) => void;
  displayMessage?: any;
  sessionFileRefs?: Array<{ fileId?: string; sessionId?: string; sessionPath?: string; label?: string; kind?: string }>;
  uiContext?: any;
  context?: any;
} = {}) {
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    videos,
    videoAttachmentPaths,
    audios,
    audioAttachmentPaths,
    inboundFiles,
    clientMessageId,
    onDelta,
    displayMessage,
    sessionFileRefs,
    uiContext,
    context,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function" || typeof engine.promptSession !== "function") {
    throw new Error("desktop-session-submit: engine session API unavailable");
  }
  if (!sessionPath) throw new Error("desktop-session-submit: sessionPath is required");
  if (!text && !images?.length && !videos?.length && !audios?.length) throw new Error("desktop-session-submit: text, images, videos, or audios required");
  const sessionId = resolveSessionIdForPath(engine, sessionPath);
  const submissionKey = sessionId || sessionPath;
  if (pendingDesktopSessionSubmissions.has(submissionKey)) {
    throw new Error("session_busy");
  }
  if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
    throw new Error("session_busy");
  }

  pendingDesktopSessionSubmissions.add(submissionKey);
  try {
    const session = await engine.ensureSessionLoaded(sessionPath);
    if (!session) throw new Error(`desktop-session-submit: failed to load session ${sessionPath}`);

    if (uiContext !== undefined) {
      engine.setUiContext?.(sessionPath, uiContext ?? null);
    }

    let promptImageAttachmentPaths = imageAttachmentPaths || [];
    let promptVideoAttachmentPaths = videoAttachmentPaths || [];
    let promptAudioAttachmentPaths = audioAttachmentPaths || [];
    let displayAttachments = displayMessage?.attachments;
    let promptText = text || "";
    let promptSessionFileRefs = normalizeSessionFileRefs(sessionFileRefs, sessionPath, sessionId);

    if (displayAttachments?.length) {
      const registeredDisplay = registerDisplayAttachments({
        hanakoHome: engine.hanakoHome,
        sessionPath,
        attachments: displayAttachments,
        registerSessionFile: engine.registerSessionFile?.bind(engine),
      });
      displayAttachments = registeredDisplay.attachments;
      promptImageAttachmentPaths = uniquePaths([
        ...promptImageAttachmentPaths,
        ...registeredDisplay.imageAttachmentPaths,
      ]);
      promptVideoAttachmentPaths = uniquePaths([
        ...promptVideoAttachmentPaths,
        ...registeredDisplay.videoAttachmentPaths,
      ]);
      if (audios?.length || promptAudioAttachmentPaths.length) {
        promptAudioAttachmentPaths = uniquePaths([
          ...promptAudioAttachmentPaths,
          ...registeredDisplay.audioAttachmentPaths,
        ]);
      }
      promptSessionFileRefs = mergeSessionFileRefs(
        promptSessionFileRefs,
        sessionFileRefsFromAttachments(displayAttachments, sessionPath, sessionId),
      );
    }

    if (inboundFiles?.length) {
      const materialized = await materializeBridgeInboundFiles({
        hanakoHome: engine.hanakoHome,
        sessionId,
        sessionPath,
        files: inboundFiles,
        registerSessionFile: engine.registerSessionFile?.bind(engine),
      });
      promptImageAttachmentPaths = [
        ...promptImageAttachmentPaths,
        ...materialized.imageAttachmentPaths,
      ];
      promptImageAttachmentPaths = uniquePaths(promptImageAttachmentPaths);
      displayAttachments = [
        ...(displayAttachments || []),
        ...materialized.displayAttachments,
      ];
      promptSessionFileRefs = mergeSessionFileRefs(
        promptSessionFileRefs,
        sessionFileRefsFromAttachments(materialized.displayAttachments, sessionPath, sessionId),
      );
    }

    engine.emitEvent?.({ type: "session_status", isStreaming: true }, sessionPath);
    // 来源元信息先于 prompt 持久化，让 origin 条目紧邻它注释的 user message。
    recordMessageOriginEntry(session, sessionPath, displayMessage);
    engine.emitEvent?.({
      type: "session_user_message",
      clientMessageId: clientMessageId || null,
      message: {
        text: displayMessage?.text ?? text ?? "",
        timestamp: Date.now(),
        attachments: displayAttachments,
        quotedText: displayMessage?.quotedText,
        skills: displayMessage?.skills,
        deskContext: displayMessage?.deskContext ?? null,
        source: displayMessage?.source || "desktop",
        bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
      },
    }, sessionPath);
    queueVoiceInputTranscriptions({
      speechRecognition: engine.speechRecognition,
      sessionPath,
      attachments: displayAttachments,
    });

    promptText = addAttachedImageMarkers(promptText, promptImageAttachmentPaths);
    promptText = addAttachedVideoMarkers(promptText, promptVideoAttachmentPaths);
    promptText = addAttachedAudioMarkers(promptText, promptAudioAttachmentPaths);
    promptText = addSessionFileRefMarkers(promptText, promptSessionFileRefs);

    let captured = "";
    const toolMedia = [];
    const unsub = session.subscribe?.((event) => {
      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") {
          const delta = sub.delta || "";
          captured += delta;
          try { onDelta?.(delta, captured); } catch {}
        }
      } else if (event.type === "tool_execution_end" && !event.isError) {
        toolMedia.push(...collectMediaItems(event.result?.details?.media));
        const card = event.result?.details?.card;
        if (card?.description) {
          captured += (captured ? "\n\n" : "") + card.description;
        }
        const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
        if (settingsUpdateText) {
          captured += (captured ? "\n\n" : "") + settingsUpdateText;
        }
      }
    });

    try {
      const promptOpts = buildPromptOptions({
        images,
        videos,
        audios,
        promptImageAttachmentPaths,
        promptVideoAttachmentPaths,
        promptAudioAttachmentPaths,
        context,
      });
      await engine.promptSession(sessionPath, promptText, promptOpts);
    } finally {
      try { unsub?.(); } catch {}
      engine.emitEvent?.({ type: "session_status", isStreaming: false }, sessionPath);
    }

    return {
      text: captured.trim() || null,
      toolMedia,
    };
  } finally {
    pendingDesktopSessionSubmissions.delete(submissionKey);
  }
}

export async function submitDesktopSessionInterjection(engine: any, opts: {
  sessionPath?: string;
  text?: string;
  images?: Array<{ type: string; data: string; mimeType: string }>;
  imageAttachmentPaths?: string[];
  videos?: Array<{ type: string; data: string; mimeType: string }>;
  videoAttachmentPaths?: string[];
  audios?: Array<{ type: string; data: string; mimeType: string }>;
  audioAttachmentPaths?: string[];
  inboundFiles?: Array<{ type: string; filename?: string; mimeType?: string; buffer: any }>;
  clientMessageId?: string;
  displayMessage?: any;
  sessionFileRefs?: Array<{ fileId?: string; sessionId?: string; sessionPath?: string; label?: string; kind?: string }>;
  uiContext?: any;
  context?: any;
} = {}) {
  const {
    sessionPath,
    text,
    images,
    imageAttachmentPaths,
    videos,
    videoAttachmentPaths,
    audios,
    audioAttachmentPaths,
    inboundFiles,
    clientMessageId,
    displayMessage,
    sessionFileRefs,
    uiContext,
    context,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function" || typeof engine.steerSession !== "function") {
    throw new Error("desktop-session-submit: engine interjection API unavailable");
  }
  if (!sessionPath) throw new Error("desktop-session-submit: sessionPath is required");
  if (!text && !images?.length && !videos?.length && !audios?.length) throw new Error("desktop-session-submit: text, images, videos, or audios required");

  if (typeof engine.isSessionStreaming === "function" && !engine.isSessionStreaming(sessionPath)) {
    return submitDesktopSessionMessage(engine, opts);
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session) {
    throw new Error(`desktop-session-submit: failed to load session ${sessionPath}`);
  }
  const sessionId = resolveSessionIdForPath(engine, sessionPath);

  if (uiContext !== undefined) {
    engine.setUiContext?.(sessionPath, uiContext ?? null);
  }

  let promptImageAttachmentPaths = imageAttachmentPaths || [];
  let promptVideoAttachmentPaths = videoAttachmentPaths || [];
  let promptAudioAttachmentPaths = audioAttachmentPaths || [];
  let displayAttachments = displayMessage?.attachments;
  let promptText = text || "";
  let promptSessionFileRefs = normalizeSessionFileRefs(sessionFileRefs, sessionPath, sessionId);

  if (displayAttachments?.length) {
    const registeredDisplay = registerDisplayAttachments({
      hanakoHome: engine.hanakoHome,
      sessionPath,
      attachments: displayAttachments,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    displayAttachments = registeredDisplay.attachments;
    promptImageAttachmentPaths = uniquePaths([
      ...promptImageAttachmentPaths,
      ...registeredDisplay.imageAttachmentPaths,
    ]);
    promptVideoAttachmentPaths = uniquePaths([
      ...promptVideoAttachmentPaths,
      ...registeredDisplay.videoAttachmentPaths,
    ]);
    if (audios?.length || promptAudioAttachmentPaths.length) {
      promptAudioAttachmentPaths = uniquePaths([
        ...promptAudioAttachmentPaths,
        ...registeredDisplay.audioAttachmentPaths,
      ]);
    }
    promptSessionFileRefs = mergeSessionFileRefs(
      promptSessionFileRefs,
      sessionFileRefsFromAttachments(displayAttachments, sessionPath, sessionId),
    );
  }

  if (inboundFiles?.length) {
    const materialized = await materializeBridgeInboundFiles({
      hanakoHome: engine.hanakoHome,
      sessionId,
      sessionPath,
      files: inboundFiles,
      registerSessionFile: engine.registerSessionFile?.bind(engine),
    });
    promptImageAttachmentPaths = uniquePaths([
      ...promptImageAttachmentPaths,
      ...materialized.imageAttachmentPaths,
    ]);
    displayAttachments = [
      ...(displayAttachments || []),
      ...materialized.displayAttachments,
    ];
    promptSessionFileRefs = mergeSessionFileRefs(
      promptSessionFileRefs,
      sessionFileRefsFromAttachments(materialized.displayAttachments, sessionPath, sessionId),
    );
  }

  engine.emitEvent?.({
    type: "session_user_message",
    clientMessageId: clientMessageId || null,
    message: {
      text: displayMessage?.text ?? text ?? "",
      timestamp: Date.now(),
      attachments: displayAttachments,
      quotedText: displayMessage?.quotedText,
      skills: displayMessage?.skills,
      deskContext: displayMessage?.deskContext ?? null,
      source: displayMessage?.source || "desktop",
      bridgeSessionKey: displayMessage?.bridgeSessionKey || null,
    },
  }, sessionPath);
  queueVoiceInputTranscriptions({
    speechRecognition: engine.speechRecognition,
    sessionPath,
    attachments: displayAttachments,
  });

  promptText = addAttachedImageMarkers(promptText, promptImageAttachmentPaths);
  promptText = addAttachedVideoMarkers(promptText, promptVideoAttachmentPaths);
  promptText = addAttachedAudioMarkers(promptText, promptAudioAttachmentPaths);
  promptText = addSessionFileRefMarkers(promptText, promptSessionFileRefs);
  if (context?.beforeUser) {
    promptText = `${context.beforeUser}\n\n${promptText}`;
  }

  const steered = engine.steerSession(sessionPath, promptText);
  if (!steered) throw new Error("session_busy");
  // 来源元信息在 steer 成功后持久化，避免 steer 被拒绝时产生孤儿条目。
  // steerSession 同步返回，与 appendCustomEntry 之间无 await，紧邻性不受影响。
  // 契约：origin 条目注释其后第一条 user message（中间可能隔着在途 assistant 输出）。
  recordMessageOriginEntry(session, sessionPath, displayMessage);
  return { text: null, toolMedia: [], steered: true };
}

function buildPromptOptions({
  images,
  videos,
  audios,
  promptImageAttachmentPaths,
  promptVideoAttachmentPaths,
  promptAudioAttachmentPaths,
  context,
}: any = {}) {
  const opts: any = {};
  if (images?.length) opts.images = images;
  if (videos?.length) opts.videos = videos;
  if (audios?.length) opts.audios = audios;
  if (promptImageAttachmentPaths?.length) opts.imageAttachmentPaths = promptImageAttachmentPaths;
  if (promptVideoAttachmentPaths?.length) opts.videoAttachmentPaths = promptVideoAttachmentPaths;
  if (promptAudioAttachmentPaths?.length) opts.audioAttachmentPaths = promptAudioAttachmentPaths;
  if (context !== undefined && context !== null) opts.context = context;
  return Object.keys(opts).length ? opts : undefined;
}

function queueVoiceInputTranscriptions({ speechRecognition, sessionPath, attachments }) {
  if (!speechRecognition || typeof speechRecognition.queueVoiceTranscription !== "function") return;
  for (const attachment of attachments || []) {
    if (attachment?.presentation !== "voice-input" || !attachment.fileId) continue;
    speechRecognition.queueVoiceTranscription({
      sessionPath,
      fileId: attachment.fileId,
    });
  }
}

function registerDisplayAttachments({ hanakoHome, sessionPath, attachments, registerSessionFile }) {
  const nextAttachments = [];
  const imageAttachmentPaths = [];
  const videoAttachmentPaths = [];
  const audioAttachmentPaths = [];

  for (const attachment of attachments || []) {
    let next = { ...attachment };
    let sessionFile = null;

    if (!next.fileId && next.path && path.isAbsolute(next.path) && typeof registerSessionFile === "function") {
      sessionFile = serializeSessionFile(registerSessionFile({
        sessionPath,
        filePath: next.path,
        label: next.name || path.basename(next.path),
        origin: originForDisplayAttachment(next),
        storageKind: displayAttachmentStorageKind(hanakoHome, next.path),
        presentation: displayAttachmentPresentation(next),
        listed: listedForDisplayAttachment(next),
        waveform: next.waveform,
      }));
      if (sessionFile) {
        next = {
          ...next,
          fileId: sessionFile.fileId || sessionFile.id,
          name: next.name || sessionFile.displayName || sessionFile.filename || path.basename(next.path),
          mimeType: next.mimeType || sessionFile.mime,
          isDir: next.isDir || !!sessionFile.isDirectory,
          presentation: sessionFile.presentation || displayAttachmentPresentation(next),
          listed: sessionFile.listed !== undefined ? sessionFile.listed !== false : listedForDisplayAttachment(next),
          status: sessionFile.status,
          missingAt: sessionFile.missingAt,
          waveform: sessionFile.waveform || next.waveform,
        };
      }
    }

    if (next.path && path.isAbsolute(next.path) && next.base64Data) {
      const { base64Data, ...withoutInlineBytes } = next;
      next = withoutInlineBytes;
    }

    const kind = sessionFile?.kind || inferFileKind({
      mime: next.mimeType,
      ext: extOfName(next.name || next.path),
      isDirectory: !!next.isDir,
    } as any);
    if (!next.isDir && next.path && kind === "image") {
      imageAttachmentPaths.push(next.path);
    } else if (!next.isDir && next.path && kind === "video") {
      videoAttachmentPaths.push(next.path);
    } else if (!next.isDir && next.path && kind === "audio") {
      audioAttachmentPaths.push(next.path);
    }
    nextAttachments.push(next);
  }

  return {
    attachments: nextAttachments,
    imageAttachmentPaths: uniquePaths(imageAttachmentPaths),
    videoAttachmentPaths: uniquePaths(videoAttachmentPaths),
    audioAttachmentPaths: uniquePaths(audioAttachmentPaths),
  };
}

function displayAttachmentPresentation(attachment) {
  return attachment?.presentation === "voice-input" ? "voice-input" : "attachment";
}

function listedForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) !== "voice-input";
}

function originForDisplayAttachment(attachment) {
  return displayAttachmentPresentation(attachment) === "voice-input" ? "voice_input" : "user_attachment";
}

function displayAttachmentStorageKind(hanakoHome, filePath) {
  if (!hanakoHome) return "external";
  const root = path.resolve(hanakoHome, "session-files");
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
    return "managed_cache";
  }
  return "external";
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(imageAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedVideoMarkers(text, videoAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(videoAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_video: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_video: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function addAttachedAudioMarkers(text, audioAttachmentPaths) {
  let promptText = text || "";
  const missing = uniquePaths(audioAttachmentPaths)
    .filter((filePath) => filePath && !promptText.includes(`[attached_audio: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_audio: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set((paths || []).filter(Boolean)));
}

function resolveSessionIdForPath(engine, sessionPath) {
  try {
    const sessionId = engine?.getSessionIdForPath?.(sessionPath);
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
  } catch {
    return null;
  }
}

function normalizeSessionFileRefs(refs, fallbackSessionPath, fallbackSessionId = null) {
  if (!Array.isArray(refs)) return [];
  const normalized = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const fileId = typeof ref.fileId === "string" && ref.fileId.trim() ? ref.fileId.trim() : null;
    if (!fileId) continue;
    const sessionId = typeof ref.sessionId === "string" && ref.sessionId.trim()
      ? ref.sessionId.trim()
      : fallbackSessionId;
    const sessionPath = typeof ref.sessionPath === "string" && ref.sessionPath ? ref.sessionPath : fallbackSessionPath;
    const dedupeKey = `${sessionId || sessionPath || ""}:${fileId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({
      fileId,
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      label: typeof ref.label === "string" && ref.label ? ref.label : fileId,
      kind: typeof ref.kind === "string" && ref.kind ? ref.kind : "attachment",
    });
  }
  return normalized;
}

function sessionFileRefsFromAttachments(attachments, sessionPath, sessionId = null) {
  return normalizeSessionFileRefs((attachments || []).map((attachment) => ({
    fileId: attachment?.fileId,
    sessionId: attachment?.sessionId || sessionId,
    sessionPath,
    label: attachment?.name || attachment?.label || attachment?.path,
    kind: attachment?.isDir ? "directory" : "attachment",
  })), sessionPath, sessionId);
}

function mergeSessionFileRefs(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const ref of [...(primary || []), ...(secondary || [])]) {
    if (!ref?.fileId) continue;
    const key = `${ref.sessionId || ref.sessionPath || ""}:${ref.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function addSessionFileRefMarkers(text, refs) {
  const items = normalizeSessionFileRefs(refs, null);
  if (!items.length) return text || "";
  const markerText = items
    .map((ref) => `[SessionFile] ${JSON.stringify({
      fileId: ref.fileId,
      sessionPath: ref.sessionPath || null,
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      label: ref.label,
      kind: ref.kind,
    })}`)
    .join("\n");
  const promptText = text || "";
  return promptText ? `${markerText}\n${promptText}` : markerText;
}
