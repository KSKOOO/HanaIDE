import { useEffect, useState } from 'react';
import type { VscodeWorkbenchDiagnostics } from '../../../shared/vscode-workbench-contract-types';
import { t } from '../helpers';
import { SettingsRow } from '../components/SettingsRow';
import { SettingsSection } from '../components/SettingsSection';
import styles from '../Settings.module.css';

function valueText(value: unknown): string {
  if (value === true) return t('common.enabled');
  if (value === false) return t('common.disabled');
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export function VscodeWorkbenchTab() {
  const [diagnostics, setDiagnostics] = useState<VscodeWorkbenchDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!window.platform?.getVscodeWorkbenchStatus) {
        throw new Error('VSCode workbench platform API is unavailable');
      }
      setDiagnostics(await window.platform.getVscodeWorkbenchStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const unsubscribe = window.platform?.onVscodeWorkbenchStatus?.((next) => setDiagnostics(next));
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  return (
    <SettingsSection
      title={t('settings.vscodeWorkbench.title')}
      description={t('settings.vscodeWorkbench.description')}
      context={(
        <button
          type="button"
          className={styles['vscode-diagnostics-refresh']}
          disabled={loading}
          onClick={refresh}
        >
          {t('settings.refresh')}
        </button>
      )}
    >
      <div className={styles['vscode-diagnostics-grid']}>
        <SettingsRow
          label={t('settings.vscodeWorkbench.status')}
          hint={diagnostics?.message || ''}
          control={<span>{valueText(diagnostics?.status)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.runtimePath')}
          control={<span>{valueText(diagnostics?.runtimePath)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.userDataPath')}
          control={<span>{valueText(diagnostics?.userDataPath)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.extensionsDir')}
          control={<span>{valueText(diagnostics?.extensionsDir)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.gallery')}
          control={<span>{valueText(diagnostics?.galleryEnabled)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.extensionHost')}
          control={<span>{valueText(diagnostics?.extensionHostKind)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.extensionAutoUpdate')}
          control={<span>{valueText(diagnostics?.extensionAutoUpdate)}</span>}
        />
        <SettingsRow
          label={t('settings.vscodeWorkbench.appAutoUpdate')}
          control={<span>{valueText(diagnostics?.appAutoUpdate)}</span>}
        />
      </div>
      {error && <div className={styles['settings-inline-error']}>{error}</div>}
    </SettingsSection>
  );
}
