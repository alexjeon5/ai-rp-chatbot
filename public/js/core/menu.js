/**
 * 메뉴 안의 키보드 처리. 방향키로 항목을 옮기고, Esc 는 닫고 원래 자리로 포커스를 돌려주며,
 * Tab 으로 메뉴를 벗어나면 닫습니다. close(refocus) 는 메뉴마다 다릅니다.
 */
export function menuKeys(menu, e, close) {
  if (menu.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    close(true);
  } else if (e.key === 'Tab') {
    close(false);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...menu.querySelectorAll('.sel-item:not([hidden])')];
    const at = items.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }
}
