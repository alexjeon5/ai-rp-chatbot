#!/usr/bin/env node
/**
 * 계정 관리. 가입 화면이 없으므로 계정은 여기서만 만듭니다.
 * 서버가 켜져 있어도 됩니다. 서버는 users.json 이 바뀌면 알아서 다시 읽습니다.
 *
 *   npm run user -- list
 *   npm run user -- add <아이디> [--owner | --member]
 *   npm run user -- passwd <아이디>
 *   npm run user -- logout-all <아이디>
 *   npm run user -- remove <아이디>
 *   npm run user -- check <아이디>          비밀번호가 맞는지 확인
 *   npm run user -- unlock                  로그인 실패 제한 풀기
 *   npm run user -- auth off [30m|2h]       로그인 잠시 끄기 (기본 30분)
 *   npm run user -- auth on | status
 *
 * Docker 에서는:
 *   docker compose exec rp-chat node scripts/user.js add <아이디>
 */
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  USERS_FILE, ROLES, NAME_RULE, nameKey, readUsers, writeUsers, hashPassword, verifyPassword,
  readAuthControl, writeAuthControl
} from '../src/auth.js';

const MIN_PASSWORD = 8;
/** 로그인을 끌 수 있는 가장 긴 시간. 켜는 걸 잊어도 하루 안에는 다시 켜집니다. */
const MAX_OFF_MINUTES = 24 * 60;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;

const [, , command, name, ...flags] = process.argv;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/* ---------------- 비밀번호 입력 ---------------- */

/** 파이프로 들어온 입력(echo ... |)은 한 줄씩 꺼내 씁니다. */
let pipedLines = null;
async function pipedLine() {
  if (!pipedLines) {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    pipedLines = buf.split(/\r?\n/);
  }
  return pipedLines.length ? pipedLines.shift() : '';
}

/** 터미널에서는 친 글자가 화면에 나오지 않게 받습니다. hidden 을 끄면 보통처럼 받습니다. */
function ask(question, { hidden = true } = {}) {
  if (!process.stdin.isTTY) return pipedLine();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    // 질문 문구는 이미 찍혔으니, 이후 입력 메아리만 끕니다.
    if (hidden) rl._writeToOutput = () => {};
  });
}

/*
 * 입력이 화면에 안 보이니 한/영 전환이 한글인 채로 치면 모르고 한글 비밀번호가 만들어집니다.
 * 컴퓨터 브라우저의 비밀번호 칸은 한글 입력을 막아서, 그 계정으로는 로그인할 수 없게 됩니다.
 */
async function confirmHangul(password) {
  if (!HANGUL.test(password)) return;
  console.error('비밀번호에 한글이 들어 있습니다. 한/영 전환이 한글로 되어 있지 않았는지 확인해 주세요.\n' +
    '컴퓨터 브라우저의 비밀번호 칸에서는 한글을 칠 수 없어 로그인하지 못할 수 있습니다.');
  // 파이프로 넣은 비밀번호는 일부러 넣은 것이니 경고만 합니다.
  if (!process.stdin.isTTY) return;
  const answer = await ask('그대로 쓸까요? (y/N) ', { hidden: false });
  if (!/^y/i.test(answer.trim())) fail('취소했습니다. 영문 입력으로 바꾼 뒤 다시 실행해 주세요.');
}

