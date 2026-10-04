/** CHARX 의 카드 JSON 과 그림을 꺼내고, V3 카드와 그림을 ZIP 으로 묶습니다. */
import { openZip, writeZip, ZipError } from './zip.js';
import { CardError } from './png-card.js';

const MAX = { card: 8 * 1024 * 1024, image: 8 * 1024 * 1024 };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 읽지 못한 그림은 건너뛰고 안내합니다. 카드 JSON 을 읽지 못하면 CardError 를 던집니다. */
export function cardFromCharx(buf) {
  let zip;
  try {
    zip = openZip(buf);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    throw new CardError('CHARX(압축) 파일을 열지 못했습니다.');
  }
  if (!zip.has('card.json')) throw new CardError('CHARX 안에 card.json 이 없습니다.');
  let card;
  try {
    card = JSON.parse(zip.read('card.json', { maxBytes: MAX.card }).toString('utf8'));
    if (!isObject(card)) throw new CardError('CHARX 안의 카드 정보가 객체가 아닙니다.');
  } catch (err) {
    if (err instanceof ZipError) throw new CardError('CHARX 안의 card.json 을 읽지 못했습니다.');
    if (err instanceof SyntaxError || err instanceof CardError) throw new CardError('CHARX 안의 카드 정보를 읽지 못했습니다.');
    throw err;
  }

  const assets = Array.isArray(card?.data?.assets) ? card.data.assets : [];
  let external = 0;
  let failed = 0;
  let other = 0;
  function resolve(uri) {
    if (typeof uri !== 'string') { failed++; return null; }
    if (/^ccdefault:/i.test(uri)) return null;
    if (/^https?:\/\//i.test(uri)) { external++; return null; }
    try {
      const embedded = /^embed(?:d)?ed:\/\/(.*)$/i.exec(uri);
      if (embedded) {
        const path = embedded[1];
        let data = zip.read(path, { maxBytes: MAX.image });
        if (data === null) data = zip.read(decodeURIComponent(path), { maxBytes: MAX.image });
        if (data !== null) return data;
      } else {
        const inline = /^data:[^,]*;base64,([\s\S]*)$/i.exec(uri);
        if (inline) {
          // 할당 전에 base64 길이를 확인하고, 실제 바이트 수도 확인합니다.
          const encoded = inline[1].replace(/\s/g, '');
          if (encoded.length > Math.ceil(MAX.image / 3) * 4) { failed++; return null; }
          const data = Buffer.from(encoded, 'base64');
          if (data.length <= MAX.image) return data;
        }
      }
    } catch (err) {
      if (!(err instanceof ZipError) && !(err instanceof URIError)) throw err;
    }
    failed++;
    return null;
  }

  const icons = assets.filter((a) => isObject(a) && a.type === 'icon');
  const preferred = icons.find((a) => a.name === 'main') || icons[0];
  let icon = null;
  const expressions = [];
  for (const asset of assets) {
    if (!isObject(asset)) continue;
    if (asset.type === 'icon' || asset.type === 'emotion') {
      const data = resolve(asset.uri);
      if (data !== null) {
        if (asset.type === 'icon' && asset === preferred) icon = data;
        if (asset.type === 'emotion') expressions.push({ label: String(asset.name ?? '').trim(), data });
      }
    } else if (typeof asset.uri !== 'string' || !/^ccdefault:/i.test(asset.uri)) other++;
  }
  if (!icons.length) {
    const fallback = zip.entries.find((e) => e.name.startsWith('assets/icon/') && /\.(png|jpe?g|webp)$/i.test(e.name));
    if (fallback) icon = resolve(`embeded://${fallback.name}`);
  }
  const dropped = [];
  if (external) dropped.push(`외부 주소 그림 ${external}개`);
  if (failed) dropped.push(`읽지 못한 그림 ${failed}개`);
  if (other) dropped.push(`그 밖의 에셋 ${other}개 (배경·소리 등)`);
  if (zip.has('module.risum')) dropped.push('RisuAI 모듈(module.risum)');
  return { card, icon, expressions, dropped };
}

/** 원본 카드를 바꾸지 않고 그림 경로를 담은 CHARX 를 만듭니다. */
export function buildCharx(card, { icon = null, expressions = [] } = {}) {
  const clone = structuredClone(card);
  clone.data.assets = [];
  const files = [];
  const extension = (ext) => String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  function add(type, name, basename, picture) {
    const ext = extension(picture.ext);
    const path = `assets/${type}/image/${basename}.${ext}`;
    clone.data.assets.push({ type, uri: `embeded://${path}`, name, ext });
    files.push({ name: path, data: picture.data, compress: false });
  }
  if (icon) add('icon', 'main', 'main', icon);
  else clone.data.assets.push({ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' });
  expressions.forEach((picture, i) => add('emotion', picture.label, String(i + 1), picture));
  return writeZip([{ name: 'card.json', data: Buffer.from(JSON.stringify(clone)) }, ...files]);
}
