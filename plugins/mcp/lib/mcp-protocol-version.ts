import { MCP_PROTOCOL_VERSION } from "./mcp-stdio-client.ts";

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

export function resolveInitialMcpProtocolVersion({ headers = {}, protocolVersion = "" } = {}) {
  const explicit = stringOrEmpty(protocolVersion);
  if (explicit) return explicit;
  return headerValue(headers, MCP_PROTOCOL_VERSION_HEADER) || MCP_PROTOCOL_VERSION;
}

export function headersWithoutMcpProtocolVersion( headers: any = {}) {
  const result: any = {};
  const protocolHeader = MCP_PROTOCOL_VERSION_HEADER.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof key !== "string" || key.toLowerCase() === protocolHeader) continue;
    result[key] = value;
  }
  return result;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const found = Object.entries(headers || {}).find(([key, value]) => (
    typeof key === "string" &&
    key.toLowerCase() === lower &&
    typeof value === "string" &&
    value.trim()
  ));
  return (found?.[1] as string)?.trim() || "";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}
