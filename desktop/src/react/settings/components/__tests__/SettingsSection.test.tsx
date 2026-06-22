// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SettingsSection } from '../SettingsSection';

describe('SettingsSection', () => {
  it('renders section descriptions above the card body', () => {
    const { container } = render(
      <SettingsSection title="字体" description="选择正文阅读使用的字体">
        <div>衬线</div>
      </SettingsSection>,
    );

    expect(screen.getByText('字体')).toBeTruthy();
    expect(screen.getByText('选择正文阅读使用的字体')).toBeTruthy();

    const body = container.querySelector('[class*="sectionBody"]');
    expect(body?.textContent).toBe('衬线');
    expect(body?.textContent).not.toContain('选择正文阅读使用的字体');
  });
});
