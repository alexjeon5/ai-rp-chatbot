/** 등장인물 창: 이 대화에 함께 등장할 다른 캐릭터를 고릅니다 (최대 8명). */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc } from '../core/dom.js';

export class CastDialog {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-cast');
    $('btn-cast').addEventListener('click', () => this.open());
    $('cast-list').addEventListener('change', () => {
      // 서버도 8명에서 자릅니다. 넘기지 못하게 미리 막습니다.
      const boxes = [...$('cast-list').querySelectorAll('input[type=checkbox]')];
      const full = boxes.filter((b) => b.checked).length >= 8;
      for (const b of boxes) b.disabled = full && !b.checked;
    });
    $('cast-cancel').addEventListener('click', () => this.dialog.close('cancel'));
    this.dialog.addEventListener('close', () => this.save());
  }

  open() {
    const { state } = this;
    if (!state.chat) return;
    const chosen = new Set(state.chat.castIds || []);
    const others = state.characters.filter((c) => c.id !== state.chat.characterId);
    $('cast-list').innerHTML = others.length
      ? others.map((c) => `<li class="persona-row">
        <label class="check-row grow">
          <input type="checkbox" value="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}>
          <span><span class="p-name">${esc(c.avatar || '◦')} ${esc(c.name)}</span>
          <span class="p-desc">${esc(c.description || c.tags || '')}</span></span>
        </label>
      </li>`).join('')
      : '<li class="rail-empty">함께 부를 다른 캐릭터가 없습니다. 먼저 캐릭터를 만들어 주세요.</li>';
    this.dialog.showModal();
  }

  async save() {
    const { state, app } = this;
    if (this.dialog.returnValue !== 'save' || !state.chat) return;
    const chat = state.chat;
    const castIds = [...$('cast-list').querySelectorAll('input:checked')].map((b) => b.value);
    try {
      const saved = await api.updateChat(chat.id, { castIds });
      chat.castIds = saved.castIds || [];
    } catch (e) {
      return ui.toast(`저장하지 못했습니다 — ${e.message}`);
    }
    if (state.chat !== chat) return;
    app.view.paintSub();
    if (!state.run) app.view.paintThread();
    app.composer.refreshContext();
    const names = state.castOf(chat).map((c) => c.name);
    ui.toast(names.length ? `함께 등장: ${names.join(', ')}` : '함께 등장하는 인물을 모두 뺐습니다');
  }
}
