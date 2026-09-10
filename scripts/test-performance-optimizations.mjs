import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const smoke = read('scripts/browser-smoke-electron.cjs');
assert.ok(smoke.includes('SMOKE_PERF'), 'browser smoke should expose optional perf mode');
assert.ok(smoke.includes('SMOKE_VIEWPORT'), 'browser smoke should support desktop/mobile viewport selection');
assert.ok(smoke.includes('SMOKE_PERF_OUTPUT'), 'browser smoke should write a perf report when requested');
assert.ok(smoke.includes('frameStats'), 'browser smoke should sample frame timing in perf mode');

const app = read('js/app.js');
const index = read('index.html');
assert.ok(app.includes('function scheduleIdleTask'), 'app should defer non-critical first-load work');
assert.ok(app.includes('loadClubDataForPublications().then(loadPublications)'), 'publications should load after first paint');
assert.ok(app.includes('p.dataset.tooltipBound'), 'map tooltip binding should be idempotent');
assert.ok(app.includes("document.documentElement.setAttribute('data-theme', effectiveTheme)"), 'system theme should keep a resolved data-theme attribute for consistent dark/light selectors');
assert.ok(!app.includes("document.documentElement.removeAttribute('data-theme')"), 'system theme must not remove data-theme after the first paint');
assert.ok(app.includes('State.listProvincesCache'), 'list filters should use the latest province cache');
assert.ok(app.includes('listRenderToken'), 'club card rendering should guard stale batched work');
assert.ok(app.includes('groupListRenderToken'), 'map-side group list rendering should guard stale batched work');
assert.ok(app.includes("listEl.dataset.groupDelegated"), 'map-side group list should use delegated click handling');
assert.ok(app.includes("document.getElementById('searchInput')?.addEventListener('input', Utils.debounce"), 'map-side search should debounce expensive detail rendering');
assert.ok(app.includes('function enterMobileListView'), 'mobile list mode should bypass desktop transition state');
assert.ok(app.includes("mobile-list-mode-active"), 'mobile list mode should use an isolated layout state class');
assert.ok(index.includes('class="list-user-identity"'), 'mobile list account identity should have a left-aligned wrapper');
assert.ok(index.includes('class="list-account-actions"'), 'mobile list account actions should be grouped on the right');
assert.ok(index.includes('id="listMenuBtn"'), 'mobile list should render an in-row menu button instead of relying on a floating hamburger');
assert.ok(index.includes('id="listSecondaryActions"'), 'mobile list should expose second-level action buttons');
const listTopRowStart = index.indexOf('<div class="list-top-row">');
const listTopRowEnd = index.indexOf('<div class="list-nav-row"', listTopRowStart);
const listTopRowMarkup = index.slice(listTopRowStart, listTopRowEnd);
assert.ok(
  listTopRowMarkup.indexOf('data-mode="map"') < listTopRowMarkup.indexOf('data-mode="list"') &&
  !listTopRowMarkup.includes('data-mode="starmap"'),
  'mobile list mode switch should focus on the animated map/list pair'
);
const listNavRowStart = index.indexOf('<div class="list-nav-row"', listTopRowEnd);
const listNavRowEnd = index.indexOf('</div>', listNavRowStart);
const listNavRowMarkup = index.slice(listNavRowStart, listNavRowEnd);
assert.ok(listNavRowMarkup.includes('data-action="project-hub"') && listNavRowMarkup.includes('data-action="forum"'), 'list navigation should keep project hub and forum reachable');

