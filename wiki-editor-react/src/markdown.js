import {
  normalizeBlocks as sectionBlocksFromSection,
  safeImageUrl,
} from "../../wiki/wiki-reader.js";
function normalizeMarkdownSource(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

function existingImageMetadata(sections, url) {
  for (const section of sections || []) {
    for (const block of sectionBlocksFromSection(section)) {
      if (block.type === "image" && safeImageUrl(block.url) === url) {
        return block;
      }
    }
  }
  return null;
}

export function sectionsToMarkdown(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(function (section) {
      const level = Number(section.level) === 3 ? 3 : 2;
      const lines = [
        "#".repeat(level) + " " + String(section.heading || "").trim(),
      ];
      sectionBlocksFromSection(section).forEach(function (block) {
        if (block.type === "image") {
          const alt = encodeAttribute(String(block.alt || block.caption || ""));
          const url = String(block.url || "").trim();
          const caption = block.caption
            ? ' "' + encodeAttribute(String(block.caption)) + '"'
            : "";
          if (url) lines.push("![" + alt + "](" + url + caption + ")");
          return;
        }
        const text = normalizeMarkdownSource(block.text || "").trim();
        if (text) lines.push(text);
        if (block.note)
          lines.push(
            "<!-- wiki-note:" + encodeURIComponent(String(block.note)) + " -->",
          );
      });
      return lines.join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function parseMarkdownDocumentCore(source, existingSections) {
  const lines = normalizeMarkdownSource(source).split("\n");
  const sections = [];
  const outline = [];
  const warnings = [];
  const errors = [];
  let current = null;
  let paragraphLines = [];

  function ensureSection(lineNumber) {
    if (current) return current;
    current = { heading: "正文", level: 2, blocks: [] };
    sections.push(current);
    outline.push({
      heading: current.heading,
      level: current.level,
      line: lineNumber,
    });
    warnings.push("未发现 ## / ### 标题，已自动创建“正文”章节。");
    return current;
  }

  function flushParagraph() {
    if (!paragraphLines.length) return;
    const text = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (text)
      ensureSection(0).blocks.push({ type: "paragraph", text, note: "" });
  }

  lines.forEach(function (line, index) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{2,3})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length === 3 ? 3 : 2;
      const section = { heading: heading[2].trim(), level, blocks: [] };
      sections.push(section);
      current = section;
      outline.push({ heading: section.heading, level, line: index });
      return;
    }
    if (/^<!--\s*wiki-note:/.test(trimmed)) {
      flushParagraph();
      const noteMatch = trimmed.match(/^<!--\s*wiki-note:([^>]*)\s*-->$/);
      if (noteMatch && current && current.blocks.length) {
        const last = current.blocks[current.blocks.length - 1];
        if (last.type === "paragraph") {
          try {
            last.note = decodeURIComponent(noteMatch[1].trim());
          } catch (error) {
            errors.push(
              "第 " + (index + 1) + " 行的注释编码无效，请修正后重试。",
            );
          }
        }
      } else {
        warnings.push("第 " + (index + 1) + " 行的注释没有对应段落。");
      }
      return;
    }
    const image = trimmed.match(
      /^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)"|\s+'([^']*)')?\)$/,
    );
    if (image) {
      flushParagraph();
      const url = safeImageUrl(image[2]);
      if (!url) {
        errors.push("第 " + (index + 1) + " 行图片地址不安全或为空。");
        return;
      }
      const previous = existingImageMetadata(existingSections, url) || {};
      ensureSection(index);
      current.blocks.push({
        ...previous,
        type: "image",
        url,
        alt: decodeAttribute(image[1]),
        caption: decodeAttribute(image[3] ?? image[4] ?? ""),
        width_percent: previous.width_percent || 100,
        aspect_ratio: previous.aspect_ratio || "16/10",
        align: previous.align || "center",
        fit: previous.fit || "cover",
      });
      return;
    }
    if (!trimmed) {
      flushParagraph();
      return;
    }
    if (/^(?:#\s|[-*+]\s|\d+\.\s|>\s|```)/.test(trimmed)) {
      warnings.push(
        "第 " + (index + 1) + " 行包含暂不转换的块级 Markdown 语法。",
      );
    }
    paragraphLines.push(line);
  });
  flushParagraph();

  if (!sections.length) warnings.push("正文为空；未填写的日文正文会沿用中文。");
  sections.forEach(function (section) {
    if (!section.blocks.length) {
      section.blocks.push({ type: "paragraph", text: "", note: "" });
      warnings.push("章节“" + section.heading + "”暂时没有正文内容。");
    }
  });
  return {
    sections,
    outline,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

export function parseMarkdownDocument(source, existingSections = []) {
  const result = parseMarkdownDocumentCore(source, existingSections);
  result.sections = result.sections.map((section, index) => {
    const previous =
      existingSections.find((s) => s.heading === section.heading) ||
      existingSections[index] ||
      {};
    const oldBlocks = Array.isArray(previous.blocks) ? previous.blocks : [];
    return {
      ...previous,
      ...section,
      blocks: section.blocks.map((block, i) => {
        const before =
          oldBlocks.find(
            (b) =>
              b.type === block.type &&
              (block.type === "image"
                ? b.url === block.url
                : b.text === block.text),
          ) || oldBlocks[i];
        return before?.type === block.type ? { ...before, ...block } : block;
      }),
    };
  });
  return result;
}

function encodeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;");
}
function decodeAttribute(value) {
  return value.replace(
    /&(?:quot|amp|#91|#93);/g,
    (x) => ({ "&quot;": '"', "&amp;": "&", "&#91;": "[", "&#93;": "]" })[x],
  );
}
