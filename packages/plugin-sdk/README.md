# @hana/plugin-sdk

Browser-side SDK for Hana iframe plugins.

```ts
import { hana } from '@hana/plugin-sdk';

hana.ready();
const logoUrl = hana.assets.url('images/logo.svg');
hana.ui.resize({ height: 320 });

await hana.toast.show({ message: 'Saved', type: 'success' });
await hana.external.open('https://example.com');
await hana.clipboard.writeText('Copied text');
```

## Assets

Use `hana.assets.url(path)` for files bundled under the plugin's `assets/` directory:

```ts
const js = hana.assets.url('dist/app.js');
const logo = hana.assets.url('/images/logo.svg');
```

The helper returns `/api/plugins/{pluginId}/assets/{path}` for the current iframe plugin. It accepts only relative, non-dotfile paths. Hana serves these resources through a path-scoped, HttpOnly asset session cookie, so Vite chunks, lazy imports, CSS, fonts, images, JSON, wasm, and browser-playable video files such as MP4 should live under `assets/`. The host asset route supports byte ranges for video playback.

Do not put secrets, source files, or source maps in `assets/`. Agent-generated plugins and newly edited plugin UI should not create custom route handlers just to serve static files such as CSS, JS, images, or MP4. Existing plugins that already expose static-file compatibility handlers remain loadable; treat the official `assets/` route plus `hana.assets.url(...)` as the documented contract for new work.

## Plugin API Routes

Use `hana.api.fetch(path, init)` when browser code calls this plugin's own route handlers:

```ts
const res = await hana.api.fetch('api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: 'football' }),
});
```

The helper builds `/api/plugins/{pluginId}/{path}` for the current iframe plugin and sends the `X-Hana-Plugin-Surface-Session` header from the iframe URL. Do not reuse `pluginIframeTicket` for `fetch()` calls, and do not hard-code `/api/plugins/{pluginId}/...` in browser code. `hana.api.url(path)` is available when you only need the current plugin route URL.

## Host Requests

Stable helpers are thin wrappers around `hana.host.request(type, payload)`.

| Helper | Capability | Grant |
| --- | --- | --- |
| `hana.toast.show(input)` | `toast.show` | no |
| `hana.external.open(input)` | `external.open` | yes |
| `hana.clipboard.writeText(input)` | `clipboard.writeText` | yes |

Grant-required capabilities must be declared in `manifest.json`:

```json
{
  "manifestVersion": 1,
  "ui": {
    "hostCapabilities": ["external.open", "clipboard.writeText"]
  }
}
```

## Theme

Use `hana.theme.getSnapshot()` for initial theme data and `hana.theme.subscribe(callback)` for host theme updates. The host also passes `hana-theme` and `hana-css` query parameters for compatibility with simple iframe pages.
