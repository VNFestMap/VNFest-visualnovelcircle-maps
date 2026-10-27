// The save API and offline generator use exactly the same server-side renderer.
import { renderPage } from './generate-wiki-pages.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { content, club, lang } = JSON.parse(input);
if (!content || !/^(china|japan)-\d+$/.test(content.club_key) || !['zh', 'ja'].includes(lang)) {
  throw new Error('Invalid Wiki render input');
}
process.stdout.write(renderPage(content, club || {}, lang));
