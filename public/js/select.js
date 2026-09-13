/**
 * 네이티브 <select> 를 테마에 맞는 드롭다운으로 감쌉니다.
 *
 * 원래 select 는 지우지 않고 화면에서만 숨깁니다. 값의 주인은 그대로 select 이고,
 * 고를 때마다 change 이벤트를 다시 쏘기 때문에 기존 코드는 손댈 필요가 없습니다.
 */

const esc = (s = '') =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let openOne = null;

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

  /** 아래로 펼치면 잘리는 자리에서는 위로 펼칩니다. */
  function place() {
    list.classList.remove('is-up');
    const holder = list.closest('.sheet-body') || document.body;
    const box = list.getBoundingClientRect();
    const limit = holder === document.body
      ? { bottom: window.innerHeight }
      : holder.getBoundingClientRect();
    if (box.bottom > limit.bottom - 8) list.classList.add('is-up');
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
    place();
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
