// ABOUTME: 纯 DOM UI 工具：匿名头像（确定性图形 + 色相）、Toast、SVG 图标。

import type { AliasVisual } from './api';

export function avatarSvg(visual: AliasVisual | null, size = 38): string {
  const hue = visual?.hue ?? 20;
  const shape = visual?.shape ?? 0;
  const fill = `hsl(${hue} 32% 88%)`;
  const stroke = `hsl(${hue} 38% 42%)`;
  const common = `width="${size}" height="${size}" viewBox="0 0 40 40" fill="none"`;
  const shapes: string[] = [
    `<svg ${common}><rect x="8" y="8" width="24" height="24" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    `<svg ${common}><circle cx="20" cy="20" r="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    `<svg ${common}><path d="M20 7 L33 30 L7 30 Z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/></svg>`,
    `<svg ${common}><rect x="9" y="9" width="22" height="22" rx="11" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
    `<svg ${common}><path d="M20 7 L31 14 V26 L20 33 L9 26 V14 Z" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/></svg>`,
    `<svg ${common}><circle cx="20" cy="20" r="13" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-dasharray="5 4"/></svg>`,
  ];
  return shapes[shape % shapes.length];
}

// 图标统一约定：viewBox 24、默认 16×16、stroke-width 1.8；
// 尺寸由使用处 CSS 覆盖（如 .badge svg 13px、.chat-title svg 17px），不写死可自适应。
const ICON = { sw: '1.8', vb: '24' };
export const icons = {
  bell: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  lock: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  send: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  logout: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  key: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  rooms: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  refresh: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`,
  menu: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  globe: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="${ICON.sw}" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  // plus 需要视觉更重，线宽保留 2（内部加粗图标），其余统一 1.8
  plus: `<svg width="16" height="16" viewBox="0 0 ${ICON.vb} 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
};

export interface ToastHandle {
  destroy: () => void;
}

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', durationMs = 3200): ToastHandle {
  let stack = document.querySelector<HTMLDivElement>('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  const timer = setTimeout(() => el.remove(), durationMs);
  return { destroy: () => { clearTimeout(timer); el.remove(); } };
}

export function formatTime(unixMs: number): string {
  const date = new Date(unixMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 安全约定：el() 第三参数一律走 textContent，禁止注入 HTML，防 XSS。
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 仅用于本文件内置的、由开发者静态定义的可信 SVG（图标 / 确定性头像）。
// 严禁把任何服务端或用户字符串传入。
// 返回 SVG 元素本身；如需统一垂直对齐，由使用处 CSS 控制（svg 默认 inline，配合 vertical-align）。
export function svg(markup: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = markup;
  const first = wrap.firstElementChild;
  return (first instanceof SVGElement ? first : wrap) as HTMLElement;
}

// 统一的告警条（message 用 textContent 渲染）。
export function alertBox(kind: 'error' | 'info' | 'ok', message: string): HTMLElement {
  const box = el('div', `alert alert--${kind}`);
  box.textContent = message;
  return box;
}
