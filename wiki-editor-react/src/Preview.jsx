import React, { useMemo, useRef, useEffect } from "react";
import {
  renderReaderArticle,
  renderAppearanceLauncher,
} from "../../wiki/wiki-reader.js";
export default function Preview({ content, club, lang, mobile }) {
  const scroll = useRef(0);
  useEffect(() => {
    scroll.current = 0;
  }, [lang]);
  const srcDoc = useMemo(() => {
    const base = new URL("../", location.href).href;
    return `<!doctype html><html lang="${lang === "ja" ? "ja" : "zh-CN"}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base}wiki/pages/"><link rel="stylesheet" href="${base}wiki/wiki.css?v=20260817-editor-workbench"><link rel="stylesheet" href="${base}css/button-shapes.css?v=20261002-pill-v1"><script defer src="${base}wiki/wiki-page.js?v=20261021-save-parity"></script></head><body><header class="wiki-header"><span>VNFest WIKI · 阅读预览</span>${renderAppearanceLauncher(lang)}</header><main class="wiki-page wiki-reading-page" data-wiki-page-lang="${lang}">${renderReaderArticle(content, club, lang, { assetRoot: base + "wiki/uploads/" })}</main></body></html>`;
  }, [content, club, lang]);
  return (
    <div className={`preview-surface ${mobile ? "device-mobile" : ""}`}>
      <iframe
        title="Wiki 阅读预览"
        sandbox="allow-same-origin allow-scripts"
        srcDoc={srcDoc}
        onLoad={(e) => {
          const doc = e.target.contentDocument;
          if (doc) {
            doc.documentElement.scrollTop = scroll.current;
            doc.addEventListener("scroll", () => {
              scroll.current = doc.documentElement.scrollTop;
            });
          }
          doc?.addEventListener("click", (event) => {
            const link = event.target.closest("a");
            if (link) {
              event.preventDefault();
              const href = link.getAttribute("href");
              if (href?.startsWith("#")) {
                const top = doc.getElementById(href.slice(1))?.offsetTop;
                doc.documentElement.scrollTop = top || 0;
              }
            }
          });
        }}
      />
    </div>
  );
}
