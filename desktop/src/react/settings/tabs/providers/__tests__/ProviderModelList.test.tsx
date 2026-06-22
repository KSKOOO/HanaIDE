/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
  lookupModelMeta: vi.fn((_id: unknown, _provider?: unknown): unknown => null),
}));

vi.mock('../../../api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  formatContext: (n: number) => `${n}`,
  lookupModelMeta: (id: unknown, provider?: unknown) => mocks.lookupModelMeta(id, provider),
  CONTEXT_PRESETS: [],
  OUTPUT_PRESETS: [],
}));

import { ProviderModelList } from '../ProviderModelList';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function rect(init: Partial<DOMRect>): DOMRect {
  return {
    x: init.left ?? 0,
    y: init.top ?? 0,
    left: init.left ?? 0,
    top: init.top ?? 0,
    right: init.right ?? (init.left ?? 0) + (init.width ?? 0),
    bottom: init.bottom ?? (init.top ?? 0) + (init.height ?? 0),
    width: init.width ?? 0,
    height: init.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('ProviderModelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hanaFetch.mockResolvedValue(jsonResponse({ models: [{ id: 'kimi-for-coding' }] }));
    mocks.lookupModelMeta.mockReturnValue(null);
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('portals the add-model dropdown to body so fixed coordinates are viewport-relative', async () => {
    const onRefresh = vi.fn(async () => {});
    const { container } = render(
      <div data-testid="provider-host">
        <ProviderModelList
          providerId="kimi-coding"
          summary={{
            type: 'api-key',
            auth_type: 'api-key',
            display_name: 'Kimi Coding Plan',
            base_url: 'https://api.kimi.com/coding/',
            api: 'anthropic-messages',
            api_key: '',
            models: ['kimi-for-coding'],
            custom_models: [],
            has_credentials: false,
            supports_oauth: false,
            is_coding_plan: true,
            can_delete: false,
          }}
          onRefresh={onRefresh}
        />
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'settings.api.addModel' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect({
      left: 120,
      top: 300,
      bottom: 332,
      width: 240,
      height: 32,
    }));

    fireEvent.click(trigger);

    const panel = await waitFor(() => {
      const found = document.body.querySelector('[data-provider-model-dropdown="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(container).not.toContainElement(panel);
    expect(panel).toHaveStyle({
      position: 'fixed',
      left: '120px',
      top: '336px',
      width: '320px',
    });
  });

  it('shows image, video, audio and reasoning capability icons after the added model id', () => {
    mocks.lookupModelMeta.mockImplementation((id: unknown, provider: unknown) => {
      if (id === 'doubao-seed-2-0-lite-260428' && provider === 'volcengine') {
        return {
          name: 'Doubao Seed 2.0 Lite',
          image: true,
          video: true,
          audio: true,
          reasoning: true,
          context: 256000,
        };
      }
      return null;
    });

    render(
      <ProviderModelList
        providerId="volcengine"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Volcengine',
          base_url: 'https://ark.cn-beijing.volces.com/api/v3',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: ['doubao-seed-2-0-lite-260428'],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={vi.fn(async () => {})}
      />,
    );

    const id = screen.getByText('doubao-seed-2-0-lite-260428');
    expect(id.nextElementSibling).toHaveAttribute('title', 'settings.api.capability.image');
    expect(id.nextElementSibling?.nextElementSibling).toHaveAttribute('title', 'settings.api.capability.video');
    expect(id.nextElementSibling?.nextElementSibling?.nextElementSibling).toHaveAttribute('title', 'settings.api.capability.audio');
    expect(id.nextElementSibling?.nextElementSibling?.nextElementSibling?.nextElementSibling).toHaveAttribute('title', 'settings.api.capability.reasoning');
  });

  it('opens fetched models in the add-model dropdown so they can be enabled', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ id: 'kimi-new-model' }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    render(
      <ProviderModelList
        providerId="kimi-coding"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Kimi Coding Plan',
          base_url: 'https://api.kimi.com/coding/',
          api: 'anthropic-messages',
          api_key: '',
          models: [],
          custom_models: [],
          has_credentials: false,
          supports_oauth: false,
          is_coding_plan: true,
          can_delete: false,
        }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.fetchModels' }));

    const option = await screen.findByRole('button', { name: /kimi-new-model/ });
    fireEvent.click(option);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ providers: { 'kimi-coding': { models: ['kimi-new-model'] } } }),
    })));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('does not serialize untouched capability defaults as explicit false overrides', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch.mockResolvedValue(jsonResponse({ models: [] }));
    mocks.lookupModelMeta.mockImplementation((id: unknown, provider: unknown) => {
      expect(provider).toBe('mimo');
      if (id === 'mimo-v2.5-pro') {
        return {
          name: 'MiMo V2.5 Pro',
          reasoning: true,
          image: false,
          video: false,
          audio: false,
        };
      }
      return null;
    });

    render(
      <ProviderModelList
        providerId="mimo"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Xiaomi (MiMo)',
          base_url: 'https://api.xiaomimimo.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: ['mimo-v2.5-pro'],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      const updateCall = mocks.hanaFetch.mock.calls.find(([url, options]) => (
        String(url).includes('/api/providers/mimo/models/mimo-v2.5-pro')
        && options?.method === 'PUT'
      ));
      expect(updateCall).toBeTruthy();
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
        name: 'MiMo V2.5 Pro',
      });
    });
  });

  it('serializes audio only after the user changes the audio capability toggle', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch.mockResolvedValue(jsonResponse({ models: [] }));
    mocks.lookupModelMeta.mockImplementation((id: unknown, provider: unknown) => {
      expect(provider).toBe('mimo');
      if (id === 'mimo-v2.5-pro') {
        return {
          name: 'MiMo V2.5 Pro',
          reasoning: true,
          image: false,
          video: false,
          audio: false,
        };
      }
      return null;
    });

    render(
      <ProviderModelList
        providerId="mimo"
        summary={{
          type: 'api-key',
          auth_type: 'api-key',
          display_name: 'Xiaomi (MiMo)',
          base_url: 'https://api.xiaomimimo.com/v1',
          api: 'openai-completions',
          api_key: 'sk-test',
          models: ['mimo-v2.5-pro'],
          custom_models: [],
          has_credentials: true,
          supports_oauth: false,
          is_coding_plan: false,
          can_delete: true,
        }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.api.editModel' }));
    fireEvent.click(screen.getByRole('switch', { name: 'settings.api.audio' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.api.save' }));

    await waitFor(() => {
      const updateCall = mocks.hanaFetch.mock.calls.find(([url, options]) => (
        String(url).includes('/api/providers/mimo/models/mimo-v2.5-pro')
        && options?.method === 'PUT'
      ));
      expect(updateCall).toBeTruthy();
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
        name: 'MiMo V2.5 Pro',
        audio: true,
      });
    });
  });
});
