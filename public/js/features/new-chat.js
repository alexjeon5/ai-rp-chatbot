/** 새 대화: 어떤 모드로 시작할지 묻는 창. 캐릭터 정보도 함께 보여 줍니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';
import { isLocalUrl } from '../core/state.js';

/** 내장 모드는 설명을 미리 적어 두고, 직접 만든 모드는 내용 첫 줄을 보여 줍니다. */
const MODE_NOTES = {
  default: '짧은 호흡으로 주고받습니다. *별표* 로 행동, "따옴표" 로 대사.',
  novelist: '한 장면을 통째로 그립니다. 상황만 던져 주면 주변 인물까지 등장시켜 서로 대화하게 합니다.',
  narrator: '내 페르소나가 등장하지 않습니다. 상황만 지시하면 AI 가 주인공까지 전부 서술합니다.',
  adult: '성인 소재를 다룹니다. 표기와 호흡은 롤플레이와 같습니다.',
  'adult-novel': '성인 소재를 다룹니다. 표기와 호흡은 소설 모드와 같아, 여러 인물이 함께 나옵니다.',
  'adult-narrator': '성인 소재를 다룹니다. 표기와 호흡은 연출 모드와 같습니다.',
  messenger: '묘사 없이 메신저 문자만 주고받습니다. 한 번에 짧은 문자 몇 개씩, 말풍선으로 보입니다.',
  'adult-messenger': '성인 소재를 다룹니다. 형식은 메신저 모드와 같습니다.'
};

const modeNote = (preset) =>
  MODE_NOTES[preset.id] || preset.template.split('\n').find((l) => l.trim())?.slice(0, 60) || '내용이 비어 있습니다.';

export class NewChat {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-newchat');
    // 목록의 캐릭터면 { id }, 이번만 쓰는 캐릭터면 { inline: {...} } 가 담깁니다.
    this.pending = null;

