/**
 * 캐릭터의 그림: 프로필 그림 한 장과 표정 그림들. data/portraits/<캐릭터 id>/<파일> 에 두고,
 * 캐릭터 기록에는 파일 이름만 적습니다 (portrait, expressions[{ label, file }]).
 * 에셋 그림은 원래 이름과 파일 이름을 함께 적습니다 (assets[{ name, file }]).
 * 파일 종류는 서버가 파일 머리로 알아냅니다 — 브라우저가 보낸 종류·이름은 믿지 않습니다.
 */
import { ImageFiles } from './image-files.js';
import { sniffImage } from './attachments.js';
import { Access } from './access.js';
import { AppError } from './errors.js';

export const ART_LIMITS = { bytes: 8 * 1024 * 1024, expressions: 16, labelChars: 12 };
export const ASSET_LIMITS = { count: 200, nameChars: 80, totalBytes: 64 * 1024 * 1024 };

/** 사용자에게 그대로 보여 줘도 되는 그림 오류 */
export class ArtError extends AppError {}

/** 표정 이름. 모델이 `[[표정: 이름]]` 으로 고르므로 표식에 쓰는 글자는 뺍니다. */
export const cleanLabel = (v) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f<>[\]|:：]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, ART_LIMITS.labelChars);

const sameLabel = (a, b) => a.toLowerCase() === b.toLowerCase();

/** 카드에서 그림을 부르는 이름. 확장자는 이름의 일부로 보존합니다. */
export const cleanAssetName = (v) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f<>"'`]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, ASSET_LIMITS.nameChars);

const assetKey = (name) => String(name ?? '').trim().toLowerCase();
const sameAssetName = (a, b) => assetKey(a) === assetKey(b);

export class CharacterArt {
  constructor(store, root, access = new Access(store)) {
    this.store = store;
    this.access = access;
    this.files = new ImageFiles(root);
  }

  isSafe(characterId, file) {
    return this.files.isSafe(characterId, file);
  }

  path(characterId, file) {
    return this.files.path(characterId, file);
  }

  /** 그림 파일을 보내도 되는지. 이름이 안전하고, actor 가 그 캐릭터를 볼 수 있어야 합니다. */
  canServe(actor, characterId, file) {
    return this.isSafe(characterId, file) && Boolean(this.access.findCharacter(actor, characterId));
  }

  character(actor, id) {
    const character = this.access.findCharacter(actor, id);
    if (!character) throw new ArtError('없는 캐릭터입니다.', 404);
    return character;
  }

  /** 그림 파일이 맞는지 보고 저장합니다. */
  async keep(characterId, buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ArtError('그림 파일이 비어 있습니다.');
    if (buffer.length > ART_LIMITS.bytes) throw new ArtError('그림이 너무 큽니다. 8MB 이하로 줄여 주세요.');
    const kind = sniffImage(buffer);
    if (!kind) throw new ArtError('PNG·JPEG·WebP 그림만 쓸 수 있습니다.');
    return (await this.files.save(characterId, buffer, kind.ext)).file;
  }

  async setPortrait(actor, id, buffer) {
    const character = this.character(actor, id);
    const file = await this.keep(id, buffer);
    if (character.portrait) await this.files.remove(id, character.portrait);
    return this.store.characters.update(id, { portrait: file });
  }

  async clearPortrait(actor, id) {
    const character = this.character(actor, id);
    if (character.portrait) await this.files.remove(id, character.portrait);
    return this.store.characters.update(id, { portrait: '' });
  }

  /** 같은 이름의 표정이 있으면 그림만 바꿉니다. */
  async setExpression(actor, id, label, buffer) {
    const character = this.character(actor, id);
    const name = cleanLabel(label);
    if (!name) throw new ArtError('표정 이름을 적어 주세요.');
    const list = character.expressions || [];
    const old = list.find((e) => sameLabel(e.label, name));
    if (!old && list.length >= ART_LIMITS.expressions) {
      throw new ArtError(`표정은 ${ART_LIMITS.expressions}개까지 둘 수 있습니다.`);
    }
    const file = await this.keep(id, buffer);
    if (old) await this.files.remove(id, old.file);
    const next = old ? list.map((e) => (e === old ? { label: old.label, file } : e)) : [...list, { label: name, file }];
    return this.store.characters.update(id, { expressions: next });
  }

  async removeExpression(actor, id, label) {
    const character = this.character(actor, id);
    const list = character.expressions || [];
    const gone = list.find((e) => sameLabel(e.label, cleanLabel(label)));
    if (!gone) throw new ArtError('없는 표정입니다.', 404);
    await this.files.remove(id, gone.file);
    return this.store.characters.update(id, { expressions: list.filter((e) => e !== gone) });
  }

  /** 카드 순서대로 에셋 그림을 넣고, 같은 이름은 그림만 바꿉니다. 잘못된 그림은 안내하고 계속합니다. */
  async addAssets(actor, id, list) {
    const character = this.character(actor, id);
    const failed = [];
    let skipped = 0;
    if (!list.length) return { character, failed, skipped };
    const next = [...(character.assets || [])];
    const seen = new Set();
    let totalBytes = 0;
    let bytesFull = false;
    for (const { name: rawName, data } of list) {
      const name = cleanAssetName(rawName);
      if (!name) {
        failed.push({ name: rawName, message: '이름이 없습니다.' });
        continue;
      }
      const key = assetKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const index = next.findIndex((asset) => sameAssetName(asset.name, name));
      if (index < 0 && next.length >= ASSET_LIMITS.count) {
        skipped++;
        continue;
      }
      const bytes = Buffer.isBuffer(data) ? data.length : 0;
      if (bytesFull || totalBytes + bytes > ASSET_LIMITS.totalBytes) {
        bytesFull = true;
        skipped++;
        continue;
      }
      let file;
      try {
        file = await this.keep(id, data);
      } catch (err) {
        if (!(err instanceof ArtError)) throw err;
        failed.push({ name, message: err.message });
        continue;
      }
      totalBytes += bytes;
      if (index >= 0) {
        const old = next[index];
        await this.files.remove(id, old.file);
        next[index] = { name: old.name, file };
      } else next.push({ name, file });
    }
    return { character: this.store.characters.update(id, { assets: next }), failed, skipped };
  }

  async removeAsset(actor, id, name) {
    const character = this.character(actor, id);
    const list = character.assets || [];
    const gone = list.find((asset) => sameAssetName(asset.name, cleanAssetName(name)));
    if (!gone) throw new ArtError('없는 에셋 그림입니다.', 404);
    await this.files.remove(id, gone.file);
    return this.store.characters.update(id, { assets: list.filter((asset) => asset !== gone) });
  }

  /** 캐릭터를 지울 때 그 캐릭터의 그림도 모두 지웁니다. */
  removeAll(id) {
    return this.files.removeAll(id);
  }
}
