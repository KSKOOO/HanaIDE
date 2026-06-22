/**
 * Provider auth policy helpers.
 *
 * 认证需求属于 provider 契约，不属于 URL 形态。loopback 无 key 放行
 * 只作为历史兼容规则保留，避免旧本地服务配置突然不可用。
 */
import { isLocalBaseUrl } from "./net-utils.ts";
import { isMaskedSecretValue, maskSecretValue } from "./secret-custody.ts";

const AUTH_TYPES_ALLOWING_MISSING_API_KEY = new Set(["none", "optional"]);
const KNOWN_AUTH_TYPES = new Set(["api-key", "oauth", "none", "optional"]);
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_PROVIDER_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function normalizeProviderAuthType(authType) {
  return KNOWN_AUTH_TYPES.has(authType) ? authType : "api-key";
}

export function providerAuthTypeAllowsMissingApiKey(authType) {
  return AUTH_TYPES_ALLOWING_MISSING_API_KEY.has(normalizeProviderAuthType(authType));
}

export function providerCredentialAllowsMissingApiKey({ authType, baseUrl }: { authType?: string; baseUrl?: string } = {}) {
  return providerAuthTypeAllowsMissingApiKey(authType) || isLocalBaseUrl(baseUrl);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function headerKeyForName(name) {
  return String(name || "").trim().toLowerCase();
}

function isValidProviderHeaderName(name) {
  const key = headerKeyForName(name);
  return !!key && HTTP_HEADER_NAME.test(key) && !FORBIDDEN_PROVIDER_HEADERS.has(key);
}

function findExistingHeaderValue(existing, name) {
  const key = headerKeyForName(name);
  for (const [existingName, value] of Object.entries(existing || {})) {
    if (headerKeyForName(existingName) === key) return value;
  }
  return "";
}

export function normalizeProviderHeaders(headers) {
  if (!isPlainObject(headers)) return {};
  const byLowerName = new Map();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || "").trim();
    if (!isValidProviderHeaderName(name)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (!value) continue;
    byLowerName.set(headerKeyForName(name), { name, value });
  }
  return Object.fromEntries([...byLowerName.values()].map(({ name, value }) => [name, value]));
}

export function maskProviderHeaders(headers) {
  const normalized = normalizeProviderHeaders(headers);
  const masked = {};
  for (const [name, value] of Object.entries(normalized)) {
    masked[name] = maskSecretValue(value);
  }
  return masked;
}

export function resolveProviderHeadersPatch({ patch, existing = {} }: { patch?: Record<string, any>; existing?: Record<string, any> } = {}) {
  if (!isPlainObject(patch)) return {};
  const resolved = {};
  const saved = normalizeProviderHeaders(existing);
  for (const [rawName, rawValue] of Object.entries(patch)) {
    const name = String(rawName || "").trim();
    if (!isValidProviderHeaderName(name)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (!value) continue;
    resolved[name] = isMaskedSecretValue(value)
      ? findExistingHeaderValue(saved, name)
      : value;
  }
  return normalizeProviderHeaders(resolved);
}

export function collectProviderHeaderSecretPatchPaths(headers, prefix = "headers") {
  if (!isPlainObject(headers)) return [];
  const paths = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined || isMaskedSecretValue(String(value))) continue;
    paths.push(`${prefix}.${name}`);
  }
  return paths;
}

export function collectProviderHeaderSecretPatchPathsFromConfig(partial) {
  const providers = isPlainObject(partial?.providers) ? partial.providers : {};
  const paths = [];
  for (const [providerId, patch] of Object.entries(providers)) {
    if (!isPlainObject(patch) || !Object.prototype.hasOwnProperty.call(patch, "headers")) continue;
    paths.push(...collectProviderHeaderSecretPatchPaths(
      (patch as Record<string, any>).headers,
      `providers.${providerId}.headers`,
    ));
  }
  return paths;
}
