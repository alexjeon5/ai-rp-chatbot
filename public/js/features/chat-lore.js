/** 대화의 세계관 창: 이 대화에 붙일 설정집을 고르고, 지금 발동 중인 항목을 보여 줍니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

const MAX_ATTACHED = 20;

export class ChatLoreDialog {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-chat-lore');
    on('btn-chat-lore', 'click', () => this.open());
    on('cl-cancel', 'click', () => this.dialog.close('cancel'));
    on('cl-manage', 'click', () => {
      this.dialog.close('cancel');
      this.app.lorebooks.open();
    });
    on('cl-list', 'change', () => this.limitChecks());
    this.dialog.addEventListener('close', () => this.save());
  }

  /** 설정집이 왜 이 대화에 적용되는지. 직접 붙인 것만 여기서 뺄 수 있습니다. */
  reasonOf(book, chat) {
    if (book.global) return '모든 대화에 적용 중';
    if (chat.characterId && book.characterIds?.includes(chat.characterId)) return '이 캐릭터에 묶여 적용 중';
    return '';
  }

  async open() {
    const { state } = this;
    const chat = state.chat;
    if (!chat) return;
    const attached = new Set(chat.lorebookIds || []);
    $('cl-list').innerHTML = state.lorebooks.length
      ? state.lorebooks.map((b) => {
        const reason = this.reasonOf(b, chat);
        return `<li class="persona-row">
          <label class="check-row grow">
            <input type="checkbox" value="${esc(b.id)}" ${reason || attached.has(b.id) ? 'checked' : ''} ${reason ? 'disabled' : ''}>
            <span><span class="p-name">${esc(b.name)}</span>
            <span class="p-desc">${esc(reason || b.description || `항목 ${b.entries.length}개`)}</span></span>
          </label>
        </li>`;
      }).join('')
      : '<li class="rail-empty">설정집이 없습니다. 「세계관 관리」에서 먼저 만들어 주세요.</li>';
    this.limitChecks();
    $('cl-triggered').innerHTML = '<li class="rail-empty">확인하는 중…</li>';
    this.dialog.showModal();
    this.paintTriggered(chat);
  }

  /** 서버도 20개에서 자릅니다. 넘기지 못하게 미리 막습니다. */
  limitChecks() {
    const boxes = [...$('cl-list').querySelectorAll('input[type=checkbox]:not([disabled])')];
    const full = boxes.filter((b) => b.checked).length >= MAX_ATTACHED;
    for (const b of boxes) b.disabled = full && !b.checked;
  }

  async paintTriggered(chat) {
    const list = $('cl-triggered');
    try {
      const { triggered } = await api.chatLore(chat.id);
      if (!this.dialog.open || this.state.chat !== chat) return;
      const books = new Map(this.state.lorebooks.map((b) => [b.id, b.name]));
      list.innerHTML = triggered.length
        ? triggered.map((t) => `<li class="trait-item" title="약 ${t.tokens}토큰">${esc(books.get(t.bookId) || '')} · ${esc(t.title || '제목 없음')}</li>`).join('')
        : '<li class="rail-empty">지금 발동 중인 항목이 없습니다.</li>';
    } catch {
      list.innerHTML = '';
    }
  }

  async save() {
    const { state, app } = this;
    if (this.dialog.returnValue !== 'save' || !state.chat) return;
    const chat = state.chat;
    // 잠긴(다른 이유로 적용 중인) 칸은 직접 붙인 목록에 넣지 않습니다.
    const lorebookIds = [...$('cl-list').querySelectorAll('input:checked:not([disabled])')].map((b) => b.value);
    const same = lorebookIds.length === (chat.lorebookIds || []).length && lorebookIds.every((id) => chat.lorebookIds.includes(id));
    if (same) return;
    try {
      const saved = await api.updateChat(chat.id, { lorebookIds });
      chat.lorebookIds = saved.lorebookIds || [];
    } catch (e) {
      return ui.toast(`저장하지 못했습니다 — ${e.message}`);
    }
    if (state.chat !== chat) return;
    app.composer.refreshContext();
    ui.toast(chat.lorebookIds.length ? `세계관 ${chat.lorebookIds.length}개를 이 대화에 붙였습니다` : '이 대화에 붙인 세계관을 모두 뺐습니다');
  }
}
