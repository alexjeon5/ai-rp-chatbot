/** 입력창에 그림 붙이기: 고르기·붙여넣기·끌어놓기, 줄여서 올리기, 보내기 전 미리보기. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
// 이 안이면 원본을 그대로 올립니다. 스크린샷의 글자가 재압축으로 흐려지는 걸 피합니다.
const KEEP_BYTES = 1.5 * 1024 * 1024;
const NATIVE = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class AttachTray {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    /** 올려 두었지만 아직 보내지 않은 그림들: { chatId, file, name, url } */
    this.items = [];
    this.uploading = 0;

    on('btn-attach', 'click', () => $('attach-file').click());
    on('attach-file', 'change', (e) => {
      this.addFiles([...e.target.files]);
      e.target.value = '';
    });
    on('attach-tray', 'click', (e) => {
      const at = e.target.closest('[data-remove]')?.dataset.remove;
      if (at !== undefined) this.remove(Number(at));
    });
    $('input').addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });
    const composer = $('composer');
    composer.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    });
    composer.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });
  }

  get busy() {
    return this.uploading > 0;
  }

  /** 보낼 때 서버에 알려 줄 목록 */
  refs() {
    return this.items.map((i) => ({ file: i.file, name: i.name }));
  }

  /** 메시지에 붙여 보냈으니, 서버의 파일은 그대로 두고 미리보기만 치웁니다. */
  release() {
    for (const i of this.items) URL.revokeObjectURL(i.url);
    this.items = [];
    this.paint();
  }

  /** 다른 대화로 옮겨 가면 보내지 않은 그림은 버립니다. 서버에 올라간 파일도 지웁니다. */
  reset() {
    for (const i of this.items) api.discardAttachment(i.chatId, i.file).catch(() => {});
    this.release();
  }

  remove(at) {
    const [gone] = this.items.splice(at, 1);
    if (!gone) return;
    URL.revokeObjectURL(gone.url);
    api.discardAttachment(gone.chatId, gone.file).catch(() => {});
    this.paint();
  }

  async addFiles(files) {
    const chat = this.state.chat;
    if (!chat) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        ui.toast(`「${file.name}」은(는) 그림 파일이 아닙니다`);
        continue;
      }
      if (this.items.length + this.uploading >= MAX_IMAGES) {
        ui.toast(`그림은 한 번에 ${MAX_IMAGES}장까지 붙일 수 있습니다`);
        break;
      }
      this.uploading += 1;
      this.paint();
      try {
        const blob = await this.shrink(file);
        const saved = await api.uploadAttachment(chat.id, blob);
        if (this.state.chat !== chat) {
          api.discardAttachment(chat.id, saved.file).catch(() => {});
        } else {
          this.items.push({ chatId: chat.id, file: saved.file, name: file.name || '붙여넣은 그림', url: URL.createObjectURL(blob) });
        }
      } catch (e) {
        ui.toast(`그림을 붙이지 못했습니다 — ${e.message}`);
      } finally {
        this.uploading -= 1;
        this.paint();
      }
    }
  }

  /** 긴 변이 MAX_SIDE 를 넘거나 브라우저 밖 형식(GIF·HEIC 등)이면 JPEG 로 줄여 다시 만듭니다. */
  async shrink(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error('이 형식의 그림은 읽을 수 없습니다');
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && NATIVE.has(file.type) && file.size <= KEEP_BYTES) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('그림을 줄이지 못했습니다');
    return blob;
  }

  paint() {
    const tray = $('attach-tray');
    tray.hidden = !this.items.length && !this.uploading;
    tray.innerHTML = this.items
      .map((i, n) => `<span class="attach-chip"><img src="${i.url}" alt="${esc(i.name)}" title="${esc(i.name)}">
        <button type="button" class="attach-x" data-remove="${n}" aria-label="빼기" title="빼기">×</button></span>`)
      .join('') + (this.uploading ? '<span class="attach-chip is-loading" aria-label="올리는 중"></span>'.repeat(this.uploading) : '');
    $('btn-attach').setAttribute('aria-pressed', String(this.items.length > 0));
  }
}
