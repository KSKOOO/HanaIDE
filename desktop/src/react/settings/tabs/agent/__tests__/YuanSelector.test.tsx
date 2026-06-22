/**
 * @vitest-environment jsdom
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { YuanSelector } from '../YuanSelector';

beforeEach(() => {
  (window as any).t = (key: string) => {
    if (key === 'yuan.types') {
      return {
        hanako: { label: 'Default coding assistant' },
        butter: { label: 'More expressive' },
        ming: { label: 'More dependable' },
        kong: { label: 'Vanilla' },
      };
    }
    if (key === 'settings.about.tagline') return 'Coding workspace';
    return key;
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).t;
});

describe('YuanSelector', () => {
  it('shows only the HanaIDE coding template', () => {
    render(<YuanSelector currentYuan="hanako" onChange={vi.fn()} />);

    expect(screen.getByText('HanaIDE')).toBeInTheDocument();
    expect(screen.getByText('Default coding assistant')).toBeInTheDocument();
    expect(screen.queryByText('More expressive')).not.toBeInTheDocument();
    expect(screen.queryByText('More dependable')).not.toBeInTheDocument();
    expect(screen.queryByText('Vanilla')).not.toBeInTheDocument();
  });

  it('normalizes legacy yuan selections back to the coding template', async () => {
    const onChange = vi.fn();
    render(<YuanSelector currentYuan="ming" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('hanako'));
  });
});
