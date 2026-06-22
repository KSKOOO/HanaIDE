/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJimengImageAdapter,
  createJimengVideoAdapter,
  parseDreaminaTaskOutput,
  resolveDreaminaCommand,
} from "../plugins/jimeng-cli/adapters/dreamina.ts";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-jimeng-cli-"));
}

describe("Jimeng CLI command resolution", () => {
  it("uses DREAMINA_CLI_PATH before PATH lookup", () => {
    const exists = vi.fn((filePath: string) => filePath === "/opt/dreamina");
    expect(resolveDreaminaCommand({
      env: { DREAMINA_CLI_PATH: "/opt/dreamina", PATH: "/usr/bin" },
      exists,
      which: () => null,
      homeDir: "/home/hana",
      platform: "linux",
    })).toBe("/opt/dreamina");
    expect(exists).toHaveBeenCalledWith("/opt/dreamina");
  });

  it("returns null when dreamina is not installed", () => {
    expect(resolveDreaminaCommand({
      env: { PATH: "/usr/bin" },
      exists: () => false,
      which: () => null,
      homeDir: "/home/hana",
      platform: "linux",
    })).toBeNull();
  });
});

describe("Jimeng CLI output parsing", () => {
  it("parses JSON task output", () => {
    expect(parseDreaminaTaskOutput('{"submit_id":"abc123","gen_status":"querying"}')).toEqual({
      submitId: "abc123",
      status: "querying",
      failReason: null,
    });
  });

  it("parses text task output", () => {
    expect(parseDreaminaTaskOutput("submit_id: abc123\ngen_status: success")).toEqual({
      submitId: "abc123",
      status: "success",
      failReason: null,
    });
  });
});

describe("Jimeng CLI adapters", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("submits text-to-image through dreamina without shell execution", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ submit_id: "img-task", gen_status: "querying" }),
      stderr: "",
    }));
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    const result = await adapter.submit({
      prompt: "一只猫",
      ratio: "1:1",
      resolution: "2k",
      model: "jimeng-image-5.0",
    }, { generatedDir: "/tmp/out" } as any);

    expect(result).toEqual({ taskId: "img-task" });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "text2image",
      "--prompt",
      "一只猫",
      "--model_version",
      "5.0",
      "--ratio",
      "1:1",
      "--resolution_type",
      "2k",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("reads image provider defaults from image config, not video config", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ submit_id: "img-task", gen_status: "querying" }),
      stderr: "",
    }));
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await adapter.submit({
      prompt: "一只猫",
      model: "jimeng-image-5.0",
    }, {
      generatedDir: "/tmp/out",
      config: {
        get: () => ({
          "jimeng-cli": { resolution: "4k", ratio: "16:9" },
        }),
      },
      videoConfig: {
        get: () => ({
          "jimeng-cli": { resolution: "720p", ratio: "9:16" },
        }),
      },
    } as any);

    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "text2image",
      "--prompt",
      "一只猫",
      "--model_version",
      "5.0",
      "--ratio",
      "16:9",
      "--resolution_type",
      "4k",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("uses the highest supported Jimeng image defaults when no explicit defaults are saved", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ submit_id: "img-task", gen_status: "querying" }),
      stderr: "",
    }));
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await adapter.submit({
      prompt: "一只猫",
      model: "jimeng-image-5.0",
    }, { generatedDir: "/tmp/out" } as any);

    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "text2image",
      "--prompt",
      "一只猫",
      "--model_version",
      "5.0",
      "--ratio",
      "3:2",
      "--resolution_type",
      "4k",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("rejects unsupported Jimeng image resolution before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "一只猫",
      model: "jimeng-image-5.0",
      resolution: "1k",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/Jimeng.*resolution.*1k/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("submits image-to-video when a reference image is present", async () => {
    const run = vi.fn(async () => ({
      stdout: "submit_id: vid-task\ngen_status: querying",
      stderr: "",
    }));
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    const result = await adapter.submit({
      prompt: "镜头推进",
      image: "/tmp/first.png",
      duration: 5,
      resolution: "720p",
      model: "seedance2.0fast",
    }, { generatedDir: "/tmp/out" } as any);

    expect(result).toEqual({ taskId: "vid-task" });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "image2video",
      "--image",
      "/tmp/first.png",
      "--prompt",
      "镜头推进",
      "--model_version",
      "seedance2.0fast",
      "--duration",
      "5",
      "--video_resolution",
      "720p",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("uses budget-conscious Jimeng video defaults when no explicit options are provided", async () => {
    const run = vi.fn(async () => ({
      stdout: "submit_id: vid-task\ngen_status: querying",
      stderr: "",
    }));
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await adapter.submit({
      prompt: "雨夜街道，镜头缓慢推进",
      model: "seedance2.0_vip",
    }, { generatedDir: "/tmp/out" } as any);

    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "text2video",
      "--prompt",
      "雨夜街道，镜头缓慢推进",
      "--model_version",
      "seedance2.0_vip",
      "--ratio",
      "16:9",
      "--duration",
      "5",
      "--video_resolution",
      "720p",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("allows Dreamina 1080p only on seedance2.0_vip", async () => {
    const run = vi.fn(async () => ({
      stdout: "submit_id: vid-task\ngen_status: querying",
      stderr: "",
    }));
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await adapter.submit({
      prompt: "雨夜街道",
      model: "seedance2.0_vip",
      video_resolution: "1080p",
    }, { generatedDir: "/tmp/out" } as any);

    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", expect.arrayContaining([
      "--model_version",
      "seedance2.0_vip",
      "--video_resolution",
      "1080p",
    ]), expect.objectContaining({ shell: false }));
  });

  it("rejects unsupported Jimeng video resolution before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "雨夜街道",
      model: "seedance2.0fast_vip",
      video_resolution: "1080p",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/resolution.*1080p.*seedance2\.0fast_vip/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unsupported Jimeng video duration before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "镜头推进",
      image: "/tmp/first.png",
      duration: 15,
      model: "3.5pro",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/duration.*3\.5pro/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects image-only video models for text-to-video before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "雨夜街道",
      model: "3.5pro",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/text2video/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects mismatched explicit video mode before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "雨夜街道",
      mode: "image2video",
      model: "seedance2.0fast",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/image2video/);
    expect(run).not.toHaveBeenCalled();
  });

  it("queries results and returns files downloaded by dreamina", async () => {
    const root = makeTempDir();
    roots.push(root);
    const run = vi.fn(async () => {
      fs.writeFileSync(path.join(root, "dreamina_video_1.mp4"), "video");
      return {
        stdout: JSON.stringify({ submit_id: "vid-task", gen_status: "success" }),
        stderr: "",
      };
    });
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.query("vid-task", { generatedDir: root } as any)).resolves.toEqual({
      status: "success",
      files: ["dreamina_video_1.mp4"],
    });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "query_result",
      "--submit_id",
      "vid-task",
      "--download_dir",
      root,
    ], expect.objectContaining({ shell: false }));
  });

  it("reports a missing CLI as an auth failure", async () => {
    const adapter = createJimengImageAdapter({
      resolveCommand: () => null,
      runCommand: vi.fn(),
    });

    await expect(adapter.checkAuth({} as any)).resolves.toEqual({
      ok: false,
      code: "cli_missing",
      installCommand: "curl -s https://jimeng.jianying.com/cli | bash",
      message: expect.stringContaining("dreamina"),
    });
  });
});
