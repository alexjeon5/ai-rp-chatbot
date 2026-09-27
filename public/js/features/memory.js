/** 기억: 답변 뒤에 도는 자동 기억·요약과, 기억·작가 노트 창. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

/** 마지막 기억 확인 뒤로 쌓인 답변 수. 서버와 같은 규칙입니다. */
const turnsSinceFacts = (chat) => {
  const since = Number(chat.factsUntilAt) || 0;
  return chat.messages.filter((m) => m.role === 'assistant' && m.content?.trim() && (m.at || 0) > since).length;
};

export class Memory {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-memory');
    /* 창에서 고치는 동안의 사실 목록 사본. 저장을 눌러야 서버에 들어갑니다. */
    this.draftFacts = [];

    on('f-list', 'input', (e) => {
      const row = e.target.closest('[data-fact]');
      const fact = this.draftFacts.find((f) => f.id === row?.dataset.fact);
      if (!fact) return;
      fact.text = e.target.value;
      // 사람이 고친 항목은 AI 가 다시 바꾸지 않도록 '직접' 으로 돌립니다.
      if (fact.auto) {
        fact.auto = false;
        row.querySelector('.fact-tag').textContent = '직접';
      }
    });
    on('f-list', 'click', (e) => {
      const row = e.target.closest('[data-fact]');
      const fact = this.draftFacts.find((f) => f.id === row?.dataset.fact);
      if (!fact) return;
      if (e.target.closest('[data-pin]')) fact.pinned = !fact.pinned;
      else if (e.target.closest('[data-del]')) this.draftFacts = this.draftFacts.filter((f) => f !== fact);
      else return;
      this.paintFacts();
      this.paintFactStatus(this.state.chat);
    });
    on('f-add', 'click', () => this.addFact());
    on('f-new', 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.addFact(); }
    });
    on('f-extract', 'click', () => this.extractNow());
    on('btn-memory', 'click', () => this.open());
    on('m-cancel', 'click', () => this.dialog.close('cancel'));
    on('m-summarize', 'click', () => this.summarizeNow());
    this.dialog.addEventListener('close', () => this.save());
  }

  /**
   * 컨텍스트 밖으로 밀려났는데 아직 요약에 안 들어간 메시지 수.
   * 어디까지 들어가는지는 토큰 예산으로 서버가 정하므로, 게이지와 함께 받은 값을 씁니다.
   */
  pendingCount(chat) {
    return this.state.chat === chat && this.state.context ? this.state.context.pendingSummary ?? 0 : 0;
  }

  /** 답변이 끝난 뒤 뒤에서 기억을 정리합니다. 로컬 엔진이 한 번에 하나씩만 받으므로 차례로 돌립니다. */
  async afterReply(chat) {
    await this.autoFacts(chat);
    await this.autoSummarize(chat);
  }

  /** 답변 4개마다 최근 대화에서 오래 남길 사실을 뽑습니다. 새 항목이 생기면 알려 줍니다. */
  async autoFacts(chat) {
    if (chat.kind === 'assistant' || this.state.settings.memory?.autoFacts === false) return;
    if (turnsSinceFacts(chat) < 4) return;
    try {
      const r = await api.extractFacts(chat.id, true);
      if (r.skipped) return;
      chat.facts = r.facts;
      chat.factsUntilAt = r.factsUntilAt;
      if (this.state.chat === chat && r.added.length) {
        const more = r.added.length > 1 ? ` 외 ${r.added.length - 1}개` : '';
        ui.toast(`기억함: ${r.added[0].text}${more}`);
      }
    } catch { /* 자동 기억은 실패해도 대화를 막지 않습니다 */ }
  }

  /** 답변이 끝난 뒤 조용히 돕니다. 밀린 메시지가 기준보다 적으면 요청도 보내지 않습니다. */
  async autoSummarize(chat) {
    const { state, app } = this;
    if (chat.kind === 'assistant' || !state.settings.memory?.autoSummarize) return;
    // 답변이 붙으며 잘리는 범위가 바뀌었으니 새로 받아 봅니다.
    if (state.chat === chat) await app.composer.refreshContext();
    if (this.pendingCount(chat) < 10) return;
    try {
      const r = await api.summarize(chat.id, true);
      if (!r.summarized) return;
      chat.memory = r.memory;
      chat.summaryUntilAt = r.summaryUntilAt;
      if (state.chat === chat) {
        ui.toast(`오래된 대화 ${r.summarized}개를 기억에 요약했습니다`);
        app.composer.refreshContext();
      }
    } catch { /* 자동 요약은 실패해도 대화를 막지 않습니다 */ }
  }

  /* ---------------- 기억·노트 창 ---------------- */

  paintMemoryStatus(chat) {
    const pending = this.pendingCount(chat);
    $('m-status').textContent = pending
      ? `아직 요약하지 않은 옛 메시지 ${pending}개`
      : chat.summaryUntilAt ? '밀려난 대화를 모두 요약했습니다' : '아직 기억할 메시지 수를 넘지 않았습니다';
    $('m-summarize').disabled = !pending;
  }

  paintFacts() {
    $('f-list').innerHTML = this.draftFacts.length
      ? this.draftFacts.map((f) => `<li class="fact-row${f.pinned ? ' is-pinned' : ''}" data-fact="${esc(f.id)}">
        <input class="fact-text" value="${esc(f.text)}" maxlength="240" aria-label="기억 항목">
        <span class="fact-tag" title="${f.auto ? 'AI 가 뽑은 항목' : '직접 적거나 고친 항목'}">${f.auto ? '자동' : '직접'}</span>
        <button type="button" class="tool" data-pin aria-pressed="${f.pinned}" title="고정하면 AI 가 고치거나 지우지 않습니다">📌</button>
        <button type="button" class="tool" data-del title="삭제">✕</button>
      </li>`).join('')
      : '<li class="rail-empty">아직 없습니다. 대화가 쌓이면 자동으로 채워집니다.</li>';
  }

  paintFactStatus(chat) {
    const left = Math.max(0, 4 - turnsSinceFacts(chat));
    $('f-status').textContent = `${this.draftFacts.length}개 · ` + (left ? `답변 ${left}개 뒤 자동 확인` : '다음 답변 뒤 자동 확인');
  }

  addFact() {
    const text = $('f-new').value.trim();
    if (!text) return;
    this.draftFacts.push({ id: `u${Date.now().toString(36)}`, text, pinned: false, auto: false, sourceIds: [] });
    $('f-new').value = '';
    this.paintFacts();
    this.paintFactStatus(this.state.chat);
  }

  keptFacts() {
    return this.draftFacts.filter((f) => f.text.trim());
  }

  async extractNow() {
    const chat = this.state.chat;
    if (!chat) return;
    const btn = $('f-extract');
    btn.disabled = true;
    btn.textContent = '확인하는 중…';
    try {
      // 창에서 고친 목록을 먼저 저장해야 AI 가 그걸 보고 판단합니다.
      await api.updateChat(chat.id, { facts: this.keptFacts() });
      const r = await api.extractFacts(chat.id, false);
      chat.facts = r.facts;
      chat.factsUntilAt = r.factsUntilAt;
      this.draftFacts = structuredClone(r.facts);
      this.paintFacts();
      const changes = r.added.length + r.updated.length + r.removed.length;
      ui.toast(r.skipped ? '확인할 새 대화가 없습니다'
        : changes ? `추가 ${r.added.length} · 수정 ${r.updated.length} · 삭제 ${r.removed.length}` : '바뀐 것이 없습니다');
    } catch (err) {
      ui.toast(`확인하지 못했습니다 — ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '지금 확인하기';
      this.paintFactStatus(chat);
    }
  }

  async open() {
    const { state } = this;
    if (!state.chat) return;
    const chat = state.chat;
    // 뒤에서 기억이 바뀌었거나 메시지를 지워 항목이 치워졌을 수 있어 새로 읽습니다.
    const fresh = await api.chat(chat.id).catch(() => null);
    if (fresh) {
      for (const k of ['facts', 'factsUntilAt', 'memory', 'summaryUntilAt', 'authorNote']) chat[k] = fresh[k];
    }
    await this.app.composer.refreshContext();
    this.draftFacts = structuredClone(chat.facts || []);
    this.paintFacts();
    this.paintFactStatus(chat);
    $('f-auto').checked = state.settings.memory?.autoFacts !== false;
    $('m-memory').value = chat.memory || '';
    $('m-note').value = chat.authorNote || '';
    $('m-auto').checked = state.settings.memory?.autoSummarize !== false;
    this.paintMemoryStatus(chat);
    this.dialog.showModal();
  }

  async summarizeNow() {
    const chat = this.state.chat;
    if (!chat) return;
    const btn = $('m-summarize');
    btn.disabled = true;
    btn.textContent = '요약하는 중…';
    try {
      // 손으로 고친 기억이 있으면 먼저 저장해야 요약이 그 위에 쌓입니다.
      await api.updateChat(chat.id, { memory: $('m-memory').value });
      chat.memory = $('m-memory').value;
      const r = await api.summarize(chat.id, false);
      chat.memory = r.memory;
      chat.summaryUntilAt = r.summaryUntilAt;
      $('m-memory').value = r.memory;
      ui.toast(r.summarized ? `옛 메시지 ${r.summarized}개를 요약했습니다` : '요약할 메시지가 없습니다');
      await this.app.composer.refreshContext();
    } catch (e) {
      ui.toast(`요약하지 못했습니다 — ${e.message}`);
    } finally {
      btn.textContent = '지금 요약하기';
      this.paintMemoryStatus(chat);
    }
  }

  async save() {
    const { state } = this;
    if (this.dialog.returnValue !== 'save' || !state.chat) return;
    const chat = state.chat;
    const patch = { memory: $('m-memory').value.trim(), authorNote: $('m-note').value.trim(), facts: this.keptFacts() };
    const memory = { autoSummarize: $('m-auto').checked, autoFacts: $('f-auto').checked };
    try {
      const saved = await api.updateChat(chat.id, patch);
      Object.assign(chat, patch, { facts: saved.facts });
      const now = state.settings.memory || {};
      if (memory.autoSummarize !== (now.autoSummarize !== false) || memory.autoFacts !== (now.autoFacts !== false)) {
        state.settings = await api.saveSettings({ memory });
      }
      ui.toast('기억과 작가 노트를 저장했습니다');
      this.app.composer.refreshContext();
    } catch (e) {
      this.dialog.returnValue = '';
      this.dialog.showModal();
      ui.toast(`저장하지 못했습니다 — ${e.message}`);
    }
  }
}
