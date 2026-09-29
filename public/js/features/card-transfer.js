/** 캐릭터 카드 가져오기·내보내기. 카드는 JSON 이거나 JSON 을 그림 파일에 숨긴 PNG 입니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';

/** 바이트를 base64 로. 한 번에 다 넘기면 인자가 너무 많아지므로 잘라서 이어 붙입니다. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const isPng = (file) => file.type === 'image/png' || /\.png$/i.test(file.name);

export class CardTransfer {
  constructor(app) {
    this.app = app;
    this.state = app.state;

    on('btn-import-card', 'click', () => $('card-file').click());
    on('card-file', 'change', (e) => {
      const [file] = e.target.files;
      e.target.value = '';
      if (file) this.importFile(file);
    });
    on('c-export', 'click', () => this.download(this.state.editingCharacterId));
  }

  /** 파일을 서버가 읽을 본문으로. PNG 는 그대로 base64 로, JSON 은 여기서 한 번 해석해 봅니다. */
  async payloadOf(file) {
    if (isPng(file)) return { png: toBase64(await file.arrayBuffer()) };
    try {
      return { card: JSON.parse(await file.text()) };
    } catch {
      throw new Error('JSON 파일을 읽지 못했습니다. 캐릭터 카드(.json 또는 .png)인지 확인해 주세요.');
    }
  }

  async importFile(file) {
    const { state, app } = this;
    try {
      const { character, lorebook, dropped } = await api.importCard(await this.payloadOf(file));
      [state.characters, state.lorebooks] = await Promise.all([api.characters(), api.lorebooks()]);
      app.characters.rememberTab('mine');
      app.characters.paint();
      ui.toast(
        `「${character.name}」을(를) 가져왔습니다` +
        (lorebook ? ` · 세계관 ${lorebook.entries.length}항목` : '') +
        (dropped.length ? ` (옮기지 못함: ${dropped.join(', ')})` : '')
      );
    } catch (err) {
      ui.toast(`가져오지 못했습니다 — ${err.message}`);
    }
  }

  download(id) {
    if (!id) return;
    const a = document.createElement('a');
    a.href = api.cardUrl(id);
    a.download = '';
    a.click();
  }
}
