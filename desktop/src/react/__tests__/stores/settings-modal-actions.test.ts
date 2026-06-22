import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import {
  closeSettingsModal,
  openSettingsModal,
  setSettingsModalActiveTab,
} from '../../stores/settings-modal-actions';

describe('settings modal actions', () => {
  beforeEach(() => {
    useStore.setState({
      settingsModal: { open: false, activeTab: 'agent' },
    } as never);
  });

  it('opens the settings modal on the agent tab by default', () => {
    openSettingsModal();

    expect(useStore.getState().settingsModal).toEqual({
      open: true,
      activeTab: 'agent',
    });
  });

  it('opens the settings modal on the requested tab', () => {
    openSettingsModal('work');

    expect(useStore.getState().settingsModal).toEqual({
      open: true,
      activeTab: 'work',
    });
  });

  it('normalizes removed settings tabs when opening the modal', () => {
    openSettingsModal('bridge');

    expect(useStore.getState().settingsModal).toEqual({
      open: true,
      activeTab: 'general',
    });
  });

  it('closes the settings modal while preserving the last coding-safe tab', () => {
    openSettingsModal('work');
    closeSettingsModal();

    expect(useStore.getState().settingsModal).toEqual({
      open: false,
      activeTab: 'work',
    });
  });

  it('maps the removed Computer Use tab to general settings when reopening', () => {
    openSettingsModal('computer');
    closeSettingsModal();
    openSettingsModal();

    expect(useStore.getState().settingsModal).toEqual({
      open: true,
      activeTab: 'general',
    });
  });

  it('updates the remembered modal tab while it remains open', () => {
    openSettingsModal('agent');
    setSettingsModalActiveTab('security');

    expect(useStore.getState().settingsModal).toEqual({
      open: true,
      activeTab: 'security',
    });
  });
});
