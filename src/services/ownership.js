/**
 * 항목의 주인 정하기와 옮기기. 계정별로 나누기 전의 데이터(ownerId 가 없는 항목)에 주인을 붙이고,
 * 계정을 지울 때 남은 항목을 다른 계정으로 옮기거나 지웁니다.
 *
 *   주인 없는 항목    ownerId 가 없는 옛 항목
 *   고아 항목        ownerId 가 지금 계정 목록에 없는 항목 (지운 계정, 로그인을 끈 개발 모드의 'local')
 *
 * 데이터 파일은 서버만 씁니다. 계정 명령(scripts/user.js)은 AdminRequests 로 요청만 남기고, 서버가 여기서 처리합니다.
 */
import { copyFile, access as exists } from 'node:fs/promises';
import path from 'node:path';
import { pickPrefs, PREF_KEYS } from './prefs.js';

/** 주인이 붙는 저장소. Access 의 종류 이름과 같은 순서입니다. */
const KINDS = [
  ['chat', 'chats'],
  ['character', 'characters'],
  ['persona', 'personas'],
  ['lorebook', 'lorebooks'],
  ['background', 'backgrounds']
];

/** 로그인을 끈 개발 모드(AUTH_DISABLED)의 계정 id. src/auth.js 의 LOCAL_OWNER 와 같습니다. */
export const LOCAL_ID = 'local';

export class Ownership {
  /**
   * @param {object} deps
   * @param {import('../store.js').Store} deps.store
   * @param {import('./prefs.js').UserPrefs} deps.prefs
   * @param {() => {id: string, name: string, role: string}[]} deps.users  지금 계정 목록 (users.json)
   * @param {{ images, attachments, art, backgrounds }} deps.files  항목에 딸린 그림 파일을 지우는 서비스들
   * @param {import('./usage-ledger.js').UsageLedger} [deps.usage] 사용량 기록. 옛 줄의 주인도 함께 옮깁니다
   * @param {boolean} [deps.authDisabled] 로그인을 끈 개발 모드인지
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ store, prefs, users, files, usage = null, authDisabled = false, log = console.log }) {
    Object.assign(this, { store, prefs, users, files, usage, authDisabled, log });
    this.unownedLeft = null;
  }

  /** 모든 저장소의 항목을 [종류, 항목] 으로. */
  *items() {
    for (const [kind, name] of KINDS) {
      for (const item of this.store[name].all()) yield [kind, item];
    }
  }

  /** 종류별 항목 수. owned 가 참인 항목만 셉니다. */
  count(owned) {
    const out = { chat: 0, character: 0, persona: 0, lorebook: 0, background: 0 };
    for (const [kind, item] of this.items()) if (owned(item)) out[kind] += 1;
    return out;
  }

  static total(counts) {
    return KINDS.reduce((sum, [kind]) => sum + (counts[kind] || 0), 0);
  }

  static describe(counts) {
    const names = { chat: '대화', character: '캐릭터', persona: '페르소나', lorebook: '로어북', background: '배경' };
    const parts = KINDS.filter(([kind]) => counts[kind]).map(([kind]) => `${names[kind]} ${counts[kind]}개`);
    return parts.length ? parts.join(', ') : '없음';
  }

  /**
   * 옛 설정 파일에 계정별 값이 남아 있는지. 남아 있으면 아직 주인에게 옮기지 않은 것입니다.
   * dev 는 공용(adultCloud)도 들어 있는 칸이라, 그 밖의 값이 있을 때만 옛 값으로 봅니다.
   */
  hasLegacySettings() {
    const s = this.store.settings;
    const legacyDev = Object.keys(s.dev || {}).some((k) => k !== 'adultCloud');
    return legacyDev || 'seededPersonas' in s || PREF_KEYS.some((k) => k !== 'dev' && k in s);
  }

  /** 주인을 정하지 못한 옛 데이터가 있어 claim 을 기다리는 중인지. */
  waitingForClaim() {
    if (this.unownedLeft === null) this.unownedLeft = Ownership.total(this.count((item) => !item.ownerId));
    return this.unownedLeft > 0 || this.hasLegacySettings();
  }

