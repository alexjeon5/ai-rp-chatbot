/** 세계관 항목 편집기: 설정집 창 안에서 항목 목록을 그리고, 아래 칸으로 항목 하나를 만들거나 고칩니다. */
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

const MAX_ENTRIES = 300;
const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const words = (text) => [...new Set(text.split(/[,\n]/).map((w) => w.trim()).filter(Boolean))];

export class LoreEntryEditor {
  constructor() {
    /* 창에서 고치는 동안의 항목 목록 사본. 설정집을 저장해야 서버에 들어갑니다. */
    this.entries = [];
    this.editingId = null;

    on('le-apply', 'click', () => this.apply());
    on('le-cancel', 'click', () => this.fill(null));
    on('lb-entries', 'click', (e) => this.onListClick(e));
  }

  /** 다른 설정집으로 바꿀 때 목록과 입력칸을 통째로 갈아 끼웁니다. */
  load(entries) {
    this.entries = structuredClone(entries || []);
    this.fill(null);
    this.paintList();
  }

  paintList() {
    $('lb-entry-count').textContent = `— ${this.entries.length}개`;
    $('lb-entries').innerHTML = this.entries.length
      ? this.entries.map((e) => this.row(e)).join('')
      : '<li class="rail-empty">아직 항목이 없습니다. 아래 칸에서 추가해 주세요.</li>';
  }

  row(e) {
    const label = e.title || e.keys[0] || e.content.slice(0, 20);
    const trigger = e.constant ? '항상 넣기' : e.keys.length ? `키워드: ${e.keys.join(', ')}` : '키워드 없음 — 발동하지 않습니다';
    const meta = [e.enabled ? null : '꺼짐', `우선순위 ${e.priority}`, `${e.content.length}자`].filter(Boolean).join(' · ');
    return `<li class="persona-row${e.enabled ? '' : ' is-off'}${e.id === this.editingId ? ' active' : ''}" data-entry="${esc(e.id)}">
      <span class="grow">
        <div class="p-name">${esc(label)}</div>
        <div class="p-desc" title="${esc(trigger)}">${esc(trigger)}</div>
        <div class="p-meta">${esc(meta)}</div>
      </span>
      <button type="button" class="ghost-btn" data-toggle>${e.enabled ? '끄기' : '켜기'}</button>
      <button type="button" class="ghost-btn" data-edit>수정</button>
      <button type="button" class="ghost-btn danger" data-del>삭제</button>
    </li>`;
  }

  onListClick(e) {
    const entry = this.entries.find((x) => x.id === e.target.closest('[data-entry]')?.dataset.entry);
    if (!entry) return;
    if (e.target.closest('[data-toggle]')) entry.enabled = !entry.enabled;
    else if (e.target.closest('[data-edit]')) return this.fill(entry);
    else if (e.target.closest('[data-del]')) {
      this.entries = this.entries.filter((x) => x !== entry);
      if (this.editingId === entry.id) this.fill(null);
    } else return;
    this.paintList();
  }

  /** 입력칸을 항목 하나로 채웁니다. null 이면 새 항목용으로 비웁니다. */
  fill(entry) {
    this.editingId = entry?.id ?? null;
    $('le-form-title').textContent = entry ? '항목 수정' : '새 항목';
    $('le-apply').textContent = entry ? '항목 적용' : '항목 추가';
    $('le-cancel').hidden = !entry;
    $('le-title').value = entry?.title ?? '';
    $('le-keys').value = entry?.keys.join(', ') ?? '';
    $('le-secondary').value = entry?.secondaryKeys?.join(', ') ?? '';
    $('le-content').value = entry?.content ?? '';
    $('le-priority').value = entry?.priority ?? 50;
    $('le-constant').checked = entry?.constant ?? false;
    $('le-case').checked = entry?.caseSensitive ?? false;
    $('le-enabled').checked = entry?.enabled ?? true;
    if (entry) $('le-title').focus();
    this.paintList();
  }

  read() {
    const priority = Math.round(Number($('le-priority').value));
    return {
      id: this.editingId ?? newId(),
      title: $('le-title').value.trim(),
      keys: words($('le-keys').value),
      secondaryKeys: words($('le-secondary').value),
      content: $('le-content').value.trim(),
      priority: Number.isFinite(priority) ? Math.min(100, Math.max(0, priority)) : 50,
      constant: $('le-constant').checked,
      caseSensitive: $('le-case').checked,
      enabled: $('le-enabled').checked
    };
  }

  apply() {
    const entry = this.read();
    if (!entry.content) return ui.toast('내용을 적어 주세요');
    if (!entry.constant && !entry.keys.length && !confirm('키워드가 없고 「항상 넣기」도 꺼져 있어 발동하지 않습니다. 그래도 넣을까요?')) return;
    const at = this.entries.findIndex((x) => x.id === entry.id);
    if (at >= 0) this.entries[at] = entry;
    else if (this.entries.length >= MAX_ENTRIES) return ui.toast(`항목은 설정집마다 ${MAX_ENTRIES}개까지 둘 수 있습니다`);
    else this.entries.push(entry);
    this.fill(null);
  }
}
