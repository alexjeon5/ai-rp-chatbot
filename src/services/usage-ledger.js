/**
 * 날짜별 토큰 사용량 기록 (data/usage.json). 대화 내용은 담지 않고 계정·엔진·모델별 숫자만 남깁니다.
 * 계정별로 나누기 전의 줄에는 userId 가 없습니다. 옛 데이터의 주인을 정할 때(Ownership.claim) 함께 붙습니다.
 */
import { UsageTally, dayKey, summarizeUsage } from '../usage.js';
import { rawPromptTokens } from './chat-context.js';

/** 이만큼 지난 날짜는 지웁니다. 화면은 30일까지만 보여 주지만 넉넉히 둡니다. */
const KEEP_DAYS = 90;

export class UsageLedger {
  /** @param {import('../db.js').JsonDoc} doc */
  constructor(doc) {
    this.doc = doc;
  }

  get days() {
    return this.doc.data.days;
  }

  /**
   * 모델 호출 하나를 지켜보는 계량기. onUsage 를 엔진에 넘기고, 끝나면 record(text) 로 남깁니다.
   * request 는 streamChat 에 넘기는 것과 같은 { provider, config, system, messages } 에 호출한 사람(userId)을 더한 것.
   * promptEstimate 는 엔진이 프롬프트 토큰을 알려 주지 않을 때 쓸 어림. 없으면 여기서 셉니다.
   */
  meter({ userId = null, provider, config, system = '', messages = [], promptEstimate = rawPromptTokens(system, messages) }) {
    const tally = new UsageTally({ promptEstimate });
    return {
      onUsage: (u) => tally.note(u),
      record: (text) => this.add(provider, config?.model, tally.finish(text), Date.now(), userId)
    };
  }

  add(provider, model, used, now = Date.now(), userId = null) {
    if (!used) return;
    const key = dayKey(now);
    const rows = this.days[key] || (this.days[key] = []);
    const name = String(model || '(모델 미지정)');
    let row = rows.find((r) => (r.userId ?? null) === userId && r.provider === provider && r.model === name);
    if (!row) rows.push((row = { ...(userId ? { userId } : {}), provider, model: name, requests: 0, promptTokens: 0, completionTokens: 0, estimated: 0 }));
    row.requests += 1;
    row.promptTokens += used.promptTokens;
    row.completionTokens += used.completionTokens;
    if (used.estimated) row.estimated += 1;
    this.prune(now);
    this.doc.save();
  }

  prune(now = Date.now()) {
    const oldest = dayKey(now - KEEP_DAYS * 86_400_000);
    for (const key of Object.keys(this.days)) if (key < oldest) delete this.days[key];
  }

  /**
   * 한 계정의 요약(userId), 또는 전체 요약과 계정별 합계(all). nameOf 로 계정별 합계에 이름을 붙입니다.
   * 계정별 합계에는 숫자만 있고 대화 내용은 없습니다 — 주인이 요금을 확인하려고 봅니다.
   */
  summary({ userId, all = false, nameOf = (id) => id } = {}, now = Date.now()) {
    const out = summarizeUsage(this.days, now, all ? { byUser: true } : { userId });
    if (all) {
      for (const period of out.periods) {
        for (const u of period.users) u.name = u.userId ? nameOf(u.userId) : '(계정 나누기 전)';
      }
    }
    return out;
  }

  /**
   * 줄의 주인을 옮깁니다. from 이 없으면 userId 가 없는 옛 줄을 옮깁니다 (Ownership.claim 이 부름).
   * @returns 옮긴 줄 수
   */
  reassign(to, { from } = {}) {
    let moved = 0;
    for (const rows of Object.values(this.days)) {
      for (const row of rows) {
        if (from ? row.userId !== from : row.userId) continue;
        row.userId = to;
        moved += 1;
      }
    }
    if (moved) this.doc.save();
    return moved;
  }

  clear() {
    this.doc.data.days = {};
    this.doc.save();
  }
}
