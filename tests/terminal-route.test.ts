import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalRoute } from "../server/routes/terminal.ts";

describe("terminal route", () => {
  let terminalSessions: any;
  let app: Hono;

  beforeEach(() => {
    terminalSessions = {
      start: vi.fn(async (input) => ({
        ...input,
        terminalId: "term_ui_1",
        status: "running",
        seq: 0,
        output: "",
      })),
      list: vi.fn((sessionPath) => ({
        sessionPath,
        terminals: [{ terminalId: "term_ui_1", status: "running", seq: 0 }],
      })),
      read: vi.fn((input) => ({ ...input, status: "running", seq: 1, output: "ready\n" })),
      write: vi.fn((input) => ({ ...input, status: "running", seq: 2, output: "typed\n" })),
      close: vi.fn((input) => ({ ...input, status: "killed", output: "" })),
    };
    app = new Hono();
    app.route("/api", createTerminalRoute({
      currentAgentId: "hana",
      terminalSessions,
    }));
  });

  it("starts a terminal for the requested UI session and cwd", async () => {
    const res = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
        cwd: "D:/hana/workspace",
        command: "",
        label: "workspace",
        cols: 120,
        rows: 32,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ terminalId: "term_ui_1", status: "running" });
    expect(terminalSessions.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
      agentId: "hana",
      cwd: "D:/hana/workspace",
      label: "workspace",
      cols: 120,
      rows: 32,
    }));
  });

  it("passes profile startup commands separately from the interactive shell command", async () => {
    const res = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
        cwd: "D:/hana/workspace",
        profile: "hana-cli",
        label: "HanaIDE CLI",
      }),
    });

    expect(res.status).toBe(200);
    expect(terminalSessions.start).toHaveBeenCalledWith(expect.objectContaining({
      command: "",
      startupCommand: expect.stringContaining("cli"),
      profile: "hana-cli",
      label: "HanaIDE CLI",
    }));
  });

  it("starts VSCode CLI as an initial terminal input while keeping the PTY interactive", async () => {
    const res = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
        cwd: "D:/hana/workspace",
        profile: "vscode-cli",
        label: "VSCode CLI",
      }),
    });

    expect(res.status).toBe(200);
    expect(terminalSessions.start).toHaveBeenCalledWith(expect.objectContaining({
      command: "",
      startupCommand: expect.stringContaining("code"),
      profile: "vscode-cli",
      label: "VSCode CLI",
    }));
  });

  it("starts an SSH terminal from a mounted workspace without requiring a native cwd", async () => {
    const resolveTerminalWorkspace = vi.fn(() => ({
      mountId: "ssh_project",
      provider: "ssh",
      remoteAuthority: "hana@dev.example.test:22",
      rootLocator: {
        host: "dev.example.test",
        port: 22,
        username: "hana",
        rootPath: "/srv/project",
        password: "secret",
      },
    }));
    app = new Hono();
    app.route("/api", createTerminalRoute({
      currentAgentId: "hana",
      terminalSessions,
      resolveTerminalWorkspace,
    }));

    const res = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
        workspaceMountId: "ssh_project",
        label: "Remote Project",
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveTerminalWorkspace).toHaveBeenCalledWith("ssh_project");
    expect(terminalSessions.start).toHaveBeenCalledWith(expect.objectContaining({
      provider: "ssh",
      workspaceMountId: "ssh_project",
      cwd: "/srv/project",
      remoteAuthority: "hana@dev.example.test:22",
      rootLocator: expect.objectContaining({
        host: "dev.example.test",
        username: "hana",
        password: "secret",
      }),
    }));
    const data = await res.json();
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  it("supports list, read, write, and close actions without exposing manager internals", async () => {
    const body = {
      sessionPath: "D:/hana/agents/hana/sessions/main.jsonl",
      terminalId: "term_ui_1",
    };

    const list = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: "list" }),
    });
    const read = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: "read", sinceSeq: 1 }),
    });
    const write = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: "write", chars: "pwd\n" }),
    });
    const close = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: "close" }),
    });

    expect(await list.json()).toMatchObject({ terminals: [{ terminalId: "term_ui_1" }] });
    expect(await read.json()).toMatchObject({ output: "ready\n" });
    expect(await write.json()).toMatchObject({ output: "typed\n" });
    expect(await close.json()).toMatchObject({ status: "killed" });
    expect(terminalSessions.write).toHaveBeenCalledWith(expect.objectContaining({ chars: "pwd\n" }));
  });

  it("rejects terminal writes without a session path", async () => {
    const res = await app.request("/api/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", terminalId: "term_ui_1", chars: "pwd\n" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "sessionPath is required" });
  });
});
