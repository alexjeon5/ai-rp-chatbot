/** 설정 창: 탭, 엔진 칸, 대화 모드 편집, 저장·취소, 백업 불러오기. 이미지·화면·개발자 탭은 따로 둡니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { makeCombo } from '../select.js';
import { $, storage, on } from '../core/dom.js';
import { applyTheme } from './theme.js';
import { ImageSettings } from './settings-image.js';
import { DevSettings } from './settings-dev.js';

const TABS = [...$('s-tabs').querySelectorAll('[data-tab]')].map((t) => t.dataset.tab);

const MODEL_HINTS = {
  lmstudio: 'LM Studio 의 Developer 탭에서 서버를 켠 뒤 불러오기를 눌러 주세요.',
  ollama: 'ollama.com/settings/keys 에서 만든 API 키를 넣고 불러오기를 누르세요. 로컬 Ollama 는 주소를 http://localhost:11434/v1 로 바꾸면 키 없이 됩니다.',
  vercel: 'Vercel 대시보드 → AI Gateway → API Keys 에서 만든 키를 넣고 불러오기를 누르세요. 모델 이름은 anthropic/claude-sonnet-5 처럼 회사/모델 입니다.'
};

/** 서버가 거부한 이유를 보고, 고칠 칸이 있는 탭을 짐작합니다. */
const tabForError = (message = '') => (/ComfyUI|워크플로/.test(message) ? 'image' : /엔진 주소/.test(message) ? 'engine' : null);

export class Settings {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-settings');
    this.draftProviders = null;
    this.shownProvider = null;
    this.draftPresets = null;
    this.shownPreset = null;
    this.modelOptions = [];
    // 창을 연 뒤 아직 맨 위로 되돌리지 않은 탭 (아래 resetScroll 참고)
    this.unscrolled = new Set();

    this.image = new ImageSettings(app);
    this.dev = new DevSettings(app, this);
    this.modelCombo = makeCombo($('s-model'), {
      items: () => this.modelOptions,
      emptyText: '먼저 불러오기를 눌러 주세요.',
      noMatchText: (q) => `'${q}' 와 일치하는 모델이 없습니다. 직접 입력한 이름을 그대로 써도 됩니다.`,
      onPick: (name) => { $('s-model-msg').textContent = `선택한 모델: ${name}`; }
    });
    this.bindEngine();
    this.bindPresets();
    this.bindTabs();

