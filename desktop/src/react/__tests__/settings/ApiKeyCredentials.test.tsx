/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ProviderSummary } from '../../settings/store';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
  API_FORMAT_OPTIONS: [
    { value: 'openai-completions', label: 'OpenAI Compatible' },
  ],
}));

import { ApiKeyCredentials } from '../../settings/tabs/providers/ApiKeyCredentials';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

function providerSummary(overrides: Partial<ProviderSummary>): ProviderSummary {
  return {
    type: 'api-key',
    auth_type: 'api-key',
    display_name: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    api: 'openai-completions',
    api_key: '',
    models: [],
    custom_models: [],
    has_credentials: false,
    supports_oauth: false,
    can_delete: false,
    ...overrides,
  };
}

describe('ApiKeyCredentials', () => {
  beforeEach(() => {
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });

  afterEach(() => {
    cleanup();
  });

  it('syncs an empty saved api key into the input when the provider summary is refreshed', async () => {
    const onRefresh = vi.fn(async () => {});
    const { container, rerender } = render(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: 'saved-deepseek-key', has_credentials: true })}
        onRefresh={onRefresh}
      />,
    );

    const keyInput = () => container.querySelector('input[type="password"]');
    await waitFor(() => expect(keyInput()).toHaveValue('saved-deepseek-key'));

    rerender(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: '', has_credentials: false })}
        onRefresh={onRefresh}
      />,
    );

    await waitFor(() => expect(keyInput()).toHaveValue(''));
  });

  it('sends the provider id when verifying saved credentials', async () => {
    const onRefresh = vi.fn(async () => {});
    const { container } = render(
      <ApiKeyCredentials
        providerId="groq"
        summary={providerSummary({
          display_name: 'Groq',
          base_url: 'https://api.groq.com/openai/v1',
          api_key: 'saved-groq-key',
          has_credentials: true,
        })}
        onRefresh={onRefresh}
      />,
    );
    await waitFor(() => expect(container.querySelector('input[type="password"]')).toHaveValue('saved-groq-key'));

    const verifyButton = container.querySelector('button[title="settings.providers.verifyConnection"]');
    expect(verifyButton).not.toBeNull();
    fireEvent.click(verifyButton as HTMLButtonElement);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/providers/test',
      expect.objectContaining({ method: 'POST' }),
    ));
    const [, options] = mocks.hanaFetch.mock.calls[0];
    expect(JSON.parse(String((options as RequestInit).body))).toMatchObject({
      name: 'groq',
      base_url: 'https://api.groq.com/openai/v1',
      api: 'openai-completions',
      api_key: 'saved-groq-key',
    });
  });

  it('reveals a masked saved api key through the explicit provider endpoint', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch.mockResolvedValueOnce(jsonResponse({ api_key: 'sk-real-provider-key' }));

    const { container } = render(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: '********', has_credentials: true })}
        onRefresh={onRefresh}
      />,
    );

    await waitFor(() => expect(container.querySelector('input[type="password"]')).toHaveValue('********'));
    const revealButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.api.showKey') as HTMLButtonElement | undefined;

    expect(revealButton).toBeTruthy();
    fireEvent.click(revealButton as HTMLButtonElement);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/providers/deepseek/api-key'));
    await waitFor(() => expect(container.querySelector('input[type="text"]')).toHaveValue('sk-real-provider-key'));
  });

  it('keeps revealed saved api keys out of ordinary state and blocks copy', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({ api_key: 'sk-real-provider-key' }))
      .mockResolvedValue(jsonResponse({ ok: true }));

    const { container } = render(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: '********', has_credentials: true })}
        onRefresh={onRefresh}
      />,
    );

    const revealButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.api.showKey') as HTMLButtonElement | undefined;
    fireEvent.click(revealButton as HTMLButtonElement);

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="text"]') as HTMLInputElement | null;
      expect(el).toHaveValue('sk-real-provider-key');
      return el as HTMLInputElement;
    });

    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    const prevented = !input.dispatchEvent(copyEvent);
    expect(prevented).toBe(true);

    const verifyButton = container.querySelector('button[title="settings.providers.verifyConnection"]') as HTMLButtonElement;
    fireEvent.click(verifyButton);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/providers/test',
      expect.objectContaining({ method: 'POST' }),
    ));
    const testCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/providers/test');
    const body = JSON.parse(String((testCall?.[1] as RequestInit).body));
    expect(body).not.toHaveProperty('api_key', 'sk-real-provider-key');
  });

  it('lets a revealed saved api key be replaced directly', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({ api_key: 'sk-real-provider-key' }))
      .mockResolvedValue(jsonResponse({ ok: true }));

    const { container } = render(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: '********', has_credentials: true })}
        onRefresh={onRefresh}
      />,
    );

    const revealButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.api.showKey') as HTMLButtonElement | undefined;
    fireEvent.click(revealButton as HTMLButtonElement);

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="text"]') as HTMLInputElement | null;
      expect(el).toHaveValue('sk-real-provider-key');
      return el as HTMLInputElement;
    });

    fireEvent.change(input, { target: { value: 'sk-replacement-key' } });
    expect(input).toHaveValue('sk-replacement-key');
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
      providers: { deepseek: { api_key: 'sk-replacement-key' } },
    });
  });

  it('does not persist the revealed secret when editing begins from transient text', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({ api_key: 'sk-real-provider-key' }))
      .mockResolvedValue(jsonResponse({ ok: true }));

    const { container } = render(
      <ApiKeyCredentials
        providerId="deepseek"
        summary={providerSummary({ api_key: '********', has_credentials: true })}
        onRefresh={onRefresh}
      />,
    );

    const revealButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.api.showKey') as HTMLButtonElement | undefined;
    fireEvent.click(revealButton as HTMLButtonElement);

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="text"]') as HTMLInputElement | null;
      expect(el).toHaveValue('sk-real-provider-key');
      return el as HTMLInputElement;
    });

    fireEvent.change(input, { target: { value: 'sk-real-provider-keyx' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
      providers: { deepseek: { api_key: 'x' } },
    });
  });

  it('persists edited Kimi API keys on input blur without requiring connection verification', async () => {
    const onRefresh = vi.fn(async () => {});
    const { container } = render(
      <ApiKeyCredentials
        providerId="kimi-coding"
        summary={providerSummary({
          display_name: 'Kimi Coding',
          base_url: 'https://api.kimi.com/coding',
          api: 'anthropic-messages',
          api_key: 'old-kimi-key',
          has_credentials: true,
        })}
        onRefresh={onRefresh}
      />,
    );

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="password"]') as HTMLInputElement | null;
      expect(el).toHaveValue('old-kimi-key');
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: 'new-kimi-key' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    expect(mocks.hanaFetch).not.toHaveBeenCalledWith(
      '/api/providers/test',
      expect.objectContaining({ method: 'POST' }),
    );
    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
      providers: { 'kimi-coding': { api_key: 'new-kimi-key' } },
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it('persists an intentionally cleared API key instead of leaving the old provider secret active', async () => {
    const onRefresh = vi.fn(async () => {});
    const { container } = render(
      <ApiKeyCredentials
        providerId="kimi-coding"
        summary={providerSummary({
          display_name: 'Kimi Coding',
          base_url: 'https://api.kimi.com/coding',
          api: 'anthropic-messages',
          api_key: 'old-kimi-key',
          has_credentials: true,
        })}
        onRefresh={onRefresh}
      />,
    );

    const input = await waitFor(() => container.querySelector('input[type="password"]') as HTMLInputElement);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
      providers: { 'kimi-coding': { api_key: '' } },
    });
  });

  it('saves discovered Gemini models during preset setup instead of static defaults', async () => {
    const onRefresh = vi.fn(async () => {});
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          {
            id: 'gemini-3-pro-preview',
            name: 'Gemini 3 Pro Preview',
            context: 1048576,
            maxOutput: 65536,
          },
          { id: 'gemini-3-flash-preview' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const { container } = render(
      <ApiKeyCredentials
        providerId="gemini"
        summary={providerSummary({
          display_name: 'Gemini',
          base_url: '',
          api: '',
          models: [],
        })}
        isPresetSetup
        presetInfo={{
          label: 'Gemini',
          value: 'gemini',
          url: 'https://generativelanguage.googleapis.com/v1beta',
          api: 'google-generative-ai',
        }}
        onRefresh={onRefresh}
      />,
    );

    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gemini-key' } });
    const saveButton = container.querySelector('button[title="settings.providers.verifyConnection"]') as HTMLButtonElement;
    fireEvent.click(saveButton);

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/config',
      expect.objectContaining({ method: 'PUT' }),
    ));
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/providers/fetch-models', expect.objectContaining({
      method: 'POST',
    }));

    const configCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/config');
    const body = JSON.parse(String((configCall?.[1] as RequestInit).body));
    expect(body.providers.gemini).toEqual({
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      api_key: 'gemini-key',
      api: 'google-generative-ai',
      models: [
        {
          id: 'gemini-3-pro-preview',
          name: 'Gemini 3 Pro Preview',
          context: 1048576,
          maxOutput: 65536,
        },
        'gemini-3-flash-preview',
      ],
    });
  });
});
