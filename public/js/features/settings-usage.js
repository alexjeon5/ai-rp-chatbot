/** 설정 창의 사용량 탭: 기간별 합계, 엔진·모델별 표, 최근 30일 막대. 주인은 전체와 계정별 합계도 봅니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on, esc } from '../core/dom.js';

const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

export class UsageSettings {
  constructor(app) {
    this.app = app;
    this.data = null;
    this.period = 'today';
    // 'mine' 은 내 계정만, 'all' 은 모든 계정(주인만)
    this.scope = 'mine';
    this.seq = 0;

    on('u-scope', 'click', (e) => {
      const btn = e.target.closest('[data-scope]');
      if (!btn || btn.dataset.scope === this.scope) return;
      this.scope = btn.dataset.scope;
      this.load();
    });
    on('u-periods', 'click', (e) => {
      const btn = e.target.closest('[data-period]');
      if (!btn) return;
      this.period = btn.dataset.period;
      this.paint();
    });
    on('u-clear', 'click', () => this.clear());
  }

  async load() {
    const seq = ++this.seq;
    try {
      const data = await api.usage(this.scope);
      if (seq !== this.seq) return;
      this.data = data;
      this.paint();
    } catch (err) {
      ui.toast(`사용량을 불러오지 못했습니다 — ${err.message}`);
    }
  }

  async clear() {
    if (!confirm('모든 계정의 토큰 사용량 기록을 지울까요? 되돌릴 수 없습니다.')) return;
    try {
      await api.clearUsage();
    } catch (err) {
      ui.toast(`지우지 못했습니다 — ${err.message}`);
      return;
    }
    ui.toast('사용량 기록을 지웠습니다');
    this.load();
  }

  labelOf(provider) {
    return this.app.state.settings?.providers?.[provider]?.label || provider;
  }

  paint() {
    const { data } = this;
    if (!data) return;
    const current = data.periods.find((p) => p.key === this.period) || data.periods[0];

    // 주인만 범위를 고르고 기록을 지웁니다.
    $('u-scope').hidden = !data.canSeeAll;
    $('u-clear-row').hidden = !data.canSeeAll;
    $('u-scope').innerHTML = [['mine', '내 사용량'], ['all', '모든 계정']].map(([key, label]) => `<button type="button"
      class="char-tab ${key === data.scope ? 'is-on' : ''}" data-scope="${key}" aria-pressed="${key === data.scope}">${label}</button>`).join('');
    const users = current.users || [];
    $('u-users-box').hidden = !users.length;
    $('u-users').innerHTML = users.map((u) => {
      const mark = u.estimated ? '≈' : '';
      return `<tr><td>${esc(u.name)}</td><td>${fmt(u.requests)}</td><td>${mark}${fmt(u.promptTokens)}</td><td>${mark}${fmt(u.completionTokens)}</td></tr>`;
    }).join('');

    $('u-periods').innerHTML = data.periods.map((p) => `<button type="button" class="char-tab ${p.key === current.key ? 'is-on' : ''}"
      data-period="${p.key}" aria-pressed="${p.key === current.key}">${esc(p.label)}</button>`).join('');

    const { total } = current;
    const guess = total.estimated ? '≈' : '';
    $('u-total').innerHTML = [
      ['호출', fmt(total.requests)],
      ['입력', guess + fmt(total.promptTokens)],
      ['출력', guess + fmt(total.completionTokens)],
      ['합계', guess + fmt(total.promptTokens + total.completionTokens)]
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

    $('u-rows').innerHTML = current.rows.map((r) => {
      const mark = r.estimated ? `<span title="토큰 수를 알려 주지 않아 어림한 호출이 ${r.estimated}번 들어 있습니다">≈</span>` : '';
      return `<tr><td><span class="usage-model">${esc(r.model)}</span><small>${esc(this.labelOf(r.provider))}</small></td>
        <td>${fmt(r.requests)}</td><td>${mark}${fmt(r.promptTokens)}</td><td>${mark}${fmt(r.completionTokens)}</td></tr>`;
    }).join('');
    $('u-empty').hidden = current.rows.length > 0;
    $('u-rows').closest('table').hidden = !current.rows.length;

    const peak = Math.max(1, ...data.daily.map((d) => d.promptTokens + d.completionTokens));
    $('u-bars').innerHTML = data.daily.map((d) => {
      const sum = d.promptTokens + d.completionTokens;
      const height = sum ? Math.max(4, Math.round((sum / peak) * 100)) : 0;
      return `<span class="usage-bar" title="${esc(d.date)} — ${fmt(sum)} 토큰 · ${fmt(d.requests)}회"><i style="height:${height}%"></i></span>`;
    }).join('');
  }
}
