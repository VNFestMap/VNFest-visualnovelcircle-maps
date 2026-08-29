import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const apiPath = path.join(rootDir, 'api', 'wiki.php');
const source = fs.readFileSync(apiPath, 'utf8');

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`wiki API contract failed: cannot locate ${startMarker}`);
  }
  return source.slice(start, end);
}

const formatText = sectionBetween('function wikiFormatText', 'function wikiSafeHref');
if (!formatText.includes('str_replace(["\\\\r\\\\n", "\\\\n", "\\\\r"]')) {
  throw new Error('wiki API should normalize literal escaped line breaks');
}
if (!formatText.includes('nl2br($html, false)')) {
  throw new Error('wiki API should render line breaks as HTML br elements');
}
if (source.includes('>\\n\';')) {
  throw new Error('wiki API must not emit a literal \\n in generated section markup');
}

const articleRenderer = sectionBetween('function wikiRenderArticle', 'function wikiRenderPage');
if (articleRenderer.includes('wikiRenderAppearanceLauncher()')) {
  throw new Error('wiki article renderer must not put the appearance launcher inside the article grid');
}

const pageRenderer = sectionBetween('function wikiRenderPage', 'function wikiReadLibraryDocs');
if ((pageRenderer.match(/wikiRenderAppearanceLauncher\(\)/g) || []).length !== 1) {
  throw new Error('wiki page renderer should place exactly one appearance launcher in the page header');
}
if (!pageRenderer.includes('wiki.css?v=20260817-editor-workbench')) {
  throw new Error('wiki page renderer should bust the stylesheet cache after the editor and TOC changes');
}

console.log('wiki API contract ok');
