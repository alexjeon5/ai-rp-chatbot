/** 브라우저에서 그림을 줄입니다. 서버에는 그림 라이브러리가 없어서, 올리기 전에 여기서 줄입니다. */

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * 긴 변이 max 픽셀을 넘으면 줄인 사본(WebP)을 돌려줍니다. 작으면 원본 그대로입니다.
 * 읽지 못하는 그림이면 null.
 */
export async function downscale(blob, { max = 1024, quality = 0.9 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const ratio = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (ratio === 1 && blob.size <= 1024 * 1024) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // 투명한 배경(스프라이트)을 지키려고 WebP 로. 지원하지 않는 브라우저는 PNG 로 돌아옵니다.
    return (await canvasBlob(canvas, 'image/webp', quality)) || blob;
  } finally {
    bitmap.close?.();
  }
}

/** Blob 을 base64 글자로. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
