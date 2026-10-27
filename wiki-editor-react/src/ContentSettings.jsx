import React from "react";
import { Field, ImageEditor } from "./Editors.jsx";
export default function ContentSettings({
  panel,
  fields,
  lang,
  patch,
  context,
  session,
  update,
  setMessage,
}) {
  return (
    <>
      {panel === "meta" && (
        <>
          <Field label="词条标题">
            <input
              id="titleInput"
              value={fields.title || ""}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="简介">
            <textarea
              rows={5}
              value={fields.summary || ""}
              onChange={(e) => patch({ summary: e.target.value })}
            />
          </Field>
          <h2>信息栏</h2>
          {Object.entries(fields.infobox || {}).map(([name, value]) => (
            <div className="infobox-row" key={name}>
              <Field label={name}>
                <input
                  value={
                    typeof value === "string" ? value : JSON.stringify(value)
                  }
                  onChange={(e) =>
                    patch({
                      infobox: {
                        ...fields.infobox,
                        [name]: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <button
                className="icon"
                aria-label={`删除信息项 ${name}`}
                onClick={() =>
                  patch({
                    infobox: Object.fromEntries(
                      Object.entries(fields.infobox).filter(
                        ([k]) => k !== name,
                      ),
                    ),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <form
            className="new-fact"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const name = data.get("name").trim();
              if (!name || Object.hasOwn(fields.infobox || {}, name)) {
                setMessage("请填写不重复的信息项名称");
                return;
              }
              patch({
                infobox: {
                  ...fields.infobox,
                  [name]: data.get("value"),
                },
              });
              e.currentTarget.reset();
            }}
          >
            <input
              name="name"
              aria-label="新信息项名称"
              placeholder="例如：学校"
            />
            <input
              name="value"
              aria-label="新信息项内容"
              placeholder="信息内容"
            />
            <button>添加</button>
          </form>
        </>
      )}
      {panel === "media" && (
        <>
          <h2>词条头像</h2>
          {lang === "ja" && !fields.avatar && (
            <p className="helper">
              当前沿用中文头像；上传或填写地址后将单独设置。
            </p>
          )}
          <ImageEditor
            image={fields.avatar || {}}
            onChange={(avatar) => patch({ avatar })}
            avatar
            {...context}
          />
          {fields.avatar && (
            <button
              onClick={() => {
                const next = { ...fields };
                delete next.avatar;
                if (lang === "ja")
                  update({
                    ...session.content,
                    i18n: { ...session.content.i18n, ja: next },
                  });
                else {
                  const root = { ...session.content };
                  delete root.avatar;
                  update(root);
                }
              }}
            >
              {lang === "ja" ? "恢复沿用中文头像" : "移除头像"}
            </button>
          )}
          <h2>词条图片</h2>
          {lang === "ja" && !fields.images?.length && (
            <p className="helper">当前沿用中文词条图片。</p>
          )}
          {(fields.images || []).map((image, index) => (
            <div className="content-block" key={index}>
              <ImageEditor
                image={image}
                onChange={(value) =>
                  patch({
                    images: fields.images.map((x, i) =>
                      i === index ? value : x,
                    ),
                  })
                }
                {...context}
              />
              <button
                onClick={() =>
                  patch({
                    images: fields.images.filter((_, i) => i !== index),
                  })
                }
              >
                删除图片
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              patch({
                images: [...(fields.images || []), { url: "", fit: "contain" }],
              })
            }
          >
            ＋ 添加词条图片
          </button>
        </>
      )}
      {panel === "refs" && (
        <>
          <p className="helper">
            填写可核对的社团主页、公告和作品页面。
            {lang === "ja" && !fields.references?.length
              ? " 当前沿用中文参考资料。"
              : ""}
          </p>
          {(fields.references || []).map((item, index) => (
            <div className="content-block" key={index}>
              <Field label="显示名称">
                <input
                  value={item.label || ""}
                  onChange={(e) =>
                    patch({
                      references: fields.references.map((x, i) =>
                        i === index ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="来源链接">
                <input
                  value={item.url || ""}
                  onChange={(e) =>
                    patch({
                      references: fields.references.map((x, i) =>
                        i === index ? { ...x, url: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <button
                onClick={() =>
                  patch({
                    references: fields.references.filter((_, i) => i !== index),
                  })
                }
              >
                删除来源
              </button>
            </div>
          ))}
          <button
            onClick={() =>
              patch({
                references: [
                  ...(fields.references || []),
                  { label: "", url: "" },
                ],
              })
            }
          >
            ＋ 添加来源
          </button>
        </>
      )}
    </>
  );
}
