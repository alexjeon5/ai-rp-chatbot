/**
 * 화면 동작 기록 시나리오. 브라우저 안에서 앱을 조작하고, 단계마다
 * 서버로 나간 요청·알림·물음창·화면 상태를 모아 ui-server 로 보냅니다.
 * 리팩터링 전후 결과 파일이 같으면 화면 동작이 같은 것입니다.
 */
const RESULT = 'http://127.0.0.1:5189/result/';

export async function run(name) {
  const $ = (id) => document.getElementById(id);
  const q = (sel, root = document) => root.querySelector(sel);
  // 가려진 창에서는 타이머가 크게 늦춰지므로 ui-server 에 쉬어 달라고 요청해서 기다립니다.
  const realFetchForSleep = window.fetch.bind(window);
  const sleep = (ms) => realFetchForSleep(`http://127.0.0.1:5189/sleep/${ms}`).then((r) => r.text());
  const out = [];

  /* ---------- 고정: 시각, 물음창, 클립보드, 대화상자 close ---------- */
  let clock = Date.UTC(2026, 8, 27, 12, 0, 0);
  Date.now = () => (clock += 1);
  let answers = [];
  let asked = [];
  window.prompt = (text, value) => { asked.push(`prompt: ${text} [${value ?? ''}]`); return answers.length ? answers.shift() : null; };
  window.confirm = (text) => { asked.push(`confirm: ${text}`); return answers.length ? answers.shift() : true; };
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { copied.push(t); } } });
  // 가려진 창에서는 대화상자의 close 이벤트가 오지 않습니다. close() 가 곧바로 알리게 하고, 브라우저가 보내는 것은 막습니다.
  const nativeClose = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close = function (value) {
    const was = this.open;
    nativeClose.call(this, value);
    if (was) this.dispatchEvent(new Event('close'));
  };
  window.addEventListener('close', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);

  /* ---------- 요청 기록 ---------- */
  const calls = [];
  let inflight = 0;
  const realFetch = window.fetch;
  window.fetch = async (url, opts = {}) => {
    let body = opts.body;
    try { body = body ? JSON.parse(body) : undefined; } catch { /* 글 그대로 */ }
    calls.push({ method: opts.method || 'GET', url: String(url), body });
    inflight += 1;
    try {
      const res = await realFetch(url, opts);
      res.clone().text().catch(() => '').finally(() => { inflight -= 1; });
      return res;
    } catch (e) {
      inflight -= 1;
      throw e;
    }
  };
  let toasts = [];
  new MutationObserver(() => { const t = $('toast').textContent; if (t && !$('toast').hidden) toasts.push(t); })
    .observe($('toast'), { childList: true, characterData: true, subtree: true, attributes: true });

  /* ---------- 화면 상태 ---------- */
  const fields = (root) => [...root.querySelectorAll('input, select, textarea')].map((el) =>
    `${el.id || el.name || el.className}${el.type === 'checkbox' || el.type === 'radio' ? `=${el.checked}` : `=${JSON.stringify(el.value)}`}` +
    `${el.disabled ? ' disabled' : ''}${el.closest('[hidden]') ? ' hidden' : ''}${el.readOnly ? ' ro' : ''}`);
  const vis = (id) => { const el = $(id); return el ? `${el.hidden || el.closest('[hidden]') ? 'hidden' : 'shown'}${el.disabled ? ',disabled' : ''}` : 'none'; };
  const clean = (html = '') => html.replace(/\s+/g, ' ').trim();
  const snap = () => ({
    rail: {
      modes: [...document.querySelectorAll('.mode-tab')].map((t) => `${t.dataset.mode}:${t.className}`),
      adult: $('btn-toggle-adult').textContent,
      buttons: ['btn-new-chat', 'btn-new-assistant', 'btn-toggle-adult', 'character-group'].map((id) => `${id}:${vis(id)}`),
      chats: clean($('chat-list').innerHTML),
      tabs: clean($('char-tabs').innerHTML),
      characters: clean($('character-list').innerHTML),
      rowMenu: $('row-menu').hidden ? null : clean($('row-menu').innerHTML)
    },
    head: {
      title: $('chat-title').textContent,
      sub: $('chat-sub').textContent,
      buttons: ['chat-preset', 'chat-persona', 'btn-cast', 'btn-memory', 'btn-chat-menu', 'chat-menu', 'btn-save-character', 'btn-rename', 'btn-archive-chat', 'btn-delete-chat'].map((id) => `${id}:${vis(id)}`),
      archive: `${$('btn-archive-chat').textContent}|${$('btn-archive-chat').title}`,
      preset: `${$('chat-preset').value}|${clean($('chat-preset').innerHTML)}`,
      persona: `${$('chat-persona').value}|${clean($('chat-persona').innerHTML)}`,
      selects: [...document.querySelectorAll('.stage-head .sel-label')].map((l) => l.textContent)
    },
    messages: clean($('messages').innerHTML),
    composer: {
      state: ['composer', 'stream-status', 'btn-send', 'btn-regen', 'btn-continue', 'btn-impersonate', 'btn-thinking', 'btn-websearch', 'ctx-gauge'].map((id) => `${id}:${vis(id)}`),
      input: `${$('input').value}|${$('input').placeholder}|${$('input').readOnly}`,
      stream: $('stream-label').textContent,
      toggles: ['btn-thinking', 'btn-websearch'].map((id) => `${$(id).getAttribute('aria-pressed')}|${$(id).title}`),
      provider: `${$('quick-provider').value}|${clean($('quick-provider').innerHTML)}`,
      model: `${$('active-model').textContent}|${$('active-model').className}|${$('active-model').title}`,
      gauge: `${$('ctx-label').textContent}|${$('ctx-gauge').className}|${$('ctx-gauge').title}|` +
        [...$('ctx-gauge').querySelectorAll('[class^=seg]')].map((s) => s.style.width).join(',')
    },
    dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => ({
      id: d.id,
      fields: fields(d),
      text: clean(d.innerText).slice(0, 4000)
    })),
    theme: document.documentElement.getAttribute('style'),
    favicon: $('favicon').href.length,
    storage: Object.keys(localStorage).sort().map((k) => `${k}=${localStorage.getItem(k)}`)
  });

  // 아직 받고 있거나 쓰고 있다는 표시. 이런 게 보이면 더 기다립니다.
  const LOADING = /불러오는 중|받는 중|연결하는 중|쓰는 중|요약하는 중|확인하는 중|장면을 읽는 중|그리는 중/;
  const busyNow = () => inflight > 0 || document.querySelector('.turn-image.is-pending') ||
    !$('stream-status').hidden || LOADING.test(document.body.innerText);

  /** 요청이 끝나고 화면이 멈출 때까지 기다립니다. */
  async function settle(max = 15000) {
    let last = '';
    let stable = 0;
    for (let t = 0; t < max; t += 120) {
      await sleep(120);
      const now = JSON.stringify(snap());
      stable = !busyNow() && now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 3) return;
    }
  }

  async function step(title, fn) {
    toasts = [];
    asked = [];
    const from = calls.length;
    try {
      await fn();
    } catch (e) {
      asked.push(`시나리오 오류: ${e.message}`);
    }
    await settle();
    out.push({ step: title, calls: calls.slice(from), toasts: [...new Set(toasts)], asked, dom: snap() });
  }

  const click = (el) => { if (!el) throw new Error('누를 것이 없습니다'); el.click(); };
  const type = (el, text) => { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const choose = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const lastTurn = () => [...document.querySelectorAll('#thread .turn')].pop();
  const tool = (act, turn = lastTurn()) => q(`[data-act="${act}"]`, turn);
  const context = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }));
  const focus = (el) => el.dispatchEvent(new FocusEvent('focus'));

  /* ================= 시나리오 ================= */

  await step('처음 화면', async () => {});
  await step('어시스턴트 탭', () => click(q('.mode-tab[data-mode="assistant"]')));
  await step('롤플레이 탭', () => click(q('.mode-tab[data-mode="rp"]')));
  await step('기본 캐릭터 탭', () => click(q('#char-tabs [data-tab="builtin"]')));
  await step('캐릭터 눌러 새 대화', () => click(q('#character-list [data-character]')));
  await step('모드 창: 성인 탭', () => click(q('#nc-tabs [data-audience="adult"]')));
  await step('모드 창: 일반 탭', () => click(q('#nc-tabs [data-audience="general"]')));
  await step('모드 고르기', () => click(q('#nc-list [data-preset="default"]')));
  await step('메시지 보내기', () => { type($('input'), '안녕, 옥상 가자'); key($('input'), 'Enter'); });
  await step('다시 받기', () => click($('btn-regen')));
  await step('이전 버전', () => click(tool('swipe-prev')));
  await step('다음 버전', () => click(tool('swipe-next')));
  await step('이어쓰기', () => click($('btn-continue')));
  await step('메시지 고치기', async () => {
    click(tool('edit'));
    const ta = q('.turn-edit');
    ta.value = '고친 답변입니다.';
    ta.dispatchEvent(new FocusEvent('blur'));
  });
  await step('복사', () => click(tool('copy')));
  await step('대신 쓰기', () => click($('btn-impersonate')));
  await step('입력 비우고 보내기', () => { type($('input'), '두 번째 메시지'); click($('btn-send')); });
  await step('대화 모드 바꾸기(메신저)', () => choose($('chat-preset'), 'messenger'));
  await step('대화 모드 되돌리기(드롭다운 조작)', async () => {
    const wrap = $('chat-preset').closest('.sel');
    click(q('.sel-btn', wrap));
    await sleep(50);
    q('.sel-list [data-i="0"]', wrap).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await step('페르소나 바꾸기', () => choose($('chat-persona'), [...$('chat-persona').options].find((o) => o.text.includes('도윤')).value));
  await step('등장인물 창', () => click($('btn-cast')));
  await step('등장인물 고르고 저장', () => {
    const box = q('#cast-list input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    $('dlg-cast').close('save');
  });
  await step('기억 창', () => click($('btn-memory')));
  await step('기억 항목 추가·고정', () => {
    type($('f-new'), '직접 적은 사실');
    click($('f-add'));
    click(q('#f-list [data-pin]'));
    type($('m-note'), '{{char}}는 조금 쌀쌀맞게');
  });
  await step('기억 저장', () => $('dlg-memory').close('save'));
  await step('기억: 지금 확인하기', async () => { click($('btn-memory')); await settle(); click($('f-extract')); });
  await step('기억 창 닫기', () => $('dlg-memory').close('cancel'));
  await step('장면 그리기(검토 창)', () => click(tool('draw', [...document.querySelectorAll('#thread .turn.char')].pop())));
  await step('태그 고쳐 그리기', () => { $('tg-text').value = '1girl, adult, rooftop'; $('dlg-tags').close('draw'); });
  await step('그림 크게 보기', () => q('#messages a.img-open').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
  await step('크게 보기 닫기', () => click($('lb-close')));
  await step('그림: 태그·모델 고쳐 그리기 창', () => click(q('[data-act="img-edit"]')));
  await step('그림: 모델 바꿔 그리기', () => { choose($('tg-checkpoint'), 'b.safetensors'); $('dlg-tags').close('draw'); });
  await step('그림: 다시 그리기', () => click(q('[data-act="img-redraw"]')));
  await step('그림: 지우기', () => click(q('[data-act="img-del"]')));
  await step('⋯ 메뉴 열기', () => click($('btn-chat-menu')));
  await step('이름 바꾸기', () => { answers = ['옥상 대화']; click($('btn-rename')); });
  await step('두 번째 대화 만들기', async () => {
    click([...document.querySelectorAll('#character-list [data-character]')][1]);
    await settle();
    click(q('#nc-list [data-preset="novelist"]'));
  });
  await step('보관', () => { click($('btn-chat-menu')); click($('btn-archive-chat')); });
  await step('보관함 보기', () => click(q('[data-archive-view="on"]')));
  await step('보관한 대화 열기', () => click(q('#chat-list [data-chat]')));
  await step('우클릭 메뉴', () => context(q('#chat-list [data-chat]')));
  await step('우클릭: 보관 해제', () => click(q('#row-menu [data-act="unarchive"]')));
  await step('성인 숨기기', () => click($('btn-toggle-adult')));
  await step('성인 표시', () => click($('btn-toggle-adult')));
  await step('우클릭: 삭제', () => { context([...document.querySelectorAll('#chat-list [data-chat]')].pop()); click(q('#row-menu [data-act="delete"]')); });
  await step('엔진 빠른 전환', () => choose($('quick-provider'), 'openai'));
  await step('엔진 되돌리기', () => choose($('quick-provider'), 'lmstudio'));
  await step('어시스턴트 새 채팅', async () => { click(q('.mode-tab[data-mode="assistant"]')); click($('btn-new-assistant')); });
  await step('생각 켜기', () => click($('btn-thinking')));
  await step('어시스턴트에 묻기', () => { type($('input'), '생각테스트 질문'); key($('input'), 'Enter'); });
  await step('롤플레이로', () => click(q('.mode-tab[data-mode="rp"]')));

  /* 캐릭터 */
  await step('캐릭터 창(우클릭)', () => context(q('#character-list [data-character]')));
  await step('AI 로 채우기', () => { type($('c-brief'), '헌책방 주인'); click($('c-draft')); });
  await step('복사해서 내 캐릭터로', () => click($('c-copy')));
  await step('캐릭터 저장', () => $('dlg-character').close('save'));
  await step('내 캐릭터 탭', () => click(q('#char-tabs [data-tab="mine"]')));
  await step('내 캐릭터 지우기', async () => { context(q('#character-list [data-character]')); await settle(); click($('c-delete')); });
  await step('새 캐릭터: 이번만 쓰기', async () => {
    click($('btn-new-character'));
    type($('c-name'), '임시 인물');
    type($('c-greeting'), '{{char}}가 손을 흔든다.');
    click($('c-once'));
  });
  await step('이번만 쓰기: 모드 고르기', () => { $('nc-remember').checked = true; click(q('#nc-list [data-preset="default"]')); });
  await step('1회성 캐릭터 저장', () => { click($('btn-chat-menu')); click($('btn-save-character')); });

  /* 페르소나 */
  await step('페르소나 창', () => click($('btn-personas')));
  await step('랜덤 굴리기', () => click($('p-roll')));
  await step('칩 하나 다시 굴리기', () => click(q('#p-seeds [data-key="trait"]')));
  await step('문장 만들기', () => click($('p-write')));
  await step('특징 넣고 추가', () => { type($('p-trait-input'), '고양이, 커피'); key($('p-trait-input'), 'Enter'); click($('p-add')); });
  await step('페르소나 수정', () => { click([...document.querySelectorAll('#persona-list [data-edit]')].pop()); type($('p-age'), '30대'); choose($('p-gender'), 'custom'); type($('p-gender-custom'), '논바이너리'); click($('p-add')); });
  await step('페르소나 사용', () => click([...document.querySelectorAll('#persona-list [data-use]:not([disabled])')].pop()));
  await step('페르소나 지우기', () => click([...document.querySelectorAll('#persona-list [data-del]')].pop()));
  await step('페르소나 창 닫기', () => $('dlg-persona').close());

  /* 설정 */
  await step('설정 열기', () => click($('btn-settings')));
  for (const tab of ['engine', 'generation', 'mode', 'assistant', 'image', 'display', 'dev', 'backup']) {
    await step(`설정 탭: ${tab}`, () => click(q(`#s-tabs [data-tab="${tab}"]`)));
  }
  await step('설정: 엔진 바꿔 보기', () => { click(q('#s-tabs [data-tab="engine"]')); choose($('s-provider'), 'anthropic'); });
  await step('설정: 키 보기', () => click($('s-key-toggle')));
  await step('설정: LM Studio 모델 불러오기', async () => { choose($('s-provider'), 'lmstudio'); await settle(); click($('s-fetch-models')); });
  await step('설정: 모델 목록 거르기·고르기', async () => {
    type($('s-model'), 'mock');
    key($('s-model'), 'ArrowDown');
    key($('s-model'), 'Enter');
    focus($('s-model'));
  });
  await step('설정: 모드 새로 만들기', () => { click(q('#s-tabs [data-tab="mode"]')); answers = ['내 모드']; click($('s-preset-new')); });
  await step('설정: 원본 가져오기', () => { choose($('s-template-source'), 'narrator'); click($('s-reset-template')); });
  await step('설정: 모드 이름 바꾸기', () => { answers = ['내 연출 모드']; click($('s-preset-rename')); });
  await step('설정: 이미지 연결 확인', async () => { click(q('#s-tabs [data-tab="image"]')); await settle(); click($('i-check')); });
  await step('설정: 체크포인트 목록', () => { $('i-checkpoint').value = ''; focus($('i-checkpoint')); });
  await step('설정: 그리기 끄기', () => { $('i-enabled').checked = false; $('i-enabled').dispatchEvent(new Event('change')); });
  await step('설정: 강조색 바꾸기', () => { click(q('#s-tabs [data-tab="display"]')); $('d-accent').value = '#3366ff'; $('d-accent').dispatchEvent(new Event('input')); });
  await step('설정: 표기 끄기', () => { $('d-mk-quote').checked = false; $('d-mk-quote').dispatchEvent(new Event('change')); });
  await step('설정: 엔진 추가', () => {
    click(q('#s-tabs [data-tab="engine"]'));
    type($('d-p-label'), '내 엔진');
    type($('d-p-baseurl'), 'http://127.0.0.1:5181/v1');
    click($('d-p-add'));
  });
  await step('설정: 추가한 엔진 지우기', () => click(q('#d-provider-list [data-del-provider]')));
  await step('설정: 성인 클라우드 풀기 창', () => { click(q('#s-tabs [data-tab="dev"]')); click($('d-adult-cloud-unlock')); });
  await step('설정: 풀기 확인', () => { $('ac-agree').checked = true; $('ac-agree').dispatchEvent(new Event('change')); $('dlg-adult-cloud').close('unlock'); });
  await step('설정: 시스템 프롬프트 보기', () => click($('d-show-system')));
  await step('시스템 프롬프트 복사·닫기', () => { click($('sys-copy')); $('dlg-system').close(); });
  await step('설정: 통신 로그', () => click($('d-show-logs')));
  await step('통신 로그 닫기', () => $('dlg-logs').close());
  await step('설정 저장', () => $('dlg-settings').close('save'));
  await step('설정 다시 열기(맨 위)', () => click($('btn-settings')));
  await step('설정: 거부되는 주소로 저장', () => { click(q('#s-tabs [data-tab="engine"]')); type($('s-baseurl'), 'http://evil.example.com/v1'); $('dlg-settings').close('save'); });
  await step('설정 취소', () => $('dlg-settings').close('cancel'));
  await step('백업 불러오기', async () => {
    const backup = await (await realFetch('/api/export')).json();
    backup.characters.push({ id: 'imported1', name: '가져온 인물' });
    click($('btn-settings'));
    click(q('#s-tabs [data-tab="backup"]'));
    answers = [true, false];
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));
    $('s-import-file').files = dt.files;
    $('s-import-file').dispatchEvent(new Event('change'));
  });
  await step('대화 삭제(⋯ 메뉴)', async () => { click(q('#chat-list [data-chat]')); await settle(); click($('btn-chat-menu')); click($('btn-delete-chat')); });

  // 서버가 백업에 적는 내보낸 시각은 고정되지 않은 실제 시각입니다.
  const body = JSON.stringify(out, null, 2).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'DATE');
  await realFetch(RESULT + name, { method: 'POST', body });
  return `${out.length}단계, ${calls.length}요청, 복사 ${copied.length}`;
}
