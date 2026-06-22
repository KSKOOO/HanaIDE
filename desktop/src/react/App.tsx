import { useEffect, lazy, Suspense } from 'react';
import { useStore } from './stores';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RegionalErrorBoundary } from './components/RegionalErrorBoundary';
import { SidebarLayout } from './components/SidebarLayout';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { toggleJianSidebar } from './stores/desk-actions';
import { ToastContainer } from './components/ToastContainer';
import { InputContextMenu } from './components/InputContextMenu';
import { StatusBar } from './components/StatusBar';
import { LeavesOverlay } from './components/LeavesOverlay';
import { SelectionQuoteActionSurface } from './components/selection/SelectionQuoteActionSurface';
import { MediaViewer } from './components/shared/MediaViewer/MediaViewer';
import { SettingsModalShell } from './components/SettingsModalShell';
import { initTheme, initDragPrevention } from './bootstrap';
import { initApp } from './app-init';
import { AppTitlebar } from './components/app/AppTitlebar';
import { AppPages } from './components/app/AppPages';

const SkillViewerOverlay = lazy(() => import('./components/SkillViewerOverlay').then(m => ({ default: m.SkillViewerOverlay })));

declare function t(key: string, vars?: Record<string, string | number>): string;

initTheme();
initDragPrevention();

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  const statusKey = useStore(s => s.statusKey);
  const statusVars = useStore(s => s.statusVars);
  return (
    <div className={`connection-status${connected ? ' connected' : ''}`}>
      <span className="status-dot"></span>
      <span className="status-text">{statusKey ? t(statusKey, statusVars) : ''}</span>
    </div>
  );
}

function App() {
  useSidebarResize();
  useStore(s => s.locale);
  const jianOpen = useStore(s => s.jianOpen);
  const currentTab = useStore(s => s.currentTab);

  useEffect(() => {
    console.info('[hana-launch] init-start');
    initApp()
      .then(() => {
        console.info('[hana-launch] init-finished');
      })
      .catch((err: unknown) => {
        console.error('[init] init failed', err);
        console.error('[hana-launch] init-failed', err);
        console.info('[hana-launch] app-ready', JSON.stringify({ reason: 'init-failed' }));
        window.platform?.appReady?.();
      });
  }, []);

  return (
    <ErrorBoundary>
      <SidebarLayout />

      <div className="app-shell">
        <AppTitlebar
          sidebarOpen={false}
          jianOpen={jianOpen}
          showSidebarToggle={false}
          onToggleSidebar={() => {}}
          onToggleJian={() => { toggleJianSidebar(); }}
        />

        <div className="app">
          <RegionalErrorBoundary region="app-pages" resetKeys={[currentTab]}>
            <AppPages />
          </RegionalErrorBoundary>
        </div>
      </div>

      <ConnectionStatus />
      <Suspense fallback={null}><SkillViewerOverlay /></Suspense>
      <StatusBar />
      <LeavesOverlay />
      <MediaViewer />
      <SettingsModalShell />
      <InputContextMenu />
      <SelectionQuoteActionSurface />
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
