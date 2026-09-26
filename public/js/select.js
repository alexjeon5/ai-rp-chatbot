/**
 * 네이티브 <select> 를 테마에 맞는 드롭다운으로 감쌉니다.
 *
 * 원래 select 는 지우지 않고 화면에서만 숨깁니다. 값의 주인은 그대로 select 이고,
 * 고를 때마다 change 이벤트를 다시 쏘기 때문에 기존 코드는 손댈 필요가 없습니다.
 */

const esc = (s = '') =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let openOne = null;

/**
 * 펼친 목록이 잘리지 않게 자리를 잡습니다. 목록은 글자 길이만큼 넓어지므로(CSS 의 width: max-content),
 * 아래가 모자라면 위로, 오른쪽이 모자라면 버튼 오른쪽 끝에 맞춰 펼칩니다.
 * 설정 시트처럼 안에서 스크롤되는 곳이면 그 시트가 경계이고, 아니면 화면이 경계입니다.
 */
function placeList(list) {
  list.classList.remove('is-up', 'is-end');
  const holder = list.closest('.sheet-body') || document.body;
  const box = list.getBoundingClientRect();
  const limit = holder === document.body
    ? { bottom: window.innerHeight, right: window.innerWidth }
    : holder.getBoundingClientRect();
  if (box.bottom > limit.bottom - 8) list.classList.add('is-up');
  if (box.right > limit.right - 8) list.classList.add('is-end');
}

function enhance(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  // 입력창 아래 줄은 작은 글씨, 대화 상단은 옆 버튼과 같은 크기로 맞춥니다.
  const compact = select.classList.contains('quick-select');
  const head = select.classList.contains('head-select');

  const wrap = document.createElement('span');
  wrap.className = `sel${compact ? ' sel--sm' : ''}${head ? ' sel--head' : ''}`;
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel-btn';
  btn.innerHTML = '<span class="sel-label"></span><span class="sel-chev" aria-hidden="true">⌄</span>';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (select.title) btn.title = select.title;

  const list = document.createElement('div');
  list.className = 'sel-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  wrap.append(btn, list);

  let index = -1;

  const options = () => [...select.options];
  const current = () => select.options[select.selectedIndex];

  function refresh() {
    const opt = current();
    btn.querySelector('.sel-label').textContent = opt ? opt.textContent.trim() : '';
    // 항목 수로 잠그면 안 됩니다. innerHTML 로 항목을 갈아끼운 직후에는
    // MutationObserver 가 아직 안 돌아서, 비어 있던 것으로 오해할 수 있습니다.
    btn.disabled = select.disabled;
    // 바깥 코드가 select 를 hidden 으로 감추면 감싼 것도 같이 감춥니다.
    if (wrap.hidden !== select.hidden) wrap.hidden = select.hidden;
  }

  function paint() {
    const opts = options();
    if (!opts.length) {
      list.innerHTML = '<div class="sel-empty">선택할 항목이 없습니다.</div>';
      return;
    }
    list.innerHTML = opts
      .map((o, i) => {
        const on = i === (index < 0 ? select.selectedIndex : index);
        return `<button type="button" role="option" data-i="${i}"
          class="sel-item${on ? ' is-active' : ''}${o.disabled ? ' is-off' : ''}"
          ${o.disabled ? 'disabled' : ''}>${esc(o.textContent.trim())}</button>`;
      })
      .join('');
  }


  function open() {
    if (btn.disabled) return;
    openOne?.();
    openOne = close;
    index = select.selectedIndex;
    paint();
    list.hidden = false;
    wrap.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    placeList(list);
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }

  function close() {
    list.hidden = true;
    index = -1;
    wrap.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    if (openOne === close) openOne = null;
  }

  function choose(i) {
    const opt = select.options[i];
    if (!opt || opt.disabled) return;
    select.selectedIndex = i;
    refresh();
    close();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function move(step) {
    const opts = options();
    if (!opts.length) return;
    let next = index < 0 ? select.selectedIndex : index;
    for (let n = 0; n < opts.length; n++) {
      next = (next + step + opts.length) % opts.length;
      if (!opts[next].disabled) break;
    }
    index = next;
    paint();
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }

  btn.addEventListener('click', () => (list.hidden ? open() : close()));

  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); list.hidden ? open() : move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list.hidden ? open() : move(-1); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); }
    else if ((e.key === 'Enter' || e.key === ' ') && !list.hidden) { e.preventDefault(); choose(index); }
  });

  // blur 보다 먼저 잡아야 클릭이 먹습니다.
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-i]');
    if (!item) return;
    e.preventDefault();
    choose(Number(item.dataset.i));
  });

  btn.addEventListener('blur', () => setTimeout(close, 120));

  // 바깥 코드가 select.value 나 option 목록을 갈아끼워도 버튼 글자가 따라가게 합니다.
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', refresh);

  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); refresh(); }
  });

  refresh();
}

