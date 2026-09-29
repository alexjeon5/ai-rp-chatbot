/** 로어북과 대화를 잇습니다. 어떤 책이 이 대화에 적용되는지, 지금 어느 항목이 발동하는지. */
import { LoreScanner, LORE_DEFAULTS, renderLore } from '../lorebook.js';

export class LoreBooks {
  constructor(store) {
    this.store = store;
  }

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
   */
  appliedTo(chat) {
    const seen = new Set();
    const out = [];
    const add = (book, via) => {
      if (!book || seen.has(book.id)) return;
      seen.add(book.id);
      out.push({ book, via });
    };
    const all = this.store.lorebooks.all();
    for (const book of all) if (book.global) add(book, 'global');
    for (const book of all) if (chat.characterId && book.characterIds?.includes(chat.characterId)) add(book, 'character');
    for (const id of chat.lorebookIds || []) add(this.store.lorebooks.get(id), 'chat');
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

  /** 책을 지우면 그 책을 붙여 둔 대화에서도 뺍니다. */
  detach(bookId) {
    const chats = this.store.chats;
    for (const chat of chats.all()) {
      if (!chat.lorebookIds?.includes(bookId)) continue;
      chat.lorebookIds = chat.lorebookIds.filter((id) => id !== bookId);
      chats.save(chat.id);
    }
  }
}
