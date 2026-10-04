/** 캐릭터 카드 가져오기·내보내기. 카드는 JSON, PNG, CHARX(카드와 그림을 묶은 ZIP) 셋 중 하나입니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';
import { downscale, blobToBase64 } from '../core/image-resize.js';

const isPng = (file) => file.type === 'image/png' || /\.png$/i.test(file.name);
const isCharx = (file) => /\.charx$/i.test(file.name);
const CHARX_MAX = 28 * 1024 * 1024;

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
    on('c-export-charx', 'click', () => this.download(this.state.editingCharacterId, 'charx'));

    // characters.js 의 openDialog 와 c-copy 핸들러가 바꾸는 c-export 의 숨김 상태를 따릅니다.
    const exportButton = $('c-export');
    const syncExportHidden = () => { $('c-export-charx').hidden = exportButton.hidden; };
    syncExportHidden();
    this.exportObserver = new MutationObserver(syncExportHidden);
    this.exportObserver.observe(exportButton, { attributes: true, attributeFilter: ['hidden'] });
  }

  /**
   * 파일을 서버가 읽을 본문으로. PNG 는 그대로 base64 로 보내고, 카드 그림은 줄여서 portrait 로 함께 보냅니다
   * (카드 그림은 수 MB 일 수 있어서). 줄이지 못하면 서버가 원본 그림을 씁니다. CHARX 는 그대로 base64 로 보내고,
   * JSON 은 여기서 한 번 해석해 봅니다.
   */
  async payloadOf(file) {
    if (isCharx(file)) {
      if (file.size > CHARX_MAX) throw new Error('CHARX 파일이 너무 큽니다 (28MB 까지).');
      return { charx: await blobToBase64(file) };
    }
    if (isPng(file)) {
      const small = await downscale(file, { max: 1024 });
      return { png: await blobToBase64(file), ...(small && small !== file ? { portrait: await blobToBase64(small) } : {}) };
    }
    try {
      return { card: JSON.parse(await file.text()) };
    } catch {
      throw new Error('JSON 파일을 읽지 못했습니다. 캐릭터 카드(.json·.png·.charx)인지 확인해 주세요.');
    }
  }

  async importFile(file) {
    const { state, app } = this;
    try {
      const { character, lorebook, dropped = [], notices = [] } = await api.importCard(await this.payloadOf(file));
      [state.characters, state.lorebooks] = await Promise.all([api.characters(), api.lorebooks()]);
      app.characters.rememberTab('mine');
      app.characters.paint();
      ui.toast(
        `「${character.name}」을(를) 가져왔습니다` +
        (character.expressions?.length ? ` · 표정 ${character.expressions.length}개` : '') +
        (lorebook ? ` · 세계관 ${lorebook.entries.length}항목` : '') +
        (notices.length ? ` · ${notices.join(' · ')}` : '') +
        (dropped.length ? ` (옮기지 못함: ${dropped.join(', ')})` : '')
      );
    } catch (err) {
      ui.toast(`가져오지 못했습니다 — ${err.message}`);
    }
  }

  download(id, format) {
    if (!id) return;
    const a = document.createElement('a');
    a.href = api.cardUrl(id, format);
    a.download = '';
    a.click();
  }
}
