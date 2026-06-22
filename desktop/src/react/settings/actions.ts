/**
 * Settings shared actions — extracted from SettingsApp to avoid circular imports
 */
import { useSettingsStore } from './store';
import { hanaFetch, hanaUrl } from './api';
import { t } from './helpers';
import {
  createRemoteResource,
  failRemoteLoad,
  finishRemoteLoad,
  makeSettingsResourceKey,
  startRemoteLoad,
} from './resource-state';
import type { SettingsSnapshot } from './store';

let _settingsConfigLoadVersion = 0;
let _settingsConfigAbortController: AbortController | null = null;
let _settingsSnapshotLoadVersion = 0;
let _settingsSnapshotAbortController: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const agents = data.agents || [];
    let currentAgentId = store.currentAgentId;
    if (!currentAgentId) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      if (primary) currentAgentId = primary.id;
    }
    const currentAgent = agents.find((a: any) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/health');
    const data = await res.json();
    const avatars = data.avatars || {};
    for (const role of ['agent', 'user']) {
      if (avatars[role]) {
        const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
        if (role === 'agent') store.set({ agentAvatarUrl: url });
        else store.set({ userAvatarUrl: url });
      } else {
        if (role === 'agent') store.set({ agentAvatarUrl: null });
        else store.set({ userAvatarUrl: null });
      }
    }
  } catch {}
}

export async function loadSettingsConfig() {
  const store = useSettingsStore.getState();
  const myVersion = ++_settingsConfigLoadVersion;
  if (_settingsConfigAbortController) {
    _settingsConfigAbortController.abort();
  }
  const controller = new AbortController();
  _settingsConfigAbortController = controller;
  const agentId = store.getSettingsAgentId();
  const resourceKey = makeSettingsResourceKey('config', agentId, store.activeServerConnectionId);
  const keepSameOwnerData = store.settingsConfigKey === resourceKey;
  store.set({
    settingsConfigKey: resourceKey,
    settingsConfigStatus: 'loading',
    settingsConfigError: null,
    ...(keepSameOwnerData ? {} : {
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
    }),
  });
  if (!agentId || !resourceKey) {
    store.set({
      settingsConfigStatus: 'error',
      settingsConfigError: 'No settings agent selected',
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
    });
    return;
  }
  try {
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, identityRes, ishikiRes, publicIshikiRes, userProfileRes, pinnedRes, globalModelsRes] =
      await Promise.all([
        hanaFetch(`${agentBase}/config`, { signal: controller.signal }),
        hanaFetch(`${agentBase}/identity`, { signal: controller.signal }),
        hanaFetch(`${agentBase}/ishiki`, { signal: controller.signal }),
        hanaFetch(`${agentBase}/public-ishiki`, { signal: controller.signal }),
        hanaFetch('/api/user-profile', { signal: controller.signal }),
        hanaFetch(`${agentBase}/pinned`, { signal: controller.signal }),
        hanaFetch('/api/preferences/models', { signal: controller.signal }),
      ]);

    const config = await configRes.json();
    const globalModels = await globalModelsRes.json();
    const identityData = await identityRes.json();
    config._identity = identityData.content || '';
    const ishikiData = await ishikiRes.json();
    config._ishiki = ishikiData.content || '';
    const publicIshikiData = await publicIshikiRes.json();
    config._publicIshiki = publicIshikiData.content || '';
    const userProfileData = await userProfileRes.json();
    config._userProfile = userProfileData.content || '';
    const pinnedData = await pinnedRes.json();
    config._experience = '';
    if (config.experience?.enabled === true) {
      const experienceRes = await hanaFetch(`${agentBase}/experience`, { signal: controller.signal });
      const experienceData = await experienceRes.json();
      config._experience = experienceData.content || '';
    }
    if (myVersion !== _settingsConfigLoadVersion) return;
    if (_settingsConfigAbortController !== controller) return;
    const latest = useSettingsStore.getState();
    if (latest.settingsConfigKey !== resourceKey) return;

    store.set({
      settingsConfigKey: resourceKey,
      settingsConfigStatus: 'ready',
      settingsConfigError: null,
      settingsConfig: config,
      globalModelsConfig: globalModels,
      homeFolder: config.desk?.home_folder || null,
      currentPins: pinnedData.pins || [],
    });
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] load failed:', err);
    const latest = useSettingsStore.getState();
    if (latest.settingsConfigKey === resourceKey && myVersion === _settingsConfigLoadVersion) {
      store.set({
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (_settingsConfigAbortController === controller) {
      _settingsConfigAbortController = null;
    }
  }
}

function configFromSnapshot(snapshot: SettingsSnapshot): Record<string, any> {
  return {
    ...(snapshot.config || {}),
    _identity: snapshot.identity || '',
    _ishiki: snapshot.ishiki || '',
    _publicIshiki: snapshot.publicIshiki || '',
    _userProfile: snapshot.userProfile || '',
    _experience: snapshot.experience || '',
  };
}

function applySettingsSnapshot(snapshot: SettingsSnapshot, resourceKey: string, requestId: number) {
  const latest = useSettingsStore.getState();
  if (latest.settingsSnapshot.key !== resourceKey || latest.settingsSnapshot.requestId !== requestId) return;
  const config = configFromSnapshot(snapshot);
  const configKey = makeSettingsResourceKey('config', snapshot.agentId, latest.activeServerConnectionId);
  latest.set({
    settingsSnapshot: finishRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, snapshot),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'ready',
    settingsConfigError: null,
    settingsConfig: config,
    globalModelsConfig: snapshot.globalModels || {},
    homeFolder: config.desk?.home_folder || null,
    currentPins: Array.isArray(snapshot.pinned?.pins) ? snapshot.pinned.pins : [],
    pluginSettingsStatus: 'ready',
    pluginSettingsError: null,
    pluginAllowFullAccess: snapshot.plugins?.allowFullAccess === true,
    pluginDevToolsEnabled: snapshot.plugins?.devToolsEnabled === true,
    pluginUserDir: snapshot.plugins?.userDir || '',
    pluginSettingsTabs: Array.isArray(snapshot.plugins?.settingsTabs) ? snapshot.plugins.settingsTabs : [],
  });
}

