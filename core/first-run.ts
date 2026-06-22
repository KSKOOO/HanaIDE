/**
 * first-run.js — 首次运行播种
 *
 * 在 server/engine 启动之前调用，确保 ~/.hanako/ 结构存在。
 * 如果是全新安装（agents/ 为空），自动创建默认 agent。
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeCopyDir } from '../shared/safe-fs.ts';
import { AppError } from '../shared/errors.ts';
import { errorBus } from '../shared/error-bus.ts';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  ensureDefaultWorkspace,
} from "../shared/default-workspace.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { USER_PROFILE_FILENAME } from "../lib/user-profile-store.ts";

const log = createModuleLogger("first-run");

const DEFAULT_AGENT_ID = "hanako";

export interface InvalidAgentDirReport {
  id: string;
  reason: "config_missing" | "config_unreadable";
}

export interface FirstRunReport {
  /** 缺失/损坏 config.yaml 而被跳过的非默认 agent 目录（用户数据原样保留） */
  invalidAgentDirs: InvalidAgentDirReport[];
  /** 本次是否播种/修复了默认 agent */
  repairedDefaultAgent: boolean;
  /** 默认 agent config 损坏时的备份文件路径 */
  defaultConfigBackupPath: string | null;
}

/**
 * 确保 ~/.hanako/ 数据目录就绪
 *
 * 对 agent 目录采用"分类处置"而不是 fail-fast：
 * - 默认 agent（hanako）缺 config → 播种修复；config 损坏 → 先备份再播种
 * - 非默认目录缺/坏 config → 跳过并记入诊断报告，不阻断启动、不动用户数据
 * 历史上脏目录有多个来源（旧版物理删除残留、phone projection 复活、半截创建），
 * 启动链路必须容忍它们，运行时扫描（AgentManager）本来就会跳过这类目录。
 *
 * @param {string} hanakoHome - ~/.hanako 绝对路径
 * @param {string} productDir - 产品模板目录（lib/）
 */
export function ensureFirstRun(hanakoHome, productDir): FirstRunReport {
  // 1. 确保目录结构存在
  fs.mkdirSync(path.join(hanakoHome, "agents"), { recursive: true });
  fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });

  // 2. 分类每个 agent 目录；没有任何可用 agent → 播种默认 agent
  const agentsDir = path.join(hanakoHome, "agents");
  const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

  const invalidAgentDirs: InvalidAgentDirReport[] = [];
  const validAgentIds = new Set<string>();
  let defaultAgentState: "valid" | "config_missing" | "config_unreadable" | null = null;
  for (const entry of agentEntries) {
    const cls = classifyAgentDirectoryForStartup(agentsDir, entry.name);
    if (entry.name === DEFAULT_AGENT_ID) {
      defaultAgentState = cls.status === "valid" ? "valid" : cls.reason;
      if (cls.status === "valid") validAgentIds.add(entry.name);
      continue;
    }
    if (cls.status === "valid") {
      validAgentIds.add(entry.name);
      continue;
    }
    invalidAgentDirs.push({ id: entry.name, reason: cls.reason });
    log.warn(
      `invalid agent directory "${entry.name}": `
      + (cls.reason === "config_missing" ? "config.yaml missing" : `config.yaml is not readable: ${cls.detail}`)
      + "（已跳过，不阻断启动；目录内容保留，请手动确认后清理）",
    );
  }

  const hasAgent = validAgentIds.size > 0;
  const needsDefaultAgentRepair = defaultAgentState === "config_missing" || defaultAgentState === "config_unreadable";

  let repairedDefaultAgent = false;
  let defaultConfigBackupPath: string | null = null;
  if (!hasAgent || needsDefaultAgentRepair) {
    if (defaultAgentState === "config_unreadable") {
      defaultConfigBackupPath = backupUnreadableDefaultConfig(agentsDir);
      log.warn(`默认助手 config.yaml 无法解析，已备份到 ${defaultConfigBackupPath}`);
    }
    log.log(needsDefaultAgentRepair ? "默认助手数据不完整，正在补齐..." : "首次启动，正在创建默认助手...");
    seedDefaultAgent(agentsDir, productDir);
    repairedDefaultAgent = true;
    validAgentIds.add(DEFAULT_AGENT_ID);
  }

  // 3. 同步 skills：从 skills2set/ 复制到 ~/.hanako/skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(hanakoHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
  }

  // 4. 确保可选文件存在（老用户升级 + 新 agent 都覆盖）。
  // 只补有效 agent 目录：往无效目录里写 pinned.md 会把垃圾目录越喂越像 agent 目录。
  const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
  touchIfMissing(path.join(hanakoHome, 'user', USER_PROFILE_FILENAME));
  for (const agentId of validAgentIds) {
    touchIfMissing(path.join(agentsDir, agentId, 'pinned.md'));
  }

  // 5. 确保 user/preferences.json 存在
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        primaryAgent: "hanako",
      }, null, 2) + "\n",
      "utf-8",
    );
  }

  return { invalidAgentDirs, repairedDefaultAgent, defaultConfigBackupPath };
}

