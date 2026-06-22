import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useSettingsStore, type Agent } from '../../store';
import { hanaFetch, hanaUrl, yuanFallbackAvatar } from '../../api';
import { t } from '../../helpers';
import { loadAgents } from '../../actions';
import styles from '../../Settings.module.css';

interface AgentCardGeometry {
  total: number;
  cardSize: number;
  spreadStep: number;
  edgeBleed: number;
  groupWidth: number;
  spreadWidth: number;
  positions: number[];
}

export function calculateAgentCardGeometry(totalCards: number): AgentCardGeometry {
  const total = Math.max(1, totalCards);
  const compactWidth = 260;
  const cardSize = 62;
  const spreadStep = 72;
  const edgeBleed = 18;
  const groupWidth = (total - 1) * spreadStep + cardSize;
  const visualWidth = groupWidth + edgeBleed * 2;
  const spreadWidth = Math.max(compactWidth, visualWidth);
  const spreadOffset = (spreadWidth - visualWidth) / 2;
  const positions = Array.from({ length: total }, (_unused, index) => spreadOffset + edgeBleed + index * spreadStep);

  return {
    total,
    cardSize,
    spreadStep,
    edgeBleed,
    groupWidth,
    spreadWidth,
    positions,
  };
}

export function AgentCardStack({
  agents,
  selectedId,
  onSelect,
  onAvatarClick,
  onSetPrimary,
  onDelete,
  onExport,
  onAdd,
  exportingAgentId = null,
}: {
  agents: Agent[];
  selectedId: string | null;
  currentAgentId: string | null;
  onSelect: (id: string) => void;
  onAvatarClick: () => void;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onAdd: () => void;
  exportingAgentId?: string | null;
}) {
  const cardsRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  // Wheel 只在展开态归本组件所有；收起态交还页面滚动，避免旧 scrollLeft 影响弧形堆叠。
  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!expanded) return;
      e.preventDefault();
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [expanded]);

  useEffect(() => {
    const el = cardsRef.current;
    if (!expanded) {
      if (el) el.scrollLeft = 0;
      return;
    }
    if (!selectedId) return;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const card = el.querySelector(`[data-agent-id="${selectedId}"]`) as HTMLElement;
    if (!card) return;
    const containerRect = el.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardVisLeft = cardRect.left - containerRect.left + el.scrollLeft;
    const cardVisRight = cardVisLeft + cardRect.width;
    const visLeft = el.scrollLeft;
    const visRight = visLeft + el.clientWidth;
    if (cardVisLeft < visLeft || cardVisRight > visRight) {
      el.scrollLeft = cardVisLeft - (el.clientWidth - cardRect.width) / 2;
    }
  }, [expanded, selectedId]);

  // 总卡片数 = agents + 1 (add 按钮)
  const total = agents.length + 1;
  const n = total;
  const stepTight = n > 1 ? Math.min(2.5, 10 / (n - 1)) : 0;
  const cardGeometry = calculateAgentCardGeometry(total);
  const spreadStep = cardGeometry.spreadStep;
  const spreadWidth = cardGeometry.spreadWidth;
  const ts = Date.now();

  // 拖拽排序（只对 agent 卡片，排除最后的 add 按钮）
  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;

    const handlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];

    const cards = [...container.children] as HTMLElement[];
    // 只给 agent 卡片（非 add 按钮、非 spacer）绑定拖拽
    const agentCards = cards.filter(c => !c.dataset.addBtn && !c.dataset.spacer);
    agentCards.forEach((card, dragIdx) => {

      const handler = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!container.matches(':hover')) return;

        e.preventDefault();
        card.setPointerCapture(e.pointerId);

        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let dropIdx = dragIdx;

        const allCards = ([...container.children] as HTMLElement[]).filter(c => !c.dataset.spacer);
        const positions = allCards.map(c => parseFloat(c.style.getPropertyValue('--tx-spread')) || 0);
        const origTx = positions[dragIdx];

        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

          if (!moved) {
            moved = true;
            card.classList.add(styles['dragging']);
            card.dataset.wasDragged = '1';
            // Lock scroll during drag
            container.classList.add(styles['dragging-active']);
          }

          card.style.transform = `translateX(${origTx + dx}px) rotate(0deg) translateY(-4px)`;

          const currentPos = origTx + dx;
          let newIdx = dragIdx;
          const agentCount = agents.length;
          for (let j = 0; j < agentCount; j++) {
            if (j === dragIdx) continue;
            if (dragIdx < j && currentPos > positions[j] - 15) newIdx = j;
            if (dragIdx > j && currentPos < positions[j] + 15) newIdx = Math.min(newIdx, j);
          }

          allCards.forEach((c, ci) => {
            if (c === card || c.dataset.addBtn) return;
            if (ci >= Math.min(dragIdx, newIdx) && ci <= Math.max(dragIdx, newIdx) && newIdx !== dragIdx) {
              const shift = dragIdx < newIdx ? -spreadStep : spreadStep;
              c.style.transform = `translateX(${positions[ci] + shift}px) rotate(0deg)`;
            } else {
              c.style.transform = `translateX(${positions[ci]}px) rotate(0deg)`;
            }
            c.style.transition = 'transform var(--duration-fast) var(--ease-out)';
          });

          dropIdx = newIdx;
        };

        const onUp = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.classList.remove(styles['dragging']);

          allCards.forEach(c => { c.style.transform = ''; c.style.transition = ''; });
          container.classList.remove(styles['dragging-active']);

          if (!moved) return;

          if (dropIdx !== dragIdx) {
            const currentAgents = agentsRef.current;
            const reordered = [...currentAgents];
            const [movedAgent] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, movedAgent);
            useSettingsStore.setState({ agents: reordered });
            hanaFetch('/api/agents/order', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered.map(a => a.id) }),
            }).catch(err => {
              console.error('[agent-reorder] failed:', err);
              loadAgents();
            });
          }
        };

        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
      };

      card.addEventListener('pointerdown', handler);
      handlers.push([card, handler]);
    });

    return () => {
      handlers.forEach(([el, fn]) => el.removeEventListener('pointerdown', fn));
    };
  }, [agents, spreadStep]);

  const suppressContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const selectedAgent = selectedId ? agents.find(a => a.id === selectedId) : null;
  const canSetPrimary = !!selectedAgent && !selectedAgent.isPrimary;
  // 删除门控只依据 agent 自身属性（非主助手）+ 数量下限，刻意不挂钩 currentAgentId：
  // 新建 agent 会被自动切为当前 agent，门控若看 current 则新建后永远删不掉（#1301）。
  // 删当前 agent 是安全的：AgentDeleteOverlay 会先切到其他 agent 再 DELETE，后端也拒删 active agent。
  const canDeleteSelected = !!selectedAgent && agents.length >= 2 && !selectedAgent.isPrimary;
  const isExportingSelected = !!selectedAgent && exportingAgentId === selectedAgent.id;

  return (
    <div
      className={styles['agent-card-stack']}
      style={{ '--cards-spread-width': spreadWidth } as React.CSSProperties}
    >
      <div
        className={`${styles['agent-cards']}${expanded ? ' ' + styles['agent-cards-expanded'] : ''}`}
        ref={cardsRef}
        onPointerEnter={() => setExpanded(true)}
        onPointerLeave={() => setExpanded(false)}
        onFocus={() => setExpanded(true)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setExpanded(false);
        }}
      >
        {/* spacer: 撑出实际滚动宽度，绝对定位的卡片不贡献 scrollWidth */}
        <div data-spacer="1" style={{ width: spreadWidth, height: 1, pointerEvents: 'none', flexShrink: 0 }} />
        {agents.map((agent, i) => {
          const rotTight = i * stepTight;
          const txSpread = cardGeometry.positions[i];
          const z = n - i;
          const isSelected = agent.id === selectedId;

          return (
            <div
              key={agent.id}
              className={`${styles['agent-card']}${isSelected ? ' ' + styles['selected'] : ''}`}
              data-agent-id={agent.id}
              data-index={i}
              style={{
                '--rot-tight': `${rotTight}deg`,
                '--tx-spread': `${txSpread}px`,
                '--z': z,
                zIndex: z,
              } as React.CSSProperties}
              onClick={(e) => {
                const el = e.currentTarget as HTMLElement;
                if (el.dataset.wasDragged) { delete el.dataset.wasDragged; return; }
                if (isSelected) onAvatarClick();
                else onSelect(agent.id);
              }}
              onContextMenu={suppressContextMenu}
            >
              <div className={styles['agent-card-inner']}>
                <img
                  className={styles['agent-card-avatar']}
                  draggable={false}
                  src={agent.hasAvatar
                    ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`)
                    : yuanFallbackAvatar(agent.yuan)}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan);
                  }}
                />
                {isSelected && (
                  <div className={styles['agent-card-overlay']}>
                    <span>{t('settings.agent.changeAvatar')}</span>
                  </div>
                )}
              </div>
              {agent.isPrimary && <div className={styles['agent-card-badge']} />}
              <span className={styles['agent-card-name']}>{agent.name}</span>
            </div>
          );
        })}
        {/* "+" 新建卡片 */}
        <div
          data-add-btn="1"
          className={styles['agent-card']}
          style={{
            '--rot-tight': `${agents.length * stepTight}deg`,
            '--tx-spread': `${cardGeometry.positions[agents.length]}px`,
            '--z': 0,
            zIndex: 0,
          } as React.CSSProperties}
          onClick={onAdd}
        >
          <div className={`${styles['agent-card-inner']} ${styles['agent-card-add']}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </div>
        </div>
      </div>

      {selectedAgent && (
        <div className={styles['agent-card-actions']}>
          {canSetPrimary && (
            <button
              type="button"
              className={styles['agent-card-action']}
              onClick={() => onSetPrimary(selectedAgent.id)}
            >
              {t('settings.agent.setPrimary')}
            </button>
          )}
          <button
            type="button"
            className={styles['agent-card-action']}
            onClick={() => onExport(selectedAgent.id)}
            disabled={!!exportingAgentId}
          >
            {isExportingSelected ? t('settings.agent.generatingPreview') : t('settings.agent.exportAgent')}
          </button>
          {canDeleteSelected && (
            <button
              type="button"
              className={`${styles['agent-card-action']} ${styles['agent-card-action-danger']}`}
              onClick={() => onDelete(selectedAgent.id)}
            >
              {t('settings.agent.deleteBtn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
