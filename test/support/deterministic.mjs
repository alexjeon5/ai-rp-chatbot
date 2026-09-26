/**
 * 서버를 띄울 때 `node --import` 로 먼저 읽혀, 실행할 때마다 달라지는 값을 고정합니다.
 * 리팩터링 전후의 서버를 같은 시나리오로 돌려 결과를 한 글자씩 비교하려면 필요합니다.
 *
 *   - Math.random / crypto.randomUUID / randomBytes : 정해진 순서로 나오는 값
 *   - Date.now : 부를 때마다 1ms 씩만 흐르는 시계 (요청 제한 창이 지나지 않게)
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

let seed = 20260927;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// 프로세스를 여러 번 띄우는 테스트는 DET_SEQ_BASE 로 시작값을 달리 줍니다 (id 가 겹치지 않게).
let n = Number(process.env.DET_SEQ_BASE || 0);
crypto.randomUUID = () => {
  n += 1;
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
};
const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = (size, cb) => {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
  if (cb) return process.nextTick(cb, null, buf);
  return buf;
};
crypto.randomBytes.real = realRandomBytes;
syncBuiltinESMExports();

let clock = Date.UTC(2026, 8, 27, 3, 0, 0);
Date.now = () => (clock += 1);
