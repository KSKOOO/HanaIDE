import { McpRuntime } from "./lib/mcp-runtime.ts";

export default class McpPlugin {
  declare ctx: any;
  declare register: any;
  async onload() {
    const runtime = new McpRuntime(this.ctx);
    this.ctx._mcpRuntime = runtime;
    this.register(this.ctx.bus.handle("mcp:settings-action", (payload) => runtime.handleSettingsAction(payload)));
    await runtime.load();
    this.register(() => runtime.dispose());
    this.ctx.log.info("mcp plugin loaded");
  }
}
