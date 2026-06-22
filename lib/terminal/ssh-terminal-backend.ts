import fs from "fs";
import path from "path";
import { Client } from "ssh2";

const SSH_READY_TIMEOUT_MS = 15000;

export async function createSshTerminalBackend() {
  return {
    spawn({ rootLocator, command = "", cwd = "/", cols = 80, rows = 24, onData, onExit }) {
      const conn = new Client();
      const pendingWrites: string[] = [];
      let stream: any = null;
      let closed = false;

      const finish = (result: any = {}) => {
        if (closed) return;
        closed = true;
        try { conn.end(); } catch {}
        onExit?.({
          exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
          signal: typeof result.signal === "string" ? result.signal : null,
        });
      };

      conn.once("ready", () => {
        conn.shell({ term: "xterm-256color", cols, rows }, (err, shellStream) => {
          if (err) {
            onData?.(`SSH shell failed: ${err.message || String(err)}\n`);
            finish({ exitCode: 1 });
            return;
          }
          stream = shellStream;
          stream.on("data", (data) => onData?.(data));
          stream.stderr?.on?.("data", (data) => onData?.(data));
          stream.once("close", () => finish({ exitCode: 0 }));
          stream.write("export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color\n");
          stream.write(`cd ${quotePosixLiteral(cwd)}\n`);
          if (command) stream.write(command.endsWith("\n") ? command : `${command}\n`);
          while (pendingWrites.length > 0) {
            stream.write(pendingWrites.shift());
          }
        });
      });
      conn.once("error", (err) => {
        onData?.(`SSH connection failed: ${err.message || String(err)}\n`);
        finish({ exitCode: 1 });
      });
      conn.once("timeout", () => {
        onData?.("SSH connection timed out\n");
        finish({ exitCode: 1 });
      });

      try {
        conn.connect(sshConfig(rootLocator));
      } catch (err: any) {
        onData?.(`SSH connection failed: ${err?.message || String(err)}\n`);
        finish({ exitCode: 1 });
      }

      return {
        write(data) {
          const text = String(data ?? "");
          if (!text) return;
          if (stream) stream.write(text);
          else pendingWrites.push(text);
        },
        kill() {
          try { stream?.end?.(); } catch {}
          finish({ signal: "SIGTERM" });
        },
        dispose() {
          try { stream?.end?.(); } catch {}
          finish({ signal: "SIGTERM" });
        },
        resize(nextCols, nextRows) {
          try { stream?.setWindow?.(nextRows, nextCols, 0, 0); } catch {}
        },
      };
    },
  };
}

function sshConfig(rootLocator) {
  const locator = rootLocator && typeof rootLocator === "object" ? rootLocator : {};
  const host = String(locator.host || "").trim();
  const username = String(locator.username || "").trim();
  if (!host) throw new Error("SSH host required");
  if (!username) throw new Error("SSH username required");

  const config: Record<string, any> = {
    host,
    username,
    port: normalizePort(locator.port),
    readyTimeout: normalizeTimeout(locator.readyTimeoutMs),
  };
  if (typeof locator.password === "string" && locator.password) config.password = locator.password;
  if (typeof locator.passphrase === "string" && locator.passphrase) config.passphrase = locator.passphrase;
  if (typeof locator.privateKey === "string" && locator.privateKey) config.privateKey = locator.privateKey;
  if (!config.privateKey && typeof locator.privateKeyPath === "string" && locator.privateKeyPath.trim()) {
    config.privateKey = fs.readFileSync(path.resolve(locator.privateKeyPath.trim()), "utf-8");
  }
  if (!config.password && !config.privateKey && process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }
  return config;
}

function normalizePort(value) {
  const port = Number(value || 22);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22;
}

function normalizeTimeout(value) {
  const timeout = Number(value || SSH_READY_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout >= 1000 ? timeout : SSH_READY_TIMEOUT_MS;
}

function quotePosixLiteral(value) {
  return `'${String(value || "/").replace(/'/g, "'\\''")}'`;
}
