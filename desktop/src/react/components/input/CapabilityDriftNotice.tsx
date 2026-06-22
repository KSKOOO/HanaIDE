/**
 * #1624 工具能力漂移提示 — 输入框上方的非阻塞 chip。
 *
 * 服务端在 session restore 时对比冻结快照与当前 agent 配置，算出漂移数据
 * 经 /sessions/switch 下发；本组件只消费。默认行为零变化：不点"刷新"，
 * session 继续用冻结快照（保护 prompt cache）。刷新 = fresh compact：
 * 旧对话压缩成摘要，细节可能丢失——确认文案必须诚实说明这一点。
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import {
  dismissSessionCapabilityDrift,
  refreshSessionCapabilities,
} from '../../stores/session-actions';
import type { SessionCapabilityDrift } from '../../types';
import styles from './InputArea.module.css';

interface CapabilityDriftNoticeProps {
  sessionPath: string;
  drift: SessionCapabilityDrift;
}

function buildDetailText(
  drift: SessionCapabilityDrift,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (drift.addedToolNames.length > 0) {
    parts.push(t('session.capabilityDrift.addedTools', { count: drift.addedToolNames.length }));
  }
  const unavailableCount = drift.removedToolNames.length + drift.invalidToolNames.length;
  if (unavailableCount > 0) {
    parts.push(t('session.capabilityDrift.removedTools', { count: unavailableCount }));
  }
  if (drift.promptChanged) {
    parts.push(t('session.capabilityDrift.promptUpdated'));
  }
  return parts.join(t('session.capabilityDrift.separator'));
}

export function CapabilityDriftNotice({ sessionPath, drift }: CapabilityDriftNoticeProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  // 切换 session 或漂移数据更新时收起确认态
  useEffect(() => {
    setConfirming(false);
  }, [sessionPath, drift.fingerprint]);

  const detail = buildDetailText(drift, t);

  return (
    <div className={styles['capability-drift-notice']} data-testid="capability-drift-notice" role="status">
      <div className={styles['capability-drift-text']}>
        {confirming ? (
          <span className={styles['capability-drift-detail']}>
            {t('session.capabilityDrift.confirmText')}
          </span>
        ) : (
          <>
            <span className={styles['capability-drift-title']}>
              {t('session.capabilityDrift.title')}
            </span>
            {detail && <span className={styles['capability-drift-detail']}>{detail}</span>}
          </>
        )}
      </div>
      <div className={styles['capability-drift-actions']}>
        {confirming ? (
          <>
            <button
              type="button"
              className={styles['capability-drift-button']}
              onClick={() => setConfirming(false)}
            >
              {t('session.capabilityDrift.cancelButton')}
            </button>
            <button
              type="button"
              className={`${styles['capability-drift-button']} ${styles['capability-drift-button-primary']}`}
              onClick={() => { void refreshSessionCapabilities(sessionPath); }}
            >
              {t('session.capabilityDrift.confirmButton')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles['capability-drift-button']}
              onClick={() => { void dismissSessionCapabilityDrift(sessionPath, drift.fingerprint); }}
            >
              {t('session.capabilityDrift.dismissButton')}
            </button>
            <button
              type="button"
              className={`${styles['capability-drift-button']} ${styles['capability-drift-button-primary']}`}
              onClick={() => setConfirming(true)}
            >
              {t('session.capabilityDrift.refreshButton')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
