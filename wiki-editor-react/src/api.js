export async function readWikiResponse(resp) {
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `服务器未返回有效 JSON（HTTP ${resp.status}），请稍后重试。`,
    );
  }
  if (!resp.ok || !data.success)
    throw new Error(data.message || `请求失败（HTTP ${resp.status}）`);
  return data;
}
export async function wikiRequest(clubKey, action, body) {
  return readWikiResponse(
    await fetch(
      `../api/wiki.php?action=${action}&club_key=${encodeURIComponent(clubKey)}`,
      {
        credentials: "same-origin",
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers:
                body instanceof FormData
                  ? {}
                  : { "Content-Type": "application/json" },
              body: body instanceof FormData ? body : JSON.stringify(body),
            }),
      },
    ),
  );
}
export const WIKI_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export async function uploadImage(clubKey, file) {
  if (file.size > WIKI_IMAGE_MAX_BYTES)
    throw new Error("图片大小不能超过 10MB");
  if (
    !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)
  )
    throw new Error("仅支持 JPEG、PNG、GIF、WebP 图片");
  const body = new FormData();
  body.append("image", file);
  return wikiRequest(clubKey, "upload", body);
}
