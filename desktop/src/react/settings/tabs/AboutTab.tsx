import React, { useEffect, useState } from 'react';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import hanaideIconUrl from '../../../assets/hanaide/hanaide-icon.png';
import hanaideBannerUrl from '../../../assets/hanaide/hanaide-coding-banner.png';
import styles from '../Settings.module.css';

export function AboutTab() {
  const hana = window.hana;
  const [version, setVersion] = useState('');

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
  }, [hana]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={hanaideIconUrl} alt="HanaIDE" />
        <div className={styles['about-name']}>HanaIDE</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {version && <div className={styles['about-version']}>v{version}</div>}
        <img className={styles['about-banner']} src={hanaideBannerUrl} alt="" aria-hidden="true" />
      </div>

      <SettingsSection>
        <SettingsRow
          label={t('settings.about.license')}
          control={<span>Apache License 2.0</span>}
        />
        <SettingsRow
          label={t('settings.about.copyright')}
          control={<span>(c) 2026 liliMozi, kskooo</span>}
        />
      </SettingsSection>

      <ExpandableRow label={t('settings.about.licenseToggle')}>
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      </ExpandableRow>
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi, kskooo

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;
