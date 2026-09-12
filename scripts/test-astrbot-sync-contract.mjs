import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => {
  const direct = path.join(root, file);
  if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8');
  return fs.readFileSync(path.join(root, '..', file), 'utf8');
};

const botApi = read('api/bot.php');
assert.ok(botApi.includes("case 'membership_applications'"), 'bot API should expose membership_applications action');
assert.ok(botApi.includes('club_bot_tokens'), 'bot API should create and use club_bot_tokens');
assert.ok(botApi.includes('function botEnsureClubTokenTable'), 'bot API should self-heal the club bot token table');
assert.ok(botApi.includes('gmap_club_'), 'bot API should support public club bot tokens');
assert.ok(botApi.includes("case 'bot_tokens_list'"), 'bot API should expose bot token listing');
assert.ok(botApi.includes("case 'bot_tokens_create'"), 'bot API should expose bot token creation');
assert.ok(botApi.includes("case 'bot_tokens_revoke'"), 'bot API should expose bot token revocation');
assert.ok(botApi.includes('password_hash($token') && botApi.includes('password_verify($actual'), 'bot API should store only token hashes');
assert.ok(botApi.includes('同好会 Bot token 只能读取本同好会申请'), 'club tokens should be scoped to their own membership applications');
assert.ok(botApi.includes('同好会 Bot token 无权访问其他同好会'), 'club tokens should reject cross-club access');
assert.ok(botApi.includes('approve_membership'), 'bot API should support optional approval permission');
assert.ok(botApi.includes("case 'membership_approve'") && botApi.includes("case 'membership_reject'"), 'bot API should expose approve/reject actions');
assert.ok(botApi.includes('function botMembershipApplications'), 'bot API should implement membership application listing');
assert.ok(botApi.includes('botEnsureMembershipApplicationColumns'), 'bot API should self-heal missing membership application columns');
assert.ok(botApi.includes('since_id'), 'membership application API should support since_id');
assert.ok(botApi.includes("order'] ?? 'asc'") && botApi.includes("'DESC'"), 'membership application API should support newest-first ordering');
assert.ok(botApi.includes('club_key'), 'membership application API should support club_key');
assert.ok(botApi.includes("scope'] ?? 'all'"), 'membership application API should support all-scope sync');
assert.ok(botApi.includes('join_method_label'), 'membership application rows should include join method labels');
assert.ok(botApi.includes('role_label'), 'membership application rows should include role labels');
assert.ok(botApi.includes('external_club_name') && botApi.includes('apply_reason'), 'external exchange fields should be exposed');
assert.ok(botApi.includes('pending_memberships_school_no_code'), 'admin summary should split school no-code applications');
assert.ok(botApi.includes('pending_memberships_external_exchange'), 'admin summary should split external exchange applications');
assert.ok(botApi.includes('function botMoeKing') && botApi.includes("row['moe_king']"), 'club detail API should include moe king data');

const pluginDir = [
  path.join(root, 'astrbot_plugin_galgamemap'),
  path.join(root, '..', 'astrbot_plugin_galgamemap')
].find((dir) => fs.existsSync(path.join(dir, 'main.py')));

