/** ZIP 중앙 디렉터리를 읽고, 필요한 파일만 압축 해제합니다. ZIP64 는 지원하지 않습니다. */
import { inflateRawSync, deflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

const MAX_ENTRIES = 5000;
const UINT32_MAX = 0xffffffff;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(data) {
  let crc = UINT32_MAX;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ UINT32_MAX) >>> 0;
}

const normalize = (name) => String(name).replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
const truncated = () => new ZipError('ZIP 파일이 잘렸거나 손상되었습니다.');

/** 중앙 디렉터리만 읽습니다. 파일 내용과 CRC 는 read 를 부를 때 검사합니다. */
export function openZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('ZIP 파일이 아닙니다.');
  let end = -1;
  for (let at = buf.length - 22, min = Math.max(0, buf.length - 22 - 65535); at >= min; at--) {
    if (buf.readUInt32LE(at) === 0x06054b50 && at + 22 + buf.readUInt16LE(at + 20) === buf.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError('ZIP 파일이 아닙니다.');
  if (end >= 20 && buf.readUInt32LE(end - 20) === 0x07064b50) throw new ZipError('ZIP64 파일은 지원하지 않습니다.');

  const disk = buf.readUInt16LE(end + 4);
  const centralDisk = buf.readUInt16LE(end + 6);
  const diskCount = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  const centralSize = buf.readUInt32LE(end + 12);
  const centralOffset = buf.readUInt32LE(end + 16);
  if (diskCount === 0xffff || count === 0xffff || centralSize === UINT32_MAX || centralOffset === UINT32_MAX) {
    throw new ZipError('ZIP64 파일은 지원하지 않습니다.');
  }
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count) throw new ZipError('분할 ZIP 파일은 지원하지 않습니다.');
  if (count > MAX_ENTRIES) throw new ZipError('ZIP 안의 파일이 너무 많습니다.');
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > end) throw truncated();

  const files = new Map();
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > centralEnd || buf.readUInt32LE(at) !== 0x02014b50) throw truncated();
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const startDisk = buf.readUInt16LE(at + 34);
    const offset = buf.readUInt32LE(at + 42);
    if (compressedSize === UINT32_MAX || size === UINT32_MAX || offset === UINT32_MAX || startDisk === 0xffff) {
      throw new ZipError('ZIP64 파일은 지원하지 않습니다.');
    }
    if (startDisk !== 0) throw new ZipError('분할 ZIP 파일은 지원하지 않습니다.');
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw truncated();
    const name = normalize(buf.toString('utf8', at + 46, at + 46 + nameLength));
    if (name && !name.endsWith('/') && !files.has(name)) files.set(name, { name, size, compressedSize, method, flags, crc, offset });
    at = next;
  }

  return {
    entries: [...files.values()].map(({ name, size, compressedSize, method }) => ({ name, size, compressedSize, method })),
    has: (name) => files.has(normalize(name)),
    read(name, { maxBytes = 8 * 1024 * 1024 } = {}) {
      const file = files.get(normalize(name));
      if (!file) return null;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ZipError('압축 해제 크기 한도가 올바르지 않습니다.');
      const { size, compressedSize, method, flags, crc, offset } = file;
      if (flags & 0x41) throw new ZipError('암호화된 ZIP 파일은 지원하지 않습니다.');
      if (size > maxBytes) throw new ZipError('ZIP 안의 파일이 너무 큽니다.');
      if (offset + 30 > centralOffset || buf.readUInt32LE(offset) !== 0x04034b50) throw truncated();
      if (buf.readUInt16LE(offset + 6) & 0x41) throw new ZipError('암호화된 ZIP 파일은 지원하지 않습니다.');
      if (buf.readUInt16LE(offset + 8) !== method) throw truncated();
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      if (start + compressedSize > centralOffset) throw truncated();
      const data = buf.subarray(start, start + compressedSize);
      let out;
      if (method === 0) {
        if (compressedSize !== size) throw truncated();
        out = Buffer.from(data);
      } else if (method === 8) {
        try {
          out = inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
        } catch {
          throw new ZipError('ZIP 파일을 압축 해제하지 못했습니다. 크기 한도를 넘었거나 손상되었습니다.');
        }
      } else throw new ZipError('지원하지 않는 ZIP 압축 방식입니다.');
      if (out.length > maxBytes) throw new ZipError('ZIP 안의 파일이 너무 큽니다.');
      if (out.length !== size) throw truncated();
      if (crc32(out) !== crc) throw new ZipError('ZIP 파일의 CRC 가 일치하지 않습니다.');
      return out;
    }
  };
}

/** 파일 순서대로 ZIP 을 만듭니다. 압축했을 때 더 작아지는 파일만 deflate 를 사용합니다. */
export function writeZip(files) {
  if (!Array.isArray(files) || files.length > MAX_ENTRIES) throw new ZipError('ZIP 안의 파일 수가 올바르지 않습니다.');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    if (!Buffer.isBuffer(file?.data)) throw new ZipError('ZIP 파일 내용은 Buffer 여야 합니다.');
    const name = Buffer.from(normalize(file.name), 'utf8');
    if (!name.length || name.length > 0xffff) throw new ZipError('ZIP 파일 이름이 올바르지 않습니다.');
    if (file.data.length >= UINT32_MAX) throw new ZipError('ZIP64 파일은 지원하지 않습니다.');
    const packed = file.compress === false ? file.data : deflateRawSync(file.data);
    const method = packed.length < file.data.length && file.compress !== false ? 8 : 0;
    const data = method === 8 ? packed : file.data;
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01 입니다.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(file.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
    if (offset >= UINT32_MAX) throw new ZipError('ZIP64 파일은 지원하지 않습니다.');
  }
  const directory = Buffer.concat(central);
  if (directory.length >= UINT32_MAX || offset + directory.length >= UINT32_MAX) throw new ZipError('ZIP64 파일은 지원하지 않습니다.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
