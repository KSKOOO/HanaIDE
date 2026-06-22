import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(...parts: string[]) {
  return fs.readFileSync(path.join(root, ...parts), "utf8");
}

describe("native coding mode surface", () => {
  it("routes legacy chat and channel product surfaces into OpenHanako native coding mode", () => {
    const appPages = read("desktop", "src", "react", "components", "app", "AppPages.tsx");
    const tabBar = read("desktop", "src", "react", "components", "channels", "ChannelTabBar.tsx");
    const app = read("desktop", "src", "react", "App.tsx");
    const uiSlice = read("desktop", "src", "react", "stores", "ui-slice.ts");
    const types = read("desktop", "src", "react", "types.ts");

    expect(appPages).toContain("CodingModePage");
    expect(appPages).toContain("const effectiveTab = isPluginTab ? currentTab : 'coding'");
    expect(appPages).not.toContain("ChatPage");
    expect(appPages).not.toContain("ChannelPage");
    expect(appPages).not.toContain("PreviewPanel");
    expect(appPages).not.toContain("WorkspaceCompanionRail");
    expect(appPages).not.toContain("VscodeWorkbenchPage");
    expect(appPages).not.toContain("openVscodeWorkbench");

    expect(tabBar).toContain("const CODING_TAB = 'coding' as TabType");
    expect(tabBar).toContain("channel.codingTab");
    expect(tabBar).not.toContain("channel.chatTab");
    expect(tabBar).not.toContain("channel.tab");
    expect(tabBar).not.toContain("channel.vscodeWorkbenchTab");
    expect(tabBar).not.toContain("'vscode-workbench' as TabType");

    expect(app).not.toContain("ChannelsPanel");
    expect(app).not.toContain("ChannelCreateOverlay");
    expect(uiSlice).toContain("currentTab: 'coding'");
    expect(types).toContain("'coding'");
    expect(types).not.toContain("'vscode-workbench' |");
  });

  it("keeps VSCode workbench launch out of normal app startup and page rendering", () => {
    const app = read("desktop", "src", "react", "App.tsx");
    const codingPage = read("desktop", "src", "react", "components", "coding", "CodingModePage.tsx");

    expect(app).toContain("showSidebarToggle={false}");
    expect(app).not.toContain("isVscodeWorkbenchTab");
    expect(codingPage).not.toContain("openVscodeWorkbench");
    expect(codingPage).not.toContain("setVscodeWorkbenchBounds");
  });

  it("pins coding editor, terminal, and assistant to fixed grid columns with a larger input dock", () => {
    const css = read("desktop", "src", "react", "components", "coding", "CodingMode.module.css");

    expect(css).toContain("--coding-assistant-width: clamp(430px, 31vw, 600px);");
    expect(css).toContain("--input-card-h: 176px;");
    expect(css).toContain(".editorShell {\n  grid-column: 3;");
    expect(css).toContain(".bottomPanel {\n  grid-column: 3;");
    expect(css).toContain(".assistantPanel {\n  grid-column: 4;");
    expect(css).toContain(".assistantBody {\n  min-height: 0;\n  display: grid;\n  grid-template-rows: auto minmax(0, 1fr);");
    expect(css).not.toContain(".assistantContext");
  });

  it("keeps standalone channel and DM routes out of the compiled server surface", () => {
    const serverIndex = read("server", "index.ts");
    const routeSecurity = read("server", "http", "route-security.ts");

    expect(serverIndex).not.toContain("createChannelsRoute");
    expect(serverIndex).not.toContain("createDmRoute");
    expect(routeSecurity).toContain("isStandaloneChannelRoute");
    expect(routeSecurity).toContain("return LOCAL_ONLY");
  });

  it("removes standalone quick chat settings from the settings surface", () => {
    const generalTab = read("desktop", "src", "react", "settings", "tabs", "GeneralTab.tsx");
    const searchIndex = read("desktop", "src", "react", "settings", "settings-search-index.ts");

    expect(generalTab).not.toContain("quickChat");
    expect(generalTab).not.toContain("QuickChat");
    expect(searchIndex).not.toContain("general-quick-chat");
    expect(searchIndex).not.toContain("settings.general.quickChat.title");
  });
});
