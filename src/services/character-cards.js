/** JSON·PNG·CHARX 캐릭터 카드를 가져오고 내보냅니다. 카드 변환 규칙과 그림·세계관 저장소를 잇습니다. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCard, buildCard, buildCardV3 } from '../character-card.js';
import { cardFromPng, stripCardText, CardError } from '../png-card.js';
import { cardFromCharx, buildCharx } from '../charx-card.js';
import { cleanLorebook, LORE_LIMITS } from '../lorebook.js';
import { ArtError, ART_LIMITS } from './character-art.js';
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

  /** 본문의 JSON 카드({ card }) 또는 base64 파일({ png }, { charx })에서 카드와 그림을 꺼냅니다. */
  unpack(payload) {
    if (isObj(payload?.card)) return { card: payload.card, picture: null, expressions: [], dropped: [] };
    if (typeof payload?.png === 'string' && payload.png) {
      const png = Buffer.from(payload.png, 'base64');
      const picture = typeof payload.portrait === 'string' && payload.portrait
        ? Buffer.from(payload.portrait, 'base64') : stripCardText(png);
      return { card: cardFromPng(png), picture, expressions: [], dropped: [] };
    }
    if (typeof payload?.charx === 'string' && payload.charx) {
      const { card, icon, expressions, dropped } = cardFromCharx(Buffer.from(payload.charx, 'base64'));
      return { card, picture: icon, expressions, dropped };
    }
    throw new CardError('가져올 카드 파일이 없습니다.');
  }

  /**
   * 카드를 새 캐릭터로 넣습니다. 카드에 세계관(character_book)이 있으면 그 캐릭터에 묶인 로어북으로 함께 만듭니다.
   * PNG 카드면 그림을 프로필 그림으로 씁니다. 브라우저가 줄여 보낸 그림(portrait)이 있으면 그걸, 없으면 원본에서 카드 글만 벗겨 씁니다.
   * CHARX 카드의 프로필과 표정 그림도 함께 저장합니다. 표정 개수는 앱의 한도에 맞춥니다.
   * 그림을 못 쓰더라도 캐릭터는 만들고 dropped 에 적습니다.
   * @returns {{character: object, lorebook: object|null, dropped: string[]}}
   */
  async import(actor, payload) {
    const { card, picture, expressions, dropped: extra } = this.unpack(payload);
    const { character: added, book, dropped } = parseCard(card);
    dropped.push(...extra);
    let character = this.store.characters.add(this.access.stamp(actor, added));

    if (picture) {
      try {
        character = await this.art.setPortrait(actor, character.id, picture);
      } catch (err) {
        if (!(err instanceof ArtError)) throw err;
        dropped.push(`프로필 그림 (${err.message})`);
      }
    }

    for (const { label, data } of expressions.slice(0, ART_LIMITS.expressions)) {
      try {
        character = await this.art.setExpression(actor, character.id, label, data);
      } catch (err) {
        if (!(err instanceof ArtError)) throw err;
        dropped.push(`표정 '${label}' (${err.message})`);
      }
    }
    if (expressions.length > ART_LIMITS.expressions) {
      dropped.push(`표정 그림 ${expressions.length - ART_LIMITS.expressions}개 (최대 ${ART_LIMITS.expressions}개)`);
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

  /** 내보낼 캐릭터와 그 캐릭터에 묶인, actor 가 볼 수 있는 로어북을 모읍니다. */
  #exportSource(actor, id) {
    const character = this.access.findCharacter(actor, id);
    if (!character) throw new NotFound('없는 캐릭터입니다.');
    const books = this.access.lorebooks(actor).filter((b) => b.characterIds?.includes(character.id));
    return { character, books };
  }

  /** 캐릭터를 세계관과 함께 V2 JSON 카드로 내보냅니다. */
  export(actor, id) {
    const { character, books } = this.#exportSource(actor, id);
    return { filename: `${safeName(character.name)}.json`, card: buildCard(character, books) };
  }

  /** 안전한 이름의 그림 파일만 읽습니다. 없거나 읽지 못하는 파일은 건너뜁니다. */
  async #readArt(characterId, file) {
    if (!file || !this.art.isSafe(characterId, file)) return null;
    try {
      const data = await readFile(this.art.path(characterId, file));
      return { data, ext: path.extname(file).slice(1).toLowerCase() };
    } catch {
      return null;
    }
  }

  /** 캐릭터를 세계관·프로필·표정 그림과 함께 V3 CHARX 파일로 내보냅니다. */
  async exportCharx(actor, id) {
    const { character, books } = this.#exportSource(actor, id);
    const card = buildCardV3(character, books);
    const icon = await this.#readArt(character.id, character.portrait);
    const expressions = [];
    for (const { label, file } of character.expressions || []) {
      const picture = await this.#readArt(character.id, file);
      if (picture) expressions.push({ label, ...picture });
    }
    return { filename: `${safeName(character.name)}.charx`, data: buildCharx(card, { icon, expressions }) };
  }
}
