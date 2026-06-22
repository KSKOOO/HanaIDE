import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { usePanel } from '../hooks/use-panel';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import fp from './FloatingPanels.module.css';
import styles from './automation/AutomationPanel.module.css';
import { AutomationCard } from './automation/AutomationCard';
import { AgentTabScroller, type AgentTabScrollerItem } from './automation/AgentTabScroller';
import type { CronJob, ModelOption } from './automation/automation-types';
import { jobAgentId } from './automation/automation-utils';
import type { Agent } from '../types';

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

function primaryAgentId(agents: Agent[], currentAgentId: string | null) {
  return currentAgentId || agents.find(a => a.isPrimary)?.id || agents[0]?.id || null;
}

function groupJobs(jobs: CronJob[], currentAgentId: string | null) {
  const groups = new Map<string, CronJob[]>();
  for (const job of jobs) {
    const agentId = jobAgentId(job, currentAgentId) || '__unknown__';
    const list = groups.get(agentId) || [];
    list.push(job);
    groups.set(agentId, list);
  }
  return groups;
}

function agentTabIds(agents: Agent[], groups: Map<string, CronJob[]>) {
  const ids = agents.map(agent => agent.id);
  for (const id of groups.keys()) {
    if (id !== '__unknown__' && !ids.includes(id)) ids.push(id);
  }
  if (groups.has('__unknown__')) ids.push('__unknown__');
  return ids;
}

export function AutomationPanel() {
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentName = useStore(s => s.agentName);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentSessionProjection = useStore(s => s.currentSessionPath
    ? s.sessions.find(session => session.path === s.currentSessionPath)
    : null);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const homeFolder = useStore(s => s.homeFolder);
  const agents = useStore(s => s.agents);
  const addToast = useStore(s => s.addToast);
  const t = window.t ?? ((p: string) => p);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(currentAgentId);
  const [openJobs, setOpenJobs] = useState<Record<string, boolean>>({});

  const loadData = useCallback(async () => {
    try {
      const [cronRes, modelsRes] = await Promise.all([
        hanaFetch('/api/desk/cron'),
        hanaFetch('/api/models'),
      ]);
      const cronData = await cronRes.json();
      const modelsData = await modelsRes.json().catch(() => ({ models: [] }));
      const modelOptions = (modelsData.models || [])
        .filter((m: { id?: string; provider?: string }) => m.id && m.provider)
        .map((m: { id: string; provider: string; name?: string }) => ({
          id: m.id,
          provider: m.provider,
          name: m.name,
        }));
      const nextJobs = cronData.jobs || [];
      setJobs(nextJobs);
      setAvailableModels(modelOptions);
      updateBadge(nextJobs);
    } catch (err) {
      console.error('[automation] load failed:', err);
    }
  }, []);

  const { visible, close } = usePanel('automation', loadData, [currentAgentId]);

  const toggleJob = useCallback(async (jobId: string) => {
    await hanaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', id: jobId }),
    });
    await loadData();
  }, [loadData]);

  const removeJob = useCallback(async (jobId: string) => {
    await hanaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', id: jobId }),
    });
    await loadData();
  }, [loadData]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>) => {
    await hanaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: jobId, ...fields }),
    });
    await loadData();
  }, [loadData]);

  const addManualJob = useCallback(async () => {
    const tr = window.t ?? ((p: string) => p);
    const tabAgentId = selectedAgentId && selectedAgentId !== '__unknown__' ? selectedAgentId : null;
    const actorAgentId = tabAgentId || primaryAgentId(agents, currentAgentId);
    if (!actorAgentId) {
      addToast(tr('automation.agentRequired'), 'error');
      return;
    }
    const cwd = deskWorkspaceMountId
      ? (currentSessionProjection?.cwd || null)
      : (deskBasePath || homeFolder || null);
    const res = await hanaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        scheduleType: 'cron',
        schedule: '0 9 * * *',
        label: tr('automation.newAutomation'),
        prompt: '',
        enabled: false,
        actorAgentId,
        executionContext: {
          kind: 'ui_manual',
          cwd,
          workspaceFolders: cwd ? [cwd] : [],
          sourceSessionPath: currentSessionPath,
          createdByAgentId: actorAgentId,
        },
        createdBy: { kind: 'user' },
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      addToast(data.error || tr('automation.createFailed'), 'error');
      return;
    }
    const data = await res.json();
    await loadData();
    if (data.job?.id) setOpenJobs(prev => ({ ...prev, [data.job.id]: true }));
  }, [addToast, agents, currentAgentId, currentSessionPath, currentSessionProjection?.cwd, deskBasePath, deskWorkspaceMountId, homeFolder, loadData, selectedAgentId]);

  const groups = useMemo(() => groupJobs(jobs, currentAgentId), [currentAgentId, jobs]);
  const tabs = useMemo(() => agentTabIds(agents, groups), [agents, groups]);
  const activeAgentId = selectedAgentId && tabs.includes(selectedAgentId)
    ? selectedAgentId
    : tabs[0] || null;
  const activeJobs = activeAgentId ? groups.get(activeAgentId) || [] : [];
  const agentTabItems = useMemo<AgentTabScrollerItem[]>(() => tabs.map(agentId => {
    const info = resolveAgentDisplayInfo({
      id: agentId === '__unknown__' ? null : agentId,
      agents,
      fallbackAgentName: agentName,
      fallbackAgentYuan: agentYuan,
      fallbackAgentAvatarUrl: agentAvatarUrl,
    });
    return {
      id: agentId,
      label: info.displayName,
      avatar: <AgentAvatar info={info} className={styles.agentTabAvatar} />,
    };
  }), [agentAvatarUrl, agentName, agentYuan, agents, tabs]);

  useEffect(() => {
    if (activeAgentId && activeAgentId !== selectedAgentId) {
      setSelectedAgentId(activeAgentId);
    }
  }, [activeAgentId, selectedAgentId]);

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="automationPanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <h2 className={fp.floatingPanelTitle}>{t('automation.title')}</h2>
          <button className={fp.floatingPanelClose} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          <div className={styles.toolbar}>
            <button className={styles.iconButton} type="button" onClick={addManualJob} title={t('automation.add')} aria-label={t('automation.add')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className={fp.automationList} id="automationList">
            {tabs.length === 0 ? (
              <div className={fp.automationEmpty}>{t('automation.empty')}</div>
            ) : (
              <>
                <AgentTabScroller
                  items={agentTabItems}
                  activeId={activeAgentId}
                  ariaLabel={t('automation.agentTabs')}
                  previousLabel={t('automation.previousAgent')}
                  nextLabel={t('automation.nextAgent')}
                  onSelect={setSelectedAgentId}
                />
                <div className={styles.groupList}>
                  {activeJobs.length === 0 ? (
                    <div className={fp.automationEmpty}>{t('automation.emptyForAgent')}</div>
                  ) : activeJobs.map(job => (
                    <AutomationCard
                      key={job.id}
                      job={job}
                      availableModels={availableModels}
                      open={openJobs[job.id] === true}
                      onToggleOpen={() => setOpenJobs(prev => ({ ...prev, [job.id]: prev[job.id] !== true }))}
                      onToggleEnabled={toggleJob}
                      onRemove={removeJob}
                      onUpdate={updateJob}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
