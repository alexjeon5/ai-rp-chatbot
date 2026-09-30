/**
 * 로어북 목록과, 로어북과 대화를 잇는 규칙. 어떤 책이 이 대화에 적용되는지, 지금 어느 항목이 발동하는지.
 * 목록 다루기는 actor 를 받고, 문제가 있으면 AppError 를 던집니다.
 */
import { LoreScanner, LORE_DEFAULTS, LORE_LIMITS, renderLore, cleanLorebook } from '../lorebook.js';
import { Access } from './access.js';
import { AppError } from './errors.js';

export class LoreBooks {
  constructor(store, access = new Access(store)) {
    this.store = store;
    this.access = access;
  }

  /* ---------------- 목록 ---------------- */

  list(actor) {
    return this.access.lorebooks(actor);
  }

  create(actor, body) {
    if (this.list(actor).length >= LORE_LIMITS.books) throw new AppError('로어북이 너무 많습니다.');
    const clean = cleanLorebook(body || {});
    if (!clean.name) throw new AppError('이름을 입력해 주세요.');
    return this.store.lorebooks.add({ description: '', global: false, characterIds: [], entries: [], ...clean });
  }

  update(actor, id, body) {
    const clean = cleanLorebook(body || {});
    if ('name' in clean && !clean.name) throw new AppError('이름을 입력해 주세요.');
    const book = this.access.lorebook(actor, id);
    return this.store.lorebooks.update(book.id, clean);
  }

  async remove(actor, id) {
    const book = this.access.lorebook(actor, id);
    this.detach(book);
    await this.store.lorebooks.remove(book.id);
  }

  /**
   * 이 글을 대화로 봤을 때 이 책에서 발동하는 항목. 저장하지 않습니다.
   * 화면에서 고치는 중인 항목도 시험할 수 있게, entries 를 주면 그걸 씁니다.
   */
  trial(actor, id, { text, entries } = {}) {
    const book = this.access.lorebook(actor, id);
    const draft = Array.isArray(entries) ? { ...book, ...cleanLorebook({ entries }) } : book;
    return this.test(draft, text).map(({ entry, tokens }) => ({ id: entry.id, title: entry.title, tokens }));
  }

  /** 이 대화에 적용되는 책(적용 이유 포함)과 지금 발동 중인 항목, 스캔 설정. */
  forChat(actor, chatId) {
    const chat = this.access.chat(actor, chatId);
    return {
      applied: this.appliedTo(chat).map(({ book, via }) => ({ id: book.id, name: book.name, via })),
      triggered: this.triggered(chat).map(({ book, entry, tokens }) => ({ bookId: book.id, id: entry.id, title: entry.title, tokens })),
      settings: this.settings
    };
  }

  /* ---------------- 대화에 적용 ---------------- */

  /** 스캔 깊이·토큰 상한. 저장된 설정 위에 기본값을 깝니다. */
  get settings() {
    return { ...LORE_DEFAULTS, ...(this.store.settings.lorebook || {}) };
  }

  scanner() {
    return new LoreScanner(this.settings);
  }

  /**
   * 이 대화에 적용되는 책과 그 이유.
   *   global: 모든 롤플레이에 · character: 이 캐릭터와의 대화에 · chat: 이 대화에 직접 붙임
   * 한 책이 여러 이유에 걸려도 한 번만 나오고, 앞선 이유가 이깁니다.
   * 책은 그 대화의 주인이 볼 수 있는 것만 붙습니다.
   */
  appliedTo(chat) {
    const owner = this.access.ownerOf(chat);
    const seen = new Set();
    const out = [];
    const add = (book, via) => {
      if (!book || seen.has(book.id)) return;
      seen.add(book.id);
      out.push({ book, via });
    };
    const all = this.access.lorebooks(owner);
    for (const book of all) if (book.global) add(book, 'global');
    for (const book of all) if (chat.characterId && book.characterIds?.includes(chat.characterId)) add(book, 'character');
    for (const id of chat.lorebookIds || []) add(this.access.findLorebook(owner, id), 'chat');
    return out;
  }

  /** 지금 발동하는 항목들. messages 는 검사할 대화(다시 쓰기라면 마지막 답변을 뺀 것). */
  triggered(chat, messages = chat.messages) {
    return this.scanner().select(this.appliedTo(chat).map((a) => a.book), messages);
  }

  /** 시스템 프롬프트에 붙일 세계관 설정 글. */
  block(chat, messages = chat.messages) {
    return renderLore(this.triggered(chat, messages));
  }

  /** 책 하나만 놓고 이 글에서 무엇이 발동하는지 시험해 봅니다. */
  test(book, text) {
    return this.scanner().select([book], [{ role: 'user', content: String(text ?? '') }]);
  }

  /** 책을 지우면 그 책을 붙여 둔 대화(책 주인의 대화)에서도 뺍니다. */
  detach(book) {
    for (const chat of this.access.chats(this.access.ownerOf(book))) {
      if (!chat.lorebookIds?.includes(book.id)) continue;
      chat.lorebookIds = chat.lorebookIds.filter((id) => id !== book.id);
      this.store.chats.save(chat.id);
    }
  }
}
