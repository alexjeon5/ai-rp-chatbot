/**
 * 누가 어떤 항목을 볼 수 있는지 정하는 한 곳.
 *
 * 대화·캐릭터·페르소나·로어북·배경을 찾을 때는 저장소(store.chats.get 등)를 직접 부르지 않고 여기를 거칩니다.
 * 남의 항목은 없는 것과 똑같이 다룹니다 — 있다는 사실도 드러내지 않습니다.
 *
 * actor 는 요청한 사람 { id, name, role } 입니다. 웹에서는 req.user, 디스코드에서는 연결된 앱 계정입니다.
 * 역할(role)은 보지 않습니다. 주인 계정도 남의 항목은 못 봅니다.
 */
import { NotFound } from './errors.js';

/** 모두가 모든 항목을 봅니다. 계정별로 나누기 전의 동작이라, 지금은 비교 테스트에만 씁니다. */
export class SharedPolicy {
  allows() {
    return true;
  }
}

/** 항목의 ownerId 가 요청한 사람과 같을 때만 봅니다. */
export class OwnerPolicy {
  allows(actor, item) {
    return Boolean(actor?.id) && item.ownerId === actor.id;
  }
}

/** 종류별 저장소 이름과, 못 찾았을 때의 기본 안내. */
const KINDS = {
  chat: { collection: 'chats', missing: '없는 대화입니다.' },
  character: { collection: 'characters', missing: '없는 캐릭터입니다.' },
  persona: { collection: 'personas', missing: '없는 페르소나입니다.' },
  lorebook: { collection: 'lorebooks', missing: '없는 로어북입니다.' },
  background: { collection: 'backgrounds', missing: '없는 배경입니다.' }
};

export class Access {
  /**
   * @param {import('../store.js').Store} store
   * @param {{ allows(actor, item): boolean }} [policy] 기본은 주인만 보기
   */
  constructor(store, policy = new OwnerPolicy()) {
    this.store = store;
    this.policy = policy;
  }

  collectionOf(kind) {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`모르는 종류: ${kind}`);
    return this.store[spec.collection];
  }

  canSee(actor, item) {
    return Boolean(item) && this.policy.allows(actor, item);
  }

  /** 볼 수 있는 항목 하나. 없거나 남의 것이면 null. */
  find(kind, actor, id) {
    if (typeof id !== 'string' || !id) return null;
    const item = this.collectionOf(kind).get(id);
    return this.canSee(actor, item) ? item : null;
  }

  /** find 와 같지만, 못 찾으면 NotFound 를 던집니다. message 로 안내를 바꿀 수 있습니다. */
  get(kind, actor, id, message = KINDS[kind]?.missing) {
    const item = this.find(kind, actor, id);
    if (!item) throw new NotFound(message);
    return item;
  }

  /** 볼 수 있는 항목 전부. 저장소의 정렬 순서를 따릅니다. */
  list(kind, actor) {
    return this.collectionOf(kind).all().filter((item) => this.policy.allows(actor, item));
  }

  /**
   * 새 항목에 주인을 적습니다. ownerId 를 쓰는 곳은 여기뿐입니다 — API 로 받은 값은 어디서도 ownerId 로 옮기지 않습니다.
   * actor 가 없으면(부팅 때 넣는 기본 항목) 그대로 두고, 나중에 마이그레이션이 주인을 정합니다.
   */
  stamp(actor, item) {
    if (actor?.id) item.ownerId = actor.id;
    return item;
  }

  /** 이 항목의 주인. 대화에 딸린 캐릭터·로어북처럼 '그 대화의 주인이 볼 수 있는 것'을 찾을 때 씁니다. */
  ownerOf(item) {
    return { id: item?.ownerId ?? null };
  }

  /* ---- 자주 쓰는 모양. 종류마다 find(null) · 단수(던짐) · 복수(목록) ---- */

  chats(actor) { return this.list('chat', actor); }
  findChat(actor, id) { return this.find('chat', actor, id); }
  chat(actor, id, message) { return this.get('chat', actor, id, message); }

  characters(actor) { return this.list('character', actor); }
  findCharacter(actor, id) { return this.find('character', actor, id); }
  character(actor, id, message) { return this.get('character', actor, id, message); }

  personas(actor) { return this.list('persona', actor); }
  findPersona(actor, id) { return this.find('persona', actor, id); }
  persona(actor, id, message) { return this.get('persona', actor, id, message); }

  lorebooks(actor) { return this.list('lorebook', actor); }
  findLorebook(actor, id) { return this.find('lorebook', actor, id); }
  lorebook(actor, id, message) { return this.get('lorebook', actor, id, message); }

  backgrounds(actor) { return this.list('background', actor); }
  findBackground(actor, id) { return this.find('background', actor, id); }
  background(actor, id, message) { return this.get('background', actor, id, message); }

  /** 대화 속 메시지. 대화가 없거나 남의 것이어도 '없는 메시지'로 봅니다. */
  findMessage(actor, chatId, messageId) {
    const chat = this.findChat(actor, chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    return msg ? { chat, msg } : null;
  }

  message(actor, chatId, messageId, message = '없는 메시지입니다.') {
    const found = this.findMessage(actor, chatId, messageId);
    if (!found) throw new NotFound(message);
    return found;
  }
}
