import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    on() {}
    send() {}
    close() {}
  }
  return { default: MockWebSocket };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// #1612：adapter 的所有出站 REST 必须经由 Bridge outbound HTTP helper（带 stage），
// 这里 mock 成 globalThis.fetch 透传，既捕获 stage 标签，又让既有断言继续工作。
const outboundCapture = vi.hoisted(() => ({
  platforms: [] as string[],
  requests: [] as Array<{ stage: string; url: string; method: string }>,
}));

vi.mock("../lib/bridge/outbound-http.ts", () => ({
  createBridgeOutboundHttp: ({ platform }: any) => {
    outboundCapture.platforms.push(platform);
    return {
      request: async ({ stage, url, method = "GET", headers, body }: any) => {
        outboundCapture.requests.push({ stage, url: String(url), method });
        return (globalThis as any).fetch(url, { method, headers, body });
      },
    };
  },
}));

import { createQQAdapter, deriveQQPrincipal } from "../lib/bridge/qq-adapter.ts";

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  };
}

describe("createQQAdapter media delivery", () => {
  let tmpDir = null;

  beforeEach(() => {
    outboundCapture.platforms.length = 0;
    outboundCapture.requests.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "qq-token", expires_in: 7200 });
      }
      if (href.endsWith("/gateway")) {
        return jsonResponse({ url: "ws://localhost/qq" });
      }
      if (href.includes("cos.example.com")) {
        return emptyResponse();
      }
      if (href.includes("/upload_prepare")) {
        return jsonResponse({
          upload_id: "upload-1",
          block_size: 5,
          parts: [
            { index: 1, presigned_url: "https://cos.example.com/part-1" },
            { index: 2, presigned_url: "https://cos.example.com/part-2" },
          ],
          concurrency: 1,
        });
      }
      if (href.includes("/upload_part_finish")) {
        return emptyResponse();
      }
      if (href.includes("/files")) {
        return jsonResponse({ file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeTempFile(name, content) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-qq-adapter-"));
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function md5Hex(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }

  function sha1Hex(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  it("rejects local buffer media with an explicit unsupported error", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(
      adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
        mime: "image/png",
        filename: "image.png",
      }),
    ).rejects.toThrow(/QQ.*本地.*staged file/);

    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/files"),
      expect.anything(),
    );
    adapter.stop();
  });

  it("uploads local C2C staged files through QQ chunked upload before sending rich media", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({
      file_type: 4,
      file_name: "note.txt",
      file_size: 10,
      md5: md5Hex("helloworld"),
      sha1: sha1Hex("helloworld"),
      md5_10m: md5Hex("helloworld"),
    });

    const putCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("cos.example.com"));
    expect(putCalls).toHaveLength(2);
    expect(await putCalls[0][1].body.text()).toBe("hello");
    expect(await putCalls[1][1].body.text()).toBe("world");

    const partFinishCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/users/user-openid/upload_part_finish"));
    expect(partFinishCalls).toHaveLength(2);
    expect(JSON.parse(partFinishCalls[0][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 1,
      block_size: 5,
      md5: md5Hex("hello"),
    });
    expect(JSON.parse(partFinishCalls[1][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 2,
      block_size: 5,
      md5: md5Hex("world"),
    });

    const completeCall = (fetch as any).mock.calls.find(([url, init = {}]: any) =>
      String(url).includes("/v2/users/user-openid/files")
      && init.body
      && JSON.parse(init.body).upload_id === "upload-1"
    );
    expect(completeCall).toBeTruthy();

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends QQ group replies as markdown passive replies with msg_id and distinct msg_seq values", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("group-openid", "first", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });
    await adapter.sendReply("group-openid", "second", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });

    const messageCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(messageCalls).toHaveLength(2);
    expect(JSON.parse(messageCalls[0][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "first" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCalls[1][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "second" },
      msg_id: "qq-mid-1",
      msg_seq: 2,
    });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/messages"))).toBe(false);
    adapter.stop();
  });

  it("sends QQ C2C replies as official markdown messages", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("user-openid", "**bold**\n- item", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "**bold**\n- item" },
      msg_id: "qq-dm-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("sends legacy QQ channel replies with the channel markdown object", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("channel-id", "# Title", {
      messageId: "qq-channel-mid-1",
      targetType: "channel",
      isGroup: true,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/channels/channel-id/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      markdown: { content: "# Title" },
      msg_id: "qq-channel-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCall[1].body)).not.toHaveProperty("msg_type");
    adapter.stop();
  });

  it("uploads local group images through QQ group chunked upload", async () => {
    const filePath = makeTempFile("image.png", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("group-openid", filePath, {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({ file_type: 1 });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/upload_prepare"))).toBe(false);

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends QQ rich media replies with passive reply context", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      replyContext: {
        messageId: "qq-mid-1",
        targetType: "group",
      },
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("rejects local group documents before chunked upload", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMediaFile("group-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/upload_prepare"))).toBe(false);
    adapter.stop();
  });

  it("uses staged file metadata to choose QQ rich-media image file_type for extensionless URLs", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://hana.example.com/api/bridge/media/token_123", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 1,
      url: "https://hana.example.com/api/bridge/media/token_123",
      srv_send_msg: false,
    });
    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends C2C documents with QQ rich-media file_type 4", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 4,
      url: "https://cdn.example.com/note.txt",
      srv_send_msg: false,
    });
    adapter.stop();
  });

  it("uses the group rich-media endpoint directly when Bridge knows the target is a group", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/files"))).toBe(false);
    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({ file_type: 1 });
    adapter.stop();
  });

  it("labels every QQ outbound REST call with an explicit stage for diagnostics (#1612)", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    // 排空后台 connect()（token + gateway）的微任务链
    await vi.advanceTimersByTimeAsync(0);

    await adapter.sendReply("user-openid", "hi", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });
    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    expect(outboundCapture.platforms).toContain("qq");
    const stages = outboundCapture.requests.map((r) => r.stage);
    expect(stages).toContain("token");
    expect(stages).toContain("gateway");
    expect(stages).toContain("send_reply");
    expect(stages).toContain("upload_prepare");
    expect(stages).toContain("upload_part_put");
    expect(stages).toContain("upload_part_finish");
    expect(stages).toContain("upload_complete");
    expect(stages).toContain("send_media_message");
    // 每一笔出站调用都必须显式带 stage，禁止匿名出站
    expect(outboundCapture.requests.length).toBeGreaterThan(0);
    expect(outboundCapture.requests.every((r) => typeof r.stage === "string" && r.stage.length > 0)).toBe(true);
    adapter.stop();
  });

  it("rejects QQ group documents before upload because the official API has not opened file_type 4 for groups", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMedia("group-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/groups/group-openid/files"))).toBe(false);
    adapter.stop();
  });
});

describe("QQ principal metadata", () => {
  it("prefers stable author id as principal while keeping C2C openid as delivery alias", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      user_openid: "c2c-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "c2c-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });

  it("uses member openid as a QQ alias without treating placeholder username as display name", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      member_openid: "member-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "member-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });
});
