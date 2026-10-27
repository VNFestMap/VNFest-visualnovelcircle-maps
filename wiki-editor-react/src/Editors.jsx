import React, { useRef, useState } from "react";
import { uploadImage } from "./api.js";
export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ImageEditor({
  image = {},
  onChange,
  clubKey,
  report,
  avatar = false,
}) {
  const [busy, setBusy] = useState(false);
  const file = useRef();
  const patch = (p) => onChange({ ...image, ...p });
  async function upload(e) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setBusy(true);
    try {
      const data = await uploadImage(clubKey, selected);
      patch({
        url: data.image_url,
        alt: image.alt || selected.name.replace(/\.[^.]+$/, ""),
      });
      report("图片已上传，发布后生效");
    } catch (error) {
      report(error.message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }
  const src = image.url?.startsWith("../uploads/")
    ? image.url.replace("../uploads/", "../wiki/uploads/")
    : image.url;
  return (
    <div className="image-editor">
      <div className="image-primary">
        {src ? (
          <img src={src} alt={image.alt || "图片预览"} />
        ) : (
          <div className="image-placeholder">图片</div>
        )}
        <div className="image-inputs">
          <Field label="图片地址">
            <input
              value={image.url || ""}
              onChange={(e) => patch({ url: e.target.value })}
              placeholder="https:// 或 ../uploads/…"
            />
          </Field>
          <button
            type="button"
            onClick={() => file.current.click()}
            disabled={busy}
            data-action="upload-image"
          >
            {busy ? "上传中…" : "上传 / 替换图片"}
          </button>
          <input
            ref={file}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={upload}
            hidden
          />
        </div>
      </div>
      <Field label="图片说明">
        <input
          value={image.caption || ""}
          onChange={(e) => patch({ caption: e.target.value })}
        />
      </Field>
      <details>
        <summary>显示设置与替代文本</summary>
        <div className="two-columns">
          <Field label="替代文本">
            <input
              value={image.alt || ""}
              onChange={(e) => patch({ alt: e.target.value })}
            />
          </Field>
          {avatar ? (
            <Field label="位置">
              <select
                value={image.position || "top"}
                onChange={(e) => patch({ position: e.target.value })}
              >
                <option value="top">顶部</option>
                <option value="bottom">底部</option>
              </select>
            </Field>
          ) : (
            <>
              <Field label="宽度">
                <select
                  data-field="width_percent"
                  value={image.width_percent || 100}
                  onChange={(e) =>
                    patch({ width_percent: Number(e.target.value) })
                  }
                >
                  {[25, 50, 75, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}%
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="比例">
                <select
                  value={image.aspect_ratio || "16/10"}
                  onChange={(e) => patch({ aspect_ratio: e.target.value })}
                >
                  {["auto", "16/10", "16/9", "4/3", "1/1", "3/4"].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </Field>
              <Field label="对齐">
                <select
                  data-field="align"
                  value={image.align || "center"}
                  onChange={(e) => patch({ align: e.target.value })}
                >
                  <option value="left">靠左</option>
                  <option value="center">居中</option>
                  <option value="right">靠右</option>
                </select>
              </Field>
              <Field label="适配">
                <select
                  data-field="fit"
                  value={image.fit || "cover"}
                  onChange={(e) => patch({ fit: e.target.value })}
                >
                  <option value="contain">完整显示</option>
                  <option value="cover">填满裁切</option>
                </select>
              </Field>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
export function ParagraphEditor({ block, onChange }) {
  const ref = useRef();
  function format(before, after = before) {
    const el = ref.current;
    const start = el.selectionStart,
      end = el.selectionEnd;
    const selected = el.value.slice(start, end) || "文字";
    onChange({
      ...block,
      text:
        el.value.slice(0, start) +
        before +
        selected +
        after +
        el.value.slice(end),
    });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(
        start + before.length,
        start + before.length + selected.length,
      );
    });
  }
  return (
    <>
      <div
        className="format-toolbar"
        data-button-shape="keep"
        role="group"
        aria-label="段落格式"
      >
        <button title="加粗" onClick={() => format("**")}>
          粗体
        </button>
        <button title="斜体" onClick={() => format("*")}>
          斜体
        </button>
        <button
          title="插入链接"
          onClick={() => format("[", "](https://example.com)")}
        >
          链接
        </button>
        <button title="行内代码" onClick={() => format("`")}>
          代码
        </button>
      </div>
      <Field label="段落正文">
        <textarea
          ref={ref}
          data-field="paragraph"
          value={block.text || ""}
          rows={Math.min(
            16,
            Math.max(5, (block.text || "").split("\n").length + 2),
          )}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
      </Field>
      <details open={!!block.note}>
        <summary>段落注释{block.note ? " · 已填写" : ""}</summary>
        <Field label="注释内容">
          <textarea
            data-field="note"
            rows={2}
            value={block.note || ""}
            onChange={(e) => onChange({ ...block, note: e.target.value })}
          />
        </Field>
      </details>
    </>
  );
}