    on('nc-tabs', 'click', (e) => {
      const tab = e.target.closest('[data-audience]');
      if (tab) this.paintModeTab(tab.dataset.audience);
    });
    // 정보를 보다가 고칠 게 보이면 바로 편집 창으로 넘어갑니다.
    on('nc-character', 'click', (e) => {
      if (!e.target.closest('[data-edit-character]')) return;
      const character = this.pending?.inline || this.state.characters.find((c) => c.id === this.pending?.id);
      this.dialog.close('edit');
      app.characters.openDialog(character);
    });
    on('nc-cancel', 'click', () => this.dialog.close('cancel'));
    on('nc-list', 'click', (e) => this.pick(e));
  }

  async startChatWith(target, presetId) {
    const chat = await api.createChat(target.inline ? { character: target.inline, presetId } : { characterId: target.id, presetId });
    await this.app.list.refresh();
    await this.app.view.open(chat.id);
  }

  /** 모드를 물어본 뒤 대화를 엽니다. 묻지 않기로 해 뒀으면 바로 시작합니다. */
  start(target) {
    const s = this.state.settings;
    if (!s.askModeOnNewChat || s.presets.length < 2) return this.startChatWith(target, s.activePresetId);

    this.pending = target;
    const character = target.inline || this.state.characters.find((c) => c.id === target.id);
    $('nc-title').textContent = character ? `${character.name} — 어떤 모드로 시작할까요` : '어떤 모드로 시작할까요';
    this.paintCastCard(character);
    $('nc-remember').checked = false;

    // 지난번에 고른 모드가 있는 쪽 탭으로 엽니다. 그쪽이 비어 있으면 모드가 있는 쪽으로.
    const last = s.presets.find((p) => p.id === s.activePresetId);
    let audience = last?.adult ? 'adult' : 'general';
    if (!s.presets.some((p) => p.adult === (audience === 'adult'))) audience = audience === 'adult' ? 'general' : 'adult';
    this.paintModeTab(audience);
    this.dialog.showModal();
  }

  /**
   * 일반 / 성인 모드 중 한쪽만 보여 줍니다.
   * 섞어 두면 성인 모드를 실수로 누르기 쉽고, 목록도 길어져 한눈에 안 들어옵니다.
   */
  paintModeTab(audience) {
    const s = this.state.settings;
    const adult = audience === 'adult';
    for (const tab of $('nc-tabs').querySelectorAll('[data-audience]')) {
      const on = tab.dataset.audience === audience;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    }

    // 성인 모드는 기본적으로 로컬 엔진으로만 나갑니다. 지금 엔진이 외부면 고르기 전에 알려 줍니다.
    const note = $('nc-audience-note');
    const cfg = s.providers[s.activeProvider];
    const label = cfg?.label || s.activeProvider;
    const local = isLocalUrl(cfg?.baseUrl);
    const cloud = this.state.adultCloud;
    note.hidden = !adult;
    note.classList.toggle('is-warn', adult && !local);
    note.textContent = !adult ? ''
      : local && cloud ? '지금 엔진은 로컬 주소입니다. 대화 내용이 이 PC 밖으로 나가지 않습니다.'
      : local ? '성인 모드는 로컬 엔진으로만 보냅니다. 외부 API 로는 전송되지 않습니다.'
      : cloud ? `지금 엔진(${label})은 클라우드입니다. 대화 내용이 그 회사 서버로 전송되고, 이용 약관에 따라 거부되거나 계정이 제한될 수 있습니다.`
      : `지금 엔진(${label})은 로컬 주소가 아니라 성인 모드로 보낼 수 없습니다. 입력창 아래에서 LM Studio 로 바꿔 주세요.`;

    const list = s.presets.filter((p) => Boolean(p.adult) === adult);
    $('nc-list').innerHTML = list.length
      ? list.map((p) => `<li><button type="button" class="mode-card${p.id === s.activePresetId ? ' is-last' : ''}" data-preset="${p.id}">
      <span class="m-name">
        ${esc(p.name)}
        ${p.adult ? '<span class="m-tag">19</span>' : ''}
        ${p.id === s.activePresetId ? '<span class="m-last">이전 사용</span>' : ''}
      </span>
      <span class="m-desc">${esc(modeNote(p))}</span>
    </button></li>`).join('')
      : `<li class="rail-empty">${adult ? '성인' : '일반'} 모드가 없습니다. 설정 → 대화 모드에서 만들 수 있습니다.</li>`;
  }

  /** 어떤 캐릭터인지 잊고 눌렀을 때를 대비해, 설정해 둔 특징을 함께 보여 줍니다. */
  paintCastCard(character) {
    const box = $('nc-character');
    if (!character) {
      box.innerHTML = '<p class="cast-empty">캐릭터 정보를 찾지 못했습니다.</p>';
      return;
    }
    const facts = [
      ['성격', character.personality],
      ['말투', character.speech],
      ['배경', character.scenario],
      ['설정', character.notes]
    ].filter(([, v]) => v && v.trim());
    const { personas, settings } = this.state;
    const me = personas.find((p) => p.id === settings.activePersonaId)?.name || personas[0]?.name || '나';
    const fill = (t = '') => esc(ui.fillNames(t, { char: character.name, user: me }));

    box.innerHTML = `
    <div class="cast-head">
      ${ui.avatarHtml(character, { cls: 'cast-avatar' })}
      <span class="grow">
        <span class="cast-name">
          ${esc(character.name)}
          ${character.tags ? `<span class="cast-tags">${esc(character.tags)}</span>` : ''}
        </span>
        ${character.description ? `<div class="cast-desc">${fill(character.description)}</div>` : ''}
      </span>
      <button type="button" class="ghost-btn" data-edit-character>수정</button>
    </div>
    ${facts.length ? `<dl class="cast-facts">${facts
      .map(([k, v]) => `<div class="cast-fact"><dt>${k}</dt><dd>${fill(v)}</dd></div>`)
      .join('')}</dl>` : ''}`;
  }

  async pick(e) {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const presetId = btn.dataset.preset;
    const target = this.pending;
    const remember = $('nc-remember').checked;
    this.dialog.close('picked');
    // 고른 모드를 다음 기본값으로 둡니다. 묻지 않기를 켰으면 그대로 쓰게 됩니다.
    this.state.settings = await api.saveSettings({ activePresetId: presetId, ...(remember ? { askModeOnNewChat: false } : {}) });
    await this.startChatWith(target, presetId);
  }
}
