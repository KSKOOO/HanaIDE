import styles from './CodingMode.module.css';

const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]/g;

export function cleanTerminalOutput(output: unknown): string {
  return String(output || '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r(?!\n)/g, '\n');
}

export function appendTerminalOutput(current: string, next: unknown): string {
  return `${current}${cleanTerminalOutput(next)}`;
}

interface HanaTerminalViewProps {
  output: string;
  error?: string | null;
  emptyText: string;
  onFocusRequest?: () => void;
}

export function HanaTerminalView({ output, error, emptyText, onFocusRequest }: HanaTerminalViewProps) {
  const cleanedOutput = cleanTerminalOutput(output);
  const text = error ? `${cleanedOutput}\n${error}` : cleanedOutput || emptyText;
  const lines = text.split('\n');
  return (
    <div
      className={styles.terminalOutput}
      role="log"
      aria-live="polite"
      tabIndex={0}
      data-hana-terminal-view=""
      onClick={onFocusRequest}
    >
      {lines.map((line, index) => (
        <div key={`${index}-${line}`} className={styles.terminalLine}>
          {line || '\u00a0'}
        </div>
      ))}
    </div>
  );
}
