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
 *
 * Docker 에서는:
 *   docker compose exec rp-chat node scripts/user.js add <아이디>
 */
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  USERS_FILE, ROLES, NAME_RULE, nameKey, readUsers, writeUsers, hashPassword
} from '../src/auth.js';

const MIN_PASSWORD = 8;

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

/** 터미널에서는 친 글자가 화면에 나오지 않게 받습니다. */
function askHidden(question) {
  if (!process.stdin.isTTY) return pipedLine();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // 질문 문구는 이미 찍혔으니, 이후 입력 메아리만 끕니다.
    rl._writeToOutput = () => {};
  });
}

async function askNewPassword() {
  const first = await askHidden('새 비밀번호: ');
  if (first.length < MIN_PASSWORD) fail(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  const second = await askHidden('한 번 더: ');
  if (first !== second) fail('두 번 입력한 비밀번호가 다릅니다.');
  return hashPassword(first);
}

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

    default:
      console.log([
        '사용법:',
        '  list                          계정 목록',
        '  add <아이디> [--owner|--member]  계정 만들기 (첫 계정은 주인)',
        '  passwd <아이디>                 비밀번호 바꾸기 (모든 기기 로그아웃)',
        '  logout-all <아이디>             모든 기기 로그아웃',
        '  role <아이디> <owner|member>     역할 바꾸기',
        '  remove <아이디>                 계정 지우기'
      ].join('\n'));
      if (command) process.exit(1);
  }
}

main().catch((e) => fail(e.message));
