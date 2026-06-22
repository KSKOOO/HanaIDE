import type { ContextMenuItem } from '../../ui';

export interface WorkspaceContextMenuTarget {
  name: string;
  isDirectory: boolean;
  absolutePath?: string | null;
  relativePath: string;
  hasPomXml?: boolean;
}

export interface WorkspaceContextMenuActions {
  open?: () => void;
  openWith?: () => void;
  revealInExplorer?: () => void;
  openInTerminal?: () => void;
  compare?: () => void;
  maven?: () => void;
  addToAssistant?: () => void;
  cut?: () => void;
  copy?: () => void;
  copyPath?: () => void;
  copyRelativePath?: () => void;
  rename?: () => void;
  delete?: () => void;
}

interface BuildWorkspaceContextMenuOptions {
  t: (key: string, vars?: Record<string, string | number>) => string;
  target: WorkspaceContextMenuTarget;
  actions: WorkspaceContextMenuActions;
}

function menuItem(
  t: BuildWorkspaceContextMenuOptions['t'],
  key: string,
  action: (() => void) | undefined,
  disabled = false,
  extra: Partial<ContextMenuItem> = {},
): ContextMenuItem {
  return {
    label: t(`workspace.context.${key}`),
    disabled: disabled || !action,
    action,
    ...extra,
  };
}

export function buildWorkspaceContextMenuItems({
  t,
  target,
  actions,
}: BuildWorkspaceContextMenuOptions): ContextMenuItem[] {
  const hasAbsolutePath = typeof target.absolutePath === 'string' && target.absolutePath.trim().length > 0;
  const items: ContextMenuItem[] = [
    menuItem(t, 'open', actions.open),
    menuItem(t, 'openWith', actions.openWith, !hasAbsolutePath),
    menuItem(t, 'revealInExplorer', actions.revealInExplorer, !hasAbsolutePath),
    menuItem(t, 'openInTerminal', actions.openInTerminal),
    { divider: true },
    menuItem(t, 'compare', actions.compare, target.isDirectory),
  ];

  if (target.hasPomXml) {
    items.push(menuItem(t, 'maven', actions.maven));
  }

  items.push(
    menuItem(t, 'addToAssistant', actions.addToAssistant),
    { divider: true },
    menuItem(t, 'cut', actions.cut),
    menuItem(t, 'copy', actions.copy),
    menuItem(t, 'copyPath', actions.copyPath, !hasAbsolutePath),
    menuItem(t, 'copyRelativePath', actions.copyRelativePath),
    { divider: true },
    menuItem(t, 'rename', actions.rename),
    menuItem(t, 'delete', actions.delete, false, { danger: true }),
  );

  return items;
}
