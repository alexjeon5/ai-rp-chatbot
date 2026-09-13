import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const uid = () => randomUUID().slice(0, 8);

/* ---------------- 쓰기 큐 ---------------- */

const pending = new Map();

/** 같은 파일에 몰아치는 쓰기를 한 번으로 묶습니다. */
function schedule(file, getData) {
  pending.set(file, getData);
  clearTimeout(schedule.timer);
  schedule.timer = setTimeout(() => { flushAll().catch(console.error); }, 250);
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

/** 큐에 남은 쓰기를 모두 끝냅니다. 종료 직전이나 테스트에서 씁니다. */
export async function flushAll() {
  const jobs = [...pending.entries()];
  pending.clear();
  for (const [file, getData] of jobs) await writeJson(file, getData());
}

const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/* ---------------- 문서 한 개 ---------------- */

/** settings.json 처럼 파일 하나에 담기는 객체. */
export class JsonDoc {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = defaults();
  }

  async load() {
    const raw = await readJson(this.file);
    this.data = raw ? merge(this.defaults(), raw) : this.defaults();
    return this;
  }

  save() {
    schedule(this.file, () => this.data);
  }
}

/** 기본값을 바탕에 깔고 저장된 값을 덮습니다. 새로 생긴 항목이 자동으로 채워집니다. */
export function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const isPlain = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]);
    out[k] = isPlain ? merge(base[k], v) : v;
  }
  return out;
}

/* ---------------- 여러 개가 모인 폴더 ---------------- */

/**
 * 폴더 하나를 컬렉션으로 다룹니다. 항목 하나가 파일 하나입니다.
 * characters/a1b2c3d4.json 처럼 파일 이름이 곧 id 입니다.
 */
export class Collection {
  /**
   * @param {string} dir 항목 파일이 담길 폴더
   * @param {(a, b) => number} [sort] 목록 정렬 규칙. 기본은 만든 순서의 역순
   */
  constructor(dir, sort) {
    this.dir = dir;
    this.items = new Map();
    this.sort = sort || ((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    for (const file of files) {
      const item = await readJson(path.join(this.dir, file));
      if (item?.id) this.items.set(item.id, item);
    }
    return this;
  }

  fileOf(id) {
    return path.join(this.dir, `${id}.json`);
  }

  all() {
    return [...this.items.values()].sort(this.sort);
  }

  get(id) {
    return id ? this.items.get(id) || null : null;
  }

  has(id) {
    return this.items.has(id);
  }

  get size() {
    return this.items.size;
  }

  /** id 와 createdAt 을 붙여 새 항목을 넣습니다. */
  add(item) {
    const made = { id: item.id || uid(), createdAt: item.createdAt || Date.now(), ...item };
    made.id = made.id || uid();
    this.items.set(made.id, made);
    this.save(made.id);
    return made;
  }

  /** 항목을 바꾸고 파일에 씁니다. 없는 id 면 null. */
  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save(id);
    return item;
  }

  /** 항목을 직접 고친 뒤 이걸 불러 저장합니다. */
  save(id) {
    const item = this.get(id);
    if (!item) return;
    schedule(this.fileOf(id), () => item);
  }

  async remove(id) {
    if (!this.items.delete(id)) return false;
    pending.delete(this.fileOf(id));
    await unlink(this.fileOf(id)).catch(() => {});
    return true;
  }
}
