# @hana/plugin-runtime

Node-side helper package for Hana plugins.

This package is intentionally small. It gives plugin authors stable shapes and TypeScript types while preserving Hana's current plugin loading model.

```ts
import { definePlugin, defineTool } from '@hana/plugin-runtime';

export const searchTool = defineTool({
  name: 'search',
  description: 'Search project data',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    ctx.log.info('searching', input);
    return `results for ${input.query}`;
  },
});

export default definePlugin({
  async onload(ctx, { register }) {
    if (ctx.registerTool) {
      register(ctx.registerTool(searchTool));
    }
  },
});
```

Static `tools/*.js` and `commands/*.js` still use Hana's named export loader today. Lifecycle plugins can already use `export default definePlugin(...)` because the host expects a default class-compatible value.

Scheduled automation `plugin_action` jobs reuse plugin tools in v0. The scheduler stores `{ pluginId, actionId, params }` and invokes the loaded tool named `pluginId_actionId`; both static tools and dynamic `ctx.registerTool()` tools receive the SDK-style `(input, ctx)` call.

## EventBus helpers

```ts
import { defineBusHandler, HANA_BUS_SKIP, requestBus } from '@hana/plugin-runtime';

export const bridgeSend = defineBusHandler<
  { platform: string; text: string },
  { sent: boolean } | typeof HANA_BUS_SKIP
>({
  type: 'bridge:send',
  async handle(payload) {
    if (payload.platform !== 'telegram') return HANA_BUS_SKIP;
    return { sent: true };
  },
});

export default definePlugin({
  async onload(ctx, { register }) {
    register(ctx.bus.handle(bridgeSend.type, (payload) => bridgeSend.handle(payload as any, ctx as any), {
      capability: {
        title: 'Bridge send',
        description: 'Send text to a bridge platform.',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permission: 'bridge.send',
        errors: ['NO_HANDLER', 'TIMEOUT'],
        owner: 'plugin:example',
        stability: 'experimental',
      },
    }));

    await requestBus(ctx, 'session:send', {
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      text: 'Plugin loaded',
    }, { timeout: 5000 });
  },
});
```

`HANA_BUS_SKIP` is the shared skip sentinel used by the host `EventBus.SKIP`, so SDK-authored handlers can participate in chained handlers without importing host internals.

Use `ctx.bus.listCapabilities?.()` or `ctx.bus.getCapability?.(type)` to inspect
the host EventBus capability directory before making optional requests.

## External HTTP APIs

Use `ctx.network.fetch()` when runtime plugin code needs public HTTP data such as
live scores, weather, prices, search, or third-party platform APIs. Browser
iframe code should call this plugin's own route with `hana.api.fetch(...)`; the
route then calls `ctx.network.fetch(...)`.

```json
{
  "trust": "full-access",
  "capabilities": ["network.fetch"],
  "network": {
    "allowedHosts": ["site.api.espn.com"],
    "methods": ["GET"],
    "defaultTimeoutMs": 8000,
    "maxResponseBytes": 1048576
  }
}
```

```ts
route.get('/live-scores', async (c) => {
  const ctx = c.get('pluginCtx');
  const res = await ctx.network.fetch(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    { cacheTtlMs: 30_000 },
  );
  return c.json(await res.json());
});
```

`ctx.network.fetch()` returns a standard `Response`. It validates the
`network.fetch` capability, manifest host allowlist, HTTP method, HTTPS scheme,
private-network targets, timeout, cache TTL, and response byte limit. Keep API
keys in plugin configuration and read them from route or lifecycle code; do not
ship secrets in iframe assets.

## Session, Agent, model, and media helpers

Plugins that need their own chat surface should use the typed helpers instead of
writing session files or importing host internals. `createSession()` creates a
detached Hana session, so it does not switch the main UI focus.

