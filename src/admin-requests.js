/**
 * 계정 명령(scripts/user.js)과 서버 사이의 요청 통로.
 *
 * 서버는 데이터를 전부 메모리에 올려 두고 씁니다. 명령이 data/chats/*.json 같은 파일을 직접 고치면
 * 서버가 다음에 저장할 때 옛 내용으로 덮어씁니다. 그래서 데이터를 바꾸는 명령(claim, remove --purge)은
 * 요청만 남기고, 실제로 바꾸는 일은 서버가 합니다. 서버가 꺼져 있으면 다음에 켤 때 처리합니다.
 *
 *   data/admin/requests/<id>.json   명령이 남긴 요청
 *   data/admin/results/<id>.json    서버가 남긴 결과. 명령이 읽고 지웁니다
 *
 * 요청 하나가 파일 하나라, 명령과 서버가 같은 파일을 동시에 쓰는 일이 없습니다.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export class AdminRequests {
  constructor(dir = path.join(DATA_DIR, 'admin')) {
    this.requests = path.join(dir, 'requests');
    this.results = path.join(dir, 'results');
  }

  /* ---------------- 명령 쪽 ---------------- */

  /** 요청을 남기고 id 를 돌려줍니다. */
  submit(request) {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    writeAtomic(path.join(this.requests, `${id}.json`), { ...request, id, at: Date.now() });
    return id;
  }

  /** 서버가 처리할 때까지 잠깐 기다립니다. 시간 안에 끝나지 않으면 null (서버가 꺼져 있을 때). */
  async wait(id, ms = 8000) {
    const file = path.join(this.results, `${id}.json`);
    for (const until = Date.now() + ms; Date.now() < until; await sleep(200)) {
      const result = existsSync(file) && readJson(file);
      if (result) {
        try { unlinkSync(file); } catch { /* 이미 지워졌으면 그만입니다 */ }
        return result;
      }
    }
    return null;
  }

  /* ---------------- 서버 쪽 ---------------- */

  /** 아직 처리하지 않은 요청들. 남긴 순서대로. */
  pending() {
    let files;
    try {
      files = readdirSync(this.requests).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    return files.map((f) => readJson(path.join(this.requests, f)) || { id: f.replace(/\.json$/, ''), broken: true });
  }

  /** 결과를 남기고 요청을 치웁니다. */
  finish(id, result) {
    writeAtomic(path.join(this.results, `${id}.json`), { ...result, id, at: Date.now() });
    try { unlinkSync(path.join(this.requests, `${id}.json`)); } catch { /* 이미 없음 */ }
  }
}
