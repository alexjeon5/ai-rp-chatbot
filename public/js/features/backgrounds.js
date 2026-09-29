/** 배경 그림 창: 장소 이름을 붙여 올려 두면, 비주얼 노벨 화면이 답변의 장소 표식에 맞춰 바꿔 보여 줍니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { downscale } from '../core/image-resize.js';
import { $, esc, on } from '../core/dom.js';

const LIMIT = 30;

export class BackgroundsDialog {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-backgrounds');
    on('btn-backgrounds', 'click', () => this.open());
    on('bg-pick', 'click', () => this.pick());
    on('bg-name', 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.pick(); }
    });
    on('bg-file', 'change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) this.add(file);
    });
    on('bg-list', 'click', (e) => this.onRow(e));
    on('bg-close', 'click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.app.stage.sync());
  }

  open() {
    this.paint();
    this.dialog.showModal();
  }

  paint() {
    const list = this.state.backgrounds;
    $('bg-list').innerHTML = list.length
      ? list.map((b) => `<li class="bg-item" data-id="${b.id}">
        <img src="${this.state.backgroundUrl(b.name)}" alt="">
        <span class="bg-name">${esc(b.name)}</span>
        <button class="ghost-btn" type="button" data-act="rename">이름 바꾸기</button>
        <button class="ghost-btn danger" type="button" data-act="remove">지우기</button>
      </li>`).join('')
      : '<li class="rail-empty">아직 올린 배경이 없습니다.</li>';
    $('bg-count').textContent = `${list.length} / ${LIMIT}`;
  }

  pick() {
    if (!$('bg-name').value.trim()) return ui.toast('배경 이름을 먼저 적어 주세요. 예: 교실, 해질녘 바닷가');
    $('bg-file').click();
  }

  async add(file) {
    const name = $('bg-name').value.trim();
    try {
      const blob = await downscale(file, { max: 1600, quality: 0.85 });
      if (!blob) throw new Error('읽을 수 없는 그림입니다.');
      await api.addBackground(name, blob);
      this.state.backgrounds = await api.backgrounds();
      $('bg-name').value = '';
      this.paint();
      ui.toast(`배경을 넣었습니다 — ${name}`);
    } catch (err) {
      ui.toast(`올리지 못했습니다 — ${err.message}`);
    }
  }

  async onRow(e) {
    const btn = e.target.closest('[data-act]');
    const id = btn?.closest('.bg-item')?.dataset.id;
    const item = this.state.backgrounds.find((b) => b.id === id);
    if (!item) return;
    try {
      if (btn.dataset.act === 'remove') {
        if (!confirm(`「${item.name}」 배경을 지울까요?`)) return;
        await api.removeBackground(id);
      } else {
        const name = prompt('배경 이름', item.name)?.trim();
        if (!name || name === item.name) return;
        await api.renameBackground(id, name);
      }
      this.state.backgrounds = await api.backgrounds();
      this.paint();
    } catch (err) {
      ui.toast(`처리하지 못했습니다 — ${err.message}`);
    }
  }
}
