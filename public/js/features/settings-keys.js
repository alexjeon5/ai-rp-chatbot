/** 엔진 설정의 이름 붙인 API 키. 임시본만 고치고 저장할 때 서버로 보냅니다. */
import { $, esc, on } from '../core/dom.js';
import * as ui from '../ui.js';

export class ProviderKeys {
  constructor(settings) {
    this.settings = settings;
    this.busy = false;
    on('s-api-key-select', 'change', (e) => {
      if (!this.editable) return;
      this.stash();
      this.cfg.activeApiKeyId = e.target.value || null;
      this.invalidateModels();
      this.fill();
    });
    on('s-api-key-add', 'click', () => this.add());
    on('s-api-key-delete', 'click', () => this.remove());
  }

  get cfg() { return this.settings.draftProviders?.[this.settings.shownProvider]; }
  get selected() { return this.cfg?.apiKeys?.find((k) => k.id === this.cfg.activeApiKeyId); }
  get editable() { return this.settings.state.settings.canManage && !this.cfg?.keyFromEnv && !this.busy; }

  stash() {
    const cfg = this.cfg;
    if (!cfg || !this.editable) return;
    const typed = $('s-apikey').value.trim();
    let selected = this.selected;
    // 기존처럼 키를 바로 붙여 넣어도 첫 항목을 만들어 저장합니다.
    if (typed && !selected) {
      selected = { id: this.newId(), name: '기본 키', apiKey: '', hasApiKey: false };
      (cfg.apiKeys ||= []).push(selected);
      cfg.activeApiKeyId = selected.id;
    }
    if (selected) {
      selected.name = $('s-api-key-name').value.trim() || selected.name;
      if (typed) {
        selected.apiKey = typed;
        selected.hasApiKey = true;
        this.invalidateModels();
      }
    }
    cfg.apiKey = '';
  }

  newId() {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  fill() {
    const cfg = this.cfg;
    if (!cfg) return;
    if (!Array.isArray(cfg.apiKeys)) {
      cfg.apiKeys = cfg.apiKey ? [{ id: 'legacy', name: '기본 키', apiKey: cfg.apiKey, hasApiKey: true }] : [];
      cfg.activeApiKeyId = cfg.apiKeys[0]?.id || null;
      cfg.apiKey = '';
    }
    $('s-saved-keys').hidden = this.settings.shownProvider === 'lmstudio';
    $('s-api-key-select').innerHTML = '<option value="">키 사용 안 함</option>' + cfg.apiKeys
      .map((k) => `<option value="${esc(k.id)}">${esc(k.name)}${k.hasApiKey || k.apiKey ? '' : ' (입력 필요)'}</option>`).join('');
    $('s-api-key-select').value = cfg.activeApiKeyId || '';
    $('s-api-key-name').value = this.selected?.name || '';
    $('s-apikey').value = this.selected?.apiKey || '';
    this.settings.setKeyVisible(false);
    $('s-apikey').placeholder = cfg.keyFromEnv ? '환경변수로 지정되어 있습니다'
      : this.selected?.hasApiKey ? '저장됨 — 빈칸은 기존 키 유지' : 'API 키를 입력하세요';
    $('s-api-key-hint').textContent = cfg.keyFromEnv
      ? '환경변수 키가 우선 적용됩니다. 저장된 키를 사용하려면 서버 환경변수에서 해당 키를 제거하세요.'
      : !this.settings.state.settings.canManage ? 'API 키 목록과 사용 키는 주인 계정이 관리합니다.'
        : '이 제공자의 모든 대화·이미지 요청에 적용됩니다. 선택·추가·삭제 후 저장하세요. 불러오기도 변경 사항을 저장합니다.';
    this.paintControls();
  }

  paintControls() {
    $('s-api-key-select').disabled = !this.editable;
    $('s-api-key-name').disabled = !this.editable || !this.selected;
    $('s-api-key-add').disabled = !this.editable || (this.cfg?.apiKeys?.length || 0) >= 20;
    $('s-api-key-delete').disabled = !this.editable || !this.selected;
    $('s-apikey').disabled = !this.editable;
    $('s-key-toggle').disabled = !this.editable;
  }

  invalidateModels() {
    this.settings.modelOptions = [];
    this.settings.modelCombo.close();
    $('s-model-msg').textContent = '사용할 키를 변경했습니다. 불러오기로 모델 목록을 다시 확인하세요.';
  }

  add() {
    if (!this.editable) return;
    this.stash();
    if (this.cfg.apiKeys.length >= 20) return ui.toast('API 키는 제공자마다 최대 20개까지 저장할 수 있습니다.');
    const entry = { id: this.newId(), name: `키 ${this.cfg.apiKeys.length + 1}`, apiKey: '', hasApiKey: false };
    this.cfg.apiKeys.push(entry);
    this.cfg.activeApiKeyId = entry.id;
    this.invalidateModels();
    this.fill();
    $('s-api-key-name').focus();
  }

  remove() {
    if (!this.editable || !this.selected) return;
    const selected = this.selected;
    if (!confirm(`'${selected.name}' 키를 삭제할까요? 저장하면 삭제됩니다.`)) return;
    this.cfg.apiKeys = this.cfg.apiKeys.filter((k) => k.id !== selected.id);
    // 삭제한 키 대신 다른 유료 키를 자동 선택하지 않습니다.
    this.cfg.activeApiKeyId = null;
    this.invalidateModels();
    this.fill();
  }
}