if (pluginDir) {
const plugin = fs.readFileSync(path.join(pluginDir, 'main.py'), 'utf8');
assert.ok(plugin.includes('sync_enabled'), 'plugin should read sync_enabled config');
assert.ok(plugin.includes('sync_auto_enable_on_bind'), 'plugin should support auto-enable after binding');
assert.ok(plugin.includes('sync_interval_seconds'), 'plugin should read sync interval config');
assert.ok(plugin.includes('sync_group_bindings'), 'plugin should support club sync bindings');
assert.ok(plugin.includes('super_admin_sync_origins'), 'plugin should support super admin sync origins');
assert.ok(plugin.includes('asyncio.create_task') || plugin.includes('loop.create_task'), 'plugin should start a background sync task');
assert.ok(plugin.includes('async def initialize') && plugin.includes('_ensure_sync_task'), 'plugin should restart the sync task after AstrBot lifecycle initialization');
assert.ok(plugin.includes('membership_applications'), 'plugin should poll membership applications');
assert.ok(plugin.includes('unified_msg_origin'), 'plugin should bind active push targets by unified_msg_origin');
assert.ok(plugin.includes('self.context.send_message'), 'plugin should actively send messages through AstrBot context');
assert.ok(plugin.includes('MessageChain([Plain(text)])') && plugin.includes('candidates.append(text)'), 'plugin should try multiple active-message payload formats');
assert.ok(plugin.includes('def _binding_key') && plugin.includes('disabled_binding_keys'), 'plugin should track sync bindings per club and destination, not just per club');
assert.ok(plugin.includes('def _is_valid_unified_origin') && plugin.includes('invalid unified_msg_origin'), 'plugin should reject invalid active-message sessions before sending');
assert.ok(plugin.includes('_resolve_club_candidates') && plugin.includes('同步搜索'), 'plugin should support Chinese fuzzy sync binding search');
assert.ok(plugin.includes('_exact_club_candidates') && plugin.includes('_sync_check_single_club'), 'plugin should support precise fuzzy binding and single-club sync checks');
assert.ok(plugin.includes('reverse=True') && plugin.includes('sent_ids'), 'plugin should send newest application notifications first without advancing last_seen on partial sends');
assert.ok(plugin.includes('item_signatures') && plugin.includes('_application_signature'), 'plugin should detect changed pending applications, not only new IDs');
assert.ok(plugin.includes('"order": "desc"'), 'plugin should request newest pending applications first');
assert.ok(plugin.includes('"since_id"'), 'plugin should pass since_id to API for incremental sync');
assert.ok(botApi.includes("case 'auto_approve'"), 'bot API should expose auto_approve action for bot-triggered approval');
assert.ok(plugin.includes('auto_approve_on_sync'), 'plugin should support auto_approve_on_sync config');
assert.ok(plugin.includes('"auto_approve"'), 'plugin should call auto_approve endpoint when configured');
assert.ok(plugin.includes('同步开启') && plugin.includes('同步关闭') && plugin.includes('同步配置'), 'plugin should expose runtime sync configuration commands');
assert.ok(plugin.includes('os.replace(tmp_path, path)'), 'plugin should save sync state atomically');
assert.ok(plugin.includes('同步绑定') && plugin.includes('同步超管') && plugin.includes('同步检测') && plugin.includes('同步取消超管'), 'plugin should expose sync owner commands');
assert.ok(plugin.includes('JOIN_METHOD_LABELS') && plugin.includes('ROLE_LABELS'), 'plugin should render join method and role labels');
assert.ok(plugin.includes('萌王') && plugin.includes('moe_king'), 'plugin club detail should render moe king');
assert.ok(plugin.includes('外交成员（IEM）'), 'plugin should render IEM role label');
for (const command of ['待审', '通过', '拒绝', '国家', '类型', '分享', '活跃', '萌战']) {
  assert.ok(plugin.includes(command), `plugin should expose ${command} command`);
}
assert.ok(plugin.includes('_own_club_for_token'), 'plugin should support no-key sync binding for public club tokens');
assert.ok(plugin.includes('membership_approve') && plugin.includes('membership_reject'), 'plugin should call bot approval actions');

const schema = fs.readFileSync(path.join(pluginDir, '_conf_schema.json'), 'utf8');
const parsedSchema = JSON.parse(schema);
for (const key of [
  'sync_enabled',
  'sync_auto_enable_on_bind',
  'sync_interval_seconds',
  'sync_first_run_silence',
  'sync_group_bindings',
  'super_admin_sync_origins',
  'sync_max_items_per_tick',
  'auto_approve_on_sync',
]) {
  assert.ok(Object.hasOwn(parsedSchema, key), `config schema should include ${key}`);
}

const metadata = fs.readFileSync(path.join(pluginDir, 'metadata.yaml'), 'utf8');
const metadataVersion = (metadata.match(/^version:\s*(\S+)/m) || [])[1];
assert.ok(metadataVersion, 'metadata should advertise a plugin version');
assert.ok(plugin.includes(`"${metadataVersion}"`) && plugin.includes('@register('), 'plugin @register version should match metadata.yaml version');
assert.ok(metadata.includes('公开版') && metadata.includes('申请同步') && metadata.includes('IEM') && metadata.includes('萌王'), 'metadata should mention the new information surface');

const readme = fs.readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
assert.ok(readme.includes('同步绑定') && readme.includes('同步超管') && readme.includes('unified_msg_origin'), 'README should document sync commands and active message origin');
assert.ok(readme.includes('/gal地图 同步绑定 北大') && readme.includes('/gal地图 同步绑定') && readme.includes('不合法的 session 字符串'), 'README should document fuzzy binding and invalid session recovery');
assert.ok(readme.includes('/gal地图 同步检测 北大'), 'README should document single-club sync check');
assert.ok(readme.includes('membership_applications'), 'README should document the new bot API action');
assert.ok(readme.includes('负责人公开接入') && readme.includes('Bot 接入') && readme.includes('gmap_club_'), 'README should document public club onboarding');
assert.ok(readme.includes('/gal地图 待审') && readme.includes('/gal地图 通过') && readme.includes('/gal地图 拒绝'), 'README should document approval commands');
} else {
  console.warn('astrbot plugin files not found; skipped plugin-side contract checks');
}

const manager = read('club-manager-react/src/model.js') + read('club-manager-react/src/tabs/BotTokensTab.jsx');
assert.ok(manager.includes("key: 'bot_tokens'"), 'club manager should expose Bot 接入 tab');
assert.ok(manager.includes('const create = async') && manager.includes('const revoke = async'), 'club manager should manage bot tokens');
assert.ok(manager.includes('bot_tokens_create') && manager.includes('bot_tokens_revoke'), 'club manager should call bot token management API');

const migrate = read('scripts/migrate.php');
assert.ok(migrate.includes('club_bot_tokens'), 'migration should create club_bot_tokens');

console.log('astrbot sync contract tests passed');
