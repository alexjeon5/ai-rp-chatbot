/** 장면 그림 파일. data/images/<대화 id>/<파일> 에 두고, 이름을 엄격히 검사해 그 밖으로 못 나가게 합니다. */
import path from 'node:path';
import { mkdir, writeFile, unlink, rm, copyFile } from 'node:fs/promises';
import { uid } from '../db.js';
import { SAFE_ID } from './records.js';

const IMAGE_FILE = /^[a-z0-9]{6,32}\.(png|jpg|webp)$/;

export class ImageFiles {
  constructor(root) {
    this.root = root;
  }

  dir(chatId) {
    return path.join(this.root, chatId);
  }

  isSafe(chatId, file) {
    return SAFE_ID.test(chatId) && IMAGE_FILE.test(file || '');
  }

  path(chatId, file) {
    return path.join(this.dir(chatId), file);
  }

  remove(chatId, file) {
    if (this.isSafe(chatId, file)) unlink(this.path(chatId, file)).catch(() => {});
  }

  /** 대화를 지울 때 그 대화의 그림도 모두 지웁니다. */
  removeAll(chatId) {
    return rm(this.dir(chatId), { recursive: true, force: true }).catch(() => {});
  }

  /** 분기한 대화가 원본의 그림을 따로 갖게 복사합니다. 원본을 지워도 분기 쪽 그림은 남습니다. 없는 파일은 건너뜁니다. */
  async copyAll(fromChatId, toChatId, files) {
    const safe = files.filter((f) => this.isSafe(fromChatId, f) && this.isSafe(toChatId, f));
    if (!safe.length) return;
    await mkdir(this.dir(toChatId), { recursive: true });
    await Promise.all(safe.map((f) => copyFile(this.path(fromChatId, f), this.path(toChatId, f)).catch(() => {})));
  }

  async save(chatId, buffer, ext) {
    const id = uid();
    const file = `${id}${Date.now().toString(36)}.${ext}`.toLowerCase();
    await mkdir(this.dir(chatId), { recursive: true });
    await writeFile(this.path(chatId, file), buffer);
    return { id, file };
  }
}
