import { useEffect } from 'react';
import { useStore } from '../../stores';
import styles from './VscodeWorkbenchPage.module.css';

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

export function VscodeWorkbenchPage() {
  const status = useStore(s => s.vscodeWorkbenchStatus);
  const loading = useStore(s => s.vscodeWorkbenchLoading);
  const error = useStore(s => s.vscodeWorkbenchError);
  const setStatus = useStore(s => s.setVscodeWorkbenchStatus);
  const setLoading = useStore(s => s.setVscodeWorkbenchLoading);
  const setError = useStore(s => s.setVscodeWorkbenchError);

  useEffect(() => {
    let disposed = false;
    const platform = window.platform;
    const load = async () => {
      if (!platform?.getVscodeWorkbenchStatus) {
        setError(tr('vscodeWorkbench.fallback.platformUnavailable'));
        return;
      }
      setLoading(true);
      try {
        const next = await platform.getVscodeWorkbenchStatus();
        if (!disposed) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    const unsubscribe = platform?.onVscodeWorkbenchStatus?.((next) => {
      setStatus(next);
      setError(null);
    });
    load();
    return () => {
      disposed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [setError, setLoading, setStatus]);

  const runtimeReady = status?.runtimeExists === true;
  const galleryText = status?.galleryEnabled
    ? tr('vscodeWorkbench.gallery.enabled')
    : tr('vscodeWorkbench.gallery.disabled');
  const updateText = status?.extensionAutoUpdate
    ? tr('vscodeWorkbench.updates.extensionAutoOn')
    : tr('vscodeWorkbench.updates.extensionAutoOff');
  const mountText = status?.status === 'running'
    ? (status.message || tr('vscodeWorkbench.running'))
    : status?.status === 'starting'
      ? (status.message || tr('vscodeWorkbench.starting'))
      : status?.status === 'failed'
        ? (status.lastError || status.message || tr('vscodeWorkbench.failed'))
        : tr('vscodeWorkbench.fallback.mountPending');

  const openWorkbench = () => {
    setLoading(true);
    window.platform?.openVscodeWorkbench?.()
      .then((next) => {
        if (next) setStatus(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  const closeWorkbench = () => {
    setLoading(true);
    window.platform?.closeVscodeWorkbench?.()
      .then((next) => {
        if (next) setStatus(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <section className={styles.shell} aria-label={tr('vscodeWorkbench.title')}>
      <header className={styles.header}>
        <div>
          <h1>{tr('vscodeWorkbench.title')}</h1>
          <p>{status?.message || tr('vscodeWorkbench.fallback.initializing')}</p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={loading}
            onClick={() => window.platform?.reloadVscodeWorkbench?.()
              .then((next) => {
                setStatus(next);
              })
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))}
          >
            {tr('vscodeWorkbench.reload')}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={loading}
            onClick={closeWorkbench}
          >
            {tr('vscodeWorkbench.fallbackToHana')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={loading}
            onClick={openWorkbench}
          >
            {runtimeReady ? tr('vscodeWorkbench.open') : tr('vscodeWorkbench.retry')}
          </button>
        </div>
      </header>

      <div className={styles.statusGrid}>
        <div><span>{tr('vscodeWorkbench.status.runtime')}</span><strong>{runtimeReady ? tr('common.ready') : tr('common.unavailable')}</strong></div>
        <div><span>{tr('vscodeWorkbench.status.gallery')}</span><strong>{galleryText}</strong></div>
        <div><span>{tr('vscodeWorkbench.status.extensionHost')}</span><strong>{status?.extensionHostKind || 'node-workspace'}</strong></div>
        <div><span>{tr('vscodeWorkbench.status.updates')}</span><strong>{updateText}</strong></div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.mountFrame}>
        <span>{mountText}</span>
      </div>
    </section>
  );
}
