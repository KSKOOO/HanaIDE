/**
 * ChannelTabBar now acts as the single Coding Mode product switcher.
 *
 * Legacy tab values are still accepted by switchTab so persisted state,
 * plugin callbacks, and older IPC events do not strand the user on a
 * removed chat/channel surface.
 */

import { useEffect } from 'react';
import { useStore } from '../../stores';
import type { TabType } from '../../types';
import { toggleSidebar } from '../SidebarLayout';
import styles from './Channels.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

const CODING_TAB = 'coding' as TabType;

function normalizeProductTab(tab: TabType | string): TabType {
  if (tab === 'chat' || tab === 'channels' || tab === 'vscode-workbench') return CODING_TAB;
  if (typeof tab === 'string' && tab.startsWith('plugin:')) return tab as TabType;
  return CODING_TAB;
}

export function switchTab(tab: TabType) {
  const s = useStore.getState();
  const next = normalizeProductTab(tab);

  if (next === CODING_TAB) {
    s.setActivePanel(null);
  }

  localStorage.setItem('hana-tab', next);
  if (next === s.currentTab) return;

  s.setCurrentTab(next);

  const isPluginTab = typeof next === 'string' && next.startsWith('plugin:');
  if (!isPluginTab) {
    const savedLeft = localStorage.getItem(`hana-sidebar-${next}`);
    const wantLeftOpen = savedLeft !== 'closed';
    if (s.sidebarOpen !== wantLeftOpen) toggleSidebar(wantLeftOpen);
  }
}

export function ChannelTabBar() {
  const currentTab = useStore(s => s.currentTab);
  const isActive = normalizeProductTab(currentTab) === CODING_TAB;

  useEffect(() => {
    const normalizedCurrent = normalizeProductTab(currentTab);
    if (normalizedCurrent !== currentTab) {
      switchTab(normalizedCurrent);
      return;
    }

    const savedTab = localStorage.getItem('hana-tab');
    if (!savedTab) {
      localStorage.setItem('hana-tab', CODING_TAB);
      return;
    }
    const next = normalizeProductTab(savedTab);
    if (next !== savedTab) {
      localStorage.setItem('hana-tab', next);
    }
    if (next !== currentTab) {
      switchTab(next);
    }
  }, [currentTab]);

  return (
    <div className={styles.tbTabs}>
      <div className={styles.tbTabsSlider} />
      <button
        type="button"
        className={`${styles.tbTab}${isActive ? ` ${styles.tbTabActive}` : ''}`}
        data-tab="coding"
        onClick={() => switchTab(CODING_TAB)}
      >
        {t('channel.codingTab')}
      </button>
    </div>
  );
}
