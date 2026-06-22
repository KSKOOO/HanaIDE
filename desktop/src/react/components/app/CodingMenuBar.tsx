import { useCallback, useMemo, useState } from 'react';
import { applyFolder, promptAndCreateSshStudioWorkspace } from '../../stores/desk-actions';
import { openSettingsModal } from '../../stores/settings-modal-actions';
import { ContextMenu, type ContextMenuItem } from '../../ui';

interface CodingMenuBarProps {
  onToggleSidebar: () => void;
  onToggleJian: () => void;
}

interface MenuState {
  id: string;
  items: ContextMenuItem[];
  position: { x: number; y: number };
}

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function dispatchCodingCommand(action: string, command?: string) {
  window.dispatchEvent(new CustomEvent('hana:coding-command', {
    detail: command ? { action, command } : { action },
  }));
}

function editCommand(command: string) {
  try {
    document.execCommand(command);
  } catch {
    // Browser support varies; failed edit commands should not break the menu.
  }
}

export function CodingMenuBar({ onToggleSidebar, onToggleJian }: CodingMenuBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openFolder = useCallback(async () => {
    const folder = await window.platform?.selectFolder?.();
    if (folder) await applyFolder(folder);
  }, []);

  const menus = useMemo(() => [
    {
      id: 'file',
      label: t('titlebar.menu.file'),
      items: [
        { label: t('titlebar.menu.openFolder'), action: () => { void openFolder(); } },
        { label: t('titlebar.menu.connectSshWorkspace'), action: () => { void promptAndCreateSshStudioWorkspace(); } },
        {
          label: t('titlebar.menu.newProjectFromTemplate'),
          children: [
            { label: t('titlebar.menu.templateBasicWeb'), action: () => dispatchCodingCommand('project.createTemplate', 'basic-web') },
            { label: t('titlebar.menu.templateDesktopApp'), action: () => dispatchCodingCommand('project.createTemplate', 'desktop-app') },
            { label: t('titlebar.menu.templateAiApp'), action: () => dispatchCodingCommand('project.createTemplate', 'ai-app') },
          ],
        },
        { divider: true },
        { label: t('titlebar.menu.settings'), action: () => openSettingsModal('general') },
      ],
    },
    {
      id: 'edit',
      label: t('titlebar.menu.edit'),
      items: [
        { label: t('titlebar.menu.undo'), action: () => editCommand('undo') },
        { label: t('titlebar.menu.redo'), action: () => editCommand('redo') },
        { divider: true },
        { label: t('titlebar.menu.cut'), action: () => editCommand('cut') },
        { label: t('titlebar.menu.copy'), action: () => editCommand('copy') },
        { label: t('titlebar.menu.paste'), action: () => editCommand('paste') },
      ],
    },
    {
      id: 'selection',
      label: t('titlebar.menu.selection'),
      items: [
        { label: t('titlebar.menu.selectAll'), action: () => editCommand('selectAll') },
      ],
    },
    {
      id: 'view',
      label: t('titlebar.menu.view'),
      items: [
        { label: t('titlebar.menu.explorer'), action: () => dispatchCodingCommand('view.explorer') },
        { label: t('titlebar.menu.search'), action: () => dispatchCodingCommand('view.search') },
        { label: t('titlebar.menu.sourceControl'), action: () => dispatchCodingCommand('view.sourceControl') },
        { label: t('titlebar.menu.extensions'), action: () => dispatchCodingCommand('view.extensions') },
        { divider: true },
        { label: t('titlebar.menu.toggleSidebar'), action: onToggleSidebar },
        { label: t('titlebar.menu.toggleAssistant'), action: onToggleJian },
      ],
    },
    {
      id: 'go',
      label: t('titlebar.menu.go'),
      items: [
        { label: t('titlebar.menu.goExplorer'), action: () => dispatchCodingCommand('view.explorer') },
        { label: t('titlebar.menu.goSearch'), action: () => dispatchCodingCommand('view.search') },
        { label: t('titlebar.menu.goExtensions'), action: () => dispatchCodingCommand('view.extensions') },
      ],
    },
    {
      id: 'run',
      label: t('titlebar.menu.run'),
      items: [
        { label: t('titlebar.menu.startTerminal'), action: () => dispatchCodingCommand('terminal.start') },
        { label: t('titlebar.menu.gitStatus'), action: () => dispatchCodingCommand('terminal.run', 'git status --short --branch') },
        { label: t('titlebar.menu.npmTest'), action: () => dispatchCodingCommand('terminal.run', 'npm test') },
        { label: t('titlebar.menu.npmBuild'), action: () => dispatchCodingCommand('terminal.run', 'npm run build') },
      ],
    },
    {
      id: 'terminal',
      label: t('titlebar.menu.terminal'),
      items: [
        { label: t('titlebar.menu.newTerminal'), action: () => dispatchCodingCommand('terminal.start') },
        { label: t('titlebar.menu.closeTerminal'), action: () => dispatchCodingCommand('terminal.close') },
      ],
    },
    {
      id: 'help',
      label: t('titlebar.menu.help'),
      items: [
        { label: t('titlebar.menu.about'), action: () => openSettingsModal('about') },
      ],
    },
  ], [onToggleJian, onToggleSidebar, openFolder]);

  const openMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, id: string, items: ContextMenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      id,
      items,
      position: { x: rect.left, y: rect.bottom + 4 },
    });
  }, []);

  return (
    <nav className="tb-menu-bar" aria-label={t('titlebar.menu.label')}>
      {menus.map(item => (
        <button
          key={item.id}
          type="button"
          className={`tb-menu-button${menu?.id === item.id ? ' active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => openMenu(event, item.id, item.items)}
          onMouseEnter={(event) => {
            if (menu) openMenu(event, item.id, item.items);
          }}
        >
          {item.label}
        </button>
      ))}
      {menu && (
        <ContextMenu
          items={menu.items}
          position={menu.position}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}
