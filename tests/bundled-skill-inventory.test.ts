import fs from "node:fs";
import path from "node:path";
import YAML from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";

const root = process.cwd();
const skillsRoot = path.join(root, "skills2set");

const defaultCodingSkills = [
  "hanaide-coding",
  "karpathy-guidelines",
  "polished-web-ui",
  "supeepowers",
  "code-review",
  "create-project",
  "doc-writer",
  "frontend-design",
  "skill-installer",
];

const removedGeneralSkills = [
  "office-documents",
  "quiet-musing",
  "user-guide",
];

function readSkill(name: string) {
  return fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
}

function readDefaultEnabledFromConfig() {
  const config = YAML.load(fs.readFileSync(path.join(root, "lib", "config.example.yaml"), "utf8")) as any;
  return config?.skills?.enabled ?? [];
}

function computeDefaultEnabledFromBundledMetadata() {
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const content = readSkill(entry.name);
      const metadata = parseSkillMetadata(content, entry.name);
      return { name: metadata.name, defaultEnabled: metadata.defaultEnabled };
    })
    .filter((skill) => skill.defaultEnabled !== false)
    .map((skill) => skill.name);
}

describe("bundled coding skill inventory", () => {
  it("bundles the default HanaIDE coding skills with SKILL.md files", () => {
    for (const skillName of defaultCodingSkills) {
      expect(fs.existsSync(path.join(skillsRoot, skillName, "SKILL.md")), `${skillName} should be bundled`).toBe(true);
      expect(readSkill(skillName)).toContain(`name: ${skillName}`);
    }
  });

  it("keeps non-coding starter skills out of the bundled default inventory", () => {
    for (const skillName of removedGeneralSkills) {
      expect(fs.existsSync(path.join(skillsRoot, skillName)), `${skillName} should not be bundled`).toBe(false);
    }
  });

  it("seeds new agents with the complete coding skill set", () => {
    expect(readDefaultEnabledFromConfig()).toEqual(defaultCodingSkills);
  });

  it("does not default-enable optional bundled tooling skills", () => {
    expect([...computeDefaultEnabledFromBundledMetadata()].sort()).toEqual([...defaultCodingSkills].sort());
  });
});
