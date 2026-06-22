import { describe, expect, it } from "vitest";
import { getYuanVisual, moodLabelForYuan, normalizeYuan } from "../shared/yuan-visuals.ts";

describe("yuan visuals", () => {
  it("keeps the desktop and CLI yuan symbolism in one place", () => {
    expect(getYuanVisual("hanako")).toMatchObject({
      symbol: "</>",
      moodLabel: "CODE",
      accent: "#D45F4E",
      avatar: "hanaide/hanaide-assistant-avatar.png",
    });
    expect(getYuanVisual("butter")).toMatchObject({
      symbol: "❊",
      moodLabel: "PULSE",
      accent: "#5BA88C",
      avatar: "Butter.png",
    });
    expect(getYuanVisual("ming")).toMatchObject({
      symbol: "◈",
      moodLabel: "REFLECT",
      accent: "#8BA4B4",
      avatar: "Ming.png",
    });
  });

  it("falls back to hanako for unknown yuan values", () => {
    expect(normalizeYuan("unknown")).toBe("hanako");
    expect(moodLabelForYuan("unknown")).toBe("</> CODE");
  });
});
