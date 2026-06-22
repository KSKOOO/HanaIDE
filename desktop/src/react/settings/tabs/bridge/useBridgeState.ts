/**
 * Bridge state management hook — loads status, saves config, tests platforms.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { loadSettingsConfig, updateSettingsSnapshot } from '../../actions';
import { t } from '../../helpers';
import type { BridgePermissionMode, KnownUser } from './BridgeWidgets';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
  agentId?: string | null;
}

export interface TelegramStatus extends PlatformStatusBase { token?: string }
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecret?: string }
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecret?: string }
export interface WechatStatus extends PlatformStatusBase { token?: string }

export interface BridgeStatus {
  agentId?: string | null;
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  whatsapp: PlatformStatusBase;
  qq: QQStatus;
  wechat: WechatStatus;
  permissionMode: BridgePermissionMode;
  readOnly: boolean;
  receiptEnabled: boolean;
  richStreamingEnabled: boolean;
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; whatsapp?: string; qq?: string; wechat?: string };
}

export type BridgePlatform = 'telegram' | 'feishu' | 'whatsapp' | 'qq' | 'wechat';

function normalizeBridgeStatus(data: any): BridgeStatus | null {
  if (!data || typeof data !== 'object') return null;
  return {
    agentId: data.agentId || null,
    telegram: data.telegram || {},
    feishu: data.feishu || {},
    whatsapp: data.whatsapp || {},
    qq: data.qq || {},
    wechat: data.wechat || {},
    permissionMode: data.permissionMode || (data.readOnly === true ? 'read_only' : 'auto'),
    readOnly: data.readOnly === true,
    receiptEnabled: data.receiptEnabled !== false,
    richStreamingEnabled: data.richStreamingEnabled !== false,
    knownUsers: data.knownUsers || {},
    owner: data.owner || {},
  };
}

function bridgeCredentials(status: BridgeStatus | null) {
  return {
    tgToken: status?.telegram?.token || '',
    fsAppId: status?.feishu?.appId || '',
    fsAppSecret: status?.feishu?.appSecret || '',
    qqAppId: status?.qq?.appID || '',
    qqAppSecret: status?.qq?.appSecret || '',
  };
}

export function useBridgeState() {
  // Atomic selectors: only re-render when these specific fields change
  const showToast = useSettingsStore(s => s.showToast);
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const settingsSnapshot = useSettingsStore(s => s.settingsSnapshot.data);
  const snapshotBridgeStatus = settingsSnapshot?.agentId === currentAgentId
    ? normalizeBridgeStatus(settingsSnapshot.bridgeStatus)
    : null;
  const snapshotCredentials = bridgeCredentials(snapshotBridgeStatus);

  const [status, setStatus] = useState<BridgeStatus | null>(() => snapshotBridgeStatus);
  const [testingPlatform, setTestingPlatform] = useState<BridgePlatform | null>(null);
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false);

  // Selected agent for bridge config (independent of Agent tab selection)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    currentAgentId
  );
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  // Sync initial value when store becomes ready (only if null)
  useEffect(() => {
    if (selectedAgentId) return;
    if (currentAgentId) setSelectedAgentId(currentAgentId);
  }, [currentAgentId]);

  // Public Ishiki — keyed to selectedAgentId
  const initialPublicIshiki = settingsSnapshot?.agentId === currentAgentId ? settingsSnapshot.publicIshiki || '' : '';
  const [publicIshiki, setPublicIshiki] = useState(initialPublicIshiki);
  const [publicIshikiOriginal, setPublicIshikiOriginal] = useState(initialPublicIshiki);

  // Credential fields
  const [tgToken, setTgToken] = useState(snapshotCredentials.tgToken);
  const [fsAppId, setFsAppId] = useState(snapshotCredentials.fsAppId);
  const [fsAppSecret, setFsAppSecret] = useState(snapshotCredentials.fsAppSecret);
  const [qqAppId, setQqAppId] = useState(snapshotCredentials.qqAppId);
  const [qqAppSecret, setQqAppSecret] = useState(snapshotCredentials.qqAppSecret);

  const applyStatus = useCallback((nextStatus: BridgeStatus | null) => {
    setStatus(nextStatus);
    const nextCredentials = bridgeCredentials(nextStatus);
    setTgToken(nextCredentials.tgToken);
    setFsAppId(nextCredentials.fsAppId);
    setFsAppSecret(nextCredentials.fsAppSecret);
    setQqAppId(nextCredentials.qqAppId);
    setQqAppSecret(nextCredentials.qqAppSecret);
  }, []);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) return;
    const nextStatus = normalizeBridgeStatus(settingsSnapshot.bridgeStatus);
    if (!nextStatus) return;
    applyStatus(nextStatus);
  }, [applyStatus, selectedAgentId, settingsSnapshot]);

  // Fetch public ishiki for selected agent (abort stale requests on agent switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId === selectedAgentId) {
      const content = settingsSnapshot.publicIshiki || '';
      setPublicIshiki(content);
      setPublicIshikiOriginal(content);
      return;
    }
    const ac = new AbortController();
    hanaFetch(`/api/agents/${selectedAgentId}/public-ishiki`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => { setPublicIshiki(data.content || ''); setPublicIshikiOriginal(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.warn('[bridge] fetch public-ishiki failed:', err); });
    return () => ac.abort();
  }, [selectedAgentId, settingsSnapshot]);

  const savePublicIshiki = async () => {
    const agentId = selectedAgentId;
    if (!agentId || publicIshiki === publicIshikiOriginal) return;
    try {
      await hanaFetch(`/api/agents/${agentId}/public-ishiki`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicIshiki }),
      });
      updateSettingsSnapshot(snapshot => (
        snapshot.agentId === agentId ? { ...snapshot, publicIshiki } : snapshot
      ));
      setPublicIshikiOriginal(publicIshiki);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const agentId = selectedAgentIdRef.current;
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await hanaFetch(`/api/bridge/status${query}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (signal?.aborted) return;
      applyStatus(normalizeBridgeStatus(data));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      console.error('[bridge] load status failed:', err);
    }
  }, [applyStatus]); // stable: reads agentId from ref, all setters are stable

  // Auto-fetch when selectedAgentId changes (abort stale on switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) {
      applyStatus(null);
    }
    const ac = new AbortController();
    loadStatus(ac.signal);
    return () => ac.abort();
  }, [applyStatus, selectedAgentId, loadStatus, settingsSnapshot?.agentId]);

  useEffect(() => {
    const handler = () => loadStatus();
    window.addEventListener('hana-bridge-reload', handler);
    return () => window.removeEventListener('hana-bridge-reload', handler);
  }, [loadStatus]);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    // Snapshot agentId at call time to avoid stale closure
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await hanaFetch(`/api/bridge/config${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      showToast(t('settings.saved'), 'success');
      // Only reload if user hasn't switched agent during the save (read latest from ref)
      if (selectedAgentIdRef.current === agentId) await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (plat: BridgePlatform, credentials: Record<string, string>) => {
    setTestingPlatform(plat);
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await hanaFetch(`/api/bridge/test${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials }),
      });
      const data = await res.json();
      if (data.ok) {
        const info = plat === 'telegram' ? ` @${data.info?.username || ''}` : '';
        showToast(t('settings.bridge.testOk') + info, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setTestingPlatform(null);
    }
  };

  const setOwner = async (plat: string, userId: string) => {
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await hanaFetch(`/api/bridge/owner${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, userId: userId || null }),
      });
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const saveGlobalSettings = async (partial: { permissionMode?: BridgePermissionMode; readOnly?: boolean; receiptEnabled?: boolean; richStreamingEnabled?: boolean }) => {
    setGlobalSettingsSaving(true);
    try {
      const res = await hanaFetch('/api/bridge/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const saved = await res.json();
      if (saved.error) throw new Error(saved.error);
      if (typeof saved.permissionMode === 'string' && typeof saved.readOnly === 'boolean' && typeof saved.receiptEnabled === 'boolean' && typeof saved.richStreamingEnabled === 'boolean') {
        setStatus(prev => prev ? {
          ...prev,
          permissionMode: saved.permissionMode,
          readOnly: saved.readOnly,
          receiptEnabled: saved.receiptEnabled,
          richStreamingEnabled: saved.richStreamingEnabled,
        } : prev);
      }
      showToast(t('settings.saved'), 'success');
      await Promise.all([
        loadStatus(),
        loadSettingsConfig(),
      ]);
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setGlobalSettingsSaving(false);
    }
  };

  return {
    status, testingPlatform, globalSettingsSaving, showToast, loadStatus,
    selectedAgentId, setSelectedAgentId,
    publicIshiki, setPublicIshiki, savePublicIshiki,
    tgToken, setTgToken,
    fsAppId, setFsAppId, fsAppSecret, setFsAppSecret,
    qqAppId, setQqAppId, qqAppSecret, setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner, saveGlobalSettings,
  };
}
