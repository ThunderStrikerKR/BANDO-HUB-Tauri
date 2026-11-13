/**
 * Optimize newly uploaded product photos before storing them in the existing
 * SQLite state snapshot. Existing imageData entries are never rewritten.
 * WebP preserves alpha on modern WebView2; PNG fallback preserves transparency.
 */
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 1_500_000;
const MAX_SOURCE_PIXELS = 30_000_000;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function optimizeProductImage(file: File): Promise<string> {
  if (!MIME_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw Error("이미지는 JPG, PNG, WEBP 형식이며 5MB 이하여야 합니다.");
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(Error("이미지를 열 수 없습니다. 파일 형식을 확인하세요."));
      image.src = objectUrl;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width * height > MAX_SOURCE_PIXELS) {
      throw Error("해상도가 너무 높은 이미지입니다. 크기를 줄인 뒤 다시 등록하세요.");
    }
    for (const edge of [1024, 840, 700, 560]) {
      const ratio = Math.min(1, edge / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw Error("이미지 처리 기능을 사용할 수 없습니다.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const optimized = canvas.toDataURL("image/webp", 0.8);
      const output = optimized.startsWith("data:image/webp;base64,")
        ? optimized
        : canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.8);
      if (output.length <= MAX_DATA_URL_CHARS) return output;
    }
    throw Error("압축 후에도 이미지가 큽니다. 다른 사진을 선택하세요.");
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}