/** 문서 안의 모든 select 를 바꿉니다. */
export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('select:not([data-enhanced])')) enhance(select);
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.sel')) openOne?.();
});

/** 입력한 글자와 겹치는 부분을 강조해 보여 줍니다. */
function markHit(text, query) {
  if (!query) return esc(text);
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return esc(text);
  return esc(text.slice(0, at)) +
    `<span class="hit">${esc(text.slice(at, at + query.length))}</span>` +
    esc(text.slice(at + query.length));
}

/**
 * 글자를 쳐서 거르거나 목록에서 고르는 입력칸. 브라우저 기본 datalist 는 테마를 따라오지 않아 직접 그립니다.
 * 목록에 없는 이름을 그대로 적어도 됩니다 — 값의 주인은 여전히 input 입니다.
 *
 * @param {HTMLInputElement} input
 * @param {object} o
 * @param {() => string[]} o.items           지금 고를 수 있는 항목
 * @param {(value: string) => void} [o.onPick] 목록에서 골랐을 때
 * @param {string} [o.emptyText]              항목이 하나도 없을 때 안내
 * @param {(q: string) => string} [o.noMatchText] 거른 결과가 없을 때 안내. q 는 이미 escape 된 값
 * @returns {{ open: () => void, close: () => void }}
 */
export function makeCombo(input, { items, onPick = () => {}, emptyText = '목록이 없습니다.', noMatchText } = {}) {
  let wrap = input.closest('.combo');
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
  }
  let list = wrap.querySelector('.combo-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'combo-list';
    list.id = `${input.id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.appendChild(list);
  }
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let index = -1;

  /** 적힌 값이 목록의 한 항목과 똑같으면(고른 뒤 다시 연 경우) 거르지 않고 전부 보여 줍니다. */
  function query() {
    const q = input.value.trim();
    return items().includes(q) ? '' : q;
  }

  function filtered() {
    const q = query().toLowerCase();
    return q ? items().filter((v) => v.toLowerCase().includes(q)) : items();
  }

  function open() {
    const all = items();
    const shown = filtered();
    const q = query();
    if (!all.length) {
      list.innerHTML = `<div class="combo-empty">${esc(emptyText)}</div>`;
    } else if (!shown.length) {
      const text = noMatchText ? noMatchText(esc(q)) : `'${esc(q)}' 와 일치하는 항목이 없습니다.`;
      list.innerHTML = `<div class="combo-empty">${text}</div>`;
    } else {
      const current = input.value.trim();
      const head = `<div class="combo-head">${shown.length}개${q ? ` · '${esc(q)}' 검색` : ''}</div>`;
      list.innerHTML = head + shown
        .map((v, i) => `<button type="button" role="option" data-value="${esc(v)}"
          class="combo-item${i === index || (index < 0 && v === current) ? ' is-active' : ''}">${markHit(v, q)}</button>`)
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    placeList(list);
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }

  function close() {
    list.hidden = true;
    index = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function move(step) {
    const shown = filtered();
    if (!shown.length) return;
    index = (index + step + shown.length) % shown.length;
    open();
  }

  function pick(value) {
    input.value = value;
    close();
    onPick(value);
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { index = -1; open(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); }
    else if (e.key === 'Enter') {
      const shown = filtered();
      if (!list.hidden && index >= 0 && shown[index]) {
        e.preventDefault();
        pick(shown[index]);
      } else {
        close();
      }
    }
  });

  // blur 보다 먼저 잡아야 클릭이 먹습니다.
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-value]');
    if (!item) return;
    e.preventDefault();
    pick(item.dataset.value);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  return { open, close };
}
