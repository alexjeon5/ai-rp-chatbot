/** 세계관 설정집 창: 설정집 목록(수정·삭제), 아래 입력칸(이름·적용 범위·항목), 발동 시험. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';
import { LoreEntryEditor } from './lore-entry.js';

export class Lorebooks {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-lore');
    this.entries = new LoreEntryEditor();
    // 수정 중인 설정집 id. null 이면 아래 칸은 새 설정집을 만드는 데 씁니다.
    this.editingId = null;

    on('btn-lore', 'click', () => this.open());
    on('lb-save', 'click', () => this.save());
    on('lb-cancel', 'click', () => this.fill(null));
    on('lb-test', 'click', () => this.test());
    on('lore-list', 'click', (e) => this.onListClick(e));
    on('ls-depth', 'change', () => this.saveScan());
    on('ls-budget', 'change', () => this.saveScan());
    // 한 줄 입력칸에서 Enter 를 누르면 창이 닫히므로 막습니다. 한글 조합 중 Enter 는 글자 확정이라 그대로 둡니다.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') e.preventDefault();
    });
  }

  open() {
    const scan = this.state.settings.lorebook || {};
    $('ls-depth').value = scan.scanDepth ?? 4;
    $('ls-budget').value = scan.tokenBudget ?? 1200;
    this.paintList();
    this.fill(null);
    this.dialog.showModal();
  }

  /** 검사 깊이·토큰 상한은 모든 설정집이 함께 쓰는 설정이라 바로 저장합니다. 서버가 범위 안으로 맞춰 돌려줍니다. */
  async saveScan() {
    const { state } = this;
    try {
      state.settings = await api.saveSettings({
        lorebook: { scanDepth: Number($('ls-depth').value), tokenBudget: Number($('ls-budget').value) }
      });
    } catch (err) {
      ui.toast(`저장하지 못했습니다 — ${err.message}`);
    }
    // 서버가 범위 안으로 맞춘 값을 보여 주되, 지금 입력 중인 칸은 덮어쓰지 않습니다.
    for (const [id, key] of [['ls-depth', 'scanDepth'], ['ls-budget', 'tokenBudget']]) {
      if (document.activeElement !== $(id)) $(id).value = state.settings.lorebook[key];
    }
    this.app.composer.refreshContext();
  }

  /** 적용 범위 요약: 모든 대화 / 캐릭터 N명 */
  scopeOf(book) {
    const names = (book.characterIds || []).map((id) => this.state.characters.find((c) => c.id === id)?.name).filter(Boolean);
    return [book.global ? '모든 롤플레이 대화' : null, names.length ? `캐릭터: ${names.join(', ')}` : null].filter(Boolean).join(' · ');
  }

  paintList() {
    const { lorebooks } = this.state;
    $('lore-list').innerHTML = lorebooks.length
      ? lorebooks.map((b) => {
        const desc = b.description || '설명 없음';
        const meta = [`항목 ${b.entries.length}개`, this.scopeOf(b) || '대화마다 직접 적용'].join(' · ');
        return `<li class="persona-row${b.id === this.editingId ? ' active' : ''}" data-book="${esc(b.id)}">
        <span class="grow">
          <div class="p-name">${esc(b.name)}</div>
          <div class="p-desc" title="${esc(desc)}">${esc(desc)}</div>
          <div class="p-meta" title="${esc(meta)}">${esc(meta)}</div>
        </span>
        <button type="button" class="ghost-btn" data-edit>수정</button>
        <button type="button" class="ghost-btn danger" data-del>삭제</button>
      </li>`;
      }).join('')
      : '<li class="rail-empty">아직 설정집이 없습니다. 아래에서 하나 만들어 보세요.</li>';
  }

  paintCharacters(chosen) {
    const { characters } = this.state;
    $('lb-chars').innerHTML = characters.length
      ? characters.map((c) => `<li class="persona-row">
        <label class="check-row grow">
          <input type="checkbox" value="${esc(c.id)}" ${chosen.has(c.id) ? 'checked' : ''}>
          <span class="p-name">${esc(c.avatar || '◦')} ${esc(c.name)}</span>
        </label>
      </li>`).join('')
      : '<li class="rail-empty">캐릭터가 아직 없습니다.</li>';
  }

  /** 입력칸을 설정집 하나로 채웁니다. null 이면 새 설정집용으로 비웁니다. */
  fill(book) {
    this.editingId = book?.id ?? null;
    $('lb-form-title').textContent = book ? `설정집 수정 — ${book.name}` : '새 설정집';
    $('lb-save').textContent = book ? '설정집 저장' : '설정집 추가';
    $('lb-cancel').hidden = !book;
    $('lb-name').value = book?.name ?? '';
    $('lb-desc').value = book?.description ?? '';
    $('lb-global').checked = book?.global ?? false;
    this.paintCharacters(new Set(book?.characterIds ?? []));
    this.entries.load(book?.entries);
    $('lb-test').disabled = !book;
    $('lb-test-result').textContent = book ? '' : '설정집을 저장하면 시험해 볼 수 있습니다.';
    this.paintList();
    if (book) $('lb-name').focus();
  }

  read() {
    return {
      name: $('lb-name').value.trim(),
      description: $('lb-desc').value.trim(),
      global: $('lb-global').checked,
      characterIds: [...$('lb-chars').querySelectorAll('input:checked')].map((b) => b.value),
      entries: this.entries.entries
    };
  }

  onListClick(e) {
    const id = e.target.closest('[data-book]')?.dataset.book;
    const book = this.state.lorebooks.find((b) => b.id === id);
    if (!book) return;
    if (e.target.closest('[data-edit]')) this.fill(book);
    else if (e.target.closest('[data-del]')) this.remove(book);
  }

  async save() {
    const { state } = this;
    const body = this.read();
    if (!body.name) return ui.toast('이름을 입력해 주세요');
    try {
      const saved = this.editingId ? await api.updateLorebook(this.editingId, body) : await api.createLorebook(body);
      state.lorebooks = await api.lorebooks();
      ui.toast(`「${saved.name}」을(를) ${this.editingId ? '저장' : '추가'}했습니다`);
      this.fill(saved);
    } catch (err) {
      ui.toast(`저장하지 못했습니다 — ${err.message}`);
    }
  }

  async remove(book) {
    const { state } = this;
    if (!confirm(`「${book.name}」을(를) 삭제할까요? 붙여 둔 대화에서도 빠집니다.`)) return;
    try {
      await api.deleteLorebook(book.id);
    } catch (err) {
      return ui.toast(`삭제하지 못했습니다 — ${err.message}`);
    }
    state.lorebooks = state.lorebooks.filter((b) => b.id !== book.id);
    // 열려 있는 대화에 붙어 있던 것도 사본에서 뺍니다.
    if (state.chat?.lorebookIds) state.chat.lorebookIds = state.chat.lorebookIds.filter((id) => id !== book.id);
    if (this.editingId === book.id) this.fill(null);
    else this.paintList();
    this.app.composer.refreshContext();
  }

  /** 저장된 설정집에, 지금 창에서 고치는 항목(저장 전이어도)을 대 보고 어느 것이 발동하는지 알려 줍니다. */
  async test() {
    const text = $('lb-test-text').value.trim();
    const out = $('lb-test-result');
    if (!this.editingId) return;
    if (!text) return void (out.textContent = '시험할 글을 적어 주세요.');
    try {
      const { triggered } = await api.testLorebook(this.editingId, text, this.entries.entries);
      const tokens = triggered.reduce((n, t) => n + t.tokens, 0);
      out.textContent = triggered.length
        ? `발동 ${triggered.length}개 (약 ${tokens}토큰): ${triggered.map((t) => t.title || '제목 없음').join(', ')}`
        : '발동하는 항목이 없습니다.';
    } catch (err) {
      out.textContent = `시험하지 못했습니다 — ${err.message}`;
    }
  }
}
