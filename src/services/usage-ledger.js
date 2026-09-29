/** 날짜별 토큰 사용량 기록 (data/usage.json). 대화 내용은 담지 않고 엔진·모델별 숫자만 남깁니다. */
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
   * request 는 streamChat 에 넘기는 것과 같은 { provider, config, system, messages }.
   * promptEstimate 는 엔진이 프롬프트 토큰을 알려 주지 않을 때 쓸 어림. 없으면 여기서 셉니다.
   */
  meter({ provider, config, system = '', messages = [], promptEstimate = rawPromptTokens(system, messages) }) {
    const tally = new UsageTally({ promptEstimate });
    return {
      onUsage: (u) => tally.note(u),
      record: (text) => this.add(provider, config?.model, tally.finish(text))
    };
  }

  add(provider, model, used, now = Date.now()) {
    if (!used) return;
    const key = dayKey(now);
    const rows = this.days[key] || (this.days[key] = []);
    const name = String(model || '(모델 미지정)');
    let row = rows.find((r) => r.provider === provider && r.model === name);
    if (!row) rows.push((row = { provider, model: name, requests: 0, promptTokens: 0, completionTokens: 0, estimated: 0 }));
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

  summary(now = Date.now()) {
    return summarizeUsage(this.days, now);
  }

  clear() {
    this.doc.data.days = {};
    this.doc.save();
  }
}
