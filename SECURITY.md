# Security Policy

HanaIDE is a local AI coding environment. Security reports should focus on issues that can affect source code, credentials, local files, model-provider secrets, plugin execution, or Electron renderer isolation.

## Reporting a Vulnerability

If you discover a security vulnerability, report it through the GitHub repository that hosts this project. Use a private vulnerability report when the repository enables GitHub Security Advisories; otherwise open a minimal public issue without exploit details and request a private follow-up channel.

Please include:

- Vulnerability description.
- Steps to reproduce.
- Affected platform and app version.
- Potential impact.
- Logs or diagnostics when safe to share.

The maintainer will respond within 72 hours and coordinate a fix before public disclosure.

## Scope

- Sandbox escape or PathGuard bypass.
- Credential, token, key, or local database leakage.
- Remote code execution through plugins, tools, terminal routing, IPC, preload, or renderer content.
- Cross-site scripting or privilege escalation in the Electron renderer.
- Unsafe file write/delete behavior outside the intended workspace.
