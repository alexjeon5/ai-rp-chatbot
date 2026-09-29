/** 사이드바의 대화 목록: 모드 탭, 성인 숨기기, 보관함, 우클릭 메뉴와 대화 관리(이름·보관·삭제). */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';
import { menuKeys } from '../core/menu.js';

/** 저장해 둔 JSON. 없거나 깨졌으면 기본값을 씁니다. */
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export class ChatList {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.rowMenuChatId = null;
    // 캐릭터별 보기에서 접어 둔 묶음(캐릭터 id, 1회성은 'once'). 다음에 열어도 그대로입니다.
    this.collapsed = new Set(readJson('collapsedGroups', []));

    for (const tab of document.querySelectorAll('.mode-tab[data-mode]')) {
      tab.addEventListener('click', () => this.switchMode(tab.dataset.mode));
    }
    on('btn-new-assistant', 'click', async () => {
      const chat = await api.createChat({ kind: 'assistant' });
      await this.refresh();
      await app.view.open(chat.id);
    });
    on('btn-toggle-adult', 'click', () => {
      this.state.hideAdult = !this.state.hideAdult;
      localStorage.setItem('hideAdult', this.state.hideAdult ? '1' : '0');
      this.paintAdultToggle();
      this.paint();
    });
    on('chat-view-tabs', 'click', (e) => {
      const tab = e.target.closest('[data-group]');
      if (!tab) return;
      this.state.groupByCharacter = tab.dataset.group === 'character';
      localStorage.setItem('chatGroup', tab.dataset.group);
      this.paintViewTabs();
      this.paint();
    });
    on('chat-list', 'click', (e) => {
      const folder = e.target.closest('[data-group-key]');
      if (folder) {
        const key = folder.dataset.groupKey;
        if (folder.getAttribute('aria-expanded') === 'true') this.collapsed.add(key);
        else this.collapsed.delete(key);
        localStorage.setItem('collapsedGroups', JSON.stringify([...this.collapsed]));
        this.paint();
        return;
      }
      const view = e.target.closest('[data-archive-view]');
      if (view) {
        this.state.showArchived = view.dataset.archiveView === 'on';
        this.paint();
        return;
      }
      const btn = e.target.closest('[data-chat]');
      if (btn) app.view.open(btn.dataset.chat);
    });
    on('chat-list', 'contextmenu', (e) => this.openRowMenu(e));
    on('row-menu', 'click', (e) => {
      const item = e.target.closest('[data-act]');
      if (!item) return;
      const id = this.rowMenuChatId;
      this.closeRowMenu();
      const act = item.dataset.act;
      if (act === 'rename') this.rename(id);
      else if (act === 'archive' || act === 'unarchive') this.setArchived(id, act === 'archive');
      else if (act === 'delete') this.remove(id);
    });
    on('row-menu', 'keydown', (e) => menuKeys($('row-menu'), e, (refocus) => this.closeRowMenu(refocus)));
    // 목록이 움직이면 메뉴가 엉뚱한 항목 옆에 떠 있게 되므로 닫습니다.
    document.querySelector('.rail-scroll').addEventListener('scroll', () => this.closeRowMenu());
    window.addEventListener('resize', () => this.closeRowMenu());
  }

  async refresh() {
    this.state.chats = await api.chats();
    this.paint();
  }

  paint(activeId = this.state.chat?.id) {
    const { state } = this;
    ui.renderChatList(state.visibleChats(), activeId, state.characters, {
      hideAdult: state.hideAdult,
      mode: state.mode,
      archiveView: state.showArchived,
      group: state.groupByCharacter,
      collapsed: this.collapsed,
      // 숨긴 성인 대화는 세지 않아야, 보관함에 들어갔을 때 보이는 수와 맞습니다.
      archivedCount: state.modeChats().filter((c) => c.archivedAt && !(state.hideAdult && c.adult)).length
    });
  }

  /**
   * 방금 말을 건 대화를 목록 맨 위로 올립니다. 서버도 updatedAt 순으로 돌려주지만,
   * 목록은 답변이 끝나야 다시 불러오므로 그때까지 기다리지 않고 먼저 옮겨 둡니다.
   */
  bump(chat, preview) {
    const chats = this.state.chats;
    const i = chats.findIndex((c) => c.id === chat.id);
    if (i < 0) return;
    const [row] = chats.splice(i, 1);
    const { archivedAt, ...rest } = row;
    chats.unshift({ ...rest, title: chat.title, updatedAt: Date.now(), messageCount: chat.messages.length, preview: preview.slice(0, 60) });
    this.paint();
  }

  paintMode() {
    const rp = this.state.mode === 'rp';
    for (const tab of document.querySelectorAll('.mode-tab[data-mode]')) tab.classList.toggle('is-on', tab.dataset.mode === this.state.mode);
    $('character-group').hidden = !rp;
    $('btn-new-chat').hidden = !rp;
    $('btn-toggle-adult').hidden = !rp;
    $('btn-new-assistant').hidden = rp;
    // 어시스턴트 대화에는 캐릭터가 없어 묶을 게 없습니다.
    $('chat-view-tabs').hidden = !rp;
    this.paintViewTabs();
  }

  paintViewTabs() {
    for (const tab of document.querySelectorAll('#chat-view-tabs [data-group]')) {
      const on = (tab.dataset.group === 'character') === this.state.groupByCharacter;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-pressed', String(on));
    }
  }

  switchMode(mode) {
    const { state, app } = this;
    // 이미 켜진 탭을 다시 누른 것이면 보관함 보기를 그대로 둡니다. 열려 있는 보관한 대화가 목록에서 사라지지 않게 합니다.
    if (mode !== state.mode) state.showArchived = false;
    state.mode = mode;
    localStorage.setItem('mode', state.mode);
    this.paintMode();
    // 다른 모드의 대화가 열려 있었다면 닫습니다. 아예 안 열어 둔 상태였다면 가운데 안내만 새 모드에 맞게 다시 그립니다.
    const chatMode = state.chat?.kind === 'assistant' ? 'assistant' : 'rp';
    if (state.chat && chatMode !== state.mode) app.view.close();
    else if (!state.chat) ui.renderEmptyStage(state.mode);
    this.paint();
  }

  paintAdultToggle() {
    $('btn-toggle-adult').textContent = this.state.hideAdult ? '성인 표시' : '성인 숨김';
  }

  /* ---------------- 대화 관리: 상단 ⋯ 메뉴와 우클릭 메뉴가 같이 씁니다 ---------------- */

  /**
   * 열린 대화가 목록에서 빠졌을 때(보관·삭제) 그 자리에 올라온 대화를 엽니다.
   * index 는 빠지기 전 목록에서의 자리입니다. 남은 대화가 없으면 빈 화면으로 둡니다.
   */
  async openNeighbor(index) {
    const list = this.state.listedChats();
    const next = list[Math.min(Math.max(index, 0), list.length - 1)];
    if (next) await this.app.view.open(next.id);
    else this.app.view.close();
  }

  async rename(id) {
    const { state } = this;
    const current = state.chat?.id === id ? state.chat.title : state.chats.find((c) => c.id === id)?.title;
    const title = prompt('대화 이름', current || '')?.trim();
    if (!title) return;
    try {
      await api.updateChat(id, { title });
    } catch (err) {
      ui.toast(`이름을 바꾸지 못했습니다 — ${err.message}`);
      return;
    }
    if (state.chat?.id === id) {
      state.chat.title = title;
      $('chat-title').textContent = title;
    }
    this.refresh();
  }

  async setArchived(id, archive) {
    const { state, app } = this;
    try {
      await api.updateChat(id, { archived: archive });
    } catch (err) {
      ui.toast(`${archive ? '보관하지' : '꺼내지'} 못했습니다 — ${err.message}`);
      return;
    }
    // 응답을 기다리는 사이 다른 대화를 열었을 수 있으니, 열린 대화인지는 여기서 봅니다.
    const open = state.chat?.id === id;
    if (open && archive) {
      // 보관한 대화는 목록에서 빠지므로 닫고, 대화 목록에서 그 자리의 다음 대화를 엽니다.
      const index = state.showArchived ? 0 : state.listedChats().findIndex((c) => c.id === id);
      app.view.close();
      state.showArchived = false;
      await this.refresh();
      if (!state.chat) await this.openNeighbor(index);
    } else {
      if (open) {
        delete state.chat.archivedAt;
        state.showArchived = false;
        app.view.paintArchiveButton();
        app.view.paintSub();
      }
      await this.refresh();
    }
    ui.toast(archive ? '보관함으로 옮겼습니다' : '대화 목록으로 꺼냈습니다');
  }

  async remove(id) {
    const { state } = this;
    // 목록에서 우클릭으로 지울 때는 열린 대화가 아닐 수 있으니 이름을 보여 줍니다.
    const title = state.chats.find((c) => c.id === id)?.title;
    if (!confirm(`${title ? `'${title}' ` : '이 '}대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api.deleteChat(id);
    } catch (err) {
      ui.toast(`삭제하지 못했습니다 — ${err.message}`);
      return;
    }
    const open = state.chat?.id === id;
    const index = state.listedChats().findIndex((c) => c.id === id);
    // 쓰던 답변이 지워진 대화에 붙지 않게 먼저 닫습니다.
    if (open) this.app.view.close();
    await this.refresh();
    if (open && !state.chat) await this.openNeighbor(index);
  }

  /* ---------------- 우클릭 메뉴 — 대화를 열지 않고 정리합니다 ---------------- */

  openRowMenu(e) {
    const btn = e.target.closest('[data-chat]');
    const chat = btn && this.state.chats.find((c) => c.id === btn.dataset.chat);
    if (!chat) return;
    e.preventDefault();
    this.app.view.toggleMenu(false);
    this.rowMenuChatId = chat.id;
    const menu = $('row-menu');
    menu.innerHTML = `
    <button type="button" class="sel-item" role="menuitem" data-act="rename">이름 바꾸기</button>
    <button type="button" class="sel-item" role="menuitem" data-act="${chat.archivedAt ? 'unarchive' : 'archive'}">
      ${chat.archivedAt ? '보관 해제' : '보관'}</button>
    <button type="button" class="sel-item danger" role="menuitem" data-act="delete">대화 삭제</button>`;
    menu.hidden = false;
    // 메뉴 키·Shift+F10 으로 열면 좌표가 0 이라, 그때는 항목 바로 아래에 띄웁니다.
    const box = btn.getBoundingClientRect();
    const x = e.clientX || box.left + 12;
    const y = e.clientY || box.bottom;
    const { offsetWidth: w, offsetHeight: h } = menu;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    menu.style.top = `${y + h > innerHeight - 8 ? Math.max(8, y - h) : y}px`;
    menu.querySelector('.sel-item')?.focus();
  }

  closeRowMenu(refocus = false) {
    const id = this.rowMenuChatId;
    $('row-menu').hidden = true;
    this.rowMenuChatId = null;
    if (refocus && id) $('chat-list').querySelector(`[data-chat="${CSS.escape(id)}"]`)?.focus();
  }
}
