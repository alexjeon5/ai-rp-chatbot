import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openZip, writeZip, ZipError } from '../../src/zip.js';

const file = (name = 'a.txt', data = Buffer.from('hello'), compress = false) => ({ name, data, compress });
const centralAt = (buf) => buf.readUInt32LE(buf.length - 6);
const dataAt = (buf) => 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);

test('ZIP: stored·deflate·한글 이름과 빈 파일을 왕복합니다', () => {
  const files = [file('프로필/한글.txt'), file('compressed.txt', Buffer.alloc(4096, 65), true), file('empty', Buffer.alloc(0), true)];
  const zip = openZip(writeZip(files));
  assert.deepEqual(zip.entries.map((e) => e.name), files.map((f) => f.name));
  assert.deepEqual(zip.entries.map((e) => e.method), [0, 8, 0]);
  for (const f of files) assert.deepEqual(zip.read(f.name), f.data);
  assert.equal(zip.read('empty', { maxBytes: 0 }).length, 0);
  assert.equal(zip.has('missing'), false);
  assert.equal(zip.read('missing'), null);
  const empty = openZip(writeZip([]));
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.read('anything'), null);
});

test('ZIP: 이름을 정규화하고 디렉터리는 제외하며 중복은 첫 항목을 씁니다', () => {
  const zip = openZip(writeZip([
    file('/./\\./folder\\한글.txt', Buffer.from('first')),
    file('folder/한글.txt', Buffer.from('second')),
    file('./folder/', Buffer.alloc(0))
  ]));
  assert.deepEqual(zip.entries.map((e) => e.name), ['folder/한글.txt']);
  assert.equal(zip.has('/./folder\\한글.txt'), true);
  assert.equal(zip.read('././folder/한글.txt').toString(), 'first');

  // 다른 도구가 쓴 중앙 디렉터리 이름도 정규화합니다.
  const buf = writeZip([file('xx/a.txt')]);
  buf.write('./', centralAt(buf) + 46, 'utf8');
  assert.equal(openZip(buf).read('a.txt').toString(), 'hello');
});

test('ZIP: 그림 크기 한도와 손상된 CRC 를 검사합니다', () => {
  const buf = writeZip([file()]);
  assert.throws(() => openZip(buf).read('a.txt', { maxBytes: 4 }), ZipError);
  buf[dataAt(buf)] ^= 1;
  assert.throws(() => openZip(buf).read('a.txt'), /CRC/);
});

test('ZIP: ZIP 이 아닌 값·잘린 헤더·잘린 내용을 거부합니다', () => {
  for (const buf of [null, 'zip', Buffer.alloc(0), Buffer.from('this is definitely not a zip file')]) {
    assert.throws(() => openZip(buf), ZipError);
  }
  const good = writeZip([file()]);
  for (const length of [good.length - 1, good.length - 10, 20]) assert.throws(() => openZip(good.subarray(0, length)), ZipError);
  const central = Buffer.from(good);
  central.writeUInt16LE(0xffff, centralAt(central) + 28);
  assert.throws(() => openZip(central), ZipError);
  const local = Buffer.from(good);
  local.writeUInt16LE(0xffff, 28);
  assert.throws(() => openZip(local).read('a.txt'), ZipError);
  const offset = Buffer.from(good);
  offset.writeUInt32LE(good.length - 1, centralAt(offset) + 42);
  assert.throws(() => openZip(offset).read('a.txt'), ZipError);
});

test('ZIP: ZIP64·많은 항목·암호화·지원하지 않는 압축을 거부합니다', () => {
  const good = writeZip([file()]);
  const zip64 = Buffer.from(good);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
  assert.throws(() => openZip(zip64), /ZIP64/);
  const entry64 = Buffer.from(good);
  entry64.writeUInt32LE(0xffffffff, centralAt(entry64) + 24);
  assert.throws(() => openZip(entry64), /ZIP64/);
  const many = Buffer.from(good);
  many.writeUInt16LE(5001, many.length - 14);
  many.writeUInt16LE(5001, many.length - 12);
  assert.throws(() => openZip(many), ZipError);
  const encrypted = Buffer.from(good);
  encrypted.writeUInt16LE(1, centralAt(encrypted) + 8);
  assert.throws(() => openZip(encrypted).read('a.txt'), /암호화/);
  const unsupported = Buffer.from(good);
  unsupported.writeUInt16LE(99, 8);
  unsupported.writeUInt16LE(99, centralAt(unsupported) + 10);
  assert.throws(() => openZip(unsupported).read('a.txt'), /압축 방식/);
});

test('ZIP: 중앙 디렉터리의 크기를 사용해 data descriptor 파일을 읽습니다', () => {
  const original = writeZip([file()]);
  const at = centralAt(original);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  original.copy(descriptor, 4, 14, 26);
  const buf = Buffer.concat([original.subarray(0, at), descriptor, original.subarray(at)]);
  buf.writeUInt16LE(0x0808, 6);
  buf.fill(0, 14, 26);
  buf.writeUInt16LE(0x0808, at + descriptor.length + 8);
  buf.writeUInt32LE(at + descriptor.length, buf.length - 6);
  assert.equal(openZip(buf).read('a.txt').toString(), 'hello');
});

test('ZIP: ZIP 설명에 서명이 있어도 올바른 EOCD 를 찾습니다', () => {
  const buf = writeZip([file()]);
  const comment = Buffer.alloc(40);
  comment.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(comment.length, buf.length - 2);
  assert.equal(openZip(Buffer.concat([buf, comment])).read('a.txt').toString(), 'hello');
});

test('ZIP: 선언 크기와 실제 압축 해제 중의 크기 모두 제한합니다', () => {
  const buf = writeZip([file('bomb', Buffer.alloc(20 * 1024 * 1024), true)]);
  assert.equal(openZip(buf).entries[0].method, 8);
  assert.throws(() => openZip(buf).read('bomb', { maxBytes: 1024 * 1024 }), ZipError);
  // 선언 크기를 속여도 inflateRawSync 의 출력 한도가 적용됩니다.
  buf.writeUInt32LE(1, centralAt(buf) + 24);
  assert.throws(() => openZip(buf).read('bomb', { maxBytes: 1024 * 1024 }), /크기 한도/);
});

test('ZIP: Python zipfile 로 열어 CRC 와 날짜·내용을 확인합니다', (t) => {
  const available = spawnSync('python3', ['--version']);
  if (available.error?.code === 'ENOENT') return t.skip('python3 없음');
  const buf = writeZip([file('한글.txt'), file('compress.txt', Buffer.alloc(1000, 65), true)]);
  const result = spawnSync('python3', ['-c',
    'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.read("한글.txt")==b"hello"; assert z.read("compress.txt")==b"A"*1000; assert z.getinfo("한글.txt").date_time==(1980,1,1,0,0,0)'
  ], { input: buf, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
