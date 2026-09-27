/** 화면 코드가 같이 쓰는 작은 도구. */

export const $ = (id) => document.getElementById(id);

/** id 로 찾은 요소에 이벤트를 겁니다. */
export const on = (id, type, fn) => $(id).addEventListener(type, fn);

/** 화면에 끼워 넣을 글을 HTML 로 해석되지 않게 바꿉니다. */
export const esc = (t = '') =>
  String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 브라우저 저장소. 사생활 보호 모드처럼 막혀 있어도 앱은 그대로 돕니다. */
export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 저장 못 해도 괜찮습니다 */ }
  }
};

/** 여러 요소를 한 번에 숨기거나 보입니다. */
export function setHidden(ids, hidden) {
  for (const id of ids) $(id).hidden = hidden;
}
