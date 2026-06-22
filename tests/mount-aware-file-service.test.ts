import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

describe("MountAwareFileService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("resolves default root and active local_fs studio mounts without exposing paths", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(service.resolveRoot("default")).toMatchObject({
      id: "default",
      label: "Default",
      capabilities: ["list", "read", "write"],
    });
    expect(service.resolveRoot("default")).not.toHaveProperty("path");

    const mounted = service.resolveRoot("mount_docs");
    expect(mounted).toMatchObject({
      id: "mount_docs",
      label: "Docs",
      mountId: "mount_docs",
      capabilities: ["list", "read", "write"],
    });
    expect(mounted).not.toHaveProperty("path");
    expect(await service.listFiles("mount_docs", "")).toMatchObject({
      rootId: "mount_docs",
      files: [{ name: "mounted.md", isDir: false }],
    });
  });

  it("rejects local_fs mounts outside their resolved root", async () => {
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    fs.mkdirSync(defaultRoot, { recursive: true });
    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(() => service.resolveDirectory("default", "../outside")).toThrow("invalid_subdir");
  });

  it("discloses local_fs native roots only when constructed with discloseNativeRoot", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const disclosing = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
      discloseNativeRoot: true,
    });
    expect(disclosing.resolveRoot("mount_docs")).toMatchObject({
      mountId: "mount_docs",
      nativeRootPath: mountRoot,
    });
    expect(disclosing.resolveRoot("mount_docs")).not.toHaveProperty("path");
    expect(disclosing.resolveRoot("default")).toMatchObject({ nativeRootPath: defaultRoot });
    expect((await disclosing.listFiles("mount_docs", "")).mount).toMatchObject({
      nativeRootPath: mountRoot,
    });

    const closed = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });
    expect(closed.resolveRoot("mount_docs")).not.toHaveProperty("nativeRootPath");
    expect(closed.resolveRoot("default")).not.toHaveProperty("nativeRootPath");
    expect((await closed.listFiles("mount_docs", "")).mount).not.toHaveProperty("nativeRootPath");
  });

  it("reads and writes ssh studio mounts through the ssh provider without exposing credentials", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    fs.mkdirSync(defaultRoot, { recursive: true });
    upsertStudioMount(tmpDir, {
      mountId: "ssh_project",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "ssh",
      rootLocator: {
        host: "dev.example.test",
        port: 22,
        username: "hana",
        rootPath: "/srv/project",
        password: "secret",
      },
      label: "Remote Project",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const sshProvider = createMemorySshProvider({
      "/srv/project/app.ts": "console.log('old');",
    });

    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
      sshProvider,
    });

    expect(service.resolveRoot("ssh_project")).toMatchObject({
      mountId: "ssh_project",
      provider: "ssh",
    });
    expect(JSON.stringify(service.resolveRoot("ssh_project"))).not.toContain("secret");
    expect(await service.listFiles("ssh_project", "")).toMatchObject({
      mountId: "ssh_project",
      files: [{ name: "app.ts", isDir: false }],
    });
    const resource = await service.contentResource("ssh_project", "", "app.ts");
    expect(fs.readFileSync(resource.filePath, "utf-8")).toBe("console.log('old');");

    const write = await service.writeText("ssh_project", "", {
      action: "writeText",
      name: "app.ts",
      content: "console.log('new');",
    });
    expect(write).toMatchObject({
      ok: true,
      mountId: "ssh_project",
      files: [{ name: "app.ts", isDir: false }],
    });
    const updated = await service.contentResource("ssh_project", "", "app.ts");
    expect(fs.readFileSync(updated.filePath, "utf-8")).toBe("console.log('new');");
  });
});

function createMemorySshProvider(initialFiles) {
  const files = new Map(Object.entries(initialFiles).map(([name, content]) => [
    path.posix.normalize(name),
    Buffer.from(String(content), "utf-8"),
  ]));
  let mtimeMs = Date.now();
  return {
    async list(root, subdir = "") {
      const dir = remotePath(root, subdir);
      const items = [];
      for (const file of files.keys()) {
        if (path.posix.dirname(file) === dir) {
          items.push({
            name: path.posix.basename(file),
            isDir: false,
            size: files.get(file).byteLength,
            mtime: new Date(mtimeMs).toISOString(),
          });
        }
      }
      return items.sort((a, b) => a.name.localeCompare(b.name));
    },
    async materializeFile(root, subdir, name, { cacheDir }) {
      const target = remotePath(root, subdir, name);
      const buffer = files.get(target);
      if (!buffer) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      fs.mkdirSync(cacheDir, { recursive: true });
      const filePath = path.join(cacheDir, name);
      fs.writeFileSync(filePath, buffer);
      return { root, filePath, filename: name };
    },
    async statFileVersion(root, subdir, name) {
      const target = remotePath(root, subdir, name);
      const buffer = files.get(target);
      return buffer ? { mtimeMs, size: buffer.byteLength } : null;
    },
    async writeText(root, subdir, name, content) {
      const target = remotePath(root, subdir, name);
      files.set(target, Buffer.from(String(content), "utf-8"));
      mtimeMs += 1000;
    },
  };
}

function remotePath(root, subdir = "", name = "") {
  return path.posix.normalize(path.posix.join(root.rootLocator.rootPath || root.rootLocator.path, subdir, name));
}
