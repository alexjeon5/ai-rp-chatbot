/** 가운데 대화 화면: 열기·닫기, 상단 줄(모드·페르소나·⋯ 메뉴), 대화 그리기, 메시지 도구. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, setHidden, on } from '../core/dom.js';
import { menuKeys } from '../core/menu.js';

// 대화가 열려 있을 때만 보이는 상단 버튼들
const CHAT_ONLY = ['btn-choices', 'btn-dice', 'btn-toggle-vn', 'btn-backgrounds', 'btn-toggle-dice', 'btn-toggle-autochoices', 'btn-rename', 'btn-archive-chat', 'btn-delete-chat', 'btn-save-character', 'btn-open-origin', 'btn-cast', 'btn-memory', 'btn-chat-lore',
  'btn-impersonate', 'chat-preset', 'chat-persona', 'btn-websearch', 'btn-thinking'];

// ⋯ 메뉴의 켜고 끄는 항목. 대화마다 따로 저장합니다.
const FLAG_ITEMS = [
  { id: 'btn-toggle-vn', key: 'vn', label: '비주얼 노벨 화면', hint: '캐릭터의 표정·장소 표식을 답변에 요청합니다' },
  { id: 'btn-toggle-dice', key: 'dice', label: '주사위 판정', hint: '위험한 순간에 AI 가 판정을 요청합니다' },
  { id: 'btn-toggle-autochoices', key: 'autoChoices', label: '선택지 자동 제안', hint: '답변이 끝나면 다음 행동을 제안합니다' }
];

export class ChatView {
  constructor(app) {
    this.app = app;
    this.state = app.state;

    on('chat-preset', 'change', (e) => this.changePreset(e.target.value));
    on('chat-persona', 'change', (e) => this.changePersona(e.target.value));
    on('messages', 'click', (e) => this.onTool(e));

    on('btn-chat-menu', 'click', () => this.toggleMenu());
    // 항목을 고르면 닫습니다. 각 항목의 동작은 아래 버튼별 처리기가 맡습니다.
    on('chat-menu', 'click', (e) => {
      if (e.target.closest('.sel-item')) this.toggleMenu(false);
    });
    $('chat-menu').parentElement.addEventListener('keydown', (e) => {
      menuKeys($('chat-menu'), e, (refocus) => {
        this.toggleMenu(false);
        if (refocus) $('btn-chat-menu').focus();
      });
    });
    const withChat = (fn) => () => { if (this.state.chat) fn(this.state.chat); };
    on('btn-delete-chat', 'click', withChat((chat) => app.list.remove(chat.id)));
    on('btn-archive-chat', 'click', withChat((chat) => app.list.setArchived(chat.id, !chat.archivedAt)));
    on('btn-rename', 'click', withChat((chat) => app.list.rename(chat.id)));
    on('btn-save-character', 'click', () => this.saveCharacter());
    for (const item of FLAG_ITEMS) on(item.id, 'click', () => this.toggleFlag(item));
    on('btn-backgrounds', 'click', () => app.backgrounds.open());
    on('btn-open-origin', 'click', withChat((chat) => { if (chat.branchOf) this.open(chat.branchOf.chatId); }));
    on('btn-new-chat', 'click', () => {
      const chat = this.state.chat;
      // 1회성 캐릭터는 목록에 없어도 되므로, 목록이 비었는지는 그다음에 봅니다.
      if (chat?.character) app.newChat.start({ inline: { ...chat.character } });
      else if (chat?.characterId) app.newChat.start({ id: chat.characterId });
      else if (!this.state.characters.length) ui.toast('먼저 캐릭터를 만들어 주세요');
      else ui.toast('왼쪽에서 캐릭터를 골라 주세요');
    });
    const sidebar = $('sidebar');
    on('btn-open-sidebar', 'click', () => sidebar.classList.add('open'));
    on('btn-close-sidebar', 'click', () => sidebar.classList.remove('open'));
    on('sidebar-scrim', 'click', () => sidebar.classList.remove('open'));
  }

  async open(id) {
    const { state, app } = this;
    // 다른 대화에서 생성 중이면 멈춥니다. 쓰던 내용은 그 대화에 저장됩니다.
    // 그대로 두면 끝난 답변이 새로 연 대화에 붙고, 새 대화의 전송도 잠깁니다.
    if (state.run && state.run.chatId !== id) await app.composer.stop();
    if (state.chat?.id !== id) app.attach.reset();
    state.chat = await api.chat(id);
    localStorage.setItem('lastChat', id);
    // 연 대화가 들어 있는 쪽(대화 목록/보관함)을 보여 줍니다. 새로 만든 대화는 늘 대화 목록입니다.
    state.showArchived = Boolean(state.chat.archivedAt);
    const assistant = state.chat.kind === 'assistant';
    $('chat-title').textContent = state.chat.title;
    this.paintSub();
    setHidden(['composer', 'btn-chat-menu'], false);
    this.toggleMenu(false);
    setHidden(['btn-rename', 'btn-delete-chat'], false);
    this.paintArchiveButton();
    $('btn-save-character').hidden = !state.chat.character;
    $('btn-open-origin').hidden = !this.originOf(state.chat);
    setHidden(['btn-cast', 'btn-memory', 'btn-chat-lore', 'btn-impersonate', 'btn-choices', 'btn-dice',
      'btn-toggle-vn', 'btn-backgrounds', 'btn-toggle-dice', 'btn-toggle-autochoices'], assistant);
    this.paintFlags();
    $('input').placeholder = assistant
      ? '무엇이든 물어보세요.'
      : '무엇을 하거나 말할지 적어보세요. 행동은 *별표* 로 감쌉니다.';
    if (assistant) $('chat-preset').hidden = true;
    else this.paintPreset();
    this.paintPersona();
    app.toolbar.paintQuickProvider();
    app.toolbar.paintWebSearch();
    app.toolbar.paintThinking();
    app.choices.clear();
    this.paintThread();
    this.syncScene();
    app.composer.refreshContext();
    app.list.paint(id);
    $('sidebar').classList.remove('open');
  }

  /** 장면에 딸린 화면(무대, 판정 버튼)을 지금 대화 상태에 맞춥니다. */
  syncScene() {
    this.app.stage.sync();
    this.app.choices.sync();
  }

  /** 열린 대화를 닫고 빈 화면으로 되돌립니다. */
  close() {
    const { state, app } = this;
    app.composer.stop();
    state.chat = null;
    localStorage.removeItem('lastChat');
    $('chat-title').textContent = state.mode === 'assistant' ? '어시스턴트' : '대화를 선택해 주세요';
    $('chat-sub').textContent = '';
    setHidden(['composer', 'btn-chat-menu'], true);
    this.toggleMenu(false);
    setHidden(CHAT_ONLY, true);
    app.composer.paintContext(null);
    app.composer.setStreaming(false);
    app.choices.clear();
    this.syncScene();
    ui.renderEmptyStage(state.mode);
  }

  /** 대화 제목 아래 한 줄. 1회성 여부 · 캐릭터 소개 · 내 페르소나 */
  paintSub() {
    const { state } = this;
    const chat = state.chat;
    if (!chat) return;
    const archived = chat.archivedAt ? '보관한 대화' : null;
    const branch = chat.branchOf ? `${this.originOf(chat)?.title || `${chat.branchOf.title} (지워짐)`}에서 분기` : null;
    const cast = state.castOf(chat);
    // 늘 같은 안내뿐인 줄은 좁은 화면에서 숨깁니다(CSS). 보관·분기 같은 정보가 있으면 보입니다.
    $('chat-sub').classList.toggle('is-plain', chat.kind === 'assistant' && !archived && !branch);
    $('chat-sub').textContent = (chat.kind === 'assistant'
      ? [archived, branch, '어시스턴트 모드 — 캐릭터 없이 대화합니다']
      : [
          archived,
          branch,
          chat.character ? '1회성 캐릭터' : null,
          cast.length ? `함께: ${cast.map((c) => c.name).join(', ')}` : null,
          state.characterOf(chat)?.description,
          `내 페르소나 ${state.personaOf(chat)?.name || '미설정'}`
        ]).filter(Boolean).join(' · ');
  }

  /** 대화 상단의 틀 선택기를 현재 대화에 맞춰 그립니다. 어시스턴트 대화에는 대화 모드가 없습니다. */
  paintPreset() {
    const { state } = this;
    const sel = $('chat-preset');
    if (!state.chat || state.chat.kind === 'assistant') {
      sel.hidden = true;
      return;
    }
    sel.innerHTML = state.settings.presets
      .map((p) => `<option value="${p.id}">${p.adult ? '🔒 ' : ''}${p.name}</option>`)
      .join('');
    sel.value = state.chat.presetId || state.listedChat?.presetId || state.settings.activePresetId;
    sel.hidden = false;
  }

  async changePreset(presetId) {
    const { state, app } = this;
    if (!state.chat) return;
    await api.updateChat(state.chat.id, { presetId });
    state.chat.presetId = presetId;
    ui.toast(`대화 모드를 바꿨습니다 — ${state.settings.presets.find((p) => p.id === presetId).name}`);
    await app.list.refresh();
    app.toolbar.paintQuickProvider();
    // 메신저 모드로 바꾸거나 빠져나오면 말풍선 모양이 달라집니다.
    if (!state.run) this.paintThread();
    app.composer.refreshContext();
  }

  /**
   * 대화 상단의 페르소나 선택기. 페르소나는 대화를 만들 때 정해지지만,
   * 여기서 이 대화만 따로 바꿀 수 있습니다. 다른 대화와 기본값은 그대로입니다.
   */
  paintPersona() {
    const { state } = this;
    const sel = $('chat-persona');
    if (!state.chat || state.chat.kind === 'assistant' || !state.personas.length) {
      sel.hidden = true;
      return;
    }
    sel.innerHTML = state.personas.map((p) => `<option value="${p.id}">나: ${esc(p.name)}</option>`).join('');
    sel.value = state.personaOf(state.chat)?.id || state.personas[0].id;
    sel.hidden = false;
  }

  async changePersona(personaId) {
    const { state } = this;
    if (!state.chat) return;
    const chat = state.chat;
    try {
      await api.updateChat(chat.id, { personaId });
    } catch (err) {
      this.paintPersona();
      return ui.toast(`바꾸지 못했습니다 — ${err.message}`);
    }
    chat.personaId = personaId;
    if (state.chat !== chat) return;
    this.paintSub();
    // 내 말풍선 위의 이름도 새 페르소나로 바뀌어야 합니다. 생성 중이면 화면을 건드리지 않습니다.
    if (!state.run) this.paintThread();
    ui.toast(`이 대화의 페르소나를 바꿨습니다 — ${state.personaOf(chat)?.name}. 다음 답변부터 반영됩니다.`);
  }

  /** 분기한 대화의 원본(목록에 남아 있을 때만). */
  originOf(chat) {
    return chat?.branchOf ? this.state.chats.find((c) => c.id === chat.branchOf.chatId) : null;
  }

  /** 이 메시지까지 복사한 새 대화를 만들고 엽니다. 원본은 그대로 둡니다. */
  async branch(msg) {
    const { state, app } = this;
    if (state.run) return ui.toast('답변을 쓰는 중에는 분기할 수 없습니다');
    try {
      const { chat, memoryCleared } = await api.branchChat(state.chat.id, msg.id);
      await app.list.refresh();
      await this.open(chat.id);
      ui.toast(memoryCleared
        ? '분기했습니다. 기억 요약에 분기 지점 뒤의 일이 섞여 있어 요약은 비웠습니다'
        : '분기한 대화를 열었습니다. 원본은 ⋯ 메뉴에서 열 수 있습니다');
    } catch (err) {
      ui.toast(`분기하지 못했습니다 — ${err.message}`);
    }
  }

  paintFlags() {
    const chat = this.state.chat;
    for (const { id, key, label } of FLAG_ITEMS) {
      const on = Boolean(chat?.[key]);
      $(id).textContent = `${label} ${on ? '끄기' : '켜기'}`;
    }
  }

  async toggleFlag({ key, label, hint }) {
    const { state, app } = this;
    const chat = state.chat;
    if (!chat) return;
    const next = !chat[key];
    try {
      await api.updateChat(chat.id, { [key]: next });
    } catch (err) {
      return ui.toast(`바꾸지 못했습니다 — ${err.message}`);
    }
    if (next) chat[key] = true;
    else delete chat[key];
    if (state.chat !== chat) return;
    this.paintFlags();
    this.syncScene();
    app.composer.refreshContext();
    ui.toast(next ? `${label}을 켰습니다. 다음 답변부터 반영됩니다 — ${hint}` : `${label}을 껐습니다`);
  }

  paintArchiveButton() {
    const btn = $('btn-archive-chat');
    const archived = Boolean(this.state.chat?.archivedAt);
    btn.hidden = !this.state.chat;
    btn.textContent = archived ? '보관 해제' : '보관';
    btn.title = archived
      ? '이 대화를 대화 목록으로 되돌립니다'
      : '이 대화를 목록에서 치워 보관함에 둡니다. 지우지 않으므로 언제든 꺼낼 수 있습니다';
  }

  /** 상단 ⋯ 메뉴 — 열려 있는 대화에 씁니다. */
  toggleMenu(open = $('chat-menu').hidden) {
    $('chat-menu').hidden = !open;
    $('btn-chat-menu').setAttribute('aria-expanded', String(open));
    if (open) $('chat-menu').querySelector('.sel-item:not([hidden])')?.focus();
  }

  async saveCharacter() {
    const { state, app } = this;
    if (!state.chat?.character) return;
    const { character } = await api.saveInlineCharacter(state.chat.id);
    state.chat.characterId = character.id;
    delete state.chat.character;
    state.characters = await api.characters();
    app.characters.rememberTab('mine');
    app.characters.paint();
    await app.list.refresh();
    $('btn-save-character').hidden = true;
    ui.toast(`캐릭터 목록에 넣었습니다 — ${character.name}`);
  }

  /* ---------------- 대화 그리기 ---------------- */

  /** 🎨 버튼과 그림 주소를 그릴 대화에 맞춥니다. 롤플레이 대화이고 설정에서 켰을 때만 보입니다. */
  syncDrawing(chat) {
    ui.setDrawing({ enabled: Boolean(this.state.settings.image?.enabled) && chat?.kind !== 'assistant', chatId: chat?.id || '' });
  }

  paintThread() {
    const { state } = this;
    if (!state.chat) return;
    this.syncDrawing(state.chat);
    ui.renderThread(state.chat, state.characterOf(state.chat), state.personaOf(state.chat), {
      bubbles: state.isBubbles(state.chat),
      charLabel: state.charLabel(state.chat),
      avatar: state.turnAvatar(state.chat)
    });
  }

  /** 메시지 하나를 그립니다. 생성이 끝났거나 답변을 넘겨볼 때 그 자리를 갈아 끼웁니다. */
  turnFor(chat, message) {
    const { state } = this;
    this.syncDrawing(chat);
    const assistant = chat.kind === 'assistant';
    const isUser = message.role === 'user';
    return ui.turnEl({
      message,
      speaker: isUser
        ? (assistant ? '나' : state.personaOf(chat)?.name || '나')
        : (assistant ? '어시스턴트' : state.charLabel(chat)),
      isUser,
      plain: assistant,
      bubbles: state.isBubbles(chat),
      avatar: isUser ? '' : state.turnAvatar(chat)
    });
  }

  /* ---------------- 메시지 도구 ---------------- */

  async onTool(e) {
    const { state, app } = this;
    const btn = e.target.closest('.tool');
    if (!btn) return;
    // 코드 블록 복사는 쓰는 중인 답변에서도 됩니다. 메시지를 찾지 않고 그 블록의 글만 봅니다.
    if (btn.dataset.act === 'copy-code') {
      const code = btn.closest('.code-block')?.querySelector('code')?.textContent || '';
      ui.toast(await ui.copyText(code) ? '코드를 복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.');
      return;
    }
    const turn = btn.closest('.turn');
    const mid = turn.dataset.mid;
    const msg = state.chat.messages.find((m) => m.id === mid);
    if (!msg) return;
    const act = btn.dataset.act;

    if (act === 'draw' || act.startsWith('img-')) return app.drawing.onTool(btn, turn, msg);
    if (act === 'swipe-prev' || act === 'swipe-next') return this.swipe(turn, msg, act === 'swipe-next' ? 1 : -1);
    if (act === 'copy') {
      ui.toast(await ui.copyText(msg.content) ? '복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.');
      return;
    }
    if (act === 'delete') {
      await api.deleteMessage(state.chat.id, mid);
      state.chat.messages = state.chat.messages.filter((m) => m.id !== mid);
      turn.remove();
      app.list.refresh();
      app.composer.refreshContext();
      this.syncScene();
      return;
    }
    if (act === 'roll-check') return app.choices.rollCheck(msg);
    if (act === 'branch') return this.branch(msg);
    if (act === 'edit') this.edit(turn, msg);
  }

  async swipe(turn, msg, step) {
    const { state, app } = this;
    if (state.run) return;
    const chat = state.chat;
    const total = msg.swipes?.length || 0;
    const next = (msg.swipeIndex ?? total - 1) + step;
    // 마지막 장에서 › 를 누르면 새 버전을 씁니다. 마지막 답변일 때만.
    if (next >= total) {
      if (chat.messages[chat.messages.length - 1] === msg) app.composer.run({ mode: 'regenerate' });
      return;
    }
    if (next < 0) return;
    try {
      const updated = await api.swipe(chat.id, msg.id, next);
      Object.assign(msg, updated);
      if (!updated.thought) delete msg.thought;
      if (!updated.sources) delete msg.sources;
      for (const k of ['scene', 'check']) if (!updated[k]) delete msg[k];
      if (state.chat === chat) turn.replaceWith(this.turnFor(chat, msg));
      this.syncScene();
      app.list.refresh();
      app.composer.refreshContext();
    } catch (err) {
      ui.toast(`넘기지 못했습니다 — ${err.message}`);
    }
  }

  edit(turn, msg) {
    const { state, app } = this;
    const body = turn.querySelector('.turn-text');
    if (turn.querySelector('.turn-edit')) return;
    const ta = document.createElement('textarea');
    ta.className = 'turn-edit';
    ta.value = msg.content;
    body.replaceWith(ta);
    ta.focus();
    let settled = false;
    const commit = async (keep) => {
      if (settled) return;
      settled = true;
      const next = document.createElement('div');
      next.className = state.isBubbles(state.chat) ? 'turn-text is-bubbles'
        : state.chat.kind === 'assistant' ? 'turn-text is-md' : 'turn-text';
      if (keep && ta.value.trim() !== msg.content) {
        msg.content = ta.value.trim();
        await api.editMessage(state.chat.id, msg.id, msg.content);
        app.composer.refreshContext();
      }
      next.innerHTML = ui.formatText(msg.content, { plain: state.chat.kind === 'assistant', bubbles: state.isBubbles(state.chat) });
      ta.replaceWith(next);
    };
    ta.addEventListener('blur', () => commit(true));
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ta.blur(); }
    });
  }
}
