/** 개발자 설정의 테마·표기법을 화면에 적용합니다. */
import * as ui from '../ui.js';
import { $ } from '../core/dom.js';

/** 패널·강조색에서 보조 색을 만들어 냅니다. */
function shade(hex, delta) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, v + delta)).toString(16).padStart(2, '0'));
  return `#${parts.join('')}`;
}

/**
 * 파비콘을 테마 색으로 다시 그립니다. 파일 없이 SVG 를 그대로 심기 때문에
 * 오프라인에서도 뜨고, 강조색을 바꾸면 탭 아이콘도 따라 바뀝니다.
 */
function paintFavicon({ bg = '#15111a', accent = '#d9b168' } = {}) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
    '<path d="M7 5.5h18a4.5 4.5 0 0 1 4.5 4.5v8a4.5 4.5 0 0 1-4.5 4.5H14.5L8 28v-5.5H7A4.5 4.5 0 0 1 2.5 18v-8A4.5 4.5 0 0 1 7 5.5z"' +
    ` fill="${accent}"/>` +
    [10, 16, 22].map((cx) => `<circle cx="${cx}" cy="14" r="2.1" fill="${bg}"/>`).join('') +
    '</svg>';
  $('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function applyTheme(dev) {
  if (!dev) return;
  ui.setMarkup(dev.markup || {});
  const t = dev.theme || {};
  const root = document.documentElement.style;
  const map = {
    '--bg': t.bg, '--panel': t.panel, '--line': t.line,
    '--text': t.text, '--muted': t.muted, '--brass': t.accent,
    '--sans': t.fontSans, '--serif': t.fontSerif
  };
  for (const [k, v] of Object.entries(map)) if (v) root.setProperty(k, v);
  if (t.fontSize) root.setProperty('--font-size', `${t.fontSize}px`);
  if (t.panel) root.setProperty('--panel-2', shade(t.panel, 8));
  if (t.accent) {
    root.setProperty('--brass-soft', shade(t.accent, -32));
    root.setProperty('--scroll-thumb-hover', shade(t.accent, -48));
  }
  if (t.line) root.setProperty('--scroll-thumb', shade(t.line, 14));
  paintFavicon(t);
}
