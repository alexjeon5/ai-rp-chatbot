/**
 * 배경 그림 모음. 캐릭터와 상관없이 한 사람의 모든 대화가 함께 씁니다.
 * data/backgrounds/<id>.json 에 {id, name, file}, 그림은 data/backgrounds/img/<id>/<파일> 에 둡니다.
 * 목록·이름 비교·개수 한도는 모두 actor 가 볼 수 있는 배경 안에서 셉니다.
 */
import { ImageFiles } from './image-files.js';
import { sniffImage } from './attachments.js';
import { ArtError, ART_LIMITS, cleanLabel } from './character-art.js';
import { Access } from './access.js';

export const BACKGROUND_LIMIT = 30;

export class Backgrounds {
  constructor(store, root, access = new Access(store)) {
    this.store = store;
    this.access = access;
    this.files = new ImageFiles(root);
  }

  list(actor) {
    return this.access.backgrounds(actor);
  }

  /** 화면 표식으로 고를 수 있는 장소 이름. 대화에서는 그 대화의 주인을 actor 로 넘깁니다. */
  names(actor) {
    return this.list(actor).map((b) => b.name);
  }

  /** 그림 파일을 보내도 되는지. 이름이 안전하고, actor 가 그 배경을 볼 수 있어야 합니다. */
  canServe(actor, id, file) {
    return this.isSafe(id, file) && Boolean(this.access.findBackground(actor, id));
  }

  isSafe(id, file) {
    return this.files.isSafe(id, file);
  }

  path(id, file) {
    return this.files.path(id, file);
  }

  /** 같은 이름이 이미 있으면 그림만 바꿉니다. */
  async add(actor, name, buffer) {
    const label = cleanLabel(name);
    if (!label) throw new ArtError('배경 이름을 적어 주세요.');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ArtError('그림 파일이 비어 있습니다.');
    if (buffer.length > ART_LIMITS.bytes) throw new ArtError('그림이 너무 큽니다. 8MB 이하로 줄여 주세요.');
    const kind = sniffImage(buffer);
    if (!kind) throw new ArtError('PNG·JPEG·WebP 그림만 쓸 수 있습니다.');

    const mine = this.list(actor);
    const same = mine.find((b) => b.name.toLowerCase() === label.toLowerCase());
    if (!same && mine.length >= BACKGROUND_LIMIT) {
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

  rename(actor, id, name) {
    const item = this.access.findBackground(actor, id);
    if (!item) throw new ArtError('없는 배경입니다.', 404);
    const label = cleanLabel(name);
    if (!label) throw new ArtError('배경 이름을 적어 주세요.');
    if (this.list(actor).some((b) => b.id !== id && b.name.toLowerCase() === label.toLowerCase())) {
      throw new ArtError('같은 이름의 배경이 이미 있습니다.');
    }
    return this.store.backgrounds.update(id, { name: label });
  }

  async remove(actor, id) {
    const item = this.access.findBackground(actor, id);
    if (!item) throw new ArtError('없는 배경입니다.', 404);
    await this.store.backgrounds.remove(item.id);
    await this.files.removeAll(item.id);
  }
}
