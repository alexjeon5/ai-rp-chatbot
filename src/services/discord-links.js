/**
 * 디스코드 계정과 앱 계정 잇기. 디스코드 봇은 연결된 앱 계정(actor)으로만 일합니다 — 연결이 곧 권한입니다.
 *
 * 잇는 순서: 웹(로그인한 화면)에서 1회용 코드를 받고 → 디스코드에서 `/rp link code:` 로 넣습니다.
 * 반대(봇이 준 링크를 웹에서 승인)는 쓰지 않습니다. 남이 자기 디스코드용 링크를 보내 누르게 하면
 * 그 사람의 디스코드가 내 계정에 붙기 때문입니다. 코드는 로그인한 내 화면에만 나옵니다.
 *
 * data/discord.json (store.discordDoc)
 *   links  디스코드 사용자 id → { userId, epoch, name, linkedAt }   앱 계정 하나에 디스코드 계정 하나
 *   codes  sha256(코드) → { userId, expiresAt }                     원래 코드는 남기지 않습니다
 *
 * 연결은 쓸 때마다 확인합니다. 계정을 지웠거나 epoch 가 바뀌었으면(비밀번호 변경·logout-all) 끊긴 것입니다.
 */
import { createHash, randomInt } from 'node:crypto';
import { RateLimiter } from '../security.js';
import { AppError } from './errors.js';

export const CODE_TTL_MS = 5 * 60_000;
/** 헷갈리는 글자(0·O, 1·I·L)를 뺀 31자. 8자리면 8천억 가지가 넘습니다. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** 적은 대로 받습니다. 소문자·공백·붙임표는 가리지 않습니다. */
export const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => createHash('sha256').update(normalizeCode(code)).digest('hex');
const SNOWFLAKE = /^\d{5,25}$/;

export class DiscordLinks {
  /**
   * @param {{ doc: import('../db.js').JsonDoc, resolveUser: (id: string) => ({ id, name, role, epoch? } | null), now?: () => number }} deps
   *   resolveUser 는 앱 계정 id 로 지금 계정을 찾습니다. 없으면(지운 계정) null
   */
  constructor({ doc, resolveUser, now = Date.now }) {
    Object.assign(this, { doc, resolveUser, now });
    // 코드를 맞춰 보는 시도는 디스코드 사용자마다 10분에 5번까지.
    this.attempts = new RateLimiter({ windowMs: 10 * 60_000, max: 5, message: '' });
    /** 봇이 켜져 있는지와 봇 이름. 봇이 켜질 때 채웁니다. 화면이 안내에 씁니다. */
    this.bot = { enabled: false, name: '' };
  }

  get data() {
    const d = this.doc.data;
    d.links ||= {};
    d.codes ||= {};
    return d;
  }

  prune() {
    const now = this.now();
    let changed = false;
    for (const [key, c] of Object.entries(this.data.codes)) {
      if (c.expiresAt > now) continue;
      delete this.data.codes[key];
      changed = true;
    }
    return changed;
  }

  /** 웹에서: 이 계정을 이을 1회용 코드. 전에 받은 코드는 무효가 됩니다. */
  issueCode(actor) {
    if (!actor?.id) throw new AppError('로그인이 필요합니다.', 401);
    this.prune();
    for (const [key, c] of Object.entries(this.data.codes)) if (c.userId === actor.id) delete this.data.codes[key];
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = this.now() + CODE_TTL_MS;
    this.data.codes[hashCode(code)] = { userId: actor.id, expiresAt };
    this.doc.save();
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  /**
   * 디스코드에서: 코드를 넣어 계정을 잇습니다. 이 디스코드 계정이 다른 앱 계정에 붙어 있었거나,
   * 이 앱 계정에 다른 디스코드 계정이 붙어 있었으면 그 연결은 끊고 새로 잇습니다.
   * @param {{ id: string, name?: string }} discordUser
   * @returns {{ id, name, role }} 이어진 앱 계정
   */
  redeem(discordUser, code) {
    if (!SNOWFLAKE.test(String(discordUser?.id || ''))) throw new AppError('디스코드 사용자를 알 수 없습니다.');
    if (!this.attempts.hit(`discord:${discordUser.id}`)) {
      throw new AppError('코드를 너무 여러 번 넣었습니다. 10분 뒤에 다시 해 주세요.', 429);
    }
    const changed = this.prune();
    const key = hashCode(code);
    const found = normalizeCode(code).length === CODE_LENGTH && this.data.codes[key];
    const user = found && this.resolveUser(found.userId);
    if (!user) {
      if (changed) this.doc.save();
      throw new AppError('코드가 맞지 않거나 시간이 지났습니다. 웹의 설정 → 디스코드에서 새 코드를 받아 주세요.');
    }
    delete this.data.codes[key];
    for (const [id, link] of Object.entries(this.data.links)) if (link.userId === user.id) delete this.data.links[id];
    this.data.links[discordUser.id] = {
      userId: user.id,
      epoch: user.epoch || 0,
      name: String(discordUser.name || '').slice(0, 64),
      linkedAt: this.now()
    };
    this.doc.save();
    return { id: user.id, name: user.name, role: user.role };
  }

  /**
   * 이 디스코드 사용자가 누구로 일하는지. 연결이 없거나 끊겼으면 null.
   * 끊긴 연결(계정 삭제·epoch 변경)은 여기서 치웁니다.
   */
  actorOf(discordUserId) {
    const link = this.data.links[discordUserId];
    if (!link) return null;
    const user = this.resolveUser(link.userId);
    if (!user || (user.epoch || 0) !== (link.epoch || 0)) {
      delete this.data.links[discordUserId];
      this.doc.save();
      return null;
    }
    return { id: user.id, name: user.name, role: user.role };
  }

  /** 웹에서 보여 줄 이 계정의 연결 상태. 끊긴 연결은 없는 것으로 봅니다. */
  status(actor) {
    const entry = Object.entries(this.data.links).find(([, link]) => link.userId === actor?.id);
    const linked = entry && this.actorOf(entry[0]) ? { name: entry[1].name, linkedAt: entry[1].linkedAt } : null;
    const now = this.now();
    const pending = Object.values(this.data.codes).find((c) => c.userId === actor?.id && c.expiresAt > now);
    return { linked, pending: pending ? { expiresAt: pending.expiresAt } : null, bot: { ...this.bot } };
  }

  /** 웹에서: 이 계정의 연결을 끊고 받아 둔 코드도 버립니다. */
  unlink(actor) {
    let removed = false;
    for (const [id, link] of Object.entries(this.data.links)) {
      if (link.userId !== actor?.id) continue;
      delete this.data.links[id];
      removed = true;
    }
    for (const [key, c] of Object.entries(this.data.codes)) if (c.userId === actor?.id) delete this.data.codes[key];
    this.doc.save();
    return removed;
  }

  /** 디스코드에서: 이 디스코드 계정의 연결을 끊습니다. */
  unlinkDiscord(discordUserId) {
    if (!this.data.links[discordUserId]) return false;
    delete this.data.links[discordUserId];
    this.doc.save();
    return true;
  }
}