export function updateSettingsSnapshot(mutator: (snapshot: SettingsSnapshot) => SettingsSnapshot) {
  const store = useSettingsStore.getState();
  const resource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  if (!resource.data) return;
  const next = mutator(resource.data);
  store.set({
    settingsSnapshot: {
      ...resource,
      data: next,
      updatedAt: Date.now(),
    },
  });
}

export async function loadSettingsSnapshot(options: { retainSameKeyData?: boolean } = {}) {
  const store = useSettingsStore.getState();
  const myVersion = ++_settingsSnapshotLoadVersion;
  if (_settingsSnapshotAbortController) {
    _settingsSnapshotAbortController.abort();
  }
  const controller = new AbortController();
  _settingsSnapshotAbortController = controller;
  const agentId = store.getSettingsAgentId();
  const resourceKey = makeSettingsResourceKey('snapshot', agentId, store.activeServerConnectionId);
  const currentResource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  const requestId = currentResource.requestId + 1;
  const configKey = makeSettingsResourceKey('config', agentId, store.activeServerConnectionId);
  const retainSameKeyData = options.retainSameKeyData === true;
  const keepSameConfigOwnerData = retainSameKeyData && store.settingsConfigKey === configKey;

  store.set({
    settingsSnapshot: startRemoteLoad(currentResource, resourceKey, requestId, { retainSameKeyData }),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'loading',
    settingsConfigError: null,
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    ...(keepSameConfigOwnerData ? {} : {
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
      pluginSettingsTabs: [],
    }),
  });

  if (!agentId || !resourceKey) {
    const latest = useSettingsStore.getState();
    latest.set({
      settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, 'No settings agent selected'),
      settingsConfigStatus: 'error',
      settingsConfigError: 'No settings agent selected',
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginSettingsStatus: 'error',
      pluginSettingsError: 'No settings agent selected',
    });
    return;
  }

  try {
    const res = await hanaFetch(`/api/settings/snapshot?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
    });
    const snapshot = await res.json() as SettingsSnapshot & { error?: string };
    if (snapshot.error) throw new Error(snapshot.error);
    if (myVersion !== _settingsSnapshotLoadVersion) return;
    if (_settingsSnapshotAbortController !== controller) return;
    applySettingsSnapshot(snapshot as SettingsSnapshot, resourceKey, requestId);
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] snapshot load failed:', err);
    const latest = useSettingsStore.getState();
    if (latest.settingsSnapshot.key === resourceKey && latest.settingsSnapshot.requestId === requestId) {
      latest.set({
        settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, err),
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
        pluginSettingsStatus: 'error',
        pluginSettingsError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (_settingsSnapshotAbortController === controller) {
      _settingsSnapshotAbortController = null;
    }
  }
}

export async function loadPluginSettings() {
  const store = useSettingsStore.getState();
  store.set({
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    pluginAllowFullAccess: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginAllowFullAccess,
    pluginDevToolsEnabled: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginDevToolsEnabled,
  });
  try {
    const [settingsRes, tabsRes] = await Promise.all([
      hanaFetch('/api/plugins/settings'),
      hanaFetch('/api/plugins/settings-tabs'),
    ]);
    const data = await settingsRes.json();
    const tabs = await tabsRes.json();
    if (data.error) throw new Error(data.error);
    store.set({
      pluginSettingsStatus: 'ready',
      pluginSettingsError: null,
      pluginAllowFullAccess: data.allow_full_access === true,
      pluginDevToolsEnabled: data.plugin_dev_tools_enabled === true,
      pluginUserDir: data.plugins_dir || '',
      pluginSettingsTabs: Array.isArray(tabs) ? tabs : [],
    });
  } catch (err) {
    console.error('[plugins] load settings failed:', err);
    store.set({
      pluginSettingsStatus: 'error',
      pluginSettingsError: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function browseAgent(agentId: string) {
  useSettingsStore.setState({ settingsAgentId: agentId });
  await loadSettingsConfig();
  await loadAgents();
}

export async function switchToAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    store.set({
      settingsAgentId: null,
      currentAgentId: data.agent.id,
      agentName: data.agent.name,
    });
    await loadSettingsConfig();
    await loadAgents();
    store.showToast(t('settings.agent.switched', { name: data.agent.name }), 'success');
  } catch (err: any) {
    store.showToast(t('settings.agent.switchFailed') + ': ' + err.message, 'error');
  }
}

export async function setPrimaryAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents/primary', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await loadAgents();
    store.showToast(t('settings.agent.setPrimary'), 'success');
  } catch (err: any) {
    store.showToast(t('settings.agent.setPrimaryFailed') + ': ' + err.message, 'error');
  }
}
