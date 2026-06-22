/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../settings/api', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector: any) => selector({ showToast: vi.fn() }),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange, options }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { MediaProviderDetail } from '../../settings/tabs/media/MediaProviderDetail';

describe('MediaProviderDetail schema-driven defaults', () => {
  it('saves provider mode defaults under provider/model/mode', () => {
    const onSaveConfig = vi.fn();

    render(
      <MediaProviderDetail
        providerId="jimeng-cli"
        capability="videoGeneration"
        provider={{
          displayName: '即梦 CLI',
          hasCredentials: true,
          availableModels: [],
          models: [{
            id: 'seedance2.0_vip',
            name: 'Seedance 2.0 VIP',
            protocolId: 'jimeng-cli-videos',
            modes: [{
              id: 'text2video',
              label: '文生视频',
              parameterSchema: {
                type: 'object',
                properties: {
                  video_resolution: {
                    type: 'string',
                    enum: ['720p', '1080p'],
                    default: '720p',
                  },
                },
              },
            }],
          }],
        }}
        config={{}}
        onSaveConfig={onSaveConfig}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('video_resolution')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: '1080p' } });

    expect(onSaveConfig).toHaveBeenCalledWith({
      providerDefaults: {
        'jimeng-cli': {
          models: {
            'seedance2.0_vip': {
              modes: {
                text2video: {
                  video_resolution: '1080p',
                },
              },
            },
          },
        },
      },
    });
  });
});
