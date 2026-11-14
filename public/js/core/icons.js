/** 버튼과 메뉴에 쓰는 Lucide 선 아이콘. */
const paths = {
  'x': '<path d="M18 6 6 18M6 6l12 12"/>',
  'menu': '<path d="M4 12h16M4 6h16M4 18h16"/>',
  'dices': '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3L16.5 2.58a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 14h.01M10 18h.01M15 6h.01M18 9h.01"/>',
  'pen-line': '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/>',
  'list': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  'brush': '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 0 1 4.03 4.03l-8.06 8.08M7.07 14.94a3 3 0 0 0-4.24 0c-1.17 1.17-.75 3.25-2 4.5 2 2 5.5 2 7.5 0a3 3 0 0 0-1.26-4.5Z"/>',
  'pin': '<path d="M16 9V4l1-1H7l1 1v5l-3 3v2h14v-2l-3-3ZM12 14v8"/>',
  'ellipsis': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevrons-right': '<path d="m6 17 5-5-5-5m7 10 5-5-5-5"/>',
  'rotate-cw': '<path d="M21 7v5h-5"/><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8M21 12a9 9 0 0 1-15.5 6.4"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7m-7 7h14"/>',
  'corner-down-right': '<path d="m15 10 5 5-5 5M4 4v7a4 4 0 0 0 4 4h12"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
};

export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}
