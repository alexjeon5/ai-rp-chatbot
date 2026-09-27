/** 내 페르소나 창: 목록(사용·수정·삭제), 아래 입력칸(성별·나이·특징), 랜덤 페르소나. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

const GENDER_PRESETS = ['', '여성', '남성'];

export class Personas {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-persona');
    // 수정 중인 페르소나 id. null 이면 아래 칸은 새 페르소나를 만드는 데 씁니다.
    this.editingId = null;
    // 칸에 올라와 있는 특징 목록.
    this.traits = [];
    // 지금 화면에 떠 있는 씨앗 태그. 칩을 눌러 항목 하나만 다시 굴릴 때 기준이 됩니다.
    this.seeds = null;
    this.seedFields = [];

    on('p-gender', 'change', () => {
      const custom = $('p-gender').value === 'custom';
      $('p-gender-custom').hidden = !custom;
      if (custom) $('p-gender-custom').focus();
    });
    on('p-trait-add', 'click', () => this.addTraits());
    on('p-trait-input', 'keydown', (e) => {
      // 한글 조합 중 Enter 는 글자 확정이므로 넘깁니다.
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      this.addTraits();
    });
    on('p-traits', 'click', (e) => {
      const btn = e.target.closest('[data-trait]');
      if (!btn) return;
      this.traits.splice(Number(btn.dataset.trait), 1);
      this.paintTraits();
    });
    on('btn-personas', 'click', () => {
      this.paintList();
      this.fill(null);
      this.dialog.showModal();
    });
    on('p-edit-cancel', 'click', () => this.fill(null));
    on('p-add', 'click', () => this.save());
    on('p-roll', 'click', () => this.roll());
    // 성인 여부를 바꾸면 풀이 통째로 달라지므로, 지금 뽑힌 태그는 버리고 다시 시작합니다.
    on('p-adult', 'change', () => {
      this.showSeeds(null);
      this.seedNote('');
    });
    on('p-seeds', 'click', (e) => {
      const chip = e.target.closest('[data-key]');
      if (chip) this.roll([chip.dataset.key]);
    });
    on('p-write', 'click', () => this.write());
    on('persona-list', 'click', (e) => this.onListClick(e));
  }

  paintList() {
    ui.renderPersonaList(this.state.personas, this.state.settings.activePersonaId);
  }

  setGender(value = '') {
    const preset = GENDER_PRESETS.includes(value);
    $('p-gender').value = preset ? value : 'custom';
    $('p-gender-custom').value = preset ? '' : value;
    $('p-gender-custom').hidden = preset;
  }

  readGender() {
    return $('p-gender').value === 'custom' ? $('p-gender-custom').value.trim() : $('p-gender').value;
  }

  paintTraits() {
    $('p-traits').innerHTML = this.traits
      .map((t, i) => `<li class="trait-item"><span>${esc(t)}</span>` +
        `<button type="button" data-trait="${i}" aria-label="${esc(t)} 빼기">✕</button></li>`)
      .join('');
  }

  /** 입력칸의 글을 특징으로 더합니다. 쉼표·줄바꿈으로 여러 개를 한 번에 넣어도 나눠서 들어갑니다. */
  addTraits() {
    const input = $('p-trait-input');
    for (const t of input.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
      if (!this.traits.includes(t)) this.traits.push(t);
    }
    input.value = '';
    this.paintTraits();
  }

  /** 아래 입력칸을 페르소나 하나로 채웁니다. 비우면 새 페르소나를 만드는 상태로 돌아갑니다. */
  fill(p = null) {
    this.editingId = p?.id || null;
    $('p-name').value = p?.name || '';
    $('p-age').value = p?.age || '';
    this.setGender(p?.gender || '');
    $('p-description').value = p?.description || '';
    $('p-trait-input').value = '';
    this.traits = [...(p?.traits || [])];
    this.paintTraits();
    $('p-form-title').textContent = p ? `'${p.name}' 수정` : '새 페르소나';
    $('p-add').textContent = p ? '저장' : '페르소나 추가';
    $('p-add').classList.toggle('send-btn', Boolean(p));
    $('p-add').classList.toggle('ghost-btn', !p);
    $('p-edit-cancel').hidden = !p;
    this.showSeeds(null);
    this.seedNote('');
  }

  async save() {
    const { state, app } = this;
    const name = $('p-name').value.trim();
    if (!name) return ui.toast('이름을 입력해 주세요');
    // 입력칸에 적어 두고 추가를 안 누른 특징도 함께 넣습니다.
    if ($('p-trait-input').value.trim()) this.addTraits();
    const body = { name, gender: this.readGender(), age: $('p-age').value.trim(), description: $('p-description').value.trim(), traits: this.traits };
    const editing = this.editingId;
    try {
      if (editing) await api.updatePersona(editing, body);
      else await api.createPersona(body);
    } catch (e) {
      return ui.toast(`저장하지 못했습니다 — ${e.message}`);
    }
    state.personas = await api.personas();
    this.fill(null);
    this.paintList();
    app.view.paintPersona();
    app.view.paintSub();
    if (editing) {
      // 이 페르소나를 쓰는 대화라면 다음 답변부터 바뀐 내용이 들어갑니다.
      if (state.chat && !state.run) app.view.paintThread();
      app.composer.refreshContext();
      ui.toast(`'${name}' 을(를) 고쳤습니다 — 다음 답변부터 반영됩니다`);
    }
  }

  async onListClick(e) {
    const { state, app } = this;
    const use = e.target.closest('[data-use]');
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const p = state.personas.find((x) => x.id === edit.dataset.edit);
      if (!p) return;
      this.fill(p);
      $('p-name').focus();
      $('p-form-title').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (use) {
      state.settings = await api.saveSettings({ activePersonaId: use.dataset.use });
      ui.toast('사용할 페르소나를 바꿨습니다');
    } else if (del) {
      if (!confirm('이 페르소나를 삭제할까요?')) return;
      await api.deletePersona(del.dataset.del);
      if (this.editingId === del.dataset.del) this.fill(null);
      state.personas = await api.personas();
    } else return;
    this.paintList();
    // 지운 페르소나를 쓰던 대화는 기본 페르소나로 돌아가므로 상단도 다시 그립니다.
    app.view.paintPersona();
    app.view.paintSub();
  }

  /* ---------------- 랜덤 페르소나 ---------------- */

  showSeeds(seeds, fields) {
    this.seeds = seeds;
    if (fields?.length) this.seedFields = fields;
    ui.renderSeedChips(this.seeds, this.seedFields);
    $('p-seed-actions').hidden = !this.seeds;
    if (this.seeds?.name) $('p-name').value = this.seeds.name;
    // 성별·나이대는 따로 칸이 있으니 굴린 값을 바로 옮겨 둡니다.
    if (this.seeds?.gender) this.setGender(this.seeds.gender);
    if (this.seeds?.age) $('p-age').value = this.seeds.age;
  }

  seedNote(text = '') {
    $('p-seed-note').textContent = text;
  }

  async roll(only = null) {
    try {
      const { seeds, fields } = await api.rollPersonaSeeds(only ? this.seeds : {}, only, $('p-adult').checked);
      this.showSeeds(seeds, fields);
      this.seedNote('');
    } catch (e) {
      ui.toast(e.message);
    }
  }

  async write() {
    if (!this.seeds) return;
    const btn = $('p-write');
    btn.disabled = true;
    btn.textContent = '쓰는 중…';
    this.seedNote('');
    try {
      const out = await api.generatePersona(this.seeds, $('p-adult').checked);
      this.showSeeds(out.seeds);
      $('p-name').value = out.name || $('p-name').value;
      $('p-description').value = out.description;
      // 모델을 못 쓰면 태그만으로 만든 문장이 옵니다. 왜 그런지 알려 줘야 고칠 수 있습니다.
      this.seedNote(out.fallback ? `태그만으로 만들었습니다 — ${out.reason}` : '마음에 들면 아래 버튼으로 추가하세요.');
    } catch (e) {
      ui.toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '문장 만들기';
    }
  }
}
