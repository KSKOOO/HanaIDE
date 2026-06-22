export const DEFAULT_SETTINGS_TAB = 'agent';

export const CODING_SETTINGS_TAB_IDS = [
  'agent',
  'interface',
  'general',
  'work',
  'skills',
  'providers',
  'plugins',
  'security',
  'about',
] as const;

export const CODING_SETTINGS_TAB_ID_SET: ReadonlySet<string> = new Set(CODING_SETTINGS_TAB_IDS);

const LEGACY_SETTINGS_TAB_MAP: Record<string, string> = {
  me: 'agent',
  browser: 'general',
  bridge: 'general',
  media: 'providers',
  sharing: 'interface',
  access: 'security',
  experiments: 'general',
  computer: 'general',
  workflow: 'work',
};

export function isCodingSettingsTab(tab: string): boolean {
  return CODING_SETTINGS_TAB_ID_SET.has(tab);
}

export function normalizeSettingsTab(tab?: string | null): string {
  if (!tab) return DEFAULT_SETTINGS_TAB;
  return LEGACY_SETTINGS_TAB_MAP[tab] || tab;
}
