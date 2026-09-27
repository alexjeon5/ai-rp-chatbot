/** 입력창 아래 줄: 엔진 선택기, 모델 이름, 어시스턴트의 웹 검색·생각 토글. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on } from '../core/dom.js';

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    on('btn-thinking', 'click', () => this.toggle('thinking', '생각을'));
    on('btn-websearch', 'click', () => this.toggle('webSearch', '웹 검색을'));
    on('quick-provider', 'change', (e) => this.switchEngine(e));
    on('active-model', 'click', () => app.settings.open('engine'));
  }

  async toggle(key, label) {
    const btn = $(key === 'thinking' ? 'btn-thinking' : 'btn-websearch');
    const next = btn.getAttribute('aria-pressed') !== 'true';
    this.state.settings = await api.saveSettings({ assistant: { [key]: next } });
    if (key === 'thinking') this.paintThinking();
    else this.paintWebSearch();
    ui.toast(`${label} ${next ? '켰습니다' : '껐습니다'}`);
  }

  async switchEngine(e) {
    const { state } = this;
    const before = state.settings.activeProvider;
    try {
      state.settings = await api.saveSettings({ activeProvider: e.target.value });
      this.paintModelBadge();
      this.app.composer.refreshContext();
      const cfg = state.settings.providers[state.settings.activeProvider];
      ui.toast(cfg.model ? `엔진을 바꿨습니다 — ${cfg.label}` : `모델을 먼저 선택해 주세요 — ${cfg.label}`);
    } catch (err) {
      e.target.value = before;
      ui.toast(`바꾸지 못했습니다 — ${err.message}`);
    }
  }

  paintModelBadge() {
    const s = this.state.settings;
    const cfg = s.providers[s.activeProvider];
    const btn = $('active-model');
    btn.textContent = cfg.model || '모델 미설정';
    btn.classList.toggle('is-empty', !cfg.model);
    btn.title = cfg.model ? `${cfg.label} · ${cfg.model} — 누르면 설정이 열립니다` : '설정에서 모델을 선택해 주세요';
    this.paintQuickProvider();
  }

  /** 엔진 선택기. 지금 대화가 성인 모드면 (클라우드 허용을 켜지 않은 한) 외부 엔진은 고를 수 없습니다. */
  paintQuickProvider() {
    const { state } = this;
    const sel = $('quick-provider');
    const adultChat = Boolean(state.listedChat?.adult);
    sel.innerHTML = Object.entries(state.settings.providers)
      .map(([key, cfg]) => {
        const blocked = adultChat && !state.adultAllowed(cfg);
        return `<option value="${key}"${blocked ? ' disabled' : ''}>${cfg.label}${blocked ? ' (성인 틀 불가)' : ''}</option>`;
      })
      .join('');
    sel.value = state.settings.activeProvider;
    this.paintWebSearch();
    this.paintThinking();
  }

  /** 어시스턴트 모드에서만 보이는 웹 검색 토글. 엔진이 못 하면 잠깁니다. */
  paintWebSearch() {
    const btn = $('btn-websearch');
    const assistant = this.state.chat?.kind === 'assistant';
    btn.hidden = !assistant;
    if (!assistant) return;
    const s = this.state.settings;
    const capable = s.webSearchCapable?.[s.activeProvider];
    const on = Boolean(s.assistant?.webSearch) && capable;
    btn.disabled = !capable;
    btn.setAttribute('aria-pressed', String(on));
    btn.title = capable
      ? (on ? '웹 검색이 켜져 있습니다. 답변 끝에 출처가 붙습니다.' : '최신 정보가 필요할 때 켜 주세요.')
      : `웹 검색을 지원하지 않는 엔진입니다 (${s.providers[s.activeProvider]?.label}).`;
  }

  /** 어시스턴트 모드의 생각 토글. */
  paintThinking() {
    const btn = $('btn-thinking');
    const assistant = this.state.chat?.kind === 'assistant';
    btn.hidden = !assistant;
    if (!assistant) return;
    const on = Boolean(this.state.settings.assistant?.thinking);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on
      ? '답변 전에 생각합니다. 과정은 접힌 채로 보여 줍니다. 사고 토큰도 요금에 포함됩니다.'
      : '복잡한 질문에서 정확도가 올라갑니다. 대신 느리고 토큰을 더 씁니다. 일부 모델은 완전히 끄지 못하고 최소화만 됩니다.';
  }
}
