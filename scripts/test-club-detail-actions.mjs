import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'js/app.js'), 'utf8');
const component = fs.readFileSync('club-detail-react/src/main.jsx', 'utf8');

assert.match(
  component,
  /club-detail-action-buttons/,
  'detail action buttons should use a dedicated class'
);
assert.match(
  component,
  /onClick=\{actions\.edit\}/,
  'React edit action should have its own explicit callback'
);
assert.match(
  component,
  /id="clubWikiActionWrap"/,
  'wiki action wrapper should remain separate from main detail actions'
);
assert.doesNotMatch(
  source,
  /const actionsContainer = content\.querySelector\(['"]\.club-detail-actions['"]\)/,
  'main action binding must not grab the wiki action wrapper'
);
assert.match(source, /wikiLangParam/, 'wiki links should carry the current UI language');
assert.match(source, /lang=ja/, 'Japanese UI should open wiki in Japanese mode');
assert.match(source, /loadClubDetailReact/, 'React detail should load on demand');
assert.match(source, /edit:.*openClubEditor\(club\)/, 'detail edit callback should hydrate the editor');
assert.match(source, /members:.*openMemberList\(clubId, clubCountry\)/, 'members action should retain the country');
assert.match(source, /apply:.*openMembershipApplyModal\(club\)/, 'apply action should keep the existing application workflow');
assert.doesNotMatch(source, /club-detail-wallpaper/, 'detail modal should not include club wallpaper controls');
assert.doesNotMatch(source, /club_wallpaper/, 'detail modal should not call club wallpaper APIs');

console.log('club detail action tests passed');