async function askNewPassword() {
  const first = await ask('새 비밀번호: ');
  if (first.length < MIN_PASSWORD) fail(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  const second = await ask('한 번 더: ');
  if (first !== second) fail('두 번 입력한 비밀번호가 다릅니다.');
  await confirmHangul(first);
  return hashPassword(first);
}

/** "30", "30m", "2h" → 분. */
function parseMinutes(text) {
  if (text === undefined) return 30;
  const m = /^(\d+)\s*(m|min|분|h|시간)?$/i.exec(String(text).trim());
  if (!m) return NaN;
  return Number(m[1]) * (/^(h|시간)$/i.test(m[2] || '') ? 60 : 1);
}

const clock = (ms) => new Date(ms).toLocaleString('ko-KR');

/** 로그인 실패 기록을 이 시각부터 새로 셉니다. 켜져 있는 서버가 파일을 보고 따릅니다. */
const resetFailures = () => writeAuthControl({ ...readAuthControl(), resetAt: Date.now() });

/* ---------------- 명령 ---------------- */

const users = readUsers().map((u) => ({ ...u }));
const indexOf = (n) => users.findIndex((u) => nameKey(u.name) === nameKey(n));
const owners = () => users.filter((u) => u.role === 'owner');

function need(n) {
  if (!n) fail('아이디를 적어 주세요.');
  const i = indexOf(n);
  if (i < 0) fail(`없는 계정입니다: ${n}`);
  return i;
}

async function main() {
  switch (command) {
    case 'list': {
      if (!users.length) return console.log(`계정이 없습니다. (${USERS_FILE})`);
      for (const u of users) {
        const made = u.createdAt ? new Date(u.createdAt).toLocaleString('ko-KR') : '';
        console.log(`${u.role === 'owner' ? '주인' : '멤버'}\t${u.name}\t${made}`);
      }
      return;
    }

    case 'add': {
      const clean = String(name || '').trim().normalize('NFC');
      if (!NAME_RULE.test(clean)) fail('아이디는 1~32자의 글자·숫자·_ . - 만 쓸 수 있습니다.');
      if (indexOf(clean) >= 0) fail(`이미 있는 아이디입니다: ${clean}`);

      // 첫 계정은 주인입니다. 그 뒤로는 따로 적지 않으면 멤버로 만듭니다.
      let role = users.length ? 'member' : 'owner';
      if (flags.includes('--owner')) role = 'owner';
      if (flags.includes('--member')) {
        if (!users.length) fail('첫 계정은 주인이어야 합니다. --member 를 빼고 다시 실행해 주세요.');
        role = 'member';
      }

      const passwordHash = await askNewPassword();
      users.push({ id: randomUUID().slice(0, 8), name: clean, role, passwordHash, epoch: 0, createdAt: Date.now() });
      writeUsers(users);
      return console.log(`만들었습니다: ${clean} (${role === 'owner' ? '주인' : '멤버'})`);
    }

    case 'passwd': {
      const i = need(name);
      users[i].passwordHash = await askNewPassword();
      // 비밀번호를 바꾸면 이 계정으로 로그인해 둔 기기는 모두 로그아웃됩니다.
      users[i].epoch = (users[i].epoch || 0) + 1;
      writeUsers(users);
      // 틀리다 막힌 뒤에 비밀번호를 새로 정했으면 바로 로그인할 수 있어야 합니다.
      resetFailures();
      return console.log(`비밀번호를 바꿨습니다: ${users[i].name}. 로그인해 둔 기기는 모두 로그아웃됩니다.`);
    }

    case 'logout-all': {
      const i = need(name);
      users[i].epoch = (users[i].epoch || 0) + 1;
      writeUsers(users);
      return console.log(`${users[i].name} 계정의 모든 기기를 로그아웃했습니다.`);
    }

    case 'role': {
      const i = need(name);
      const role = flags[0];
      if (!ROLES.includes(role)) fail(`역할은 ${ROLES.join(' / ')} 중 하나입니다.`);
      if (users[i].role === 'owner' && role !== 'owner' && owners().length === 1) {
        fail('마지막 주인 계정은 멤버로 바꿀 수 없습니다.');
      }
      users[i].role = role;
      writeUsers(users);
      return console.log(`${users[i].name}: ${role === 'owner' ? '주인' : '멤버'}`);
    }

    case 'remove': {
      const i = need(name);
      if (users[i].role === 'owner' && owners().length === 1) fail('마지막 주인 계정은 지울 수 없습니다.');
      const [gone] = users.splice(i, 1);
      writeUsers(users);
      return console.log(`지웠습니다: ${gone.name}. 이 계정의 로그인은 바로 끊깁니다.`);
    }

    case 'check': {
      const i = need(name);
      const password = await ask('비밀번호: ');
      if (await verifyPassword(password, users[i].passwordHash)) {
        return console.log(`맞습니다: ${users[i].name}. 서버가 읽는 계정 파일은 ${USERS_FILE} 입니다.`);
      }
      const hint = HANGUL.test(password) ? '\n입력에 한글이 섞였습니다. 한/영 전환을 확인해 주세요.' : '';
      fail(`맞지 않습니다: ${users[i].name}. 기억이 안 나면 passwd 로 새로 정하세요.${hint}`);
      break;
    }

    case 'unlock': {
      resetFailures();
      return console.log('로그인 실패 기록을 지웠습니다. 바로 다시 로그인할 수 있습니다.');
    }

    case 'auth': {
      const control = readAuthControl();
      const now = Date.now();
      const sub = name || 'status';

      if (sub === 'off') {
        const minutes = parseMinutes(flags[0]);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_OFF_MINUTES) {
          fail(`시간은 1분에서 ${MAX_OFF_MINUTES / 60}시간 사이로 적어 주세요. 예: auth off 30m, auth off 2h`);
        }
        const until = now + minutes * 60_000;
        writeAuthControl({ ...control, offUntil: until });
        return console.log([
          `로그인을 ${minutes}분 동안 껐습니다 (${clock(until)} 까지). 서버를 다시 켤 필요는 없습니다.`,
          '그동안은 주소를 아는 누구나 주인 권한으로 들어옵니다. 일을 마치면 바로 켜 주세요:',
          '  npm run user -- auth on'
        ].join('\n'));
      }
      if (sub === 'on') {
        writeAuthControl({ ...control, offUntil: 0 });
        return console.log('로그인을 다시 켰습니다.');
      }
      if (sub === 'status') {
        if (control.offUntil > now) {
          const left = Math.ceil((control.offUntil - now) / 60_000);
          return console.log(`꺼짐 — ${clock(control.offUntil)} 까지 (${left}분 남음). 로그인 없이 누구나 들어옵니다.`);
        }
        return console.log(`켜짐 — 로그인해야 들어옵니다. 계정 ${users.length}개 (${USERS_FILE})`);
      }
      fail('auth 뒤에는 off [시간] / on / status 중 하나를 적어 주세요.');
      break;
    }

    default:
      console.log([
        '사용법:',
        '  list                          계정 목록',
        '  add <아이디> [--owner|--member]  계정 만들기 (첫 계정은 주인)',
        '  passwd <아이디>                 비밀번호 바꾸기 (모든 기기 로그아웃)',
        '  logout-all <아이디>             모든 기기 로그아웃',
        '  role <아이디> <owner|member>     역할 바꾸기',
        '  remove <아이디>                 계정 지우기',
        '  check <아이디>                  비밀번호가 맞는지 확인',
        '  unlock                         로그인 실패 제한 풀기',
        '  auth off [30m|2h]              로그인 잠시 끄기 (기본 30분, 최대 24시간)',
        '  auth on                        로그인 다시 켜기',
        '  auth status                    지금 상태'
      ].join('\n'));
      if (command) process.exit(1);
  }
}

main().catch((e) => fail(e.message));
