import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.join(process.cwd(), 'js/app.js'), 'utf8');
const managerSource = ['App.jsx', 'Shell.jsx', 'model.js', 'tabs/SettingsTab.jsx']
  .map((file) => fs.readFileSync(path.join(process.cwd(), 'club-manager-react', 'src', file), 'utf8')).join('\n');
const indexSource = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const clubsApiSource = fs.readFileSync(path.join(process.cwd(), 'api', 'clubs.php'), 'utf8');
const pageBackgroundSource = fs.readFileSync(path.join(process.cwd(), 'js', 'page-background.js'), 'utf8');

assert.match(appSource, /function\s+openClubEditFromUrl\s*\(/, 'main page should handle edit_club deep links');
assert.match(appSource, /URLSearchParams\(window\.location\.search\)/, 'deep link handler should read URL parameters');
assert.match(appSource, /params\.get\(['"]edit_club['"]\)/, 'deep link handler should read edit_club');
assert.match(appSource, /State\.japanRows/, 'deep link handler should support Japan clubs');
assert.match(appSource, /function\s+loadEditableClubSnapshot\s*\(/, 'edit flow should load a complete editable club snapshot');
assert.match(appSource, /fetch\(['"]\.\/api\/clubs\.php['"][\s\S]*cache:\s*['"]no-store['"]/, 'China edit flow should read the club snapshot from the API before opening editor');
assert.match(appSource, /fetch\(['"]\.\/api\/clubs_japan\.php['"][\s\S]*cache:\s*['"]no-store['"]/, 'Japan edit flow should read the club snapshot from the API before opening editor');
assert.match(appSource, /function\s+openClubEditor\s*\(/, 'edit buttons should use the hydrated editor opener');
assert.match(appSource, /openClubEditor\(club\)/, 'deep link handler should open the hydrated edit panel');
assert.match(appSource, /data-action="edit-club"[\s\S]*openClubEditor\(club\)/, 'detail edit action should hydrate before editing');
assert.match(indexSource, /id="provincePicker"/, 'club editor should use a province picker');
assert.match(indexSource, /id="provincePickerOptions"/, 'province picker should render selectable options');
assert.match(indexSource, /id="cropImage"[^>]*loading="eager"/, 'avatar crop image should load eagerly while the crop modal opens');
assert.match(appSource, /CHINA_PROVINCE_OPTIONS/, 'club editor should provide province options');
assert.match(appSource, /bindProvincePicker/, 'club editor should bind picker interactions');
assert.match(appSource, /setProvincePickerSelection/, 'club editor should restore picker selection');
assert.match(clubsApiSource, /normalizeClubProvinces/, 'clubs API should normalize multi-province input');
assert.match(indexSource, /data-after-map/, 'main page wallpaper should wait until the map is rendered');
assert.match(pageBackgroundSource, /vnfest:map-ready/, 'wallpaper loader should listen for the map-ready event');
const renderClubCardsSource = appSource.match(/function\s+renderClubCards\s*\([\s\S]*?\n}\n\nfunction\s+refilterCards/)?.[0] || '';
assert.ok(!renderClubCardsSource.includes('japanSet'), 'renderClubCards should not depend on renderListView local state');
assert.match(appSource, /deleteClub[\s\S]*clubs_japan\.php/, 'delete flow should use Japan API for Japan clubs');
assert.match(appSource, /deleteClub[\s\S]*credentials:\s*['"]same-origin['"]/, 'delete flow should include credentials');

assert.match(managerSource, /available\s*=\s*\[[\s\S]*all:\s*true[\s\S]*\.\.\.china\.map[\s\S]*\.\.\.japan\.map/, 'super admin should keep all clubs and the global option');
assert.match(managerSource, /setSelectedKey\(available\[0\]\.all \? 'all' : clubKey/, 'manager should select the first available option and preserve country in its composite key');
assert.match(managerSource, /TAB_META\.filter\(\(item\) => !item\.superAdmin \|\| superAdmin\)/, 'super-admin tabs must be permission-filtered before rendering');
assert.doesNotMatch(managerSource, /请先选择\s*同好会\s*#0/, 'users tab should not require a sentinel club');
assert.match(managerSource, /width=\{collapsed \? 64 : 244\}/, 'manager page should keep the tightened second-level sidebar');
assert.match(managerSource, /algorithm:\s*isDark \? theme\.darkAlgorithm : theme\.defaultAlgorithm/, 'manager page should support light and dark themes');
assert.match(managerSource, /const save = async/, 'manager should save club settings in-page without redirecting');

// A stray </div> inside the topbar header makes the HTML parser close .admin-main
// early, re-parenting <main class="admin-content"> as a flex-row sibling and
// pushing all tab content to the right half of the screen.
assert.match(managerSource, /<header[\s\S]*<Layout className="cm-workspace">/, 'React topbar must precede the sidebar/content workspace');

console.log('club edit contract tests passed');
