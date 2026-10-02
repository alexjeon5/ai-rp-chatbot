/** 세션의 임시 사용자 태그 필터. 권한과 만료 판단은 서버가 합니다. */
import { api } from '../api.js';
import { $, on } from '../core/dom.js';
import * as ui from '../ui.js';

export class ContentFilter {
  constructor() {
    this.status = null;
    this.busy = false;
    this.unavailable = false;
    on('filter-relaxation-toggle', 'click', () => this.change(this.status?.active && this.status.expiresAt > Date.now()));
    on('filter-relaxation-stop', 'click', () => this.change(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh();
    });
    // 남은 시간은 매초 표시하고, 서버의 취소 상태도 열린 화면에서 주기적으로 확인합니다.
    setInterval(() => this.paint(), 1000);
    setInterval(() => {
      if (!document.hidden && (this.status?.active || $('dlg-settings').open)) this.refresh();
    }, 15000);
    this.refresh();
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.status = await api.contentFilter();
      this.unavailable = false;
    } catch {
      // 마지막으로 확인한 완화 상태를 남겨, 연결 실패가 종료처럼 보이지 않게 합니다.
      this.unavailable = true;
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  paint() {
    const status = this.status;
    const left = status?.active ? Math.max(0, Math.ceil((status.expiresAt - Date.now()) / 1000)) : 0;
    const active = left > 0;
    const remaining = `${Math.floor(left / 60)}분 ${left % 60}초`;
    $('filter-relaxation-banner').hidden = !active;
    $('filter-relaxation-remaining').textContent = `성인 태그 필터 완화 중 · ${remaining}`;
    $('filter-relaxation-status').textContent = this.unavailable
      ? `서버 상태를 확인하지 못했습니다.${active ? ` 마지막 확인: 완화 중 · ${remaining} 남음.` : ' 잠시 후 다시 시도해 주세요.'}`
      : active
      ? `완화 중 · ${remaining} 뒤 자동 종료`
      : !status ? '상태를 확인하지 못했습니다. 설정 창을 다시 열어 주세요.'
        : status.eligible ? '필터 적용 중 · 성인 확인 완료' : '성인 확인을 마친 계정으로 로그인해야 사용할 수 있습니다.';
    $('filter-relaxation-toggle').textContent = active ? '필터 완화 종료' : '30분간 필터 완화';
    $('filter-relaxation-toggle').disabled = this.busy || !status?.eligible;
    $('filter-relaxation-stop').disabled = this.busy;
  }

  async change(stop) {
    if (this.busy) return;
    this.busy = true;
    this.paint();
    try {
      this.status = await (stop ? api.restoreContentFilter() : api.relaxContentFilter());
      this.unavailable = false;
      ui.toast(stop ? '태그 필터를 다시 적용합니다.' : '이 로그인 세션에서 태그 필터를 30분간 완화합니다.');
    } catch (e) {
      this.unavailable = true;
      ui.toast(e.message);
    } finally {
      this.busy = false;
      this.paint();
    }
  }
}
