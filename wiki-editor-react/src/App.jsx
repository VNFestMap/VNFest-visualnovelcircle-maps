import React, {
  useEffect,
  useRef,
  useState,
  useDeferredValue,
  useMemo,
} from "react";
import {
  createSession,
  language,
  patchLanguage,
  sectionBlocks,
  changeContent,
  changeSource,
  materialize,
  acknowledge,
  isDirty,
  restoreDraft,
  validateImport,
} from "./model.js";
import { sectionsToMarkdown, parseMarkdownDocument } from "./markdown.js";
import { wikiRequest } from "./api.js";
import { Field, ImageEditor, ParagraphEditor } from "./Editors.jsx";
import Preview from "./Preview.jsx";
import ContentSettings from "./ContentSettings.jsx";
const identity = Symbol("editorIdentity");
let serial = 0;
function key(object) {
  if (!object[identity]) object[identity] = ++serial;
  return object[identity];
}
function download(name, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function getDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export default function App() {
  const clubKey = new URLSearchParams(location.search).get("club_key") || "";
  const draftKey = `wikiEditorDraft:${clubKey}`;
  const [session, setSession] = useState(null),
    [club, setClub] = useState({}),
    [error, setError] = useState(""),
    [lang, setLang] = useState("zh"),
    [view, setView] = useState("edit"),
    [mode, setMode] = useState("visual"),
    [panel, setPanel] = useState("body"),
    [selected, setSelected] = useState(0),
    [drawer, setDrawer] = useState(false),
    [search, setSearch] = useState(""),
    [mobile, setMobile] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [draft, setDraft] = useState(() => getDraft(draftKey)),
    [history, setHistory] = useState([]),
    [tools, setTools] = useState(false),
    [json, setJson] = useState(""),
    [localStatus, setLocalStatus] = useState(""),
    [pageUrl, setPageUrl] = useState("");
  const [published, setPublished] = useState(true);
  const latest = useRef(session);
  latest.current = session;
  const saveRef = useRef(() => {});
  const loading = useRef(false);
  const saving = useRef(false);
  const composing = useRef(false);
  async function load() {
    if (loading.current) return;
    loading.current = true;
    setError("");
    try {
      if (!clubKey)
        throw new Error("缺少 club_key，请从同好会管理页进入编辑器。");
      const data = await wikiRequest(clubKey, "get");
      setSession(
        createSession(data.content || { club_key: clubKey, sections: [] }),
      );
      setClub(data.club || {});
      setPublished(data.exists !== false);
      setPageUrl(data.page_url || "");
    } catch (e) {
      setError(e.message);
    } finally {
      loading.current = false;
    }
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!session || !isDirty(session)) return;
    const timer = setTimeout(() => {
      try {
        const value = {
          saved_at: new Date().toISOString(),
          content: session.content,
          raw: session.raw,
          sourceDirty: session.sourceDirty,
        };
        localStorage.setItem(draftKey, JSON.stringify(value));
        setLocalStatus("本地草稿已保存");
      } catch {
        setLocalStatus("本地草稿保存失败，请下载备份");
        setMessage("浏览器未能保存本地草稿，请从“更多”下载草稿备份。");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [session, draftKey]);
  useEffect(() => {
    function flushDraft() {
      const current = latest.current;
      if (!current || !isDirty(current)) return;
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            saved_at: new Date().toISOString(),
            content: current.content,
            raw: current.raw,
            sourceDirty: current.sourceDirty,
          }),
        );
      } catch {}
    }
    function hidden() {
      if (document.visibilityState === "hidden") flushDraft();
    }
    function leave(e) {
      if (latest.current && isDirty(latest.current)) {
        flushDraft();
        e.preventDefault();
        e.returnValue = "";
      }
    }
    function shortcut(e) {
      if (
        !e.isComposing &&
        !composing.current &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        saveRef.current();
      }
    }
    addEventListener("beforeunload", leave);
    addEventListener("keydown", shortcut);
    addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      removeEventListener("beforeunload", leave);
      removeEventListener("keydown", shortcut);
      removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  async function save() {
    if (!latest.current || saving.current) return;
    const snapshot = latest.current;
    const payload = materialize(snapshot);
    if (payload.errors.length) {
      setMessage("无法发布：" + payload.errors.join("；"));
      return;
    }
    if (!String(payload.content.title || "").trim()) {
      setMessage("请先在“词条资料”填写中文标题");
      setPanel("meta");
      return;
    }
    saving.current = true;
    setBusy(true);
    setMessage("正在发布…");
    try {
      const data = await wikiRequest(clubKey, "save", payload.content);
      const changed = latest.current.revision !== snapshot.revision;
      setSession((current) => acknowledge(current, snapshot.revision));
      setPageUrl(data.page_url || pageUrl);
      setPublished(true);
      if (!changed) {
        try {
          localStorage.removeItem(draftKey);
        } catch {}
        setDraft(null);
        setLocalStatus("");
      }
      setMessage(
        changed
          ? "上一版已发布，当前仍有未保存修改"
          : "发布成功，公开页面已更新",
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  saveRef.current = save;
  const deferred = useDeferredValue(session);
  const previewSession = deferred || session;
  const rendered = useMemo(
    () => (previewSession ? materialize(previewSession) : null),
    [previewSession],
  );
  if (!session)
    return (
      <div className="loading-shell">
        <a href="../wiki/index.html" className="brand">
          VNFest <span>WIKI</span>
        </a>
        <h1>同好会 Wiki 编辑器</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={load}>重新加载</button>
            <a href="./club_manager.html">返回同好会管理</a>
          </>
        ) : (
          <p role="status">正在读取词条与编辑权限…</p>
        )}
      </div>
    );
  const fields = language(session.content, lang);
  const sections = fields.sections || [];
  const current = sections[selected];
  const blocks = current ? sectionBlocks(current) : [];
  const parsed = session.sourceDirty[lang]
    ? parseMarkdownDocument(session.raw[lang], sections)
    : null;
  function update(content) {
    setHistory((h) => [...h.slice(-49), latest.current]);
    setSession((s) => changeContent(s, content));
  }
  function patch(p) {
    update(patchLanguage(session.content, lang, p));
  }
  function setSections(next) {
    patch({ sections: next });
  }
  function editSection(p) {
    setSections(sections.map((s, i) => (i === selected ? { ...s, ...p } : s)));
  }
  function editBlocks(next) {
    setSections(
      sections.map((s, i) =>
        i === selected ? { ...s, body: [], images: [], blocks: next } : s,
      ),
    );
  }
  function switchMode(next) {
    if (next === mode) return;
    if (next === "visual" && session.sourceDirty[lang]) {
      if (parsed.errors.length) {
        setMessage("请先修正 Markdown 错误，原文已保留");
        return;
      }
      setSession((s) => ({
        ...s,
        content: patchLanguage(s.content, lang, { sections: parsed.sections }),
        sourceDirty: { ...s.sourceDirty, [lang]: false },
      }));
      setSelected(0);
    }
    if (next === "markdown" && !session.sourceDirty[lang])
      setSession((s) => ({
        ...s,
        raw: { ...s.raw, [lang]: sectionsToMarkdown(sections) },
      }));
    setMode(next);
  }
  function move(list, index, delta, apply) {
    const next = [...list];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    apply(next);
  }
  function addSection() {
    const next = [
      ...sections,
      {
        heading: "新章节",
        level: 2,
        blocks: [{ type: "paragraph", text: "", note: "" }],
      },
    ];
    setSections(next);
    setSelected(next.length - 1);
    setMode("visual");
    setPanel("body");
    requestAnimationFrame(() =>
      document.getElementById("section-heading")?.focus(),
    );
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setSession((s) => ({
      ...previous,
      revision: s.revision + 1,
      savedRevision: s.savedRevision,
    }));
    setSelected(0);
    setMessage("已撤销上一步编辑");
  }
  function switchLanguage(next) {
    setLang(next);
    setSelected(0);
    setDrawer(false);
  }
  function openSection(index) {
    setSelected(index);
    setPanel("body");
    setDrawer(false);
    document.querySelector(".editor-scroll")?.scrollTo({ top: 0 });
  }
  const context = { clubKey, report: setMessage };
  const dirty = isDirty(session);
  return (
    <div
      className="app"
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
    >
      <header className="workspace-header">
        <a className="brand" href="../wiki/index.html">
          VNFest <span>WIKI</span>
        </a>
        <span className="entry-name">
          {session.content.title || club.display_name || "新词条"}
        </span>
        <a className="back-link" href="./club_manager.html">
          返回管理
        </a>
      </header>
      <div className="workspace-toolbar">
        <button
          className="outline-toggle"
          aria-expanded={drawer}
          onClick={() => setDrawer(!drawer)}
        >
          目录
        </button>
        <div
          className="segment"
          data-button-shape="keep"
          role="group"
          aria-label="编辑语言"
        >
          {[
            ["zh", "中文"],
            ["ja", "日本語"],
          ].map(([id, name]) => (
            <button
              key={id}
              aria-pressed={lang === id}
              onClick={() => switchLanguage(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <div
          className="segment view-segment"
          data-button-shape="keep"
          role="group"
          aria-label="工作区视图"
        >
          {[
            ["edit", "编辑"],
            ["split", "对照"],
            ["preview", "预览"],
          ].map(([id, name]) => (
            <button
              key={id}
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <span className={`save-state ${dirty ? "dirty" : ""}`} role="status">
          {dirty ? "未发布修改" : published ? "已与公开版本同步" : "尚未发布"}
          <small>{localStatus}</small>
        </span>
        <button
          className="more-button"
          aria-expanded={tools}
          onClick={() => {
            setTools(!tools);
            setJson("");
          }}
        >
          更多
        </button>
        {published && pageUrl && (
          <a
            className="public-link"
            href={
              pageUrl.startsWith("./wiki/") ? "../" + pageUrl.slice(2) : pageUrl
            }
            target="_blank"
            rel="noreferrer"
          >
            查看公开页 ↗
          </a>
        )}
        <button
          className="primary publish"
          disabled={busy || !!rendered.errors.length}
          onClick={save}
        >
          {busy ? "发布中…" : "保存并发布"}
        </button>
      </div>
      {message && (
        <div className="notice" role="status">
          <span>{message}</span>
          <button
            className="icon"
            aria-label="关闭提示"
            onClick={() => setMessage("")}
          >
            ×
          </button>
        </div>
      )}
      {!!rendered.errors.length && (
        <div className="notice" role="alert">
          <span>{rendered.errors.join("；")} · 原文已保留</span>
          <button
            onClick={() => {
              const broken = ["zh", "ja"].find(
                (code) =>
                  session.sourceDirty[code] &&
                  parseMarkdownDocument(
                    session.raw[code],
                    language(session.content, code).sections || [],
                  ).errors.length,
              );
              setLang(broken || lang);
              setMode("markdown");
              setPanel("body");
              setView("edit");
            }}
          >
            检查原文
          </button>
        </div>
      )}
      {draft && (
        <div className="notice draft-notice">
          <span>
            发现本地草稿 · {new Date(draft.saved_at).toLocaleString("zh-CN")}
          </span>
          <button
            onClick={() => {
              try {
                setHistory((h) => [...h, session]);
                const restored = restoreDraft(draft);
                setSession((current) => ({
                  ...restored,
                  revision: current.revision + 1,
                  savedRevision: current.savedRevision,
                }));
                setMode(restored.sourceDirty[lang] ? "markdown" : "visual");
                setDraft(null);
                setMessage("草稿已恢复，可撤销恢复操作");
              } catch (e) {
                setMessage(e.message);
              }
            }}
          >
            恢复草稿
          </button>
          <button
            onClick={() => {
              localStorage.removeItem(draftKey);
              setDraft(null);
            }}
          >
            舍弃旧草稿
          </button>
        </div>
      )}
      {tools && (
        <div className="tools-panel">
          <div className="panel-heading">
            <h2>备份与导入</h2>
            <button
              className="icon"
              aria-label="关闭备份面板"
              onClick={() => setTools(false)}
            >
              ×
            </button>
          </div>
          <p>
            JSON 文件用于内容迁移；草稿备份还会保留尚未修正的 Markdown 原文。
          </p>
          <div className="actions">
            <button
              onClick={() =>
                download(
                  `${clubKey}.json`,
                  JSON.stringify(materialize(session).content, null, 2),
                )
              }
              disabled={!!rendered.errors.length}
            >
              下载内容 JSON
            </button>
            <button
              onClick={() =>
                download(
                  `${clubKey}-draft.json`,
                  JSON.stringify(
                    {
                      saved_at: new Date().toISOString(),
                      content: session.content,
                      raw: session.raw,
                      sourceDirty: session.sourceDirty,
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              下载草稿备份
            </button>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(materialize(session).content, null, 2),
                  );
                  setMessage("内容 JSON 已复制");
                } catch {
                  setMessage("无法访问剪贴板，请下载文件");
                }
              }}
              disabled={!!rendered.errors.length}
            >
              复制 JSON
            </button>
          </div>
          <Field label="选择备份文件">
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setJson(await file.text());
              }}
            />
          </Field>
          <Field label="或粘贴 JSON">
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={5}
            />
          </Field>
          <button
            disabled={!json.trim()}
            onClick={() => {
              try {
                const data = JSON.parse(json);
                const next = data.raw
                  ? restoreDraft(data)
                  : createSession({
                      ...validateImport(json),
                      club_key: clubKey,
                    });
                setHistory((h) => [...h.slice(-49), session]);
                setSession({
                  ...next,
                  revision: session.revision + 1,
                  savedRevision: session.savedRevision,
                });
                setSelected(0);
                setTools(false);
                setMessage("备份已导入，尚未发布；可撤销");
              } catch (e) {
                setMessage("导入失败：" + e.message);
              }
            }}
          >
            应用导入
          </button>
        </div>
      )}
      <div className={`workspace view-${view}`}>
        {drawer && (
          <button
            className="drawer-scrim"
            data-button-shape="keep"
            aria-label="关闭目录"
            onClick={() => setDrawer(false)}
          />
        )}
        <aside
          data-button-shape="keep"
          className={`outline ${drawer ? "is-open" : ""}`}
          aria-label="编辑目录"
        >
          <p className="outline-label">词条设置</p>
          {[
            ["body", "正文"],
            ["meta", "词条资料"],
            ["media", "图片与头像"],
            ["refs", "参考资料"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={panel === id ? "active" : ""}
              onClick={() => {
                setPanel(id);
                setDrawer(false);
              }}
            >
              {label}
            </button>
          ))}
          <div className="outline-section-heading">
            <p className="outline-label">章节 · {sections.length}</p>
            <button
              className="icon"
              aria-label="添加章节"
              disabled={mode === "markdown"}
              onClick={addSection}
            >
              ＋
            </button>
          </div>
          <input
            className="outline-search"
            aria-label="搜索章节"
            placeholder="搜索章节…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <nav>
            {sections.map(
              (s, index) =>
                (s.heading || "").includes(search) && (
                  <button
                    key={key(s)}
                    className={
                      panel === "body" && selected === index ? "active" : ""
                    }
                    onClick={() => openSection(index)}
                  >
                    <span className="chapter-number">{index + 1}</span>
                    <span>{s.heading || "未命名章节"}</span>
                  </button>
                ),
            )}
          </nav>
          <button className="undo" disabled={!history.length} onClick={undo}>
            撤销上一步
          </button>
          <small>
            正文自动存为本地草稿
            <br />
            Ctrl / ⌘ + S 发布
          </small>
        </aside>
        {view !== "preview" && (
          <main className="editor-scroll" aria-label="编辑工作区">
            <div className="editor-paper">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">
                    {lang === "zh" ? "中文词条" : "日本語の編集"}
                  </p>
                  <h1>
                    {panel === "body"
                      ? "编辑正文"
                      : panel === "meta"
                        ? "词条资料"
                        : panel === "media"
                          ? "图片与头像"
                          : "参考资料"}
                  </h1>
                </div>
                {panel === "body" && (
                  <div
                    className="segment"
                    data-button-shape="keep"
                    role="group"
                    aria-label="正文编辑方式"
                  >
                    <button
                      aria-pressed={mode === "visual"}
                      onClick={() => switchMode("visual")}
                    >
                      可视化
                    </button>
                    <button
                      aria-pressed={mode === "markdown"}
                      onClick={() => switchMode("markdown")}
                    >
                      Markdown
                    </button>
                  </div>
                )}
              </div>
              {lang === "ja" && (
                <p className="helper language-help">
                  未填写的日文内容会沿用中文。图片、头像、参考资料可在此单独设置；切换语言会保留独立设置。
                </p>
              )}
              {panel === "body" &&
                (mode === "markdown" ? (
                  <>
                    <p className="helper">
                      支持 ## / ###
                      章节、独立图片、行内格式和段落注释。使用空行分隔段落。
                    </p>
                    <Field label="Markdown 原文">
                      <textarea
                        className="markdown-source"
                        id="markdownSourceInput"
                        spellCheck={false}
                        value={session.raw[lang]}
                        onChange={(e) => {
                          setHistory((h) => [...h.slice(-49), latest.current]);
                          setSession((s) =>
                            changeSource(s, lang, e.target.value),
                          );
                        }}
                      />
                    </Field>
                    <div
                      className={
                        parsed?.errors.length
                          ? "validation error"
                          : "validation"
                      }
                      role="status"
                    >
                      {parsed?.errors.length
                        ? parsed.errors.join("；")
                        : parsed?.warnings.length
                          ? parsed.warnings.join("；")
                          : "原文已保留；切回可视化时应用解析结果。"}
                    </div>
                  </>
                ) : (
                  <>
                    {!current ? (
                      <div className="empty-state">
                        <h2>从第一个章节开始</h2>
                        <p>写下同好会简介、活动记录，或作品介绍。</p>
                        <button onClick={addSection}>添加章节</button>
                      </div>
                    ) : (
                      <>
                        <div className="section-title-row">
                          <Field label="章节标题">
                            <input
                              id="section-heading"
                              value={current.heading || ""}
                              onChange={(e) =>
                                editSection({ heading: e.target.value })
                              }
                            />
                          </Field>
                          <Field label="标题级别">
                            <select
                              value={current.level || 2}
                              onChange={(e) =>
                                editSection({ level: Number(e.target.value) })
                              }
                            >
                              <option value={2}>二级标题</option>
                              <option value={3}>三级标题</option>
                            </select>
                          </Field>
                        </div>
                        <div
                          className="section-actions"
                          data-button-shape="keep"
                        >
                          <span>
                            第 {selected + 1} / {sections.length} 章 ·{" "}
                            {blocks.length} 个内容块
                          </span>
                          <button
                            disabled={!selected}
                            onClick={() => {
                              move(sections, selected, -1, setSections);
                              setSelected(selected - 1);
                            }}
                          >
                            前移章节
                          </button>
                          <button
                            disabled={selected === sections.length - 1}
                            onClick={() => {
                              move(sections, selected, 1, setSections);
                              setSelected(selected + 1);
                            }}
                          >
                            后移章节
                          </button>
                          <button
                            className="danger"
                            onClick={() => {
                              setSections(
                                sections.filter((_, i) => i !== selected),
                              );
                              setSelected(Math.max(0, selected - 1));
                              setMessage("章节已删除，可撤销");
                            }}
                          >
                            删除章节
                          </button>
                        </div>
                        <div className="blocks">
                          {blocks.map((block, index) => (
                            <section
                              className="content-block"
                              key={key(block)}
                              data-block-type={block.type}
                            >
                              <div className="block-heading">
                                <strong>
                                  {block.type === "image" ? "图片" : "段落"}{" "}
                                  {index + 1}
                                </strong>
                                <div className="block-actions">
                                  <button
                                    className="icon"
                                    aria-label={`上移内容块 ${index + 1}`}
                                    disabled={!index}
                                    onClick={() =>
                                      move(blocks, index, -1, editBlocks)
                                    }
                                  >
                                    ↑
                                  </button>
                                  <button
                                    className="icon"
                                    aria-label={`下移内容块 ${index + 1}`}
                                    disabled={index === blocks.length - 1}
                                    onClick={() =>
                                      move(blocks, index, 1, editBlocks)
                                    }
                                  >
                                    ↓
                                  </button>
                                  <button
                                    className="icon danger"
                                    aria-label={`删除内容块 ${index + 1}`}
                                    onClick={() => {
                                      editBlocks(
                                        blocks.filter((_, i) => i !== index),
                                      );
                                      setMessage("内容块已删除，可撤销");
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>
                              {block.type === "image" ? (
                                <ImageEditor
                                  image={block}
                                  onChange={(next) =>
                                    editBlocks(
                                      blocks.map((b, i) =>
                                        i === index ? next : b,
                                      ),
                                    )
                                  }
                                  {...context}
                                />
                              ) : (
                                <ParagraphEditor
                                  block={block}
                                  onChange={(next) =>
                                    editBlocks(
                                      blocks.map((b, i) =>
                                        i === index ? next : b,
                                      ),
                                    )
                                  }
                                />
                              )}
                            </section>
                          ))}
                        </div>
                        <div className="add-blocks">
                          <button
                            onClick={() =>
                              editBlocks([
                                ...blocks,
                                { type: "paragraph", text: "", note: "" },
                              ])
                            }
                          >
                            ＋ 添加段落
                          </button>
                          <button
                            onClick={() =>
                              editBlocks([
                                ...blocks,
                                { type: "image", url: "", fit: "contain" },
                              ])
                            }
                          >
                            ＋ 添加图片
                          </button>
                        </div>
                      </>
                    )}
                    <div className="chapter-footer">
                      <button onClick={addSection}>＋ 新章节</button>
                      <button
                        disabled={selected >= sections.length - 1}
                        onClick={() => openSection(selected + 1)}
                      >
                        下一章 →
                      </button>
                    </div>
                  </>
                ))}
              <ContentSettings
                {...{
                  panel,
                  fields,
                  lang,
                  patch,
                  context,
                  session,
                  update,
                  setMessage,
                }}
              />
            </div>
          </main>
        )}
        {view !== "edit" && (
          <section className="preview-pane" aria-label="阅读预览">
            <div className="preview-toolbar">
              <span>
                阅读预览
                {rendered.errors.length
                  ? " · 原文有错误，显示最后可解析版本"
                  : ""}
              </span>
              <button aria-pressed={mobile} onClick={() => setMobile(!mobile)}>
                {mobile ? "390px 手机" : "自适应宽度"}
              </button>
            </div>
            <Preview
              content={rendered.content}
              club={club}
              lang={lang}
              mobile={mobile}
            />
          </section>
        )}
      </div>
    </div>
  );
}
