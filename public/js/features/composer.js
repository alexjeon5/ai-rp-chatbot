/** 입력창과 답변 받기: 보내기, 다시 받기·이어쓰기, 멈추기, 대신 쓰기, 컨텍스트 게이지. */
import { api, generate, impersonate } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';
import { stripForDisplay } from '../shared/scene-tags.js';

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

// 터치 화면의 가상 키보드에는 Shift+Enter 가 없어서, 그곳의 Enter 는 줄바꿈으로 두고 보내기는 버튼으로 합니다.
const touchOnly = matchMedia('(hover: none) and (pointer: coarse)');

export class Composer {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    const input = $('input');
    input.addEventListener('input', () => this.grow());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (touchOnly.matches && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.send();
      }
    });
    on('btn-send', 'click', () => this.send());
    on('btn-regen', 'click', () => this.run({ mode: 'regenerate' }));
    on('btn-continue', 'click', () => this.run({ mode: 'continue' }));
    on('btn-stop', 'click', () => this.stop());
    on('btn-impersonate', 'click', () => this.draftMyTurn());
  }

  /** 입력창 높이를 글에 맞춥니다. */
  grow() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  /* ---------------- 컨텍스트 게이지 ---------------- */

  /**
   * 입력창 아래 막대. 한도 가운데 설정·기억(회색) / 대화(금색) / 답변 여유(옅은 금색)가
   * 얼마씩 차지하는지 보여 줍니다. 대화가 한도를 넘으면 옛 메시지부터 잘려 나갑니다.
   */
  paintContext(info) {
    const gauge = $('ctx-gauge');
    this.state.context = info || null;
    if (!info || !this.state.chat) {
      gauge.hidden = true;
      return;
    }
    const { limit, system, history, extra = 0, reserve, kept, dropped, ratio, actual, over } = info;
    const pct = (n) => `${Math.min(100, (n / limit) * 100).toFixed(1)}%`;
    gauge.querySelector('.seg-sys').style.width = pct(system + extra);
    gauge.querySelector('.seg-hist').style.width = pct(history);
    gauge.querySelector('.seg-res').style.width = pct(reserve);
    const used = system + extra + history;
    $('ctx-label').textContent = `${fmtK(used)} / ${fmtK(limit)}` + (dropped ? ` · ${dropped}개 잘림` : '');
    const share = (used + reserve) / limit;
    gauge.classList.toggle('is-over', Boolean(over));
    gauge.classList.toggle('is-warn', !over && share > 0.9);
    gauge.title = [
      `컨텍스트 한도 ${limit.toLocaleString()} 토큰 (설정 → 엔진에서 바꿉니다)`,
      `· 설정·기억·노트 ${system + extra}`,
      `· 대화 ${history} — 최근 메시지 ${kept}개를 보냅니다${dropped ? `, 앞의 ${dropped}개는 잘렸습니다` : ''}`,
      `· 답변 여유 ${reserve} (응답 최대 길이)`,
      actual ? `마지막 요청의 실제 입력: ${actual.toLocaleString()} 토큰` : null,
      ratio && ratio !== 1 ? `어림 보정 ×${ratio} (엔진이 알려 준 실제 토큰 수로 맞춘 값)` : '토큰 수는 글자 수로 어림한 값입니다',
      over ? '한도를 넘습니다. 응답 최대 길이를 줄이거나 컨텍스트 길이를 늘려 주세요.' : null
    ].filter(Boolean).join('\n');
    gauge.hidden = false;
  }

  /** 대화가 바뀌었을 때(열기·삭제·수정·엔진 변경 등) 게이지를 새로 받습니다. */
  async refreshContext() {
    const chat = this.state.chat;
    if (!chat) return this.paintContext(null);
    const info = await api.context(chat.id).catch(() => null);
    if (this.state.chat === chat) this.paintContext(info);
  }

  /* ---------------- 보내기와 답변 ---------------- */

  /** 생성 하나의 상태. 멈출 때 끝나기를 기다릴 수 있게 done 을 둡니다. */
  startRun(chat) {
    let finish;
    const run = {
      chatId: chat.id,
      controller: new AbortController(),
      stopped: false,
      done: new Promise((resolve) => { finish = resolve; })
    };
    this.state.run = run;
    this.setStreaming(true);
    this.app.choices.clear();
    return {
      run,
      end: () => {
        if (this.state.run === run) this.state.run = null;
        this.setStreaming(false);
        finish();
      }
    };
  }

  /** 입력창의 글(과 붙인 그림)을 보냅니다. */
  send() {
    return this.submit($('input').value.trim(), { fromInput: true });
  }

  /**
   * 내 메시지를 저장하고 답변을 받습니다. fromInput 이면 입력창을 비우고 붙인 그림도 함께 보내며,
   * 실패하면 쓴 글을 되돌립니다. 아니면(판정 결과처럼 따로 만든 글) 입력창의 초안은 건드리지 않습니다.
   */
  async submit(content, { fromInput = false } = {}) {
    const { state, app } = this;
    const input = $('input');
    const attachments = fromInput ? app.attach.refs() : [];
    if ((!content && !attachments.length) || !state.chat || state.run) return;
    if (fromInput && app.attach.busy) return ui.toast('그림을 올리는 중입니다. 잠시만 기다려 주세요');

    if (fromInput) {
      input.value = '';
      input.style.height = 'auto';
    }

    let msg;
    try {
      msg = await api.addMessage(state.chat.id, { role: 'user', content, attachments });
    } catch (e) {
      if (fromInput) input.value = content;
      ui.toast(`보내지 못했습니다 — ${e.message}`);
      return;
    }
    if (fromInput) app.attach.release();
    state.chat.messages.push(msg);
    app.choices.clear();
    $('thread').appendChild(app.view.turnFor(state.chat, msg));
    if (state.chat.kind === 'assistant' && state.chat.title === '새 채팅') {
      // 서버와 같은 규칙으로 첫 질문을 제목으로 씁니다.
      state.chat.title = content.slice(0, 24) || '새 채팅';
      $('chat-title').textContent = state.chat.title;
    }
    if (state.chat.archivedAt) {
      // 서버가 보관을 풀었습니다. 화면도 대화 목록으로 돌아갑니다.
      delete state.chat.archivedAt;
      state.showArchived = false;
      app.view.paintArchiveButton();
      app.view.paintSub();
      ui.toast('보관한 대화를 목록으로 꺼냈습니다');
    }
    app.list.bump(state.chat, content || '(그림)');
    ui.scrollToEnd({ force: true });
    await this.run();
  }

  /**
   * 답변을 받습니다.
   *   new         마지막 턴 다음에 새 답변
   *   regenerate  마지막 답변의 다른 버전. 이전 버전은 ‹ › 로 남습니다
   *   continue    마지막 답변 끝에 이어쓰기
   */
  async run({ mode = 'new' } = {}) {
    const { state, app } = this;
    if (!state.chat || state.run) return;
    const chat = state.chat;
    const thread = $('thread');
    const isOpen = () => state.chat === chat;
    // 표식([[표정: …]])은 저장할 때 서버가 떼지만, 쓰는 동안에는 여기서 가려야 화면에 비치지 않습니다.
    const tagged = () => chat.kind !== 'assistant' && (chat.vn || chat.dice);
    const format = (t) => ui.formatText(tagged() ? stripForDisplay(t) : t, { plain: chat.kind === 'assistant', bubbles: state.isBubbles(chat) });

    const last = chat.messages[chat.messages.length - 1];
    // 마지막이 내 메시지면 재전송은 그냥 새로 받기(실패한 요청 다시 보내기)입니다.
    const target = mode !== 'new' && last?.role === 'assistant' ? last : null;
    if (mode === 'continue' && !target) return ui.toast('이어 쓸 답변이 없습니다');
    const targetEl = target && thread.querySelector(`[data-mid="${target.id}"]`);

    // 다른 버전: 지금 답변은 새 버전이 올 때까지 숨겨만 둡니다. 실패하면 되살립니다.
    // 이어쓰기: 지금 답변 칸에 그대로 이어서 그립니다.
    let holder;
    let textEl;
    let base = '';
    if (mode === 'continue') {
      holder = targetEl;
      textEl = targetEl.querySelector('.turn-text');
      base = target.content;
      for (const el of holder.querySelectorAll('.turn-tools, .swipe-nav')) el.hidden = true;
    } else {
      if (targetEl) targetEl.hidden = true;
      holder = app.view.turnFor(chat, { id: 'pending', role: 'assistant', content: '' });
      holder.querySelector('.turn-tools').remove();
      thread.appendChild(holder);
      textEl = holder.querySelector('.turn-text');
      // 첫 글자가 올 때까지 빈 칸으로 두면 멈춘 것처럼 보입니다.
      textEl.innerHTML = ui.TYPING;
    }
    ui.scrollToEnd({ force: true });

    const { run, end } = this.startRun(chat);
    let acc = '';
    let thought = '';
    let thoughtEl = null;
    let sourcesEl = null;
    let succeeded = false;
    let reload = false;

    try {
      const result = await generate(chat.id, {
        regenerate: mode === 'regenerate',
        resume: mode === 'continue',
        signal: run.controller.signal,
        onContext: (info) => { if (isOpen()) this.paintContext(info); },
        onDelta: (d) => {
          acc += d;
          textEl.innerHTML = format(base + acc);
          if (isOpen()) {
            ui.scrollToEnd();
            app.stage.live(base + acc);
          }
        },
        onThought: (t) => {
          thought += t;
          if (!thoughtEl) {
            thoughtEl = ui.thoughtEl('');
            holder.insertBefore(thoughtEl, textEl);
          }
          thoughtEl.querySelector('.thought-body').textContent = thought;
          if (isOpen()) ui.scrollToEnd();
        },
        onSources: (list) => {
          if (!sourcesEl) {
            sourcesEl = ui.sourcesEl(list);
            textEl.after(sourcesEl);
          } else {
            ui.fillSources(sourcesEl, list);
          }
          if (isOpen()) ui.scrollToEnd();
        }
      });
      if (result.message) {
        succeeded = true;
        const msg = result.message;
        const i = chat.messages.findIndex((m) => m.id === msg.id);
        if (i >= 0) chat.messages[i] = msg;
        else chat.messages.push(msg);
        // 서버가 정리한 본문(넘겨보기 번호 포함)으로 다시 그립니다.
        holder.replaceWith(app.view.turnFor(chat, msg));
        if (targetEl && targetEl !== holder) targetEl.remove();
        if (isOpen()) ui.scrollToEnd();
      } else if (!run.stopped && isOpen()) {
        ui.showError('응답이 비어 있습니다. 모델과 프롬프트 설정을 확인해 주세요.');
      }
    } catch (e) {
      // 연결을 끊어서 멈춘 경우엔 서버가 쓰던 답변을 저장했을 수 있어, 끝난 뒤 다시 읽습니다.
      if (e.name === 'AbortError' && run.stopped) reload = true;
      if (e.name !== 'AbortError' && isOpen()) {
        ui.showError(e.message);
        // 서버가 모델을 감췄을 수 있으니 설정을 다시 읽어 둡니다.
        if (/목록에서 감췄습니다/.test(e.message)) {
          state.settings = await api.settings().catch(() => state.settings);
          app.toolbar.paintModelBadge();
        }
      }
    } finally {
      if (!succeeded) {
        if (mode === 'continue') {
          textEl.innerHTML = format(base);
          thoughtEl?.remove();
          for (const el of holder.querySelectorAll('.turn-tools, .swipe-nav')) el.hidden = false;
        } else {
          holder.remove();
          if (targetEl) targetEl.hidden = false;
        }
      }
      end();
      if (isOpen()) app.view.syncScene();
      if (succeeded && isOpen() && chat.autoChoices) app.choices.suggest({ auto: true });
      if (reload && isOpen()) setTimeout(() => { if (isOpen() && !state.run) app.view.open(chat.id); }, 300);
      app.list.refresh();
      if (succeeded) app.memory.afterReply(chat);
      if (isOpen()) this.refreshContext();
    }
  }

  /**
   * 진행 중인 생성을 멈춥니다. 연결을 끊지 않고 서버에 멈추라고 알려서,
   * 지금까지 쓴 답변이 저장되고 화면에도 그대로 남게 합니다. 서버에 닿지 못하거나 오래 걸리면 연결을 끊습니다.
   */
  async stop() {
    const run = this.state.run;
    if (!run) return;
    run.stopped = true;
    const stopped = await api.stopChat(run.chatId).then((r) => r?.stopped).catch(() => false);
    if (!stopped) run.controller.abort();
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000, 'timeout'));
    if (await Promise.race([run.done, timeout]) === 'timeout') run.controller.abort();
    await run.done;
  }

  setStreaming(on) {
    $('stream-status').hidden = !on;
    for (const id of ['btn-send', 'btn-regen', 'btn-continue', 'btn-impersonate', 'btn-choices']) $(id).disabled = on;
    if (!on) $('stream-label').textContent = '응답 생성 중';
    // 막대가 생기고 사라지면서 입력창 높이가 달라지므로 다시 맞춰 줍니다.
    ui.scrollToEnd();
  }

  /**
   * 대신 쓰기. 내 다음 차례를 AI 가 초안으로 씁니다. 입력창에 흘려 넣기만 하고 보내지는 않습니다.
   * 입력창에 미리 적어 둔 글은 '이런 방향으로' 라는 힌트로 넘깁니다.
   */
  async draftMyTurn() {
    const { state } = this;
    const chat = state.chat;
    if (!chat || chat.kind === 'assistant' || state.run) return;
    const input = $('input');
    const hint = input.value.trim();

    const { run, end } = this.startRun(chat);
    $('stream-label').textContent = hint ? '적어 둔 방향으로 초안 쓰는 중' : '내 차례 초안 쓰는 중';
    input.readOnly = true;

    // 모델이 앞에 붙이는 '내이름:' 은 보여 주지 않습니다. 서버도 끝에서 같은 정리를 합니다.
    const me = state.personaOf(chat)?.name || '';
    const tidy = (t) => (me
      ? t.replace(new RegExp(`^\\s*(\\*\\*)?${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\*\\*)?\\s*[:：]\\s*`), '')
      : t).trimStart();
    let acc = '';
    try {
      const result = await impersonate(chat.id, {
        hint,
        signal: run.controller.signal,
        onDelta: (d) => {
          acc += d;
          if (state.chat === chat) { input.value = tidy(acc); this.grow(); }
        }
      });
      if (state.chat !== chat) return;
      if (result.draft) {
        input.value = result.draft;
        ui.toast('초안을 넣었습니다. 고친 뒤 보내세요');
      } else {
        input.value = hint;
        if (!run.stopped) ui.toast('초안이 비어 있습니다. 다시 눌러 보세요');
      }
    } catch (e) {
      if (state.chat === chat) {
        // 멈췄으면 쓰던 데까지 두고, 실패했으면 원래 적어 둔 글로 되돌립니다.
        input.value = e.name === 'AbortError' && acc.trim() ? tidy(acc).trim() : hint;
        if (e.name !== 'AbortError') ui.toast(`초안을 쓰지 못했습니다 — ${e.message}`);
      }
    } finally {
      input.readOnly = false;
      this.grow();
      end();
      if (state.chat === chat) input.focus();
    }
  }
}
