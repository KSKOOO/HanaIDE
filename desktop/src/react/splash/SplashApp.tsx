/**
 * SplashApp.tsx — 启动画面
 *
 * 头像 + 旋转文字轮播 + 樱花图标。
 * 不依赖 server（splash 显示时 server 还没启动），数据来源全部是 IPC + 本地文件。
 */

import { useState, useEffect, useRef } from 'react';
import { getYuanVisual } from '../../../../shared/yuan-visuals.ts';

const DEFAULT_NAME = 'Hanako';
const DEFAULT_VISUAL = getYuanVisual('hanako');

export function SplashApp() {
  const [avatarSrc, setAvatarSrc] = useState(`assets/${DEFAULT_VISUAL.avatar}`);
  const [text, setText] = useState('');
  const [switching, setSwitching] = useState(false);
  const [symbol, setSymbol] = useState(DEFAULT_VISUAL.symbol);
  const [accentColor, setAccentColor] = useState(DEFAULT_VISUAL.accent);
  const linesRef = useRef<string[]>([]);
  const indexRef = useRef(0);

  // 复用同一个窗口承载两种模式：默认启动动画 / 更新安装中提示。
  // 安装模式固定文案、关闭轮播，避免用户误以为还在"启动中"。
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const mode = params.get('mode') || '';
  const installVersion = params.get('version') || '';

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    (async () => {
      let locale = 'zh';
      let name = DEFAULT_NAME;
      let yuan = 'hanako';

      try {
        const hana = window.hana;
        const [avatarPath, splashInfo] = await Promise.all([
          hana?.getAvatarPath?.('agent'),
          hana?.getSplashInfo?.(),
        ]);

        if (avatarPath && window.platform?.getFileUrl) {
          const base = window.platform.getFileUrl(avatarPath);
          if (base) {
            setAvatarSrc(`${base}?t=${Date.now()}`);
          } else if (splashInfo?.yuan) {
            setAvatarSrc(`assets/${getYuanVisual(splashInfo.yuan).avatar}`);
          }
        } else if (splashInfo?.yuan) {
          setAvatarSrc(`assets/${getYuanVisual(splashInfo.yuan).avatar}`);
        }

        if (splashInfo?.agentName) name = splashInfo.agentName;
        if (splashInfo?.locale?.startsWith('en')) locale = 'en';
        if (splashInfo?.yuan) yuan = splashInfo.yuan;

        const visual = getYuanVisual(yuan);
        setSymbol(visual.symbol);
        setAccentColor(visual.accent);
      } catch {}

      // 安装模式：固定文案，不进轮播
      if (mode === 'installing') {
        const data = await fetch(`./locales/${locale}.json`).then(r => r.json()).catch(() => null);
        const tpl = data?.splash?.installing
          || (locale === 'en'
            ? '{name} is updating to v{version}, please wait…'
            : '{name} 正在更新到 v{version}，请稍候…');
        setText(tpl.replaceAll('{name}', name).replaceAll('{version}', installVersion || ''));
        return;
      }

      // 加载语言包
      let lines: string[];
      try {
        const res = await fetch(`./locales/${locale}.json`);
        const data = await res.json();
        const yuanLines = data.yuan?.splash?.[yuan];
        const defaultLines = data.splash?.lines;
        const raw = Array.isArray(yuanLines) ? yuanLines : defaultLines;
        lines = raw ? raw.map((l: string) => l.replaceAll('{name}', name)) : [];
      } catch {
        lines = [];
      }

      if (!lines.length) {
        lines = [
          `${name} remembers the evening light`,
          'Some words sprouted in her memory',
          'She found your silhouette in memories',
        ];
      }

      // 打乱顺序
      lines.sort(() => Math.random() - 0.5);
      linesRef.current = lines;
      indexRef.current = 0;
      setText(lines[0]);

      // 轮播
      timer = setInterval(() => {
        indexRef.current = (indexRef.current + 1) % linesRef.current.length;
        setSwitching(true);
        setTimeout(() => {
          setText(linesRef.current[indexRef.current]);
          setSwitching(false);
        }, 400);
      }, 3000);
    })();

    return () => { if (timer) clearInterval(timer); };
  }, [mode, installVersion]);

  return (
    <div className="splash-container">
      <img
        className="splash-avatar"
        src={avatarSrc}
        alt=""
        draggable={false}
      />
      <div className="splash-text-row">
        <p className={`splash-text${switching ? ' switching' : ''}`}>{text}</p>
        <span className="splash-sakura" style={{ color: accentColor }}>{symbol}</span>
      </div>
    </div>
  );
}
