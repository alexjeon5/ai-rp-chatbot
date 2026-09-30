/** 모델 호출 한 번의 토큰 사용량을 모으고, 날짜별 기록을 기간별로 합산합니다. 저장은 services/usage-ledger.js. */
import { estimateTokens } from './context.js';

/**
 * 엔진이 스트림 도중 알려 주는 사용량은 누적값입니다. 마지막으로 알려 준 값이 그 호출의 총량입니다.
 * 엔진이 아예 알려 주지 않으면(일부 로컬 서버) 글자 수로 어림해 estimated 로 표시합니다.
 */
export class UsageTally {
  constructor({ promptEstimate = 0 } = {}) {
    this.promptEstimate = promptEstimate;
    this.prompt = 0;
    this.completion = 0;
  }

  note({ promptTokens, completionTokens } = {}) {
    if (promptTokens > 0) this.prompt = promptTokens;
    if (completionTokens > 0) this.completion = completionTokens;
  }

  /** 기록할 것이 없으면(아무것도 받지 못하고 끝난 호출) null. */
  finish(text = '') {
    const gotPrompt = this.prompt > 0;
    const gotCompletion = this.completion > 0;
    const completion = gotCompletion ? this.completion : estimateTokens(text);
    if (!gotPrompt && !gotCompletion && !text.trim()) return null;
    return {
      promptTokens: gotPrompt ? this.prompt : this.promptEstimate,
      completionTokens: completion,
      estimated: !gotPrompt || !gotCompletion
    };
  }
}

/** 로컬(YYYY-MM-DD). 하루의 경계는 서버가 도는 곳의 시간대를 따릅니다. */
export function dayKey(time = Date.now()) {
  const d = new Date(time);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const blank = () => ({ requests: 0, promptTokens: 0, completionTokens: 0, estimated: 0 });

function add(into, row) {
  into.requests += row.requests || 0;
  into.promptTokens += row.promptTokens || 0;
  into.completionTokens += row.completionTokens || 0;
  into.estimated += row.estimated || 0;
}

export const PERIODS = [
  { key: 'today', label: '오늘', days: 1 },
  { key: 'week', label: '최근 7일', days: 7 },
  { key: 'month', label: '최근 30일', days: 30 }
];

const byTokens = (a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens);

/**
 * days: { 'YYYY-MM-DD': [{ userId?, provider, model, requests, promptTokens, completionTokens, estimated }] }
 * 기간별 합계·엔진/모델별 표·날짜별 추이를 만듭니다.
 * @param {object} [o]
 * @param {string} [o.userId] 이 계정의 줄만 셉니다. 주지 않으면 모든 줄
 * @param {boolean} [o.byUser] 기간마다 계정별 합계(users)도 만듭니다. userId 가 없는 옛 줄은 userId: null 로 묶입니다
 */
export function summarizeUsage(days, now = Date.now(), { userId, byUser = false } = {}) {
  const dates = [];
  for (let i = 0; i < 30; i++) dates.push(dayKey(now - i * 86_400_000));
  const rowsOf = (date) => (days[date] || []).filter((row) => userId === undefined || row.userId === userId);

  const periods = PERIODS.map(({ key, label, days: span }) => {
    const total = blank();
    const byModel = new Map();
    const users = new Map();
    for (const date of dates.slice(0, span)) {
      for (const row of rowsOf(date)) {
        add(total, row);
        const id = `${row.provider}\u0000${row.model}`;
        if (!byModel.has(id)) byModel.set(id, { provider: row.provider, model: row.model, ...blank() });
        add(byModel.get(id), row);
        if (byUser) {
          const who = row.userId ?? null;
          if (!users.has(who)) users.set(who, { userId: who, ...blank() });
          add(users.get(who), row);
        }
      }
    }
    const rows = [...byModel.values()].sort(byTokens);
    return { key, label, total, rows, ...(byUser ? { users: [...users.values()].sort(byTokens) } : {}) };
  });

  const daily = dates.map((date) => {
    const sum = blank();
    for (const row of rowsOf(date)) add(sum, row);
    return { date, ...sum };
  }).reverse();

  return { periods, daily };
}
