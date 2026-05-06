// クライアント側で画像をリサイズしてサムネイルdata URLを作る
export async function fileToOriginalDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function makeThumbnail(
  dataUrl: string,
  maxLong = 512,
  quality = 0.7
): Promise<string> {
  const img = await loadImage(dataUrl);
  const long = Math.max(img.width, img.height);
  const scale = long > maxLong ? maxLong / long : 1;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像が読み込めませんでした（HEIC等の非対応形式の可能性）"));
    img.src = src;
  });
}
