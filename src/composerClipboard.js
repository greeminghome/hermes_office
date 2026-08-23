const DATA_IMAGE_PATTERN = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)/i;

function dataUrlToFile(dataUrl, index = 0) {
  const match = String(dataUrl || "").match(DATA_IMAGE_PATTERN);
  if (!match) return null;
  try {
    const mime = match[1].toLowerCase();
    const binary = window.atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
    return imageBlobToFile(new Blob([bytes], { type: mime }), index);
  } catch {
    return null;
  }
}

export function imageBlobToFile(blob, index = 0) {
  if (blob instanceof File && blob.name) return blob;
  const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return new File([blob], `pasted-image-${stamp}${index ? `-${index + 1}` : ""}.${extension}`, {
    type: blob.type || "image/png",
    lastModified: Date.now(),
  });
}

export function extractClipboardImageFiles(clipboard) {
  const files = [];
  const seen = new Set();
  const append = (value) => {
    if (!value?.type?.startsWith("image/")) return;
    const key = `${value.name || "blob"}:${value.type}:${value.size}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(imageBlobToFile(value, files.length));
  };

  [...(clipboard?.items || [])].forEach((item) => {
    if (item.kind === "file" && item.type.startsWith("image/")) append(item.getAsFile());
  });
  if (!files.length) [...(clipboard?.files || [])].forEach(append);

  if (!files.length) {
    const plainImage = dataUrlToFile(clipboard?.getData?.("text/plain"), 0);
    if (plainImage) append(plainImage);
  }
  if (!files.length) {
    const html = clipboard?.getData?.("text/html") || "";
    const sources = [...html.matchAll(/<img[^>]+src=["'](data:image\/[^"']+)["']/gi)];
    sources.forEach((match, index) => {
      const image = dataUrlToFile(match[1], index);
      if (image) append(image);
    });
  }
  return files;
}

export async function readClipboardImageFiles() {
  if (!navigator.clipboard?.read) throw new Error("이 브라우저에서는 클립보드 이미지 읽기를 지원하지 않습니다. 채팅창에 Ctrl+V로 붙여넣어 주세요.");
  const clipboardItems = await navigator.clipboard.read();
  const files = [];
  for (const item of clipboardItems) {
    for (const type of item.types.filter((value) => value.startsWith("image/"))) {
      files.push(imageBlobToFile(await item.getType(type), files.length));
    }
  }
  return files;
}
