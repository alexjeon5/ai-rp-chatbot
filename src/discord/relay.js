/**
 * 답변 조각을 디스코드 메시지로 옮기기. 조각이 올 때마다 고치면 디스코드 요청 한도에 걸리므로,
 * 모아 두었다가 interval 마다 한 번 메시지를 고칩니다. 길어지면 다음 메시지로 넘어갑니다.
 *
 * sink 는 메시지를 다루는 세 가지 일입니다 — 디스코드에서는 스레드(또는 웹훅)에 보내기·고치기·지우기.
 *   send(content, components) → 메시지,  edit(메시지, content, components),  remove(메시지)
 * 이 파일은 디스코드를 모릅니다. 시험에서는 가짜 sink 와 가짜 타이머를 끼웁니다.
 */
import { stripForDisplay } from '../../public/js/shared/scene-tags.js';
import { splitMessage, CHUNK_LIMIT } from './split.js';

/** 아직 쓴 글이 없을 때 보여 주는 자리. */
export const PLACEHOLDER = '…';

/** 화면 표식([[표정: …]] 등)을 떼고, 쓰는 중이라 아직 닫히지 않은 표식도 가린 글. */
export const displayText = (raw) => stripForDisplay(String(raw ?? '')).trim();

export class ReplyRelay {
  /**
   * @param {object} o
   * @param {{ send, edit, remove }} o.sink
   * @param {object[]} [o.handles] 이어서 고칠 기존 메시지 (다시 쓰기). 넘치는 것은 지웁니다
   * @param {object[]} [o.liveComponents] 쓰는 동안 마지막 메시지에 달 버튼 (멈추기)
   * @param {number} [o.interval] 메시지를 고치는 간격(ms)
   * @param {number} [o.limit] 한 메시지 길이
   * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [o.timers]
   */
  constructor({ sink, handles = [], liveComponents = [], interval = 1200, limit = CHUNK_LIMIT, timers = { set: setTimeout, clear: clearTimeout } }) {
    Object.assign(this, { sink, liveComponents, interval, limit, timers });
    this.handles = [...handles];
    this.shown = this.handles.map(() => null);
    this.raw = '';
    this.timer = null;
    this.closed = false;
    this.chain = Promise.resolve();
    this.failure = null;
  }

  /** 쓰기 시작: 글이 오기 전에 자리와 멈추기 버튼을 먼저 보여 줍니다. */
  begin() {
    return this.queue(false);
  }

  push(delta) {
    if (this.closed || !delta) return;
    this.raw += delta;
    if (this.timer) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.queue(false);
    }, this.interval);
  }

  /** 다 썼을 때: 마지막 글로 맞추고, 마지막 메시지에 components 를 답니다. 글이 없으면 메시지를 모두 지웁니다. */
  async finish({ components = [] } = {}) {
    this.closed = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    await this.queue(true, components);
    return this.handles;
  }

  get text() {
    return displayText(this.raw);
  }

  /** 앞 요청이 끝난 뒤 차례로 맞춥니다. 디스코드 오류는 모아 두고 다음 차례를 막지 않습니다. */
  queue(final, components = []) {
    this.chain = this.chain
      .then(() => this.sync(final, components))
      .catch((e) => { this.failure ||= e; });
    return this.chain;
  }

  async sync(final, components) {
    const text = this.text;
    const chunks = text ? splitMessage(text, this.limit) : final ? [] : [PLACEHOLDER];
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      const comps = last ? (final ? components : this.liveComponents) : [];
      const key = `${chunks[i]}\u0000${JSON.stringify(comps)}`;
      if (!this.handles[i]) {
        this.handles[i] = await this.sink.send(chunks[i], comps);
      } else if (this.shown[i] !== key) {
        await this.sink.edit(this.handles[i], chunks[i], comps);
      }
      this.shown[i] = key;
    }
    // 다시 쓰기로 글이 짧아졌으면 남는 옛 메시지를 지웁니다.
    while (this.handles.length > chunks.length) {
      const gone = this.handles.pop();
      this.shown.pop();
      await this.sink.remove(gone);
    }
  }
}