type AgentDirClassification =
  | { status: "valid" }
  | { status: "invalid"; reason: "config_missing" | "config_unreadable"; detail?: string };

function classifyAgentDirectoryForStartup(agentsDir, agentId): AgentDirClassification {
  const cfgPath = path.join(agentsDir, agentId, "config.yaml");
  if (!fs.existsSync(cfgPath)) {
    return { status: "invalid", reason: "config_missing" };
  }
  try {
    void YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    return { status: "valid" };
  } catch (err) {
    return { status: "invalid", reason: "config_unreadable", detail: err?.message || String(err) };
  }
}

/** 默认 agent 的 config 解析失败时，把原文件改名备份，让播种写出干净的新 config */
function backupUnreadableDefaultConfig(agentsDir): string {
  const cfgPath = path.join(agentsDir, DEFAULT_AGENT_ID, "config.yaml");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${cfgPath}.broken-${stamp}`;
  fs.renameSync(cfgPath, backupPath);
  return backupPath;
}

/**
 * 从模板播种默认 agent（与 engine.createAgent 相同逻辑，但纯同步、无依赖）
 */
function seedDefaultAgent(agentsDir, productDir) {
  const agentId = "hanako";
  const agentDir = path.join(agentsDir, agentId);

  // 创建目录结构
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });

  // config.yaml（保持模板默认值：name=HanaIDE, yuan=hanako）
  const cfgDest = path.join(agentDir, "config.yaml");
  const configSrc = path.join(productDir, "config.example.yaml");
  if (!fs.existsSync(configSrc)) {
    throw new Error(`first-run template missing: ${configSrc}`);
  }
  fs.copyFileSync(configSrc, cfgDest);
  // 写入默认工作台（per-agent，不存全局）
  const raw = fs.existsSync(cfgDest) ? YAML.load(fs.readFileSync(cfgDest, "utf-8")) || {} : {};
  raw.desk = {
    ...(raw.desk || {}),
    home_folder: ensureDefaultWorkspace(),
    heartbeat_enabled: false,
    heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  };
  raw.memory = {
    ...(raw.memory || {}),
    enabled: true,
  };
  fs.writeFileSync(cfgDest, YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");


  // 与 createAgent 同策略：按 yuan（= agentId）+ locale 优先，通用 example 兜底。
  // 首次播种读刚写入的 config.yaml 拿 locale。
  let isZh = true;
  try {
    if (fs.existsSync(cfgDest)) {
      const raw = YAML.load(fs.readFileSync(cfgDest, "utf-8")) || {};
      isZh = String(raw.locale || "zh").startsWith("zh");
    }
  } catch {}
  const langDir = isZh ? "" : "en/";
  const firstExisting = (paths) => paths.find((p) => fs.existsSync(p));

  // identity.md 保留动态占位符，在 system prompt 组装时按当前 config 渲染。
  const identitySrc = firstExisting([
    path.join(productDir, "identity-templates", `${langDir}${agentId}.md`),
    path.join(productDir, "identity-templates", `${agentId}.md`),
    path.join(productDir, "identity.example.md"),
  ]);
  if (identitySrc) {
    const tmpl = fs.readFileSync(identitySrc, "utf-8");
    fs.writeFileSync(path.join(agentDir, "identity.md"), tmpl, "utf-8");
  }

  // yuan 由 buildSystemPrompt 实时从 lib/yuan/ 读取，无需复制

  // ishiki.md
  const ishikiSrc = firstExisting([
    path.join(productDir, "ishiki-templates", `${langDir}${agentId}.md`),
    path.join(productDir, "ishiki-templates", `${agentId}.md`),
    path.join(productDir, "ishiki.example.md"),
  ]);
  if (ishikiSrc) {
    fs.copyFileSync(ishikiSrc, path.join(agentDir, "ishiki.md"));
  }

  // public-ishiki.md（对外意识模板）
  const publicIshikiSrc = firstExisting([
    path.join(productDir, "public-ishiki-templates", `${langDir}${agentId}.md`),
    path.join(productDir, "public-ishiki-templates", `${agentId}.md`),
  ]);
  if (publicIshikiSrc) {
    fs.copyFileSync(publicIshikiSrc, path.join(agentDir, "public-ishiki.md"));
  }

  log.log(`默认助手 "${agentId}" 已创建`);
}

/**
 * 同步 skills2set/ → ~/.hanako/skills/
 * 每次启动都跑，确保新增/更新的 skill 能同步到用户目录
 */
function syncSkills(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillSrc = path.join(srcDir, entry.name);
    const skillDst = path.join(dstDir, entry.name);

    // 只要源里有 SKILL.md 就同步整个目录
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) continue;

    try {
      safeCopyDir(skillSrc, skillDst);
    } catch (err) {
      errorBus.report(new AppError('SKILL_SYNC_FAILED', {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { skill: entry.name },
      }));
      // Continue with other skills, don't abort
    }
  }
}
