import { normalizeBlocks } from "../../wiki/wiki-reader.js";
import { sectionsToMarkdown, parseMarkdownDocument } from "./markdown.js";
export const clone = (value) => structuredClone(value);
export function language(content, lang) {
  return lang === "zh" ? content : content.i18n?.ja || {};
}
export function patchLanguage(content, lang, patch) {
  if (lang === "zh") return { ...content, ...patch };
  return {
    ...content,
    i18n: {
      ...(Array.isArray(content.i18n) ? {} : content.i18n),
      ja: { ...language(content, lang), ...patch },
    },
  };
}
export function sectionBlocks(section) {
  if (Array.isArray(section.blocks) && section.blocks.length)
    return section.blocks;
  return normalizeBlocks(section);
}
export function createSession(content) {
  validateContent(content || {});
  const document = clone(content || {});
  return {
    content: document,
    raw: {
      zh: sectionsToMarkdown(document.sections),
      ja: sectionsToMarkdown(document.i18n?.ja?.sections),
    },
    sourceDirty: { zh: false, ja: false },
    revision: 0,
    savedRevision: 0,
  };
}
export function changeContent(state, content) {
  return { ...state, content, revision: state.revision + 1 };
}
export function changeSource(state, lang, source) {
  return {
    ...state,
    raw: { ...state.raw, [lang]: source },
    sourceDirty: { ...state.sourceDirty, [lang]: true },
    revision: state.revision + 1,
  };
}
export function materialize(state) {
  let content = clone(state.content);
  const errors = [];
  for (const lang of ["zh", "ja"])
    if (state.sourceDirty[lang]) {
      const result = parseMarkdownDocument(
        state.raw[lang],
        language(content, lang).sections || [],
      );
      errors.push(
        ...result.errors.map((e) => `${lang === "zh" ? "中文" : "日文"}：${e}`),
      );
      if (!result.errors.length)
        content = patchLanguage(content, lang, { sections: result.sections });
    }
  return { content, errors };
}
export function acknowledge(state, revision) {
  return { ...state, savedRevision: revision };
}
export function isDirty(state) {
  return state.revision !== state.savedRevision;
}
export function restoreDraft(draft) {
  if (
    !draft ||
    !draft.content ||
    typeof draft.content !== "object" ||
    Array.isArray(draft.content)
  )
    throw new Error("草稿内容格式无效");
  const initial = createSession(draft.content);
  return {
    ...initial,
    raw: { ...initial.raw, ...draft.raw },
    sourceDirty: { ...initial.sourceDirty, ...draft.sourceDirty },
    revision: 1,
    savedRevision: 0,
  };
}
export function validateImport(text) {
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.sections)
  )
    throw new Error("JSON 应是包含 sections 数组的 Wiki 内容对象");
  if (
    value.i18n &&
    !Array.isArray(value.i18n) &&
    typeof value.i18n !== "object"
  )
    throw new Error("i18n 格式无效");
  validateContent(value);
  return value;
}

function validateContent(content) {
  for (const part of [content, content.i18n?.ja].filter(Boolean)) {
    if (typeof part !== "object" || Array.isArray(part))
      throw new Error("语言内容应为对象");
    if (part.sections != null && !Array.isArray(part.sections))
      throw new Error("sections 应为数组");
    for (const section of part.sections || []) {
      if (!section || typeof section !== "object" || Array.isArray(section))
        throw new Error("章节格式无效");
      if (
        section.blocks !== undefined &&
        (!Array.isArray(section.blocks) ||
          section.blocks.some(
            (b) =>
              !b ||
              typeof b !== "object" ||
              !["paragraph", "image"].includes(b.type),
          ))
      )
        throw new Error("内容块格式无效");
    }
    for (const field of ["images", "references"])
      if (
        part[field] != null &&
        (!Array.isArray(part[field]) ||
          part[field].some((x) => !x || typeof x !== "object"))
      )
        throw new Error(field + " 应为对象数组");
    if (
      part.infobox != null &&
      (!part.infobox ||
        typeof part.infobox !== "object" ||
        Array.isArray(part.infobox))
    )
      throw new Error("infobox 应为对象");
  }
}
