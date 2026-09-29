/**
 * 배경 그림 모음. 캐릭터와 상관없이 모든 대화가 함께 씁니다.
 * data/backgrounds/<id>.json 에 {id, name, file}, 그림은 data/backgrounds/img/<id>/<파일> 에 둡니다.
 */
import { ImageFiles } from './image-files.js';
import { sniffImage } from './attachments.js';
import { ArtError, ART_LIMITS, cleanLabel } from './character-art.js';

export const BACKGROUND_LIMIT = 30;

export class Backgrounds {
  constructor(store, root) {
    this.store = store;
    this.files = new ImageFiles(root);
  }

  list() {
    return this.store.backgrounds.all();
  }

  names() {
    return this.list().map((b) => b.name);
  }

  isSafe(id, file) {
    return this.files.isSafe(id, file);
  }

  path(id, file) {
    return this.files.path(id, file);
  }

  /** 같은 이름이 이미 있으면 그림만 바꿉니다. */
  async add(name, buffer) {
    const label = cleanLabel(name);
    if (!label) throw new ArtError('배경 이름을 적어 주세요.');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ArtError('그림 파일이 비어 있습니다.');
    if (buffer.length > ART_LIMITS.bytes) throw new ArtError('그림이 너무 큽니다. 8MB 이하로 줄여 주세요.');
    const kind = sniffImage(buffer);
    if (!kind) throw new ArtError('PNG·JPEG·WebP 그림만 쓸 수 있습니다.');

    const same = this.list().find((b) => b.name.toLowerCase() === label.toLowerCase());
    if (!same && this.store.backgrounds.size >= BACKGROUND_LIMIT) {
      throw new ArtError(`배경은 ${BACKGROUND_LIMIT}개까지 둘 수 있습니다.`);
    }
    if (same) {
      const { file } = await this.files.save(same.id, buffer, kind.ext);
      await this.files.remove(same.id, same.file);
      return this.store.backgrounds.update(same.id, { file });
    }
    const item = this.store.backgrounds.add({ name: label, file: '' });
    const { file } = await this.files.save(item.id, buffer, kind.ext);
    return this.store.backgrounds.update(item.id, { file });
  }

  rename(id, name) {
    const item = this.store.backgrounds.get(id);
    if (!item) throw new ArtError('없는 배경입니다.', 404);
    const label = cleanLabel(name);
    if (!label) throw new ArtError('배경 이름을 적어 주세요.');
    if (this.list().some((b) => b.id !== id && b.name.toLowerCase() === label.toLowerCase())) {
      throw new ArtError('같은 이름의 배경이 이미 있습니다.');
    }
    return this.store.backgrounds.update(id, { name: label });
  }

  async remove(id) {
    if (!this.store.backgrounds.get(id)) throw new ArtError('없는 배경입니다.', 404);
    await this.store.backgrounds.remove(id);
    await this.files.removeAll(id);
  }
}
