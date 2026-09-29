/** 캐릭터 카드 가져오기·내보내기. 카드는 JSON 이거나 JSON 을 그림 파일에 숨긴 PNG 입니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';
import { downscale, blobToBase64 } from '../core/image-resize.js';

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

  /**
   * 파일을 서버가 읽을 본문으로. PNG 는 그대로 base64 로 보내고, 카드 그림은 줄여서 portrait 로 함께 보냅니다
   * (카드 그림은 수 MB 일 수 있어서). 줄이지 못하면 서버가 원본 그림을 씁니다. JSON 은 여기서 한 번 해석해 봅니다.
   */
  async payloadOf(file) {
    if (isPng(file)) {
      const small = await downscale(file, { max: 1024 });
      return { png: await blobToBase64(file), ...(small && small !== file ? { portrait: await blobToBase64(small) } : {}) };
    }
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
