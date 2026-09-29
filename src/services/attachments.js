/**
 * 사용자가 메시지에 붙이는 그림 파일. data/uploads/<대화 id>/<파일> 에 두고, 모델에 보낼 때만 base64 로 풀어 줍니다.
 * 파일 이름과 종류는 서버가 정합니다 — 브라우저가 보낸 이름·종류는 믿지 않습니다.
 */
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageFiles } from './image-files.js';

export const ATTACHMENT_LIMITS = { perMessage: 4, bytes: 10 * 1024 * 1024, nameChars: 80 };

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** 파일 머리의 표식으로 종류를 알아냅니다. 지원하지 않는 형식이면 null. */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, ATTACHMENT_LIMITS.nameChars);

export class Attachments {
  constructor(root) {
    this.files = new ImageFiles(root);
  }

  isSafe(chatId, file) {
    return this.files.isSafe(chatId, file);
  }

  path(chatId, file) {
    return this.files.path(chatId, file);
  }

  remove(chatId, file) {
    this.files.remove(chatId, file);
  }

  removeAll(chatId) {
    return this.files.removeAll(chatId);
  }

  copyAll(fromChatId, toChatId, files) {
    return this.files.copyAll(fromChatId, toChatId, files);
  }

  /** 올린 파일을 저장합니다. 그림 형식이 아니면 null. */
  async save(chatId, buffer) {
    const kind = sniffImage(buffer);
    if (!kind) return null;
    const { file } = await this.files.save(chatId, buffer, kind.ext);
    return { file, mime: kind.mime, bytes: buffer.length };
  }

  /**
   * 화면이 보낸 첨부 목록을 저장된 파일과 맞춰 봅니다. 이 대화에 실제로 올라온 파일만 남기고 개수를 자릅니다.
   * @param {{file: string, name?: string}[]} refs
   */
  async resolve(chatId, refs) {
    if (!Array.isArray(refs)) return [];
    const out = [];
    const seen = new Set();
    for (const ref of refs) {
      const file = String(ref?.file ?? '');
      if (out.length >= ATTACHMENT_LIMITS.perMessage) break;
      if (seen.has(file) || !this.isSafe(chatId, file)) continue;
      const info = await stat(this.path(chatId, file)).catch(() => null);
      if (!info?.isFile()) continue;
      seen.add(file);
      const ext = path.extname(file).slice(1);
      out.push({ id: file.replace(/\.\w+$/, ''), file, mime: MIME_BY_EXT[ext], name: cleanName(ref.name), bytes: info.size });
    }
    return out;
  }

  /**
   * 모델에 보낼 히스토리의 attachments 를 base64 그림(images)으로 바꿉니다. 읽지 못한 파일은 건너뜁니다.
   * 원본 히스토리는 건드리지 않습니다.
   */
  async inline(chatId, history) {
    return Promise.all(history.map(async ({ attachments, ...turn }) => {
      if (!attachments?.length) return turn;
      const images = [];
      for (const a of attachments) {
        if (!this.isSafe(chatId, a.file)) continue;
        const data = await readFile(this.path(chatId, a.file)).catch(() => null);
        if (data) images.push({ mime: a.mime, data: data.toString('base64') });
      }
      return images.length ? { ...turn, images } : turn;
    }));
  }
}
