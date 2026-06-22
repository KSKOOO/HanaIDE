import { useStore } from '../../stores';
import { ActivityPanel } from '../ActivityPanel';
import { AutomationPanel } from '../AutomationPanel';
import { BridgePanel } from '../BridgePanel';
import { SkillsPanel } from '../SkillsPanel';
import { PluginPageView } from '../plugin/PluginPageView';
import { CodingModePage } from '../coding/CodingModePage';
import { MainContent } from '../../MainContent';

function PluginPage({ pluginId }: { pluginId: string }) {
  return (
    <div className="plugin-page-shell">
      <PluginPageView pluginId={pluginId} />
    </div>
  );
}

export function AppPages() {
  const currentTab = useStore(s => s.currentTab);
  const isPluginTab = typeof currentTab === 'string' && currentTab.startsWith('plugin:');
  const effectiveTab = isPluginTab ? currentTab : 'coding';

  return (
    <MainContent>
      {effectiveTab === 'coding' && <CodingModePage />}
      {isPluginTab && <PluginPage pluginId={effectiveTab.slice(7)} />}
      <ActivityPanel />
      <AutomationPanel />
      <SkillsPanel />
      <BridgePanel />
    </MainContent>
  );
}
