/** 캐릭터 카드 가져오기·내보내기. 카드 변환 규칙(character-card.js)과 저장소를 잇습니다. */
import { parseCard, buildCard } from '../character-card.js';
import { cardFromPng, stripCardText, CardError } from '../png-card.js';
import { cleanLorebook, LORE_LIMITS } from '../lorebook.js';
import { ArtError } from './character-art.js';
import { isObj } from './records.js';
import { Access } from './access.js';
import { NotFound } from './errors.js';

/** 파일 이름에 못 쓰는 글자를 바꿉니다. */
const safeName = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'character';

export class CharacterCards {
  constructor(store, art, access = new Access(store)) {
    this.store = store;
    this.art = art;
    this.access = access;
  }

  /** 본문에서 카드 JSON 을 꺼냅니다. { card } 는 JSON 카드, { png } 는 base64 로 보낸 PNG 카드입니다. */
  decode(payload) {
    if (isObj(payload?.card)) return payload.card;
    if (typeof payload?.png === 'string' && payload.png) return cardFromPng(Buffer.from(payload.png, 'base64'));
    throw new CardError('가져올 카드 파일이 없습니다.');
  }

  /**
   * 카드를 새 캐릭터로 넣습니다. 카드에 세계관(character_book)이 있으면 그 캐릭터에 묶인 로어북으로 함께 만듭니다.
   * PNG 카드면 그림을 프로필 그림으로 씁니다. 브라우저가 줄여 보낸 그림(portrait)이 있으면 그걸, 없으면 원본에서 카드 글만 벗겨 씁니다.
   * 그림을 못 쓰더라도 캐릭터는 만들고 dropped 에 적습니다.
   * @returns {{character: object, lorebook: object|null, dropped: string[]}}
   */
  async import(actor, payload) {
    const { character: added, book, dropped } = parseCard(this.decode(payload));
    let character = this.store.characters.add(this.access.stamp(actor, added));

    const picture = this.pictureOf(payload);
    if (picture) {
      try {
        character = await this.art.setPortrait(actor, character.id, picture);
      } catch (err) {
        if (!(err instanceof ArtError)) throw err;
        dropped.push(`프로필 그림 (${err.message})`);
      }
    }

    let lorebook = null;
    const clean = book && cleanLorebook(book);
    if (clean?.entries?.length) {
      if (this.access.lorebooks(actor).length >= LORE_LIMITS.books) dropped.push('세계관 (설정집이 너무 많아 넣지 못함)');
      else {
        lorebook = this.store.lorebooks.add(this.access.stamp(actor, { description: '', global: false, ...clean, characterIds: [character.id] }));
      }
    }
    return { character, lorebook, dropped };
  }

  pictureOf(payload) {
    if (typeof payload?.portrait === 'string' && payload.portrait) return Buffer.from(payload.portrait, 'base64');
    if (typeof payload?.png === 'string' && payload.png) return stripCardText(Buffer.from(payload.png, 'base64'));
    return null;
  }

  /** 캐릭터를 V2 카드로. 그 캐릭터에 묶인 (actor 가 볼 수 있는) 로어북은 character_book 으로 함께 담습니다. */
  export(actor, id) {
    const character = this.access.findCharacter(actor, id);
    if (!character) throw new NotFound('없는 캐릭터입니다.');
    const books = this.access.lorebooks(actor).filter((b) => b.characterIds?.includes(character.id));
    return { filename: `${safeName(character.name)}.json`, card: buildCard(character, books) };
  }
}
