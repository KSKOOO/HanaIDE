/**
 * prune-git-portable.js — 裁剪 PortableGit 运行时，砍掉 agent 用不到的部分。
 *
 * 设计见 .docs/plans/2026-05-31-prune-portablegit-runtime.md：
 *   1. 保守删除黑名单：只删确定与执行无关的大块（doc/man/info/include/gui/tcl-tk/
 *      perl/svn/cvs/gitweb/locale/editor），绝不碰任何 *.dll。MSYS2/mingw 的 DLL
 *      依赖是隐式的，删黑名单不碰 DLL 才安全（我们没有 pacman 做依赖闭包）。
 *   2. 裁剪后硬断言关键文件仍在（fail-fast），缺任何一个直接抛错，不产出残缺 runtime。
 *   3. 纯 fs 操作，跨平台（CI 在 ubuntu 用 7zz 解压、windows 上都要能跑）。
 *
 * 用法：
 *   import { prunePortableGitRuntime } from "./prune-git-portable.js";
 *   prunePortableGitRuntime("vendor/git-portable");
 *   prunePortableGitRuntime("vendor/git-portable", { dryRun: true }); // 只统计不删
 */
import fs from "fs";
import path from "path";

// 整目录删除（子树全删）。带版本号的目录（tcl8.6）走 PRUNE_DIR_PREFIXES。
export const PRUNE_DIRS = [
  // 文档 / man / info / 头文件
  "mingw64/share/doc",
  "usr/share/doc",
  "usr/share/man",
  "mingw64/share/man",
  "usr/share/info",
  "mingw64/share/info",
  "usr/include",
  "mingw64/include",
  // GUI / web 前端
  "mingw64/share/git-gui",
  "mingw64/share/gitk",
  "mingw64/share/gitweb",
  // perl userland
  "usr/lib/perl5",
  "usr/share/perl5",
  "mingw64/lib/perl5",
  "mingw64/share/perl5",
  // 本地化（英文优先；运行时编码走 C.UTF-8，不依赖这些 .mo）
  "mingw64/share/locale",
  "usr/share/locale",
  // 开发元数据
  "mingw64/lib/pkgconfig",
  "usr/lib/pkgconfig",
  "mingw64/lib/cmake",
  "mingw64/share/aclocal",
  "usr/share/aclocal",
  // 编辑器资源
  "usr/share/vim",
  "usr/share/nano",
];

// 父目录下、basename 以 prefix 开头的子目录整删（处理 tcl8.6 / tk8.6 等带版本目录）。
export const PRUNE_DIR_PREFIXES = [
  { parent: "mingw64/lib", prefix: "tcl" },
  { parent: "mingw64/lib", prefix: "tk" },
  { parent: "mingw64/lib", prefix: "itcl" },
  { parent: "mingw64/lib", prefix: "tdbc" },
  { parent: "mingw64/lib", prefix: "thread" },
];

// 父目录下、basename 命中规则的文件删除。
//   names:    精确匹配（区分/不区分大小写都试）
//   prefixes: basename 前缀匹配（小写比较）
export const PRUNE_FILES = [
  // 根目录启动器（Hana 直接 spawn bin/bash.exe，不用这些 launcher）
  { dir: "", names: ["git-bash.exe", "git-cmd.exe"] },
  // cmd 启动器 / GUI
  { dir: "cmd", names: ["git-gui.exe", "gitk.exe", "git-bash.exe"], prefixes: ["start-"] },
  // mingw64/bin 下的 GUI / 脚本运行时（不碰任何 *.dll）
  { dir: "mingw64/bin", prefixes: ["wish", "tclsh", "perl", "svn", "vim"] },
  // usr/bin 下的 perl 运行时 + 交互式编辑器（agent 非交互；CLAUDE.md 禁交互式 git）
  {
    dir: "usr/bin",
    prefixes: ["perl"],
    names: ["vi.exe", "view.exe", "vim.exe", "vimdiff.exe", "rvim.exe", "rview.exe", "nano.exe"],
  },
  // git 的 perl-based / svn / cvs / gui 子命令（核心 git 不依赖它们）
  {
    dir: "mingw64/libexec/git-core",
    names: [
      "git-svn",
      "git-send-email",
      "git-add--interactive",
      "git-archimport",
      "git-cvsimport",
      "git-cvsexportcommit",
      "git-cvsserver",
      "git-instaweb",
      "git-p4",
      "git-gui",
      "git-gui--askpass",
      "git-citool",
      "gitk",
    ],
  },
];

// 裁剪后必须存在，否则抛错。只放 100% 确定的（installer.nsh / launch-integrity 已依赖）。
// coreutils 完整性靠 scripts/smoke-git-portable.mjs 在 Windows 上实测，不在此硬断言
// （避免对每个 coreutils 的确切 exe 名做无依据假设）。
export const RETAIN_ASSERTIONS = [
  "cmd/git.exe",
  "bin/bash.exe",
  "usr/bin/bash.exe",
  "usr/bin/msys-2.0.dll",
  "mingw64/bin/git.exe",
];

function statPathUsage(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return { bytes, files };
}

function removePath(target, dryRun) {
  const usage = statPathUsage(target);
  if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  return usage;
}

export function prunePortableGitRuntime(root, { dryRun = false, logger = console } = {}) {
  if (!fs.existsSync(root)) {
    throw new Error(`[prune-git-portable] runtime root not found: ${root}`);
  }

  let removedDirs = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  // 1. 整目录
  for (const rel of PRUNE_DIRS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const { bytes } = removePath(abs, dryRun);
    removedDirs += 1;
    removedBytes += bytes;
  }

  // 2. 带版本号目录前缀
  for (const { parent, prefix } of PRUNE_DIR_PREFIXES) {
    const parentAbs = path.join(root, parent);
    let entries = [];
    try {
      entries = fs.readdirSync(parentAbs, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase().startsWith(prefix)) {
        const { bytes } = removePath(path.join(parentAbs, e.name), dryRun);
        removedDirs += 1;
        removedBytes += bytes;
      }
    }
  }

  // 3. 文件
  for (const rule of PRUNE_FILES) {
    const dirAbs = path.join(root, rule.dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      const lower = name.toLowerCase();
      const hit =
        (rule.names || []).includes(name) ||
        (rule.names || []).includes(lower) ||
        (rule.prefixes || []).some((p) => lower.startsWith(p));
      if (!hit) continue;
      const { bytes } = removePath(path.join(dirAbs, name), dryRun);
      removedFiles += 1;
      removedBytes += bytes;
    }
  }

  // 4. 裁剪后自检：缺关键文件直接抛错（不静默产出残缺 runtime）
  const missing = RETAIN_ASSERTIONS.filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (missing.length) {
    throw new Error(
      `[prune-git-portable] 裁剪后缺失关键文件，拒绝产出残缺 runtime：\n` +
        missing.map((m) => `  - ${m}`).join("\n"),
    );
  }

  const removedMB = +(removedBytes / 1048576).toFixed(1);
  const stats = { dryRun, removedDirs, removedFiles, removedMB };
  logger.log(
    `[prune-git-portable] ${dryRun ? "(dry-run) " : ""}` +
      `dirs=${removedDirs} files=${removedFiles} freed≈${removedMB}MB`,
  );
  return stats;
}
