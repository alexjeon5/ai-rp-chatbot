/**
 * 캐릭터와 페르소나 목록. 두 종류 모두 '이름이 있는 항목의 목록·추가·수정·삭제'라 Shelf 하나로 다룹니다.
 * HTTP 를 모릅니다. actor 를 받고, 문제가 있으면 AppError 를 던집니다.
 */
import { CHARACTER_FIELDS } from '../content/characters.js';
import { characterFields, PERSONA_FIELDS, normalizePersona } from './records.js';
import { AppError, NotFound } from './errors.js';

/** 한 종류의 항목. 받는 칸(fields)만 골라 담고, 이름은 비울 수 없습니다. */
export class Shelf {
  /**
   * @param {import('./access.js').Access} access
   * @param {string} kind Access 의 종류 이름 ('character' | 'persona')
   * @param {{ fields: string[], normalize?: (o) => object, beforeRemove?: (item) => any }} o
   */
  constructor(access, kind, { fields, normalize = (x) => x, beforeRemove }) {
    Object.assign(this, { access, kind, fields, normalize, beforeRemove });
    this.collection = access.collectionOf(kind);
  }

  list(actor) {
    return this.access.list(this.kind, actor);
  }

  add(actor, body) {
    const draft = {};
    for (const f of this.fields) draft[f] = body?.[f] ?? '';
    if (!String(draft.name ?? '').trim()) throw new AppError('이름을 입력해 주세요.');
    return this.collection.add(this.normalize(draft));
  }

  /** 준 칸만 고칩니다. */
  update(actor, id, body) {
    const patch = {};
    for (const f of this.fields) if (f in (body || {})) patch[f] = body[f];
    if ('name' in patch && !String(patch.name ?? '').trim()) throw new AppError('이름을 입력해 주세요.');
    const item = this.access.get(this.kind, actor, id, '없는 항목입니다.');
    return this.collection.update(item.id, this.normalize(patch));
  }

  async remove(actor, id) {
    const item = this.access.find(this.kind, actor, id);
    if (!item) throw new NotFound('없는 항목입니다.');
    await this.beforeRemove?.(item);
    await this.collection.remove(item.id);
  }
}

export class Library {
  /**
   * @param {{ store, access, art }} deps  art 는 캐릭터를 지울 때 그림을 함께 지우는 CharacterArt
   */
  constructor({ store, access, art }) {
    Object.assign(this, { store, access, art });
    this.characters = new Shelf(access, 'character', { fields: CHARACTER_FIELDS, beforeRemove: (c) => this.releaseCharacter(c) });
    this.personas = new Shelf(access, 'persona', { fields: PERSONA_FIELDS, normalize: normalizePersona });
  }

  /** 내장 캐릭터 중 아직 없는 것만 추가합니다. 기존 캐릭터는 손대지 않습니다. */
  addMissingBuiltins(actor) {
    const added = this.store.addMissingBuiltins();
    return { added, characters: this.characters.list(actor) };
  }

  releaseCharacter(character) {
    this.detachCharacter(character);
    this.art.removeAll(character.id);
  }

  /**
   * 캐릭터를 지워도 그 캐릭터와 나눈 대화는 계속 이어갈 수 있어야 합니다.
   * 지우기 전에 캐릭터 정보를 대화 안에 복사해 1회성 캐릭터로 바꿔 둡니다.
   * 마음이 바뀌면 대화 상단의 '캐릭터 저장' 으로 다시 목록에 넣을 수 있습니다.
   * 캐릭터를 쓸 수 있는 대화는 그 캐릭터 주인의 대화뿐입니다.
   */
  detachCharacter(character) {
    const copy = { ...characterFields(character), id: null };
    const chats = this.store.chats;
    for (const chat of this.access.chats(this.access.ownerOf(character))) {
      if (Array.isArray(chat.castIds) && chat.castIds.includes(character.id)) {
        chat.castIds = chat.castIds.filter((id) => id !== character.id);
        chats.save(chat.id);
      }
      if (chat.characterId !== character.id || chat.character) continue;
      chat.character = { ...copy };
      chat.characterId = null;
      chats.save(chat.id);
    }
  }
}
