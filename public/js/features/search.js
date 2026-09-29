/** 사이드바의 대화 검색: 제목과 메시지 내용에서 찾아, 결과를 누르면 그 대화의 그 메시지로 갑니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on, esc } from '../core/dom.js';

const DELAY_MS = 250;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 검색어가 걸린 곳을 <mark> 로 감쌉니다. 글은 조각마다 따로 이스케이프합니다. */
export function highlight(text, terms) {
  if (!terms.length) return esc(text);
  const parts = String(text).split(new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
}

export class SearchPanel {
  constructor(app) {
    this.app = app;
    this.timer = null;
    this.seq = 0;

    on('chat-search', 'input', () => this.schedule());
    on('chat-search', 'keydown', (e) => {
      if (e.key === 'Escape' && $('chat-search').value) {
        e.preventDefault();
        this.clear();
      }
    });
    on('search-results', 'click', (e) => {
      const hit = e.target.closest('[data-chat]');
      if (hit) this.jump(hit.dataset.chat, hit.dataset.mid);
    });
    // 모드를 바꾸면 그 모드의 대화에서 다시 찾습니다.
    for (const tab of document.querySelectorAll('.mode-tab[data-mode]')) tab.addEventListener('click', () => this.query && this.run());
    // 어디서든 Ctrl/⌘+K 로 검색창에 갑니다.
    document.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) return;
      e.preventDefault();
      $('sidebar').classList.add('open');
      $('chat-search').focus();
      $('chat-search').select();
    });
  }

  get query() {
    return $('chat-search').value.trim();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.query) return this.clear();
    this.timer = setTimeout(() => this.run(), DELAY_MS);
  }

  async run() {
    const query = this.query;
    if (!query) return this.clear();
    const seq = ++this.seq;
    let result;
    try {
      result = await api.search(query, this.app.state.mode);
    } catch (err) {
      if (seq === this.seq) this.status(`검색하지 못했습니다 — ${err.message}`);
      return;
    }
    // 더 늦게 친 글자의 결과가 이미 왔다면 이 결과는 버립니다.
    if (seq !== this.seq) return;
    this.paint(result);
  }

  clear() {
    clearTimeout(this.timer);
    this.seq++;
    $('chat-search').value = '';
    this.show(false);
  }

  show(on) {
    $('search-results').hidden = !on;
    $('search-status').hidden = !on;
    $('chat-list').hidden = on;
    $('chat-view-tabs').hidden = on || this.app.state.mode !== 'rp';
  }

  status(text) {
    this.show(true);
    $('search-results').innerHTML = '';
    $('search-status').textContent = text;
  }

  paint({ terms, hits, truncated }) {
    const { state } = this.app;
    const shown = hits.filter((h) => !(state.hideAdult && h.adult));
    if (!shown.length) return this.status('찾은 곳이 없습니다.');

    let last = null;
    $('search-results').innerHTML = shown.map((h) => {
      const head = h.chatId === last ? '' : `<li class="search-chat" aria-hidden="true">
        <span class="label">${esc(h.title)}</span>
        ${h.character ? `<span class="search-who">${esc(h.character)}</span>` : ''}
        ${h.adult ? '<span class="badge-adult">19</span>' : ''}
        ${h.archived ? '<span class="badge-branch">보관</span>' : ''}
      </li>`;
      last = h.chatId;
      const who = h.messageId === null ? '제목' : h.role === 'user' ? '나' : h.character || '답변';
      return `${head}<li><button type="button" class="search-hit" data-chat="${esc(h.chatId)}" data-mid="${esc(h.messageId ?? '')}"
        aria-label="${esc(h.title)} — ${esc(who)}">
        <span class="search-role">${esc(who)}</span>
        <span class="search-snippet">${highlight(h.snippet, terms)}</span></button></li>`;
    }).join('');
    const chats = new Set(shown.map((h) => h.chatId)).size;
    this.show(true);
    $('search-status').textContent = `${chats}개 대화 · ${shown.length}곳${truncated ? ' — 결과가 많아 일부만 보여 줍니다. 검색어를 더 넣어 보세요.' : ''}`;
  }

  /** 결과가 걸린 대화를 열고 그 메시지가 가운데 오게 스크롤합니다. 제목만 걸렸으면 대화만 엽니다. */
  async jump(chatId, messageId) {
    try {
      await this.app.view.open(chatId);
    } catch (err) {
      ui.toast(`대화를 열지 못했습니다 — ${err.message}`);
      this.run();
      return;
    }
    if (!messageId) return;
    const turn = document.querySelector(`#thread [data-mid="${CSS.escape(messageId)}"]`);
    if (!turn) return;
    turn.scrollIntoView({ block: 'center' });
    turn.classList.add('search-flash');
    setTimeout(() => turn.classList.remove('search-flash'), 2200);
  }
}
