import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

describe("VSCode workbench dormant compatibility layer", () => {
  it("keeps the experimental WebContentsView host out of the default open path and disables launch", () => {
    const main = read("desktop", "main.cjs");

    expect(main).toContain("_vscodeWorkbenchView");
    expect(main).toContain("createVscodeWorkbenchView");
    expect(main).toContain("attachVscodeWorkbenchView");
    expect(main).toContain("detachVscodeWorkbenchView");
    expect(main).toContain('session.fromPartition("persist:vscode-workbench")');
    expect(main).toContain("contentView.addChildView(_vscodeWorkbenchView)");
    expect(main).toContain("contentView.removeChildView(_vscodeWorkbenchView)");
    expect(main).toContain("disableVscodeWorkbenchLaunch");
    expect(main).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.openVscodeWorkbench, () => disableVscodeWorkbenchLaunch())");
    expect(main).toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.reloadVscodeWorkbench, () => disableVscodeWorkbenchLaunch())");
    expect(main).not.toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.openVscodeWorkbench, () => launchVscodeWorkbenchFork())");
    expect(main).not.toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.reloadVscodeWorkbench, () => launchVscodeWorkbenchFork");
    expect(main).not.toContain("wrapIpcBestEffortHandler(HANA_IPC_CHANNELS.openVscodeWorkbench, () => attachVscodeWorkbenchView())");
  });

  it("loads the local VSCode workbench entry inside the hosted view", () => {
    const main = read("desktop", "main.cjs");

    expect(main).toContain("resolveVscodeWorkbenchEntryPath");
    expect(main).toContain("workbench-dev.html");
    expect(main).toContain("workbench.html");
    expect(main).toContain("vscode-window-config");
    expect(main).toContain("vscode:fetchShellEnv");
    expect(main).toContain("installVscodeWorkbenchProtocolHandlers");
    expect(main).toContain("vscode-file");
  });

  it("does not let the renderer auto-mount VSCode HTML into the OpenHanako tab", () => {
    const contract = read("desktop", "src", "shared", "vscode-workbench-contract.cjs");
    const platformContract = read("desktop", "src", "shared", "platform-contract.cjs");
    const preload = read("desktop", "preload.cjs");
    const types = read("desktop", "src", "react", "types.ts");
    const page = read("desktop", "src", "react", "components", "vscode", "VscodeWorkbenchPage.tsx");

    expect(contract).toContain("setBounds");
    expect(contract).toContain("vscode-workbench-set-bounds");
    expect(platformContract).toContain("setVscodeWorkbenchBounds");
    expect(preload).toContain("setVscodeWorkbenchBounds");
    expect(types).toContain("setVscodeWorkbenchBounds?");
    expect(page).not.toContain("ResizeObserver");
    expect(page).not.toContain("data-vscode-workbench-mount");
    expect(page).not.toContain("setVscodeWorkbenchBounds");
  });
});
