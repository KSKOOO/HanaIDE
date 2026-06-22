/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorForm } from '../ConnectorForm';
import type { McpConnector } from '../types';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

describe('ConnectorForm', () => {
  it('server-renders the edited connector auto-start value without waiting for effects', () => {
    const connector: McpConnector = {
      id: 'connector-1',
      name: 'Remote MCP',
      transport: 'remote',
      url: 'https://mcp.example.com/mcp',
      autoStart: true,
      status: 'stopped',
      tools: [],
    };

    const html = renderToString(
      <ConnectorForm
        editingConnector={connector}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain('type="checkbox" checked=""');
  });
});