const styles = read('css/styles.css');
assert.ok(styles.includes(':root.mobile-list-mode-active .list-mode-inner'), 'mobile list mode should have isolated inner layout rules');
assert.ok(styles.includes('grid-template-rows: auto minmax(0, 1fr);'), 'mobile list layout should reserve a fixed top area and scrollable body');
assert.ok(styles.includes(':root.mobile-list-mode-active .club-grid'), 'mobile list mode should make the card grid the scrolling surface');
assert.ok(styles.includes(':root.mobile-list-mode-active .list-top-row .display-switch-container'), 'mobile list top mode switch should be promoted to its own row');
assert.ok(styles.includes('"identity identity actions"'), 'mobile list top row should place identity left and account actions right');
assert.ok(styles.includes('"menu spacer switch"'), 'mobile list second row should place menu left and mode switch right');
assert.ok(styles.includes('grid-auto-rows: min-content;'), 'mobile list top chrome should avoid fixed empty rows');
assert.ok(styles.includes('grid-area: switch;'), 'mobile list mode switch should use the right-side second-row area');
assert.ok(styles.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);'), 'mobile list filters should use a stable two-column control row');
assert.ok(styles.includes(':root.mobile-list-mode-active .hamburger-btn') && styles.includes('display: none !important;'), 'mobile list mode should override old floating hamburger rules');
assert.ok(styles.includes(':root.mobile-list-mode-active .list-menu-btn'), 'mobile list mode should use the in-row hamburger button');
assert.ok(styles.includes('min-height: 30px;'), 'mobile list top chrome should stay compact');
assert.ok(styles.includes('align-items: center;') && styles.includes('justify-content: center;'), 'mobile list account buttons should center text vertically');
assert.ok(styles.includes(':root.mobile-list-mode-active .list-secondary-actions'), 'mobile list mode should expose calendar/publication as secondary actions');
assert.ok(index.includes('data-action="project-hub"') && index.includes('id="listSecondaryActions"'), 'mobile list should keep project hub reachable without blocking the map/list switch');
assert.ok(app.includes("document.getElementById('listMenuBtn')"), 'mobile list in-row menu button should open the drawer');
assert.ok(app.includes('.list-secondary-actions .user-nav-btn'), 'mobile list secondary actions should reuse list navigation behavior');
assert.ok(styles.includes('#selectedCard') && styles.includes('left: 50% !important') && styles.includes('translateX(-50%)'), 'mobile map detail card should be centered or full-width constrained');
assert.ok(styles.includes('.top-account-btn') && styles.includes('text-decoration: none'), 'top account buttons should not show an underline');
assert.ok(index.includes('data-join-method="school_no_code"'), 'membership apply modal should expose school no-code method');
assert.ok(index.includes('data-join-method="school_code"'), 'membership apply modal should expose school bind-code method');
assert.ok(index.includes('data-join-method="external_exchange"'), 'membership apply modal should expose external exchange method');
assert.ok(index.includes('id="applyBindCode"'), 'bind-code method should have a dedicated code input');
assert.ok(index.includes('id="applyExternalClub"') && index.includes('id="applyExternalRole"'), 'external exchange method should collect source club and role');
assert.ok(app.includes("club_codes.php?action=redeem"), 'bind-code method should redeem directly instead of creating a pending application');
assert.ok(app.includes("join_method: method"), 'membership application payload should include join_method');
assert.ok(app.includes("payload.apply_role = 'external'"), 'external exchange application should request the IEM role');
assert.ok(app.includes("m.role !== 'external'"), 'IEM memberships should not unlock formal member-only frontend state');

const starMap = read('star_map.html');
assert.ok(starMap.includes('function needsStarRenderLoop'), 'star map should stop the render loop when idle');
assert.ok(starMap.includes('queueParticleFrame'), 'star map particles should be scheduled at a capped cadence');
assert.ok(starMap.includes('resizeTimer'), 'star map resize work should be debounced');
assert.ok(starMap.includes('include_members=1'), 'star map should hydrate unions without per-union request fanout');
assert.ok(starMap.includes('scheduleStarIdleTask(loadUnions'), 'star map should defer union hydration until after first render');
assert.ok(starMap.includes('function shouldUseLightweightStarRender'), 'star map should have a mobile lightweight first-paint path');
assert.ok(starMap.includes('completeInitialStarPaintSoon'), 'star map should keep mobile lightweight rendering and let desktop promote after idle');
assert.ok(starMap.includes('var maxLightweightMembers'), 'star map mobile first paint should cap member drawing');
assert.ok(starMap.includes('function markMobileStarInteraction'), 'star map should keep mobile interactions in a low-cost render path');
assert.ok(starMap.includes('function requestMobileStarFrame'), 'star map should throttle mobile touch rendering through animation frames');
assert.ok(starMap.includes('function shouldUseMobileEnhancedUnionRender'), 'star map should restore enhanced mobile union visuals after interaction');
assert.ok(starMap.includes("if (StarState.submode === 'union') return false;"), 'mobile union star map should not simplify while dragging or zooming');
assert.ok(starMap.includes('function resetStarTransientState'), 'star map should clear transient touch/selection state when switching submodes');
assert.ok(starMap.includes('if (isMobileStarMap()) {\n      StarState._submodeTransition = null;'), 'mobile star map submode switching should be immediate');
assert.ok(starMap.includes("StarState.submode === 'union' && !isMobileStarMap()"), 'mobile union mode should pan instead of invalidating layout on node drag');
assert.ok(starMap.includes('var maxLightweightClusters'), 'mobile union rendering should cap visible cluster work');
assert.ok(starMap.includes('(lightLayout || mobileEnhancedLayout) ? {} : buildSharedUnionMembershipIndex(positions)'), 'mobile union layout should skip shared-member indexing outside desktop full render');

