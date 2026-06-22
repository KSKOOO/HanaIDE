import { describe, expect, it, vi } from 'vitest';
import { saveModel, saveOnboardingIdentity, saveWorkspace } from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

describe('onboarding saveModel', () => {
  it('persists only models the user explicitly added to the provider', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveModel({
      hanaFetch,
      providerName: 'deepseek',
      selectedModel: 'deepseek-v4-pro',
      selectedUtility: 'deepseek-v4-flash',
      selectedUtilityLarge: 'deepseek-v4-pro',
      addedModels: [
        'deepseek-v4-flash',
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', audio: true },
      ],
      fetchedModels: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'deepseek-v4-unused' },
      ],
    } as Parameters<typeof saveModel>[0] & {
      addedModels: Array<string | { id: string; name?: string }>;
    });

    const providerSaveCall = hanaFetch.mock.calls.find(([path, options]) => {
      const body = JSON.parse(String(options?.body));
      return path === '/api/agents/hanako/config' && body.providers;
    });

    expect(providerSaveCall).toBeTruthy();
    const body = JSON.parse(String(providerSaveCall?.[1]?.body));
    expect(body.providers.deepseek.models).toEqual([
      'deepseek-v4-flash',
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', audio: true },
    ]);
  });
});

describe('onboarding saveOnboardingIdentity', () => {
  it('persists user name, optional agent name, and the memory master switch together', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveOnboardingIdentity({
      hanaFetch,
      userName: '  测试用户  ',
      agentName: '  小花  ',
      memoryEnabled: true,
    });

    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/hanako/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: { name: '测试用户' },
        agent: { name: '小花' },
        memory: { enabled: true },
      }),
    });
  });

  it('keeps the current agent name when the agent name input is left blank', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveOnboardingIdentity({
      hanaFetch,
      userName: '测试用户',
      agentName: '   ',
      memoryEnabled: false,
    });

    const body = JSON.parse(String(hanaFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({
      user: { name: '测试用户' },
      memory: { enabled: false },
    });
  });
});

describe('onboarding saveWorkspace', () => {
  it('creates the default workspace before saving the agent desk config', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveWorkspace({
      hanaFetch,
      workspacePath: '/Users/test/Desktop/OH-WorkSpace',
      defaultPath: '/Users/test/Desktop/OH-WorkSpace',
    });

    expect(hanaFetch).toHaveBeenNthCalledWith(1, '/api/config/default-workspace', {
      method: 'POST',
    });
    expect(hanaFetch).toHaveBeenNthCalledWith(2, '/api/agents/hanako/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        desk: {
          home_folder: '/Users/test/Desktop/OH-WorkSpace',
          heartbeat_enabled: false,
          heartbeat_interval: 31,
        },
      }),
    });
  });
});