```ts
import {
  createAgent,
  createSession,
  generateMedia,
  generateImage,
  transcribeAudio,
  sampleText,
  sendSessionMessage,
  subscribeSessionEvents,
} from '@hana/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    const agent = await createAgent(ctx, {
      name: 'Tavern Character',
      visibility: 'plugin_private',
      memoryPolicy: { enabled: true },
    });

    const session = await createSession(ctx, {
      agentId: (agent as any).agent.id,
      kind: 'tavern',
      visibility: 'plugin_private',
      cwd: ctx.dataDir,
    });

    const query = await sampleText(ctx, {
      operation: 'tavern-rag-query',
      messages: [{ role: 'user', content: 'Extract world-lore keywords for this turn' }],
      maxTokens: 80,
    });

    const sessionTarget = (session as any).sessionRef ?? { sessionId: (session as any).sessionId };

    await sendSessionMessage(ctx, sessionTarget, {
      text: 'I push the door open.',
      context: {
        beforeUser: [
          { label: 'world', text: 'Rainy city night; the old theater is still open.' },
          { label: 'rag_query', text: (query as any).text },
        ],
      },
    });

    register(subscribeSessionEvents(ctx, sessionTarget, (event) => {
      ctx.log.info('session event', event);
    }));

    await generateImage(ctx, {
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      prompt: 'A handwritten character card on warm paper',
      referenceImages: [
        { kind: 'session_file', fileId: 'sf_reference_a' },
        { kind: 'session_file', fileId: 'sf_reference_b' },
      ],
      ratio: '3:2',
    });

    await generateMedia(ctx, {
      kind: 'video',
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      prompt: 'A slow page-turn animation on warm paper',
    });

    const transcription = await transcribeAudio(ctx, {
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      fileId: 'session-file-id',
    });
    ctx.log.info('transcription', transcription);
  },
});
```

For backend code, prefer these helpers so permission checks and delivery semantics stay explicit. Plugin pages or plugin route handlers that already have host HTTP credentials can call the native facade directly: `POST /api/media/image/generate`, `POST /api/media/video/generate`, `POST /api/media/generate`, and `POST /api/media/asr/transcribe`. The submit routes require chat scope, image references must use `SessionFile` references such as `{ kind: 'session_file', fileId }`, and all requests forward into the same native Media Manager pipeline. Image and video models must declare reference-image support on the selected mode through `modes[].inputLimits.referenceImages`, such as `{ min: 0, max: 0 }` for text-only generation or `{ min: 1, max: 1 }` for a single-reference mode.

Image and video generation default to `delivery: { mode: 'session' }`, which requires `sessionId` or legacy `sessionPath` and delivers completed files as `SessionFile` records. For plugin-owned jobs that only need a generated artifact, use `delivery: { mode: 'response' }` and omit session identity; poll `GET /api/media/tasks/:taskId` until `task.status === 'done'`, then fetch filenames from `task.files[]` via `GET /api/media/generated/:filename`.

```ts
const result = await generateImage(ctx, {
  prompt: 'A small icon on transparent background',
  delivery: { mode: 'response' },
});
```

Declare ordinary needs in manifest `capabilities`, such as `session`, `agent`,
`model.sample`, and `media.generate`. `sensitiveCapabilities` records future
user-granted permission intent. `session:send.context` is injected only into the
current provider request; it does not rewrite the visible user message or the
persisted user text.

## Usage ledger helpers

Plugins that declare `usage.read` can inspect persisted LLM usage records and
subscribe to new usage events:

```ts
import { definePlugin, listUsageEntries, subscribeUsageEvents } from '@hana/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    const usage = await listUsageEntries(ctx, {
      since: '2026-05-01T00:00:00.000Z',
      limit: 100,
    });

    ctx.log.info('usage records', usage.entries.length);

    register(subscribeUsageEvents(ctx, (entry, meta) => {
      ctx.log.info('new usage entry', entry.requestId, meta.sessionId, meta.sessionPath);
    }));
  },
});
```

