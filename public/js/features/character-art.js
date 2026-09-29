/** 캐릭터 창의 그림 칸: 프로필 그림과 표정 그림. 저장된 캐릭터는 고르는 즉시 서버에 올리고, 새 캐릭터는 저장할 때 올립니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';
import { downscale } from '../core/image-resize.js';

const PORTRAIT_MAX = 768;
const SPRITE_MAX = 1024;

export class CharacterArtEditor {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    // 아직 저장하지 않은 새 캐릭터를 위해 고른 프로필 그림
    this.pending = null;

    on('c-portrait-pick', 'click', () => $('c-portrait-file').click());
    on('c-portrait-file', 'change', (e) => this.pickPortrait(e));
    on('c-portrait-clear', 'click', () => this.clearPortrait());
    on('c-expr-pick', 'click', () => this.pickExpression());
    // 이름 칸에서 Enter 를 누르면 캐릭터 저장이 되어 버리므로, 그림 고르기로 돌립니다.
    on('c-expr-label', 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.pickExpression();
    });
    on('c-expr-file', 'change', (e) => this.addExpression(e));
    on('c-expr-list', 'click', (e) => {
      const btn = e.target.closest('[data-remove-expr]');
      if (btn) this.removeExpression(btn.dataset.removeExpr);
    });
  }

  get character() {
    return this.state.characters.find((c) => c.id === this.state.editingCharacterId) || null;
  }

  /** 캐릭터 창을 열 때. ch 는 고치는 캐릭터, 새로 만들면 null. */
  open(ch) {
    this.pending = null;
    this.paint(ch);
  }

  paint(ch = this.character) {
    const saved = Boolean(ch?.id);
    const url = this.pending ? this.pending.url : ui.portraitUrl(ch);
    $('c-portrait').innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span class="art-empty">그림 없음</span>';
    $('c-portrait-clear').hidden = !url;
    $('c-expr-box').hidden = false;
    $('c-expr-note').textContent = saved
      ? '표정 이름을 적고 그림을 고르면 추가됩니다. 같은 이름이면 그림이 바뀝니다.'
      : '표정 그림은 캐릭터를 먼저 저장한 뒤 추가할 수 있습니다.';
    for (const id of ['c-expr-label', 'c-expr-pick']) $(id).disabled = !saved;
    const list = ch?.expressions || [];
    $('c-expr-list').innerHTML = list.map((e) => `<li class="art-expr">
        <img src="/api/character-art/${esc(ch.id)}/${esc(e.file)}" alt="">
        <span class="art-expr-name">${esc(e.label)}</span>
        <button class="tool" type="button" data-remove-expr="${esc(e.label)}" aria-label="${esc(e.label)} 표정 지우기">✕</button>
      </li>`).join('');
  }

  /** 서버가 돌려준 캐릭터로 목록과 화면을 새로 그립니다. */
  async refresh() {
    const { state, app } = this;
    state.characters = await api.characters();
    app.characters.paint();
    app.list.paint();
    this.paint();
    if (state.chat && !state.run && state.chat.kind !== 'assistant') app.view.paintThread();
  }

  async reduce(file, max) {
    const small = await downscale(file, { max });
    if (!small) throw new Error('그림을 읽지 못했습니다. PNG·JPEG·WebP 파일인지 확인해 주세요.');
    return small;
  }

  async pickPortrait(e) {
    const [file] = e.target.files;
    e.target.value = '';
    if (!file) return;
    try {
      const blob = await this.reduce(file, PORTRAIT_MAX);
      const id = this.state.editingCharacterId;
      if (id) {
        await api.setPortrait(id, blob);
        await this.refresh();
      } else {
        if (this.pending) URL.revokeObjectURL(this.pending.url);
        this.pending = { blob, url: URL.createObjectURL(blob) };
        this.paint();
      }
    } catch (err) {
      ui.toast(err.message);
    }
  }

  async clearPortrait() {
    try {
      if (this.pending) {
        URL.revokeObjectURL(this.pending.url);
        this.pending = null;
        this.paint();
      } else if (this.state.editingCharacterId) {
        await api.clearPortrait(this.state.editingCharacterId);
        await this.refresh();
      }
    } catch (err) {
      ui.toast(err.message);
    }
  }

  pickExpression() {
    if (!$('c-expr-label').value.trim()) return ui.toast('표정 이름을 먼저 적어 주세요');
    $('c-expr-file').click();
  }

  async addExpression(e) {
    const [file] = e.target.files;
    e.target.value = '';
    const label = $('c-expr-label').value.trim();
    const id = this.state.editingCharacterId;
    if (!file || !label || !id) return;
    try {
      await api.setExpression(id, label, await this.reduce(file, SPRITE_MAX));
      $('c-expr-label').value = '';
      await this.refresh();
    } catch (err) {
      ui.toast(err.message);
    }
  }

  async removeExpression(label) {
    try {
      await api.removeExpression(this.state.editingCharacterId, label);
      await this.refresh();
    } catch (err) {
      ui.toast(err.message);
    }
  }

  /** 새로 만든 캐릭터에 미리 고른 프로필 그림을 올립니다. 실패해도 캐릭터는 이미 만들어졌으니 안내만 합니다. */
  async flushPending(characterId) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    URL.revokeObjectURL(pending.url);
    try {
      await api.setPortrait(characterId, pending.blob);
    } catch (err) {
      ui.toast(`프로필 그림은 올리지 못했습니다 — ${err.message}`);
    }
  }
}