  /**
   * 부팅 때 옛 데이터의 주인을 정합니다.
   *   주인 계정이 딱 하나면 → 그 계정
   *   계정이 하나도 없고 로그인을 껐으면 → 'local'
   *   그 밖(주인이 여럿 등) → 그대로 두고 claim 을 안내합니다. 그동안 이 항목은 아무에게도 보이지 않습니다
   * @returns {{ to: string|null, moved?: object }}
   */
  async adoptUnowned() {
    this.unownedLeft = null;
    if (!this.waitingForClaim()) return { to: null };
    const users = this.users();
    const owners = users.filter((u) => u.role === 'owner');
    let to = null;
    if (owners.length === 1) to = owners[0].id;
    else if (!users.length && this.authDisabled) to = LOCAL_ID;

    if (!to) {
      const counts = this.count((item) => !item.ownerId);
      this.log(
        `주인이 정해지지 않은 옛 데이터가 있습니다 (${Ownership.describe(counts)}). 주인 계정이 ${owners.length}개라 자동으로 정하지 못했습니다.\n` +
        '  받을 계정을 정해 주세요: npm run user -- claim <아이디>'
      );
      return { to: null };
    }
    const moved = await this.claim(to);
    const who = users.find((u) => u.id === to)?.name || to;
    this.log(`옛 데이터를 ${who} 계정에 붙였습니다: ${Ownership.describe(moved)}${moved.settings ? ', 설정' : ''}`);
    return { to, moved };
  }

  /**
   * 항목을 to 계정으로 옮깁니다.
   * from 을 주면 ownerId 가 from 인 항목만, 안 주면 주인 없는 항목과 고아 항목을 모두 옮깁니다.
   * from 없이 옮길 때는 옛 설정 파일에 남은 계정별 값과 userId 가 없는 사용량 기록도 to 계정으로 옮깁니다.
   * 지운 계정의 사용량은 요금 기록이라 from 을 준 경우에만 옮깁니다.
   * @returns 종류별로 옮긴 수와 settings(설정을 옮겼는지)
   */
  async claim(to, { from } = {}) {
    const known = new Set(this.users().map((u) => u.id));
    const movable = from
      ? (item) => item.ownerId === from && from !== to
      : (item) => !item.ownerId || (item.ownerId !== to && !known.has(item.ownerId));
    const moved = { chat: 0, character: 0, persona: 0, lorebook: 0, background: 0, settings: false };
    for (const [kind, item] of this.items()) {
      if (!movable(item)) continue;
      item.ownerId = to;
      this.store[KINDS.find(([k]) => k === kind)[1]].save(item.id);
      moved[kind] += 1;
    }
    if (!from) moved.settings = await this.adoptLegacySettings(to);
    this.usage?.reassign(to, { from });
    this.unownedLeft = null;
    return moved;
  }

  /**
   * 계정별로 나누기 전의 설정(모드 틀·파라미터·테마 등)을 to 계정의 설정으로 옮기고, 공용 설정 파일에서는 지웁니다.
   * 원본은 settings.json.pre-accounts 로 한 번 남겨 둡니다. 옛 엔진 선택은 새 계정 기본 엔진이 됩니다.
   */
  async adoptLegacySettings(to) {
    if (!this.hasLegacySettings()) return false;
    const s = this.store.settings;
    const backup = path.join(this.store.dir, 'settings.json.pre-accounts');
    const original = path.join(this.store.dir, 'settings.json');
    if (!(await exists(backup).then(() => true, () => false))) await copyFile(original, backup).catch(() => {});

    const actor = { id: to };
    const p = this.prefs.of(actor);
    Object.assign(p, this.prefs.build({ ...p, ...pickPrefs(s) }));
    if (Array.isArray(s.seededPersonas)) p.seededPersonas = [...new Set([...(p.seededPersonas || []), ...s.seededPersonas])];
    // 옛 데이터를 받은 계정은 이미 기본 콘텐츠를 갖고 있습니다. 다시 넣지 않습니다.
    p.onboarded = true;
    this.prefs.save(actor);

    if (typeof s.activeProvider === 'string' && s.providers[s.activeProvider]) s.defaultProvider = s.activeProvider;
    for (const key of [...PREF_KEYS, 'seededPersonas']) {
      if (key === 'dev') continue;
      delete s[key];
    }
    // dev 는 공용(adultCloud)과 계정별(나머지)이 섞여 있었습니다. 공용만 남깁니다.
    s.dev = { adultCloud: s.dev?.adultCloud === true };
    this.store.saveSettings();
    return true;
  }

  /** 한 계정의 항목과 딸린 그림 파일, 계정별 설정을 모두 지웁니다. */
  async purge(ownerId) {
    const removed = { chat: 0, character: 0, persona: 0, lorebook: 0, background: 0 };
    const { images, attachments, art, backgrounds } = this.files;
    for (const [kind, item] of [...this.items()]) {
      if (item.ownerId !== ownerId) continue;
      if (kind === 'chat') await Promise.all([images.removeAll(item.id), attachments.removeAll(item.id)]);
      if (kind === 'character') await art.removeAll(item.id);
      if (kind === 'background') await backgrounds.files.removeAll(item.id);
      await this.store[KINDS.find(([k]) => k === kind)[1]].remove(item.id);
      removed[kind] += 1;
    }
    await this.prefs.remove({ id: ownerId });
    return removed;
  }
}