`listUsageEntries()` calls the host `usage:list` capability. `subscribeUsageEvents()`
subscribes to live `llm_usage` events. Restricted plugins must include
`"permissions": ["usage.read"]` in `manifest.json`; otherwise the host rejects
the request or subscription.

## SessionFile media helpers

```ts
import { createMediaDetails, defineTool } from '@hana/plugin-runtime';

export const renderImage = defineTool({
  name: 'render_image',
  description: 'Render an image',
  async execute(_input, ctx) {
    const staged = ctx.stageFile?.({
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      filePath: '/absolute/path/to/image.png',
      label: 'image.png',
    });
    if (!staged) throw new Error('stageFile unavailable');

    return {
      content: [{ type: 'text', text: 'Image generated' }],
      details: createMediaDetails([staged]),
    };
  },
});
```

Use `stageFile()` for plugin-generated local files. `createMediaDetails()` normalizes staged files, existing `session_file` media items, and serialized `SessionFile` records into the `details.media.items` shape consumed by desktop, Bridge, Mobile PWA, and future remote clients.

## Provider contributions

Provider plugins live in `providers/*.js` and require `trust: "full-access"`.
The runtime package exposes provider types and `defineProvider()` for authoring, but the host loader still reads named exports from each provider file.
Provider declarations are the canonical discovery layer for models and media capabilities. Media adapters execute a declared `protocolId`; adapter registration alone does not make a model discoverable in provider settings, default media model selectors, or media helper APIs.

```ts
import { defineProvider } from '@hana/plugin-runtime';

const provider = defineProvider({
  id: 'my-image-cli',
  displayName: 'My Image CLI',
  authType: 'none',
  runtime: {
    kind: 'local-cli',
    protocolId: 'local-cli-media',
    command: {
      executable: 'my-image-cli',
      args: [
        { literal: 'generate' },
        { option: '--prompt', from: 'prompt' },
        { option: '--model', from: 'modelId' },
        { option: '--output', from: 'outputDir' },
      ],
      timeoutMs: 120_000,
      output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
    },
  },
  capabilities: {
    chat: { projection: 'none' },
    media: {
      imageGeneration: {
        models: [
          {
            id: 'my-image-model',
            displayName: 'My Image Model',
            protocolId: 'local-cli-media',
            inputs: ['text'],
            outputs: ['image'],
            modes: [
              {
                id: 'text2image',
                label: 'Text to image',
                inputLimits: { referenceImages: { min: 0, max: 0 } },
                parameterSchema: {
                  type: 'object',
                  properties: {
                    ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'], default: '1:1' },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
});

export const { id, displayName, authType, runtime, capabilities } = provider;
```

Keep chat and media capabilities explicit. Media-only providers should use `chat.projection = "none"`, and CLI providers must use structured argument bindings rather than shell command strings.

Legacy image-generation plugins may still use `media-gen:register-adapter` as a compatibility execution path, but new plugins should not treat the `media-gen:*` namespace as the public provider API. Add a ProviderPlugin with `capabilities.media.*`, then keep adapter registration only for custom protocol execution until the host exposes a stable Adapter Plugin API.

## Pi SDK extensions

Pipeline extensions live in `extensions/*.js` and require `trust: "full-access"`. They receive Pi SDK's `ExtensionAPI` and can observe or transform request-pipeline events such as provider requests, context construction, and tool calls.

```ts
export default function(pi) {
  pi.on('before_provider_request', (event) => {
    event.payload.metadata = {
      ...(event.payload.metadata || {}),
      source: 'my-plugin',
    };
    return event.payload;
  });
}
```

Use extensions only when the plugin needs to run inside the LLM pipeline. Ordinary Agent actions should stay in `tools/*.js` so they can use the restricted permission tier. After a full-access plugin is installed, enabled, or reloaded, Hana rebinds extension runners for idle sessions; in-flight sessions pick up the change on the next safe rebuild.
