import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";

const root = process.cwd();
const DEFAULT_CODING_SKILLS = [
  "hanaide-coding",
  "karpathy-guidelines",
  "polished-web-ui",
  "supeepowers",
];

function readText(relPath: string) {
  return fs.readFileSync(path.join(root, relPath), "utf-8");
}

function readSkillMeta(skillName: string) {
  const content = readText(path.join("skills2set", skillName, "SKILL.md"));
  return parseSkillMetadata(content, skillName);
}

describe("HanaIDE default coding contract", () => {
  it("seeds the default assistant as HanaIDE with the coding skill pack", () => {
    const config = YAML.load(readText("lib/config.example.yaml")) as any;

    expect(config.agent.name).toBe("HanaIDE");
    expect(config.agent.yuan).toBe("hanako");
    expect(config.skills.enabled).toEqual(DEFAULT_CODING_SKILLS);
    expect(config.channels.enabled).toBe(false);
  });

  it("keeps the coding skill pack default-enabled from bundled skills", () => {
    for (const skillName of DEFAULT_CODING_SKILLS) {
      expect(readSkillMeta(skillName)).toMatchObject({
        name: skillName,
        defaultEnabled: true,
      });
    }

    for (const skillName of ["hana-plugin-creator", "quiet-musing", "skill-creator", "user-guide"]) {
      expect(readSkillMeta(skillName).defaultEnabled).toBe(false);
    }
  });

  it("does not expose legacy HanaAgent naming in bundled skill guides", () => {
    for (const skillName of ["user-guide", "hana-plugin-creator"]) {
      const content = readText(path.join("skills2set", skillName, "SKILL.md"));
      expect(content).toContain("HanaIDE");
      expect(content).not.toContain("HanaAgent");
    }
  });

  it("keeps the user guide focused on coding workflows", () => {
    const content = readText(path.join("skills2set", "user-guide", "SKILL.md"));

    expect(content).toContain("编程模式用户说明书");
    expect(content).toContain("打开项目文件夹");
    expect(content).toContain("多标签");
    expect(content).toContain("终端");
    expect(content).toContain("测试");
    expect(content).toContain("编程助手");
    expect(content).not.toContain("频道");
    expect(content).not.toContain("Telegram");
    expect(content).not.toContain("微信");
    expect(content).not.toContain("OpenClaw");
  });

  it("uses programming-focused default prompt templates", () => {
    const identityExample = readText("lib/identity.example.md");
    const ishikiExample = readText("lib/ishiki.example.md");
    const identity = readText("lib/identity-templates/hanako.md");
    const ishiki = readText("lib/ishiki-templates/hanako.md");
    const publicIshiki = readText("lib/public-ishiki-templates/hanako.md");

    expect(identityExample).toContain("HanaIDE");
    expect(identityExample).toContain("编程助手");
    expect(ishikiExample).toContain("编程模式");
    expect(ishikiExample).toContain("测试");
    expect(identity).toContain("HanaIDE");
    expect(identity).toContain("本地编程助手");
    expect(ishiki).toContain("软件工程助手");
    expect(ishiki).toContain("代码");
    expect(ishiki).toContain("测试");
    expect(publicIshiki).toContain("公共编程助手");
    expect(publicIshiki).toContain("源码");
    for (const content of [identityExample, ishikiExample, identity, ishiki, publicIshiki]) {
      expect(content).not.toContain("github.com");
      expect(content).not.toContain("GitHub");
      expect(content).not.toContain("HanaAgent");
      expect(content).not.toContain("个人助手");
    }
  });

  it("ships HanaIDE visual assets and visible product naming", () => {
    const pkg = JSON.parse(readText("package.json"));

    expect(pkg.build.productName).toBe("HanaIDE");
    expect(pkg.build.win.executableName).toBe("HanaIDE");
    expect(pkg.build.nsis.shortcutName).toBe("HanaIDE");
    expect(fs.existsSync(path.join(root, "desktop/src/assets/hanaide/hanaide-icon.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "desktop/src/assets/hanaide/hanaide-coding-banner.png"))).toBe(true);
    expect(fs.statSync(path.join(root, "desktop/src/icon.png")).size).toBeGreaterThan(0);
    expect(fs.statSync(path.join(root, "desktop/src/icon.ico")).size).toBeGreaterThan(0);
    expect(fs.statSync(path.join(root, "desktop/src/icon.icns")).size).toBeGreaterThan(0);
  });
});
