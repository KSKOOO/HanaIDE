import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MessageActions layout', () => {
  function readChatCss(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
  }

  it('anchors the select checkbox group to the lower right of the message block', () => {
    const css = readChatCss();
    const block = css.match(/\.msgActions\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/bottom:\s*4px/);
    expect(block).toMatch(/right:\s*4px/);
    expect(block).not.toMatch(/top:\s*4px/);
  });

  it('shows only the checkbox on message hover and keeps the action card scoped to its own hotspot', () => {
    const css = readChatCss();
    const actionsBlock = css.match(/\.msgActions\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const hotspotBlock = css.match(/\.msgActions::before\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const actionsHoverRule = css.match(/\.messageGroupAssistant:hover \.msgActions,\s*\.messageGroupUser:hover \.msgActions\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const popoverHoverRule = css.match(/\.msgActions:hover \.msgActionsPopover\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const popoverBlock = css.match(/\.msgActionsPopover\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(actionsBlock).toMatch(/--msg-actions-gap:\s*6px/);
    expect(actionsBlock).toMatch(/--msg-actions-hotspot-width:\s*78px/);
    expect(hotspotBlock).toMatch(/right:\s*100%/);
    expect(hotspotBlock).toMatch(/width:\s*calc\(var\(--msg-actions-hotspot-width\)\s*\+\s*var\(--msg-actions-gap\)\)/);
    expect(hotspotBlock).toMatch(/pointer-events:\s*auto/);
    expect(actionsHoverRule).toMatch(/opacity:\s*1/);
    expect(popoverHoverRule).toMatch(/opacity:\s*1/);
    expect(popoverHoverRule).toMatch(/pointer-events:\s*auto/);
    expect(popoverBlock).toMatch(/right:\s*calc\(100%\s*\+\s*var\(--msg-actions-gap\)\)/);
    expect(popoverBlock).toMatch(/width:\s*max-content/);
    expect(popoverBlock).toMatch(/min-width:\s*0/);
    expect(popoverBlock).toMatch(/pointer-events:\s*none/);
    expect(popoverBlock).toMatch(/background:\s*var\(--bg-card,\s*#fff\)/);
    expect(css).not.toMatch(/messageGroupAssistant:hover \.msgActionsPopover/);
    expect(css).not.toMatch(/messageGroupUser:hover \.msgActionsPopover/);
    expect(css).not.toMatch(/\.msgActions:focus-within \.msgActionsPopover/);
    expect(css).not.toMatch(/\.msgActionsPopover:hover/);
    expect(css).not.toMatch(/--msg-actions-popover-width/);
  });

  it('keeps active message action styling when the button is hovered', () => {
    const css = readChatCss();
    const block = css.match(/\.msgActionBtnActive:hover\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/color:\s*var\(--accent\)\s*!important/);
    expect(block).toMatch(/background:\s*rgba\(var\(--accent-rgb\),\s*0\.16\)/);
  });

  it('keeps the left footer timestamp flush with the assistant message body', () => {
    const css = readChatCss();
    const block = css.match(/\.messageFooterActionsLeft\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/align-self:\s*flex-start/);
    expect(block).toMatch(/justify-content:\s*flex-start/);
    expect(block).not.toMatch(/padding-left/);
  });

  it('right-aligns the whole user footer action row with the user message body', () => {
    const css = readChatCss();
    const block = css.match(/\.messageFooterActionsRight\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/align-self:\s*flex-end/);
    expect(block).toMatch(/justify-content:\s*flex-end/);
    expect(block).not.toMatch(/padding-right/);
  });

  it('keeps persistent footer time visible without making footer buttons permanent', () => {
    const css = readChatCss();
    const timeBlock = css.match(/\.messageFooterActionsTimePersistent\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const buttonBlock = css.match(/\.messageFooterActionsTimePersistent \.messageFooterBtn\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const hoverRule = css.match(/\.messageGroupUser:hover \.messageFooterActionsTimePersistent \.messageFooterBtn,\s*\.messageGroupAssistant:hover \.messageFooterActionsTimePersistent \.messageFooterBtn,\s*\.messageFooterActionsTimePersistent:focus-within \.messageFooterBtn,\s*\.messageFooterActionsTimePersistent:hover \.messageFooterBtn\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(timeBlock).toMatch(/opacity:\s*0\.72/);
    expect(buttonBlock).toMatch(/opacity:\s*0/);
    expect(buttonBlock).toMatch(/pointer-events:\s*none/);
    expect(hoverRule).toMatch(/opacity:\s*1/);
    expect(hoverRule).toMatch(/pointer-events:\s*auto/);
  });
});
