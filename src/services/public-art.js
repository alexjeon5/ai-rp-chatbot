/**
 * 캐릭터 그림(프로필·표정)을 로그인 없이 볼 수 있는 서명된 주소로 내보내기. 디스코드 웹훅 아바타와 표정 썸네일에 씁니다.
 * 디스코드는 우리 서버에 로그인할 수 없으므로 주소에 서명을 붙여, 서명이 맞는 주소만 그림을 줍니다.
 *
 *   주소  <PUBLIC_BASE_URL>/pub/art/<캐릭터 id>/<파일>?s=<서명>
 *   서명  HMAC-SHA256(비밀, "art:<캐릭터 id>/<파일>") 앞 16바이트, base64url
 *   비밀  PUBLIC_ART_SECRET 환경변수. 없으면 data/discord.json 에 한 번 만들어 둡니다. 바꾸면 옛 주소는 모두 무효
 *
 * 프로필·표정 그림만 나갑니다. 장면 그림·붙인 그림은 이 길로 나가지 않습니다.
 * 그림을 바꾸면 파일 이름이 바뀌므로 옛 주소는 저절로 죽습니다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cleanLabel } from './character-art.js';

const sameLabel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export class PublicArt {
  /**
   * @param {{ store, art: import('./character-art.js').CharacterArt, baseUrl?: string, secret?: string }} deps
   *   baseUrl 이 없으면 주소를 만들지 않습니다(아바타 없이 이름만).
   */
  constructor({ store, art, baseUrl = '', secret = '' }) {
    Object.assign(this, { store, art });
    this.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    this.fixedSecret = String(secret || '').trim();
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  get secret() {
    if (this.fixedSecret) return this.fixedSecret;
    const doc = this.store.discordDoc;
    if (!doc.data.artSecret) {
      doc.data.artSecret = randomBytes(32).toString('base64url');
      doc.save();
    }
    return doc.data.artSecret;
  }

  sign(characterId, file) {
    return createHmac('sha256', this.secret).update(`art:${characterId}/${file}`).digest().subarray(0, 16).toString('base64url');
  }

  /** 서명이 맞고, 그 파일이 지금 그 캐릭터의 프로필이나 표정 그림이면 파일 경로. 아니면 null. */
  pathFor(characterId, file, signature) {
    if (!this.art.isSafe(characterId, file)) return null;
    const expected = Buffer.from(this.sign(characterId, file));
    const given = Buffer.from(String(signature || ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const character = this.store.characters.get(characterId);
    const current = character && (character.portrait === file || (character.expressions || []).some((e) => e.file === file));
    return current ? this.art.path(characterId, file) : null;
  }

  url(characterId, file) {
    if (!this.enabled || !characterId || !file) return null;
    return `${this.baseUrl}/pub/art/${encodeURIComponent(characterId)}/${encodeURIComponent(file)}?s=${this.sign(characterId, file)}`;
  }

  /** 캐릭터의 프로필 그림 주소. 1회성 캐릭터(id 없음)나 그림이 없으면 null. */
  portraitUrl(character) {
    return this.url(character?.id, character?.portrait);
  }

  /** 표정 그림 주소. 그 이름의 표정이 없으면 null. */
  expressionUrl(character, label) {
    const want = cleanLabel(label);
    const found = want && (character?.expressions || []).find((e) => sameLabel(e.label, want));
    return found ? this.url(character.id, found.file) : null;
  }
}