const user = [
  read('user.html'),
  read('user-v2-react/src/App.jsx'),
  read('user-v2-react/src/styles.css')
].join('\n');
assert.ok(user.includes('user-v2-assets/'), 'user page should load the React user center assets');
assert.ok(user.includes("window.addEventListener('resize', check)"), 'React user page should debounce layout work through a shared viewport state');
assert.ok(user.includes('external: 1') && user.includes('member: 2'), 'user page should rank IEM below formal members');
assert.ok(user.includes('外交成员（IEM）'), 'user page should display the IEM role label');
assert.ok(user.includes('white-space: nowrap;') && user.includes('text-overflow: ellipsis;'), 'mobile user page should avoid wrapped titles and overflowing notifications');
assert.ok(user.includes("api/notifications.php?action=list") && user.includes("api/notifications.php?action=count_unread"), 'user page should load notification state through the notifications API');

const membershipApi = read('api/membership.php');
assert.ok(membershipApi.includes('join_method') && membershipApi.includes('external_exchange'), 'membership API should accept join methods including external exchange');
assert.ok(membershipApi.includes('contact_account') && membershipApi.includes('external_club_name') && membershipApi.includes('apply_reason'), 'membership API should persist external exchange application fields');
assert.ok(membershipApi.includes("'external'"), 'membership API should support the external/IEM role');
assert.ok(membershipApi.includes("status = 'active'"), 'membership API should expose active records for approved history');

const clubCodesApi = read('api/club_codes.php');
const clubCodeHelper = read('includes/club_code.php');
assert.ok(clubCodesApi.includes('clubCodeBindUser') && clubCodeHelper.includes("join_method = 'school_code'") && clubCodeHelper.includes("'school_code'"), 'club code redemption should mark direct joins as school_code');

const manager = read('admin/club_manager.html');
assert.ok(manager.includes('data-tab="diplomatic"'), 'club manager should have a diplomatic applications tab');
assert.ok(manager.includes("tab === 'approved'") && manager.includes("s.status === 'active'"), 'club manager approved tab should show active history');
assert.ok(manager.includes('joinMethodText') && manager.includes('外校成员交流申请'), 'club manager should show application method labels');
assert.ok(manager.includes('club_moe_king.php?action=get') && manager.includes('search_character'), 'club manager should manage Bangumi-backed moe kings');

const moeKingApi = read('api/club_moe_king.php');
assert.ok(moeKingApi.includes('club_moe_kings'), 'moe king API should persist one character per club');
assert.ok(moeKingApi.includes("action === 'get'") && moeKingApi.includes("action === 'set'") && moeKingApi.includes("action === 'remove'"), 'moe king API should support get/set/remove');
assert.ok(app.includes('club_moe_king.php?action=get'), 'club detail should fetch and display the moe king card');

const i18n = read('js/page-i18n.js');
assert.ok(i18n.includes('disconnectObserver'), 'page i18n should be able to disconnect its observer');
assert.ok(i18n.includes("if (getLang() !== 'ja')"), 'page i18n observer should be gated to Japanese mode');
assert.ok(i18n.includes('}, 80);'), 'page i18n mutation handling should be throttled');

const starUnionApi = read('api/star_unions.php');
assert.ok(starUnionApi.includes('include_members'), 'star union list API should support member hydration');
assert.ok(starUnionApi.includes('SELECT union_id, COUNT(*) AS member_count'), 'star union list API should aggregate member counts');
assert.ok(starUnionApi.includes('getClubIndex'), 'star union API should cache club lookups while enriching members');

console.log('performance optimization contract tests passed');
