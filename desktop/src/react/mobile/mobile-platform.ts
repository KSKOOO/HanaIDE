import type { PlatformApi } from '../types';
import type { HanaPlatformMobileFallbackMethodName } from '../../shared/platform-contract-types';

const noopUnsubscribe = () => {};
const OPEN_SETTINGS_EVENT = 'hana-mobile-open-settings';
type MobilePlatformApi = Partial<Pick<PlatformApi, HanaPlatformMobileFallbackMethodName>>;

function unavailableVscodeWorkbenchStatus() {
  return {
    status: 'unavailable' as const,
    enabled: false,
    runtimePath: null,
    runtimeExists: false,
    userDataPath: null,
    extensionsDir: null,
    logsDir: null,
    galleryEnabled: false,
    galleryServiceUrlHost: null,
    extensionHostKind: 'node-workspace' as const,
    extensionAutoUpdate: false,
    appAutoUpdate: false,
    fallbackToHanaOnFailure: true,
    message: 'VSCode workbench is only available in the desktop Electron runtime.',
    lastError: null,
  };
}

export function installMobilePlatform(): void {
  if (typeof window === 'undefined') return;
  document.documentElement.setAttribute('data-platform', 'web');

  const api: MobilePlatformApi = {
    getServerPort: async () => window.location.port || '',
    getServerToken: async () => '',
    openSettings: (tab?: string) => {
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab } }));
    },
    onOpenSettingsModal: (callback: (tab?: string) => void) => {
      const listener = (event: Event) => {
        callback((event as CustomEvent<{ tab?: string }>).detail?.tab);
      };
      window.addEventListener(OPEN_SETTINGS_EVENT, listener);
      return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
    },
    getFileUrl: (value: string) => browserSafeUrl(value),
    openFile: (value: string) => {
      const url = browserSafeUrl(value);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
    openExternal: (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
    settingsChanged: () => {},
    syncWindowTheme: () => {},
    onSettingsChanged: () => noopUnsubscribe,
    onSwitchTab: () => noopUnsubscribe,
    onServerRestarted: () => noopUnsubscribe,
    appReady: () => {},
    getPlatform: async () => 'web',
    showNotification: () => {},
    getAppVersion: async () => '',
    getVscodeWorkbenchStatus: async () => unavailableVscodeWorkbenchStatus(),
  };

  window.platform = api as PlatformApi;
}

function browserSafeUrl(value: string): string {
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith('/api/')) return value;
  return '';
}
