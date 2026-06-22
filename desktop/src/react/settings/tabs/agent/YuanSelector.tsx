import React, { useEffect } from 'react';
import { t } from '../../helpers';

import hanaideAssistantAvatarUrl from '../../../../assets/hanaide/hanaide-assistant-avatar.png';
import hanaideBannerUrl from '../../../../assets/hanaide/hanaide-coding-banner.png';

export function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const hanaideMeta = (types as Record<string, { label?: string }>).hanako || {};

  useEffect(() => {
    if (currentYuan !== 'hanako') onChange('hanako');
  }, [currentYuan, onChange]);

  return (
    <div className="yuan-selector hanaide-yuan-selector">
      <div className="yuan-chips">
        <button className="yuan-chip hanaide-yuan-card selected" type="button" aria-pressed="true">
          <img className="yuan-chip-avatar" src={hanaideAssistantAvatarUrl} alt="" draggable={false} />
          <div className="yuan-chip-info">
            <span className="yuan-chip-name">HanaIDE</span>
            <span className="yuan-chip-desc">{hanaideMeta.label || t('settings.about.tagline')}</span>
          </div>
        </button>
      </div>
      <div className="hanaide-yuan-banner" style={{ backgroundImage: `url(${hanaideBannerUrl})` }} aria-hidden="true" />
    </div>
  );
}
