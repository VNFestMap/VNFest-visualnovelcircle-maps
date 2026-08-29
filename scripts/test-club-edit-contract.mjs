import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.join(process.cwd(), 'js/app.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(process.cwd(), 'admin/club_manager.html'), 'utf8');
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

assert.match(managerSource, /let\s+allClubOptions\s*=\s*\[\]/, 'manager should keep all club options for super admin');
assert.match(managerSource, /managedClubs\s*=\s*\[\{\s*club_id:\s*0[\s\S]*\.concat\(allClubOptions\)/, 'super admin should be able to select real clubs');
assert.match(managerSource, /sel\.selectedIndex\s*=\s*0/, 'single managed club should select the first real option');
assert.match(managerSource, /selectedCountry\s*=\s*managedClubs\[0\]\.country/, 'single managed club should sync country');
assert.match(managerSource, /function\s+updateSuperAdminTabs\s*\([\s\S]*usersTabBtn\.style\.display\s*=\s*isSuperAdminUser\(\)\s*\?\s*['"]{2}\s*:\s*['"]none['"]/, 'super admin users module should be visible regardless of selected club');
assert.doesNotMatch(managerSource, /selectedClubId\s*!==\s*0[\s\S]{0,160}无权限访问/, 'super admin users module should not require selecting club #0');
assert.doesNotMatch(managerSource, /请先选择\s*同好会\s*#0/, 'users tab should not ask super admin to select club #0');
assert.match(managerSource, /--sidebar-w:\s*248px/, 'manager page should keep the sidebar/topbar admin console layout');
assert.match(managerSource, /:root\[data-theme='light'\]\s*\{/, 'manager page should include a dedicated light mode pass');
assert.match(managerSource, /async function saveClubSettings\s*\(/, 'manager should save club settings in-page without redirecting to the main editor');

// A stray </div> inside the topbar header makes the HTML parser close .admin-main
// early, re-parenting <main class="admin-content"> as a flex-row sibling and
// pushing all tab content to the right half of the screen.
for (const headerBlock of managerSource.match(/<header\b[\s\S]*?<\/header>/g) || []) {
  const navOpens = (headerBlock.match(/<nav\b/g) || []).length;
  const navCloses = (headerBlock.match(/<\/nav>/g) || []).length;
  assert.equal(navOpens, navCloses, 'manager header blocks must close every <nav> they open');
}

console.log('club edit contract tests passed');
