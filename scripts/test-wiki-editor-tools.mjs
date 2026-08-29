import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const editorPath = path.join(rootDir, 'admin', 'wiki_editor.html');
const source = fs.readFileSync(editorPath, 'utf8');

function assertContains(needle, description) {
  if (!source.includes(needle)) {
    throw new Error(`wiki editor contract failed: missing ${description}`);
  }
}

assertContains('wikiEditorDraft:', 'per-club local draft key');
assertContains('beforeunload', 'unsaved-change warning');
assertContains('renderPreview', 'live preview renderer');
assertContains('previewPane', 'preview pane markup');
assertContains('renderReaderArticle', 'shared reader preview renderer');
assertContains('bindPreviewAppearance', 'preview appearance interaction');
assertContains('data-appearance-dock', 'preview appearance dock action');
assertContains('wiki-reading-topbar', 'preview topbar appearance entry');
assertContains('wiki-reader.js', 'shared reader module');
if (source.includes('page-background.js')) {
  throw new Error('wiki editor should not load the global wallpaper runtime');
}
assertContains('wiki-preview-reader', 'reader shell preview wrapper');
if (source.includes('data-editor-mode="preview"') || source.includes('editorModePreview')) {
  throw new Error('wiki editor should not expose a preview tab');
}
assertContains('data-editor-mode="visual"', 'visual editor mode control');
assertContains('data-editor-mode="markdown"', 'Markdown editor mode control');
assertContains('支持 Markdown', 'Markdown formatting hint');
assertContains('markdownSourceInput', 'Markdown source editor');
assertContains('parseMarkdownDocument', 'Markdown parser');
assertContains('sectionsToMarkdown', 'Markdown serializer');
assertContains('editorOutline', 'editor outline navigation');
assertContains('setEditorMode', 'visual/Markdown editor mode state');
assertContains('data-editor-panel="preview"', 'persistent preview panel');
assertContains('data-action="add-paragraph-block"', 'paragraph block action');
assertContains('data-action="add-image-block"', 'inline image block action');
assertContains('section.blocks', 'content block serialization');
assertContains('dataset.blockType', 'content block DOM type marker');
assertContains('data-field="note"', 'paragraph annotation field');
assertContains('avatarEditor', 'entry avatar editor');
assertContains('collectAvatar', 'entry avatar serialization');
assertContains('data-field="position"', 'entry avatar position selector');
assertContains('parsed.avatar', 'entry avatar JSON validation');
assertContains('block.note', 'paragraph annotation serialization');
assertContains('jsonValidation', 'live JSON validation status');
assertContains('validateJsonSource', 'JSON structure validator');
assertContains('insertTemplateBtn', 'basic section template action');
assertContains('exportJsonBtn', 'JSON export action');
assertContains('importJsonBtn', 'JSON import action');
assertContains('data-action="duplicate-row"', 'duplicate row action');
assertContains('data-field="level"', 'section heading level selector');
assertContains('section.level || 2', 'existing sections default to level 2');
assertContains('restoreDraftBtn', 'draft restore action');
assertContains('clearDraftBtn', 'draft clear action');
assertContains('wikiLangZhBtn', 'Chinese wiki content tab');
assertContains('wikiLangJaBtn', 'Japanese wiki content tab');
assertContains('activeWikiLang', 'active wiki language editor state');
assertContains('i18n: { ja:', 'Japanese wiki content serialization');
assertContains('readWikiResponse', 'shared wiki API response parser');
assertContains('接口返回异常（HTTP ', 'non-JSON wiki API error visibility');
assertContains('await resp.text()', 'wiki API responses parsed from text before JSON');

console.log('wiki editor tool contract ok');
