/** 캐릭터 카드 가져오기·내보내기. 카드 변환 규칙(character-card.js)과 저장소를 잇습니다. */
import { parseCard, buildCard } from '../character-card.js';
import { cardFromPng, CardError } from '../png-card.js';
import { cleanLorebook, LORE_LIMITS } from '../lorebook.js';
import { isObj } from './records.js';

/** 파일 이름에 못 쓰는 글자를 바꿉니다. */
const safeName = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'character';

export class CharacterCards {
  constructor(store) {
    this.store = store;
  }

  /** 본문에서 카드 JSON 을 꺼냅니다. { card } 는 JSON 카드, { png } 는 base64 로 보낸 PNG 카드입니다. */
  decode(payload) {
    if (isObj(payload?.card)) return payload.card;
    if (typeof payload?.png === 'string' && payload.png) return cardFromPng(Buffer.from(payload.png, 'base64'));
    throw new CardError('가져올 카드 파일이 없습니다.');
  }

  /**
   * 카드를 새 캐릭터로 넣습니다. 카드에 세계관(character_book)이 있으면 그 캐릭터에 묶인 로어북으로 함께 만듭니다.
   * @returns {{character: object, lorebook: object|null, dropped: string[]}}
   */
  import(payload) {
    const { character: fields, book, dropped } = parseCard(this.decode(payload));
    const character = this.store.characters.add(fields);

    let lorebook = null;
    const clean = book && cleanLorebook(book);
    if (clean?.entries?.length) {
      if (this.store.lorebooks.size >= LORE_LIMITS.books) dropped.push('세계관 (설정집이 너무 많아 넣지 못함)');
      else {
        lorebook = this.store.lorebooks.add({ description: '', global: false, ...clean, characterIds: [character.id] });
      }
    }
    return { character, lorebook, dropped };
  }

  /** 캐릭터를 V2 카드로. 그 캐릭터에 묶인 로어북은 character_book 으로 함께 담습니다. */
  export(id) {
    const character = this.store.characters.get(id);
    if (!character) return null;
    const books = this.store.lorebooks.all().filter((b) => b.characterIds?.includes(id));
    return { filename: `${safeName(character.name)}.json`, card: buildCard(character, books) };
  }
}
