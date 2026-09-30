/**
 * 계정 명령이 남긴 요청(AdminRequests)을 서버에서 처리합니다. 몇 초마다 요청 폴더를 봅니다.
 *
 *   claim  { to, from? }   항목을 to 계정으로 옮기기 (Ownership.claim)
 *   purge  { userId }      지운 계정의 항목과 그림, 설정을 모두 지우기 (Ownership.purge)
 *
 * 계정 목록이 바뀌면(첫 계정을 만들었을 때 등) 주인 없는 옛 데이터의 주인도 다시 정해 봅니다.
 */
import { Ownership } from './ownership.js';

export class AdminWorker {
  /**
   * @param {{ requests: import('../admin-requests.js').AdminRequests, ownership: Ownership, log?: (msg: string) => void }} deps
   */
  constructor({ requests, ownership, log = console.log }) {
    Object.assign(this, { requests, ownership, log });
    this.busy = false;
    this.usersSeen = null;
  }

  /** 부팅 때 한 번: 옛 데이터의 주인을 정하고 밀린 요청을 처리합니다. 그 뒤로는 intervalMs 마다 봅니다. */
  async start(intervalMs = 2000) {
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((e) => console.error(e)), intervalMs);
    this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const users = JSON.stringify(this.ownership.users().map((u) => [u.id, u.role]));
      if (users !== this.usersSeen) {
        this.usersSeen = users;
        if (this.ownership.waitingForClaim()) await this.ownership.adoptUnowned();
      }
      for (const request of this.requests.pending()) {
        let result;
        try {
          result = await this.run(request);
        } catch (e) {
          result = { ok: false, message: `처리하지 못했습니다: ${e.message}` };
        }
        this.requests.finish(request.id, result);
        this.log(`[계정 명령] ${result.message}`);
      }
    } finally {
      this.busy = false;
    }
  }

  async run(request) {
    const users = this.ownership.users();
    const nameOf = (id) => users.find((u) => u.id === id)?.name || id;
    switch (request.type) {
      case 'claim': {
        if (!users.some((u) => u.id === request.to)) return { ok: false, message: `받을 계정이 없습니다: ${request.to}` };
        const moved = await this.ownership.claim(request.to, { from: request.from || undefined });
        const what = `${Ownership.describe(moved)}${moved.settings ? ', 옛 설정' : ''}`;
        return { ok: true, moved, message: `${nameOf(request.to)} 계정으로 옮겼습니다: ${what}` };
      }
      case 'purge': {
        if (users.some((u) => u.id === request.userId)) {
          return { ok: false, message: '아직 있는 계정의 데이터는 지우지 않습니다. 계정을 먼저 지워 주세요.' };
        }
        const removed = await this.ownership.purge(request.userId);
        return { ok: true, removed, message: `${request.userId} 의 데이터를 지웠습니다: ${Ownership.describe(removed)}` };
      }
      default:
        return { ok: false, message: `모르는 요청입니다: ${request.type}` };
    }
  }
}
