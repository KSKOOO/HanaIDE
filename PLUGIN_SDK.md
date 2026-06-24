# HanaIDE Plugin SDK

HanaIDE ships a small plugin SDK for built-in and developer plugins. This guide is intentionally kept at the repository root because the plugin creator skill uses it to detect a valid HanaIDE workspace before choosing workspace SDK dependencies.

## Packages

- `@hana/plugin-protocol` defines shared protocol types and surface-session headers.
- `@hana/plugin-runtime` exposes server-side plugin helpers for tools, routes, providers, and lifecycle hooks.
- `@hana/plugin-sdk` exposes iframe and client helpers, including `hana.api.fetch`.
- `@hana/plugin-components` provides React components styled for the HanaIDE host.

## Assets And Host APIs

Plugin UI routes should serve bundled assets through host URLs such as `hana.assets.url(...)`. Runtime code should keep session-scoped requests explicit and avoid depending on global renderer state.

## Development

Run `npm run build:packages` after changing SDK packages, then rebuild the plugin creator bundled tarballs before packaging HanaIDE.