    on('btn-settings', 'click', () => this.open());
    on('s-temp', 'input', (e) => { $('v-temp').textContent = e.target.value; });
    on('s-atemp', 'input', (e) => { $('v-atemp').textContent = e.target.value; });
    on('s-cancel', 'click', () => this.dialog.close('cancel'));
    on('s-import', 'click', () => {
      $('s-import-file').value = '';
      $('s-import-file').click();
    });
    on('s-import-file', 'change', (e) => this.importBackup(e.target.files?.[0]));
    this.dialog.addEventListener('close', () => this.onClose());
  }

  /* ---------------- 엔진 ---------------- */

  bindEngine() {
    on('s-key-toggle', 'click', () => this.setKeyVisible($('s-apikey').type === 'password'));
    on('s-provider', 'change', (e) => {
      this.stashProvider();
      this.fillProviderBox(e.target.value);
    });
    on('s-fetch-models', 'click', () => this.fetchModels());
  }

  /** API 키는 기본으로 가려 두고, 버튼을 눌렀을 때만 보여 줍니다. */
  setKeyVisible(on) {
    $('s-apikey').type = on ? 'text' : 'password';
    $('s-key-toggle').textContent = on ? '가리기' : '보기';
    $('s-key-toggle').setAttribute('aria-pressed', String(on));
  }

  paintProviderOptions() {
    $('s-provider').innerHTML = Object.entries(this.draftProviders)
      .map(([key, cfg]) => `<option value="${key}">${cfg.label}${key === 'lmstudio' ? ' (로컬)' : ''}</option>`)
      .join('');
    $('s-provider').value = this.shownProvider || this.state.settings.activeProvider;
  }

  fillProviderBox(key) {
    this.shownProvider = key;
    this.setKeyVisible(false);
    const cfg = this.draftProviders[key];
    $('s-baseurl').value = cfg.baseUrl || '';
    // 서버는 키를 내려보내지 않습니다. 칸은 늘 비어 있고, 뭔가 입력했을 때만 교체됩니다. 저장된 키가 있는지는 placeholder 로 알려 줍니다.
    $('s-apikey').value = '';
    $('s-apikey').placeholder = cfg.keyFromEnv
      ? '환경변수로 지정되어 있습니다 (여기서 바꿀 수 없음)'
      : cfg.hasApiKey ? '저장됨 — 바꾸려면 새 키를 입력하세요' : 'API 키를 입력하세요';
    $('s-apikey').disabled = Boolean(cfg.keyFromEnv);
    $('s-model').value = cfg.model || '';
    $('s-context').value = cfg.contextTokens || '';
    $('s-context').placeholder = key === 'lmstudio' || /localhost|127\.0\.0\.1|192\.168\./.test(cfg.baseUrl || '') ? '16384' : '128000';
    $('s-key-field').hidden = key === 'lmstudio';
    $('s-model-msg').textContent = MODEL_HINTS[key] || '';
    this.modelOptions = [];
    this.modelCombo.close();
    this.paintProviderOptions();
  }

  /** 화면에 떠 있던 엔진의 입력값을 임시본에 담아둡니다. */
  stashProvider() {
    const cfg = this.draftProviders?.[this.shownProvider];
    if (!cfg) return;
    const typedKey = $('s-apikey').value.trim();
    const contextTokens = Number($('s-context').value);
    // 컨텍스트를 비워 두면 서버가 엔진 종류에 맞는 기본값을 씁니다.
    Object.assign(cfg, { baseUrl: $('s-baseurl').value.trim(), model: $('s-model').value.trim(), contextTokens: contextTokens >= 1024 ? contextTokens : null });
    // 빈 칸은 '건드리지 않음' 입니다. 서버가 저장해 둔 키를 그대로 씁니다.
    if (typedKey) cfg.apiKey = typedKey;
  }

  async fetchModels() {
    this.stashProvider();
    const key = $('s-provider').value;
    $('s-model-msg').textContent = '모델을 불러오는 중…';
    try {
      // 아직 저장 전이므로 임시로 저장한 뒤 조회합니다.
      await api.saveSettings({ providers: this.draftProviders });
      const { models } = await api.models(key);
      this.modelOptions = models;
      $('s-model-msg').textContent = models.length
        ? `${models.length}개를 찾았습니다. 입력창을 누르면 목록이 나옵니다.`
        : '응답은 왔지만 대화에 쓸 수 있는 모델이 없습니다. 키가 이 API 에 대해 활성화돼 있는지 확인해 주세요.';
      if (models.length) {
        $('s-model').focus();
        this.modelCombo.open();
      }
      this.app.toolbar.paintWebSearch();
    } catch (e) {
      $('s-model-msg').textContent = `불러오지 못했습니다 — ${e.message}`;
    }
  }

  /* ---------------- 대화 모드 ---------------- */

  bindPresets() {
    on('s-preset', 'change', (e) => {
      this.stashPreset();
      this.showPreset(e.target.value);
    });
    on('s-preset-new', 'click', () => {
      const name = prompt('새 모드 이름');
      if (!name?.trim()) return;
      this.stashPreset();
      this.draftPresets.push({ id: `p${Date.now().toString(36)}`, name: name.trim(), template: '', adult: false });
      this.showPreset(this.draftPresets[this.draftPresets.length - 1].id);
    });
    on('s-preset-rename', 'click', () => {
      const p = this.draftPresets.find((x) => x.id === this.shownPreset);
      const name = prompt('모드 이름', p.name);
      if (!name?.trim()) return;
      p.name = name.trim();
      this.paintPresetOptions();
    });
    on('s-preset-delete', 'click', () => {
      if (this.draftPresets.length < 2) return;
      if (!confirm('이 모드를 삭제할까요?')) return;
      this.draftPresets = this.draftPresets.filter((p) => p.id !== this.shownPreset);
      this.showPreset(this.draftPresets[0].id);
    });
    on('s-reset-template', 'click', () => {
      const pick = (this.state.settings.builtinTemplates || []).find((t) => t.id === $('s-template-source').value);
      if (!pick) return ui.toast('가져올 기본 모드이 없습니다');
      const current = this.draftPresets.find((p) => p.id === this.shownPreset);
      if (current?.template.trim() && current.template !== pick.template &&
          !confirm(`'${current.name}' 의 지금 내용을 '${pick.name}' 원본으로 덮어씁니다. 계속할까요?`)) {
        return;
      }
      $('s-template').value = pick.template;
      ui.toast(`기본 내용을 가져왔습니다 — ${pick.name}`);
    });
  }

  /** 화면에 떠 있던 모드의 내용을 임시본에 담아둡니다. */
  stashPreset() {
    const p = this.draftPresets?.find((x) => x.id === this.shownPreset);
    if (!p) return;
    p.template = $('s-template').value;
    p.adult = $('s-preset-adult').checked;
  }

  paintPresetOptions() {
    $('s-preset').innerHTML = this.draftPresets.map((p) => `<option value="${p.id}">${p.adult ? '🔒 ' : ''}${p.name}</option>`).join('');
    $('s-preset').value = this.shownPreset;
    $('s-preset-delete').disabled = this.draftPresets.length < 2;
  }

  showPreset(id) {
    this.shownPreset = id;
    const p = this.draftPresets.find((x) => x.id === id);
    $('s-template').value = p?.template || '';
    $('s-preset-adult').checked = Boolean(p?.adult);
    this.paintPresetOptions();
    // 내장 모드를 편집 중이면 같은 모드의 원본이 기본으로 잡히게 합니다.
    if ((this.state.settings.builtinTemplates || []).some((t) => t.id === id)) $('s-template-source').value = id;
  }

  paintTemplateSources() {
    const sources = this.state.settings.builtinTemplates || [];
    $('s-template-source').innerHTML = sources.length
      ? sources.map((t) => `<option value="${t.id}">${t.adult ? '🔒 ' : ''}${t.name} 원본</option>`).join('')
      : '<option value="">기본 모드을 불러오지 못했습니다</option>';
  }

  /* ---------------- 탭과 스크롤 ---------------- */

  bindTabs() {
    on('s-tabs', 'click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (btn) this.showTab(btn.dataset.tab);
    });
    // 탭 목록 안에서는 화살표로 옮겨 다닙니다.
    on('s-tabs', 'keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const now = TABS.indexOf($('s-tabs').querySelector('.is-on')?.dataset.tab);
      const next = TABS[(now + step + TABS.length) % TABS.length];
      this.showTab(next);
      $('s-tabs').querySelector(`[data-tab="${next}"]`).focus();
    });
  }

  /** 마지막으로 본 탭. 다시 열 때 그 탭으로 엽니다. */
  lastTab() {
    const tab = storage.get('settingsTab');
    return TABS.includes(tab) ? tab : TABS[0];
  }

  showTab(tab) {
    if (!TABS.includes(tab)) tab = TABS[0];
    for (const btn of $('s-tabs').querySelectorAll('[data-tab]')) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      // 좁은 화면에서는 탭이 가로로 흐르므로, 고른 탭이 가려져 있으면 보이는 곳으로 당깁니다.
      if (on) btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    for (const pane of this.dialog.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab;
    this.resetScroll();
    this.modelCombo.close();
    this.image.combo.close();
    storage.set('settingsTab', tab);
  }

  /*
   * 설정 창은 어느 경로로 열든 탭마다 맨 위부터 보입니다. 창이 닫혀 있거나 탭이 숨겨진 동안에는
   * scrollTop 이 먹지 않으므로, 창을 띄운 직후와 연 뒤 처음 보는 탭으로 넘어갈 때 맞춥니다.
   */
  resetScroll() {
    if (!this.dialog.open) return;
    for (const pane of this.dialog.querySelectorAll('[data-pane]')) {
      if (pane.hidden || !this.unscrolled.has(pane.dataset.pane)) continue;
      pane.scrollTop = 0;
      this.unscrolled.delete(pane.dataset.pane);
    }
  }

  /** 설정 창을 띄웁니다. 창을 여는 곳은 모두 이 함수를 거칩니다. */
  show() {
    this.unscrolled = new Set(TABS);
    this.dialog.showModal();
    this.dialog.scrollTop = 0;
    this.resetScroll();
  }

  /** 설정 창을 엽니다. 모든 탭의 입력칸을 지금 설정으로 채운 뒤 tab 을 보여 줍니다. */
  async open(tab = this.lastTab()) {
    const { state } = this;
    // 내장 틀 원본이 비어 있으면 설정을 다시 읽어 둡니다. 없으면 '가져오기' 가 헛돕니다.
    if (!state.settings.builtinTemplates?.length) state.settings = await api.settings().catch(() => state.settings);
    const s = state.settings;
    this.draftProviders = structuredClone(s.providers);
    this.draftPresets = structuredClone(s.presets);
    this.paintTemplateSources();
    this.shownProvider = s.activeProvider;
    this.fillProviderBox(s.activeProvider);
    this.showPreset(s.activePresetId);
    $('s-temp').value = s.params.temperature;
    $('v-temp').textContent = s.params.temperature;
    $('s-topk').value = s.params.topK ?? 0;
    $('s-repeat').value = s.params.repeatPenalty ?? 1;
    $('s-maxtokens').value = s.params.maxTokens;
    $('s-history').value = s.historyLimit;
    $('s-ask-mode').checked = s.askModeOnNewChat !== false;
    $('s-assistant-prompt').value = s.assistant.systemPrompt;
    $('s-atemp').value = s.assistant.params.temperature;
    $('v-atemp').textContent = s.assistant.params.temperature;
    $('s-atopk').value = s.assistant.params.topK ?? 0;
    $('s-arepeat').value = s.assistant.params.repeatPenalty ?? 1;
    $('s-amaxtokens').value = s.assistant.params.maxTokens;
    this.image.fill();
    this.dev.fill();
    this.showTab(tab);
    this.show();
    // 창이 뜨기 전에는 스크롤이 먹지 않으므로, 연 뒤에 고른 탭을 한 번 더 보이게 합니다.
    // 좁은 화면에서는 가로로 스크롤되는 탭 줄 자체가 첫 포커스를 받아 테두리가 생기므로, 고른 탭에 포커스를 둡니다.
    const current = $('s-tabs').querySelector('.is-on');
    current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    current?.focus({ preventScroll: true });
  }

  /* ---------------- 저장 ---------------- */

  /** 모든 탭의 입력을 한 번에 저장할 요청 본문으로 모읍니다. */
  read() {
    const s = this.state.settings;
    return {
      activeProvider: $('s-provider').value,
      historyLimit: Number($('s-history').value),
      askModeOnNewChat: $('s-ask-mode').checked,
      presets: this.draftPresets,
      activePresetId: this.shownPreset,
      params: {
        temperature: Number($('s-temp').value),
        maxTokens: Number($('s-maxtokens').value),
        topP: s.params.topP,
        topK: Number($('s-topk').value),
        repeatPenalty: Number($('s-repeat').value)
      },
      providers: this.draftProviders,
      assistant: {
        systemPrompt: $('s-assistant-prompt').value,
        params: {
          temperature: Number($('s-atemp').value),
          maxTokens: Number($('s-amaxtokens').value),
          topP: s.assistant.params.topP,
          topK: Number($('s-atopk').value),
          repeatPenalty: Number($('s-arepeat').value)
        }
      },
      removeProviders: this.dev.removedProviders,
      image: this.image.read(),
      dev: this.dev.read()
    };
  }

  async onClose() {
    const { state, app } = this;
    if (this.dialog.returnValue !== 'save') {
      // 테마·표기법은 고르는 즉시 미리 보여 주므로, 저장하지 않고 닫으면 원래대로 돌립니다.
      applyTheme(state.settings.dev);
      if (!state.run) app.view.paintThread();
      return;
    }
    this.stashProvider();
    this.stashPreset();
    const wasImageOn = Boolean(state.settings.image?.enabled);
    let imageOn;
    try {
      const body = this.read();
      imageOn = body.image.enabled;
      state.settings = await api.saveSettings(body);
    } catch (e) {
      // 저장이 거부되면 입력한 그대로 창을 다시 열어 고칠 수 있게 합니다.
      this.dialog.returnValue = '';
      this.show();
      const tab = tabForError(e.message);
      if (tab) this.showTab(tab);
      ui.toast(`저장하지 못했습니다 — ${e.message}`);
      return;
    }
    this.dev.removedProviders = [];
    applyTheme(state.settings.dev);
    app.paintAdultRules();
    app.toolbar.paintModelBadge();
    app.view.paintPreset();
    await app.list.refresh();
    app.composer.refreshContext();
    // 🎨 버튼과 표기법이 바뀌었을 수 있어 다시 그립니다.
    if (!state.run) app.view.paintThread();
    ui.toast(imageOn && !wasImageOn ? '설정을 저장했습니다 — 답변 아래 🎨 그리기로 장면을 그려 보세요' : '설정을 저장했습니다');
  }

  /* ---------------- 백업 불러오기 ---------------- */

  async importBackup(file) {
    const { state, app } = this;
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return ui.toast('JSON 파일을 읽지 못했습니다. 백업 내려받기로 받은 파일인지 확인해 주세요.');
    }
    const count = (k) => (Array.isArray(data?.[k]) ? data[k].length : 0);
    const summary = `캐릭터 ${count('characters')}개, 페르소나 ${count('personas')}개, 대화 ${count('chats')}개`;
    if (!confirm(`${file.name}\n${summary}\n\n지금 데이터에 합칩니다. 이미 있는 항목은 건너뜁니다. 계속할까요?`)) return;
    const includeSettings = Boolean(data?.settings) && confirm(
      '설정(샘플링 값·어시스턴트 프롬프트·테마·표기법)도 백업의 값으로 덮어쓸까요?\n' +
      '취소를 누르면 지금 설정을 그대로 둡니다. 엔진 주소와 API 키는 어느 쪽이든 바뀌지 않습니다.'
    );

    let result;
    try {
      result = await api.importBackup(data, includeSettings);
    } catch (err) {
      return ui.toast(`불러오지 못했습니다 — ${err.message}`);
    }

    // 설정 창에 떠 있던 입력값은 옛 값이므로 저장하지 않고 닫은 뒤 전부 다시 읽습니다.
    this.dialog.close('cancel');
    [state.settings, state.characters, state.personas] = await Promise.all([api.settings(), api.characters(), api.personas()]);
    applyTheme(state.settings.dev);
    app.paintAdultRules();
    app.characters.paint();
    app.toolbar.paintModelBadge();
    await app.list.refresh();
    if (state.chat && !state.run) await app.view.open(state.chat.id);

    const { characters, personas, chats } = result;
    const skipped = characters.skipped + personas.skipped + chats.skipped;
    ui.toast(
      `불러왔습니다 — 캐릭터 ${characters.added}, 페르소나 ${personas.added}, 대화 ${chats.added}` +
      (skipped ? ` (이미 있거나 읽을 수 없는 ${skipped}개 건너뜀)` : '') +
      (result.settings ? ' · 설정 반영' : '')
    );
  }
}
