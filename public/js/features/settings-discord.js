/** 설정 창의 디스코드 탭: 봇 상태, 이 계정의 연결, 1회용 연결 코드 받기, 연결 끊기. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, on, esc } from '../core/dom.js';

const clock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString('ko-KR');

export class DiscordSettings {
  constructor(app) {
    this.app = app;
    this.status = null;
    // 받은 코드는 이 창에서만 보여 줍니다. 서버에는 해시만 남아 다시 볼 수 없습니다.
    this.code = null;
    on('d-issue', 'click', () => this.issue());
    on('d-unlink', 'click', () => this.unlink());
  }

  async load() {
    try {
      this.status = await api.discordLink();
    } catch (err) {
      ui.toast(`디스코드 연결 상태를 불러오지 못했습니다 — ${err.message}`);
      return;
    }
    if (this.status.linked) this.code = null;
    this.paint();
  }

  async issue() {
    try {
      this.code = await api.discordLinkCode();
    } catch (err) {
      ui.toast(`코드를 받지 못했습니다 — ${err.message}`);
      return;
    }
    this.paint();
  }

  async unlink() {
    if (!confirm('디스코드 연결을 끊을까요? 봇에서 이 계정으로 대화할 수 없게 됩니다.')) return;
    try {
      await api.discordUnlink();
    } catch (err) {
      ui.toast(`연결을 끊지 못했습니다 — ${err.message}`);
      return;
    }
    this.code = null;
    ui.toast('디스코드 연결을 끊었습니다');
    this.load();
  }

  paint() {
    const s = this.status;
    if (!s) return;
    const bot = s.bot || {};
    $('d-bot').innerHTML = bot.enabled
      ? `봇 <b>${esc(bot.name || '')}</b> 이 켜져 있습니다.`
      : '이 서버에는 아직 디스코드 봇이 켜져 있지 않습니다. 연결은 미리 해 둘 수 있습니다.';
    $('d-state').innerHTML = s.linked
      ? `디스코드 <b>${esc(s.linked.name || '(이름 없음)')}</b> 계정과 이어져 있습니다 (${esc(day(s.linked.linkedAt))}).`
      : '아직 이어진 디스코드 계정이 없습니다.';
    $('d-unlink').hidden = !s.linked;
    $('d-issue').textContent = s.linked ? '다른 디스코드 계정으로 바꾸기' : '연결 코드 받기';

    const code = this.code && this.code.expiresAt > Date.now() ? this.code : null;
    $('d-code-box').hidden = !code;
    if (code) {
      $('d-code').textContent = code.code;
      $('d-code-until').textContent = `${clock(code.expiresAt)} 까지 · 디스코드에서 /rp link code:${code.code}`;
    }
  }
}
