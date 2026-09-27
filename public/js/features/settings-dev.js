/** 설정 창의 화면·개발자 탭: 테마, 표기법, 엔진 추가·삭제, 감춘 모델, 성인 클라우드 허용, 진단 창. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';
import { applyTheme } from './theme.js';

const THEME_FIELDS = { 'd-bg': 'bg', 'd-panel': 'panel', 'd-line': 'line', 'd-text': 'text', 'd-muted': 'muted', 'd-accent': 'accent' };
const MARKUP_FIELDS = { 'd-mk-asterisk': 'asterisk', 'd-mk-paren': 'paren', 'd-mk-speaker': 'speaker', 'd-mk-quote': 'quote' };
const DEFAULT_THEME = {
  bg: '#15111a', panel: '#1d1822', line: '#372f42',
  text: '#ede7ee', muted: '#9c90a8', accent: '#d9b168',
  fontSans: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
  fontSerif: "'Gowun Batang', 'Nanum Myeongjo', serif",
  fontSize: 15
};

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });

export class DevSettings {
  constructor(app, settings) {
    this.app = app;
    this.state = app.state;
    this.settings = settings;
    this.draft = null;
    // 엔진 추가·삭제는 엔진 탭의 draftProviders 에 바로 반영하고, 지운 것은 저장할 때 서버에 알립니다.
    this.removedProviders = [];

    on('d-hidden-models', 'click', async (e) => {
      const btn = e.target.closest('[data-clear]');
      if (!btn) return;
      const { cleared } = await api.clearUnavailable(btn.dataset.clear);
      this.state.settings = await api.settings();
      this.paintHiddenModels();
      ui.toast(`${cleared}개를 목록에 되돌렸습니다`);
    });
    this.bindAdultCloud();
    // 색을 고르는 즉시 화면에 반영해 결과를 바로 볼 수 있게 합니다.
    for (const id of [...Object.keys(THEME_FIELDS), 'd-fontsize', 'd-fontsans', 'd-fontserif']) {
      $(id).addEventListener('input', () => applyTheme(this.read()));
    }
    for (const id of Object.keys(MARKUP_FIELDS)) {
      $(id).addEventListener('change', () => {
        applyTheme(this.read());
        app.view.paintThread();
      });
    }
    on('d-theme-reset', 'click', () => {
      this.draft.theme = { ...DEFAULT_THEME };
      this.paintTheme();
      applyTheme(this.read());
    });
    on('d-p-add', 'click', () => this.addProvider());
    on('d-provider-list', 'click', (e) => this.removeProvider(e));
    this.bindDiagnostics();
  }

  paintTheme() {
    for (const [id, key] of Object.entries(THEME_FIELDS)) $(id).value = this.draft.theme[key];
    $('d-fontsize').value = this.draft.theme.fontSize;
    $('d-fontsans').value = this.draft.theme.fontSans;
    $('d-fontserif').value = this.draft.theme.fontSerif;
  }

  fill() {
    this.draft = structuredClone(this.state.settings.dev);
    this.removedProviders = [];
    for (const [id, key] of Object.entries(MARKUP_FIELDS)) $(id).checked = Boolean(this.draft.markup[key]);
    $('d-particle').checked = Boolean(this.draft.particleFix);
    $('d-adult-cloud').checked = this.draft.adultCloud === true;
    this.paintAdultCloudRow(this.draft.adultCloud === true);
    this.paintTheme();
    this.paintProviders();
    this.paintHiddenModels();
  }

  read() {
    const markup = {};
    for (const [id, key] of Object.entries(MARKUP_FIELDS)) markup[key] = $(id).checked;
    const theme = { ...this.draft.theme };
    for (const [id, key] of Object.entries(THEME_FIELDS)) theme[key] = $(id).value;
    theme.fontSize = Number($('d-fontsize').value);
    theme.fontSans = $('d-fontsans').value.trim();
    theme.fontSerif = $('d-fontserif').value.trim();
    return { particleFix: $('d-particle').checked, adultCloud: $('d-adult-cloud').checked, markup, theme };
  }

  /* ---------------- 엔진 추가·삭제, 감춘 모델 ---------------- */

  paintProviders() {
    $('d-provider-list').innerHTML = Object.entries(this.settings.draftProviders)
      .map(([key, cfg]) => `<li class="persona-row">
      <span class="grow">
        <div class="p-name">${cfg.label}</div>
        <div class="p-desc">${cfg.type} · ${cfg.baseUrl || '주소 없음'}</div>
      </span>
      ${cfg.builtin
        ? '<span class="p-desc">내장</span>'
        : `<button type="button" class="ghost-btn danger" data-del-provider="${key}">삭제</button>`}
    </li>`)
      .join('');
  }

  paintHiddenModels() {
    const rows = Object.entries(this.state.settings.providers)
      .map(([key, cfg]) => [key, cfg, cfg.unavailableModels || []])
      .filter(([, , list]) => list.length);
    $('d-hidden-models').innerHTML = rows.length
      ? rows.map(([key, cfg, list]) => `<li class="persona-row">
        <span class="grow">
          <div class="p-name">${cfg.label}</div>
          <div class="p-desc">${list.join(', ')}</div>
        </span>
        <button type="button" class="ghost-btn" data-clear="${key}">삭제</button>
      </li>`).join('')
      : '<li class="rail-empty">아직 없습니다.</li>';
  }

  addProvider() {
    const label = $('d-p-label').value.trim();
    const baseUrl = $('d-p-baseurl').value.trim();
    if (!label || !baseUrl) return ui.toast('이름과 주소를 입력해 주세요');
    this.settings.draftProviders[`custom_${Date.now().toString(36)}`] = {
      label, type: $('d-p-type').value, builtin: false, baseUrl, apiKey: $('d-p-apikey').value.trim(), model: ''
    };
    for (const id of ['d-p-label', 'd-p-baseurl', 'd-p-apikey']) $(id).value = '';
    this.paintProviders();
    this.settings.paintProviderOptions();
    ui.toast('추가했습니다 — 위의 사용할 엔진에서 고를 수 있고, 저장을 눌러야 반영됩니다');
  }

  removeProvider(e) {
    const btn = e.target.closest('[data-del-provider]');
    if (!btn) return;
    const { settings } = this;
    const key = btn.dataset.delProvider;
    if (!confirm(`'${settings.draftProviders[key].label}' 엔진을 삭제할까요?`)) return;
    delete settings.draftProviders[key];
    this.removedProviders.push(key);
    this.paintProviders();
    // 지운 엔진을 보고 있었다면 남은 엔진으로 옮깁니다. 입력 중이던 값은 버립니다.
    if (settings.shownProvider === key) {
      const active = this.state.settings.activeProvider;
      settings.fillProviderBox(settings.draftProviders[active] ? active : 'lmstudio');
    } else {
      settings.paintProviderOptions();
    }
  }

  /* ---------------- 성인 모드 클라우드 허용 ---------------- */

  /**
   * 성인 모드 클라우드 허용 칸은 평소에 숨겨 둡니다. 켜져 있거나 경고를 확인했을 때만 보입니다.
   * 끄고 저장하면 다음에 열 때 다시 숨겨집니다.
   */
  paintAdultCloudRow(shown) {
    $('d-adult-cloud-row').hidden = !shown;
    $('d-adult-cloud-unlock').hidden = shown;
  }

  bindAdultCloud() {
    const dlg = $('dlg-adult-cloud');
    on('d-adult-cloud-unlock', 'click', () => {
      $('ac-agree').checked = false;
      $('ac-confirm').disabled = true;
      dlg.returnValue = '';
      dlg.showModal();
    });
    on('ac-agree', 'change', () => { $('ac-confirm').disabled = !$('ac-agree').checked; });
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'unlock' || !$('ac-agree').checked) return;
      $('d-adult-cloud').checked = true;
      this.paintAdultCloudRow(true);
      ui.toast('설정 창에서 저장을 눌러야 반영됩니다');
    });
  }

  /* ---------------- 진단: 시스템 프롬프트, 통신 로그 ---------------- */

  bindDiagnostics() {
    const { state } = this;
    const dlgSystem = $('dlg-system');
    on('d-show-system', 'click', async () => {
      if (!state.chat) return ui.toast('대화를 먼저 열어 주세요');
      $('sys-text').textContent = '불러오는 중…';
      $('sys-count').textContent = '';
      $('sys-source').textContent = '';
      dlgSystem.showModal();
      try {
        const { system, turns } = await api.systemPreview(state.chat.id);
        $('sys-text').textContent = system;
        const cfg = state.settings.providers[state.settings.activeProvider];
        $('sys-source').textContent = `${state.chat.title} · ${state.listedChat?.presetName || '틀 없음'} · ${cfg.label}`;
        // 한국어는 대략 글자 수의 0.6~1배가 토큰이라 정확한 수치가 아니라 어림값입니다.
        $('sys-count').textContent =
          `${system.length.toLocaleString()}자 · 대략 ${Math.round(system.length * 0.8).toLocaleString()}토큰 · 최근 대화 ${turns}턴을 함께 보냅니다`;
      } catch (err) {
        $('sys-text').textContent = `불러오지 못했습니다 — ${err.message}`;
      }
    });
    on('sys-copy', 'click', async () => {
      ui.toast(await ui.copyText($('sys-text').textContent) ? '복사했습니다' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.');
    });

    on('d-show-logs', 'click', () => {
      $('dlg-logs').showModal();
      this.loadLogs();
    });
    on('log-refresh', 'click', () => this.loadLogs());
    on('log-clear', 'click', async () => {
      if (!confirm('통신 로그를 모두 지울까요?')) return;
      await api.clearLogs();
      this.loadLogs();
    });
  }

  paintLogs(logs) {
    $('log-count').textContent = logs.length ? `최근 ${logs.length}건 (최신 순)` : '기록이 없습니다';
    $('log-list').innerHTML = logs.length ? logs.map((l) => {
      const ok = !l.error;
      const statusText = l.status ?? (ok ? '' : '연결 실패');
      return `<li class="log-row ${ok ? 'log-ok' : 'log-fail'}">
      <div class="log-row-head">
        <span class="log-dot"></span>
        <span class="log-time">${fmtTime(l.at)}</span>
        <span class="log-provider">${esc(l.provider || '?')}</span>
        <span class="log-path">${esc(l.path || '')}</span>
        ${l.retry ? '<span class="log-tag">재시도</span>' : ''}
        <span class="spacer"></span>
        <span class="log-status">${esc(statusText)}</span>
        <span class="log-ms">${l.durationMs != null ? `${l.durationMs}ms` : ''}</span>
      </div>
      ${l.detail ? `<div class="log-detail">${esc(l.detail)}</div>` : ''}
      ${l.error ? `<pre class="log-error">${esc(l.error)}</pre>` : ''}
    </li>`;
    }).join('') : '<li class="rail-empty">아직 통신 기록이 없습니다. 대화를 한 번 보내 보세요.</li>';
  }

  async loadLogs() {
    $('log-list').innerHTML = '<li class="rail-empty">불러오는 중…</li>';
    try {
      const { logs } = await api.logs();
      this.paintLogs(logs);
    } catch (err) {
      $('log-list').innerHTML = `<li class="rail-empty">불러오지 못했습니다 — ${esc(err.message)}</li>`;
    }
  }
}
