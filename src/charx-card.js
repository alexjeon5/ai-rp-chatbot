/** CHARX 의 카드 JSON 과 그림을 꺼내고, V3 카드와 그림을 ZIP 으로 묶습니다. */
import { openZip, writeZip, ZipError } from './zip.js';
import { CardError } from './png-card.js';

const MAX = { card: 8 * 1024 * 1024, image: 8 * 1024 * 1024, assets: 64 * 1024 * 1024 };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const imageExtension = /^(png|jpe?g|webp|gif|avif)$/i;
const normalizePath = (path) => path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
const uriPath = (uri) => typeof uri === 'string' ? uri.replace(/[?#].*$/, '').replace(/\\/g, '/') : '';
const assetName = (asset) => {
  const name = String(asset.name ?? '').trim();
  if (name) return name;
  let path = uriPath(asset.uri);
  try { path = decodeURIComponent(path); } catch { /* 잘못된 URI 는 resolve 에서 안내합니다. */ }
  return path.split('/').pop().replace(/\.[^.]*$/, '').trim();
};

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

  const cardAssets = Array.isArray(card?.data?.assets) ? card.data.assets : [];
  const files = new Map(zip.entries.map((entry) => [entry.name, entry]));
  let external = 0;
  let failed = 0;
  let extraIcons = 0;
  let nonImages = 0;
  let overBudget = 0;
  let assetBytes = 0;
  let budgetExceeded = false;
  function resolve(uri, assetPicture = false) {
    if (typeof uri !== 'string') { failed++; return null; }
    if (/^ccdefault:/i.test(uri)) return null;
    if (assetPicture && budgetExceeded) { overBudget++; return null; }
    if (/^https?:\/\//i.test(uri)) { external++; return null; }
    const maxBytes = assetPicture ? Math.min(MAX.image, MAX.assets - assetBytes) : MAX.image;
    const exceedsBudget = (size) => {
      if (!assetPicture || !Number.isFinite(size) || size > MAX.image || size <= MAX.assets - assetBytes) return false;
      budgetExceeded = true;
      overBudget++;
      return true;
    };
    try {
      const embedded = /^embed(?:d)?ed:\/\/(.*)$/i.exec(uri);
      if (embedded) {
        let path = embedded[1];
        if (!zip.has(path)) path = decodeURIComponent(path);
        if (exceedsBudget(files.get(normalizePath(path))?.size)) return null;
        const data = zip.read(path, { maxBytes });
        if (data !== null) return data;
      } else {
        const inline = /^data:[^,]*;base64,([\s\S]*)$/i.exec(uri);
        if (inline) {
          // 할당 전에 base64 길이를 확인하고, 실제 바이트 수도 확인합니다.
          const encoded = inline[1].replace(/\s/g, '');
          if (encoded.length > Math.ceil(MAX.image / 3) * 4) { failed++; return null; }
          const size = Math.floor(encoded.replace(/=+$/, '').length * 3 / 4);
          if (exceedsBudget(size)) return null;
          const data = Buffer.from(encoded, 'base64');
          if (data.length <= maxBytes) return data;
        }
      }
    } catch (err) {
      if (!(err instanceof ZipError) && !(err instanceof URIError)) throw err;
    }
    failed++;
    return null;
  }

  const icons = cardAssets.filter((a) => isObject(a) && a.type === 'icon');
  const preferred = icons.find((a) => a.name === 'main') || icons[0];
  let icon = null;
  const expressions = [];
  const assets = [];
  for (const asset of cardAssets) {
    if (!isObject(asset)) continue;
    if (typeof asset.uri === 'string' && /^ccdefault:/i.test(asset.uri)) continue;
    if (asset.type === 'icon') {
      if (asset !== preferred) { extraIcons++; continue; }
      const data = resolve(asset.uri);
      if (data !== null) icon = data;
      continue;
    }
    const ext = String(asset.ext ?? '').replace(/^\./, '');
    const pathExt = uriPath(asset.uri).match(/\.([^.\/]+)$/)?.[1] || '';
    if (asset.type !== 'emotion' && !imageExtension.test(ext) && !imageExtension.test(pathExt)) { nonImages++; continue; }
    const data = resolve(asset.uri, true);
    if (data !== null) {
      const name = assetName(asset);
      assetBytes += data.length;
      assets.push({ name, data });
      if (asset.type === 'emotion') expressions.push({ label: name, data });
    }
  }
  if (!icons.length) {
    const fallback = zip.entries.find((e) => e.name.startsWith('assets/icon/') && /\.(png|jpe?g|webp)$/i.test(e.name));
    if (fallback) icon = resolve(`embeded://${fallback.name}`);
  }
  const dropped = [];
  if (external) dropped.push(`외부 주소 그림 ${external}개`);
  if (failed) dropped.push(`읽지 못한 그림 ${failed}개`);
  if (extraIcons) dropped.push(`추가 아이콘 ${extraIcons}개`);
  if (nonImages) dropped.push(`소리·영상 등 그림이 아닌 에셋 ${nonImages}개`);
  if (overBudget) dropped.push(`용량 한도를 넘은 그림 ${overBudget}개`);
  if (zip.has('module.risum')) dropped.push('RisuAI 모듈(module.risum)');
  return { card, icon, expressions, assets, dropped };
}

/** 원본 카드를 바꾸지 않고 그림 경로를 담은 CHARX 를 만듭니다. */
export function buildCharx(card, { icon = null, expressions = [], assets = [] } = {}) {
  const clone = structuredClone(card);
  clone.data.assets = [];
  const files = [];
  const extension = (ext) => String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  function add(type, name, basename, picture, directory = type) {
    const ext = extension(picture.ext);
    const path = `assets/${directory}/image/${basename}.${ext}`;
    clone.data.assets.push({ type, uri: `embeded://${path}`, name, ext });
    files.push({ name: path, data: picture.data, compress: false });
  }
  if (icon) add('icon', 'main', 'main', icon);
  else clone.data.assets.push({ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' });
  expressions.forEach((picture, i) => add('emotion', picture.label, String(i + 1), picture));
  assets.forEach((picture, i) => add('x-risu-asset', picture.name, String(i + 1), picture, 'other'));
  return writeZip([{ name: 'card.json', data: Buffer.from(JSON.stringify(clone)) }, ...files]);
}
