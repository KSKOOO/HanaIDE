import { useEffect, useMemo, useRef, useState } from 'react';
import { openSettingsModal } from '../../stores/settings-modal-actions';
import { promptAndCreateSshStudioWorkspace } from '../../stores/desk-actions';

interface CodingMenuBarProps {
  onToggleSidebar?: () => void;
  onToggleJian?: () => void;
}

interface MenuItem {
  labelKey: string;
  action?: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: MenuItem[];
}

interface MenuGroup {
  id: string;
  labelKey: string;
  items: MenuItem[];
}

function tr(key: string) {
  return window.t?.(key) || key;
}

function emitCodingCommand(action: string, command?: string) {
  window.dispatchEvent(new CustomEvent('hana:coding-command', { detail: { action, command } }));
}

function execDocumentCommand(command: string) {
  document.execCommand?.(command);
}

function runTerminalCommand(command: string) {
  emitCodingCommand('terminal.run', command);
}

export function CodingMenuBar({ onToggleSidebar, onToggleJian }: CodingMenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openMenu]);

  const menus = useMemo<MenuGroup[]>(() => [
    {
      id: 'file',
      labelKey: 'titlebar.menu.file',
      items: [
        { labelKey: 'titlebar.menu.openFolder', action: () => emitCodingCommand('workspace.openFolder') },
        { labelKey: 'titlebar.menu.connectSshWorkspace', action: () => { void promptAndCreateSshStudioWorkspace(); } },
        {
          labelKey: 'titlebar.menu.newProjectFromTemplate',
          children: [
            { labelKey: 'titlebar.menu.templateBasicWeb', action: () => emitCodingCommand('project.createTemplate', 'basic-web') },
            { labelKey: 'titlebar.menu.templateDesktopApp', action: () => emitCodingCommand('project.createTemplate', 'desktop-app') },
            { labelKey: 'titlebar.menu.templateAiApp', action: () => emitCodingCommand('project.createTemplate', 'ai-app') },
          ],
        },
        { labelKey: 'titlebar.menu.settings', separatorBefore: true, action: () => openSettingsModal() },
      ],
    },
    {
      id: 'edit',
      labelKey: 'titlebar.menu.edit',
      items: [
        { labelKey: 'titlebar.menu.undo', action: () => execDocumentCommand('undo') },
        { labelKey: 'titlebar.menu.redo', action: () => execDocumentCommand('redo') },
        { labelKey: 'titlebar.menu.cut', separatorBefore: true, action: () => execDocumentCommand('cut') },
        { labelKey: 'titlebar.menu.copy', action: () => execDocumentCommand('copy') },
        { labelKey: 'titlebar.menu.paste', action: () => execDocumentCommand('paste') },
      ],
    },
    {
      id: 'selection',
      labelKey: 'titlebar.menu.selection',
      items: [
        { labelKey: 'titlebar.menu.selectAll', action: () => execDocumentCommand('selectAll') },
      ],
    },
    {
      id: 'view',
      labelKey: 'titlebar.menu.view',
      items: [
        { labelKey: 'titlebar.menu.explorer', action: () => emitCodingCommand('view.explorer') },
        { labelKey: 'titlebar.menu.search', action: () => emitCodingCommand('view.search') },
        { labelKey: 'titlebar.menu.sourceControl', action: () => emitCodingCommand('view.sourceControl') },
        { labelKey: 'titlebar.menu.extensions', action: () => emitCodingCommand('view.extensions') },
        { labelKey: 'titlebar.menu.toggleSidebar', separatorBefore: true, action: onToggleSidebar },
        { labelKey: 'titlebar.menu.toggleAssistant', action: onToggleJian },
      ],
    },
    {
      id: 'go',
      labelKey: 'titlebar.menu.go',
      items: [
        { labelKey: 'titlebar.menu.goExplorer', action: () => emitCodingCommand('view.explorer') },
        { labelKey: 'titlebar.menu.goSearch', action: () => emitCodingCommand('view.search') },
        { labelKey: 'titlebar.menu.goExtensions', action: () => emitCodingCommand('view.extensions') },
      ],
    },
    {
      id: 'run',
      labelKey: 'titlebar.menu.run',
      items: [
        { labelKey: 'titlebar.menu.startTerminal', action: () => emitCodingCommand('terminal.start') },
        { labelKey: 'titlebar.menu.gitStatus', action: () => runTerminalCommand('git status --short') },
        { labelKey: 'titlebar.menu.npmTest', action: () => runTerminalCommand('npm test') },
        { labelKey: 'titlebar.menu.npmBuild', action: () => runTerminalCommand('npm run build:renderer -- --logLevel error') },
      ],
    },
    {
      id: 'terminal',
      labelKey: 'titlebar.menu.terminal',
      items: [
        { labelKey: 'titlebar.menu.newTerminal', action: () => emitCodingCommand('terminal.start') },
        { labelKey: 'titlebar.menu.closeTerminal', action: () => emitCodingCommand('terminal.close') },
      ],
    },
    {
      id: 'help',
      labelKey: 'titlebar.menu.help',
      items: [
        { labelKey: 'titlebar.menu.about', action: () => openSettingsModal('about') },
      ],
    },
  ], [onToggleJian, onToggleSidebar]);

  const activateItem = (item: MenuItem) => {
    if (item.disabled || item.children?.length) return;
    setOpenMenu(null);
    item.action?.();
  };

  const renderItem = (item: MenuItem, index: number) => (
    <div key={`${item.labelKey}-${index}`} className={item.separatorBefore ? 'tb-menu-item-wrap separated' : 'tb-menu-item-wrap'}>
      <button
        type="button"
        role="menuitem"
        className="tb-menu-item"
        disabled={item.disabled}
        onClick={() => activateItem(item)}
      >
        <span>{tr(item.labelKey)}</span>
        {item.children?.length ? <span className="tb-menu-caret">{'>'}</span> : null}
      </button>
      {item.children?.length ? (
        <div className="tb-submenu" role="menu">
          {item.children.map(renderItem)}
        </div>
      ) : null}
    </div>
  );

  return (
    <div ref={rootRef} className="tb-menu-bar" role="menubar" aria-label={tr('titlebar.menu.label')}>
      {menus.map(menu => {
        const open = openMenu === menu.id;
        return (
          <div key={menu.id} className="tb-menu-root">
            <button
              type="button"
              className={`tb-menu-button${open ? ' active' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpenMenu(prev => prev === menu.id ? null : menu.id)}
              onMouseEnter={() => {
                if (openMenu) setOpenMenu(menu.id);
              }}
            >
              {tr(menu.labelKey)}
            </button>
            {open ? (
              <div className="tb-menu-panel" role="menu">
                {menu.items.map(renderItem)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
