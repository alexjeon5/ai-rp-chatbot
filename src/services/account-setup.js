/**
 * 계정 준비. 처음 들어온 계정에 기본 페르소나 '나' 와 내장 캐릭터를 넣고, 내장 페르소나 중 아직 넣은 적 없는 것을 추가합니다.
 * 내장 콘텐츠는 계정마다 따로 사본을 받습니다 — 고치고, 그림을 달고, 지우는 일이 계정마다 따로이기 때문입니다.
 * 손대지 않은 사본은 부팅 때 store.syncBuiltinCharacters() 가 계정과 상관없이 새 내용으로 맞춥니다.
 *
 * 웹은 로그인한 요청마다, 디스코드는 계정을 연결할 때 ensure(actor) 를 부릅니다. 여러 번 불러도 한 번만 일합니다.
 */
import { BUILTIN_PERSONAS } from '../content/personas.js';
import { UserPrefs } from './prefs.js';

export class AccountSetup {
  /**
   * @param {{ store, access, prefs: UserPrefs, library: import('./library.js').Library, ownership: import('./ownership.js').Ownership }} deps
   */
  constructor({ store, access, prefs, library, ownership }) {
    Object.assign(this, { store, access, prefs, library, ownership });
    // 이번 실행에서 이미 확인한 계정.
    this.checked = new Set();
  }

  ensure(actor) {
    if (!UserPrefs.storable(actor) || this.checked.has(actor.id)) return;
    // 주인이 여럿이라 옛 데이터의 주인을 아직 못 정했으면, 주인 계정은 기다립니다.
    // 지금 기본 콘텐츠를 넣으면 나중에 claim 으로 옛 데이터를 받았을 때 내장 캐릭터가 두 벌이 됩니다.
    if (actor.role === 'owner' && this.ownership?.waitingForClaim()) return;
    this.checked.add(actor.id);

    const p = this.prefs.of(actor);
    if (!p.onboarded) {
      this.seed(actor, p);
      p.onboarded = true;
    }
    this.addMissingBuiltinPersonas(actor, p);
    this.prefs.save(actor);
  }

  /** 처음 들어온 계정: 기본 페르소나 하나와 내장 캐릭터. */
  seed(actor, p) {
    const persona = this.store.personas.add(this.access.stamp(actor, {
      name: '나',
      description: '평범한 대학생. 호기심이 많고 말수가 적은 편이다.'
    }));
    if (!p.activePersonaId) p.activePersonaId = persona.id;
    this.library.addMissingBuiltins(actor);
  }

  /**
   * 내장 페르소나 중 이 계정에 한 번도 넣지 않은 것만 추가합니다. 넣은 이름은 계정 설정에 적어 두어,
   * 사용자가 지운 페르소나가 다음 실행 때 되살아나지 않게 합니다.
   */
  addMissingBuiltinPersonas(actor, p) {
    if (!Array.isArray(p.seededPersonas)) p.seededPersonas = [];
    const names = new Set(this.access.personas(actor).map((x) => x.name));
    let added = 0;
    for (const def of BUILTIN_PERSONAS) {
      if (p.seededPersonas.includes(def.name)) continue;
      if (!names.has(def.name)) {
        this.store.personas.add(this.access.stamp(actor, { ...def, traits: [...def.traits] }));
        added += 1;
      }
      p.seededPersonas.push(def.name);
    }
    return added;
  }
}
