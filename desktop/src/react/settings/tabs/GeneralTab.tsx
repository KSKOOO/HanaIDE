import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { autoSaveConfig, t } from '../helpers';
import { loadSettingsConfig, updateSettingsSnapshot } from '../actions';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import { readConfigBoolean } from '../resource-state';
import type { AutoLaunchStatus } from '../../types';
import {
  normalizeNotificationPreferences as normalizeSharedNotificationPreferences,
  normalizeTurnCompletionNotificationMode,
} from '../../../../../shared/notification-preferences.ts';
import styles from '../Settings.module.css';

type TurnCompletionNotificationMode = 'never' | 'when_unfocused' | 'when_session_unfocused';

interface NotificationPreferences {
  turnCompletion: TurnCompletionNotificationMode;
}

function normalizeTurnCompletionMode(value: unknown): TurnCompletionNotificationMode {
  return normalizeTurnCompletionNotificationMode(value) as TurnCompletionNotificationMode;
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  return normalizeSharedNotificationPreferences(value) as NotificationPreferences;
}

export function GeneralTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const snapshotNotifications = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.notifications);
  const showToast = useSettingsStore(s => s.showToast);
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null);
  const [autoLaunchSaving, setAutoLaunchSaving] = useState(false);
  const [keepAwakeSaving, setKeepAwakeSaving] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences | null>(() => {
    const snapshot = useSettingsStore.getState().settingsSnapshot.data?.preferences?.notifications;
    return snapshot ? normalizeNotificationPreferences(snapshot) : null;
  });
  const keepAwake = readConfigBoolean(settingsConfig, cfg => cfg.keep_awake, false);

  useEffect(() => {
    let alive = true;
    hana?.getAutoLaunchStatus?.()
      .then((status) => {
        if (alive && status) setAutoLaunch(status);
      })
      .catch(() => {
        if (alive) setAutoLaunch(null);
      });
    return () => {
      alive = false;
    };
  }, [hana]);

  useEffect(() => {
    if (snapshotNotifications) {
      setNotificationPrefs(normalizeNotificationPreferences(snapshotNotifications));
      return undefined;
    }
    let alive = true;
    hanaFetch('/api/preferences/notifications')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast, snapshotNotifications]);

  const handleAutoLaunchToggle = useCallback(async (on: boolean) => {
    if (!hana?.setAutoLaunchEnabled) return;
    const previous = autoLaunch;
    setAutoLaunchSaving(true);
    try {
      const next = await hana.setAutoLaunchEnabled(on);
      setAutoLaunch(next || previous);
    } catch {
      setAutoLaunch(previous);
    } finally {
      setAutoLaunchSaving(false);
    }
  }, [autoLaunch, hana]);

  const handleKeepAwakeToggle = useCallback(async (on: boolean) => {
    if (!hana?.setKeepAwakeEnabled) return;
    const previous = keepAwake === true;
    setKeepAwakeSaving(true);
    try {
      const saved = await autoSaveConfig({ keep_awake: on }, { silent: true });
      if (saved === false) return;
      await hana.setKeepAwakeEnabled(on);
    } catch (err: any) {
      if (previous !== on) {
        await autoSaveConfig({ keep_awake: previous }, { silent: true });
        await loadSettingsConfig();
      }
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setKeepAwakeSaving(false);
    }
  }, [hana, keepAwake, showToast]);

  const handleTurnCompletionChange = useCallback(async (value: string) => {
    if (!notificationPrefs) return;
    const turnCompletion = normalizeTurnCompletionMode(value);
    const previous = notificationPrefs;
    const next = { turnCompletion };
    setNotificationPrefs(next);
    setNotificationSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeNotificationPreferences(data?.notifications);
      setNotificationPrefs(saved);
      updateSettingsSnapshot(snapshot => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, notifications: saved },
      }));
    } catch (err: any) {
      setNotificationPrefs(previous);
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setNotificationSaving(false);
    }
  }, [notificationPrefs, showToast]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="general">
      <SettingsSection title={t('settings.general.startup.title')}>
        {autoLaunch?.supported && (
          <SettingsRow
            label={t('settings.general.launchAtLogin')}
            control={
              <Toggle
                on={autoLaunch.openAtLogin}
                onChange={handleAutoLaunchToggle}
                ariaLabel={t('settings.general.launchAtLogin')}
                disabled={autoLaunchSaving}
              />
            }
          />
        )}
        <SettingsRow
          label={t('settings.general.keepAwake')}
          control={
            <Toggle
              on={keepAwake}
              onChange={handleKeepAwakeToggle}
              ariaLabel={t('settings.general.keepAwake')}
              disabled={keepAwakeSaving || !hana?.setKeepAwakeEnabled}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.notifications.title')}>
        <SettingsRow
          label={t('settings.general.notifications.turnCompletion')}
          control={
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.turnCompletionNever') },
                { value: 'when_unfocused', label: t('settings.general.notifications.turnCompletionWhenUnfocused') },
                { value: 'when_session_unfocused', label: t('settings.general.notifications.turnCompletionWhenSessionUnfocused') },
              ]}
              value={notificationPrefs?.turnCompletion || ''}
              onChange={handleTurnCompletionChange}
              placeholder={t('common.loading')}
              disabled={notificationSaving || !notificationPrefs}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
