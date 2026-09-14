export const ROLE_LEVEL = { visitor: 0, external: 0.5, member: 1, manager: 2, representative: 3, super_admin: 4 };
export const ROLE_NAMES = { visitor: '访客', external: '外交成员（IEM）', member: '成员', manager: '管理员', representative: '负责人', super_admin: '超级管理员' };

/*
 * 权限等级是用户列表里的统一展示口径：账号角色与有效同好会关系取最高等级。
 * external 在同好会业务里仍保留 IEM 语义，但在权限徽章中显示为“活动人员”。
 */
export const PERMISSION_LEVEL_META = {
  visitor: { key: 'visitor', label: '访客', mark: '○' },
  member: { key: 'member', label: '成员', mark: '●' },
  manager: { key: 'manager', label: '管理员', mark: '◆' },
  representative: { key: 'representative', label: '负责人', mark: '★' },
  super_admin: { key: 'super-admin', label: '超级管理员', mark: '✦' },
  external: { key: 'external', label: '活动人员', mark: '✦' },
};

export const TAB_META = [
  { key: 'pending', label: '待审核' },
  { key: 'diplomatic', label: '外交申请' },
  { key: 'approved', label: '已通过' },
  { key: 'members', label: '成员' },
  { key: 'settings', label: '设置' },
  { key: 'codes', label: '绑定码' },
  { key: 'bot_tokens', label: 'Bot 接入' },
  { key: 'recommendations', label: '神器榜' },
  { key: 'projects', label: '企划枢纽' },
  { key: 'vote_projects', label: '赛事活动' },
  { key: 'recognition', label: '考核设置' },
  { key: 'jiangsu', label: '江苏专项', superAdmin: true },
  { key: 'users', label: '用户管理', superAdmin: true },
];

export const TAB_KEYS = TAB_META.map((item) => item.key);
export const DEFAULT_TAB = 'approved';

export function initialTab() {
  const requested = new URLSearchParams(window.location.search).get('tab');
  return TAB_KEYS.includes(requested) ? requested : DEFAULT_TAB;
}

export function syncTabUrl(tab) {
  const url = new URL(window.location.href);
  if (tab === DEFAULT_TAB) url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  window.history.replaceState(null, '', url);
}

export function getEffectiveLevel(auth) {
  let level = ROLE_LEVEL[auth?.user?.role] ?? -1;
  for (const membership of auth?.memberships || []) {
    if (membership.status === 'active') level = Math.max(level, ROLE_LEVEL[membership.role] ?? -1);
  }
  return level;
}

export function isSuperAdmin(auth) {
  return auth?.user?.role === 'super_admin';
}

export function clubKey(clubId, country = 'china') {
  return `${Number(clubId)}|${country || 'china'}`;
}

export function parseClubKey(value) {
  if (value === 'all') return { clubId: -1, country: 'china' };
  const [id, country] = String(value || '').split('|');
  return { clubId: Number(id) || 0, country: country || 'china' };
}

export function formatDate(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-');
}

export function applyRoleText(role) {
  return ROLE_NAMES[role] || '成员';
}

export function permissionLevelMeta(role) {
  return PERMISSION_LEVEL_META[role] || PERMISSION_LEVEL_META.visitor;
}

export function permissionLevelText(role) {
  return permissionLevelMeta(role).label;
}

export function getPermissionRole(user) {
  let bestRole = Object.prototype.hasOwnProperty.call(ROLE_LEVEL, user?.role) ? user.role : 'visitor';
  let bestLevel = ROLE_LEVEL[bestRole];
  for (const membership of user?.memberships || []) {
    if (membership.status !== 'active' || !Object.prototype.hasOwnProperty.call(ROLE_LEVEL, membership.role)) continue;
    if (ROLE_LEVEL[membership.role] > bestLevel) {
      bestRole = membership.role;
      bestLevel = ROLE_LEVEL[membership.role];
    }
  }
  return bestRole;
}

export function getClubName(directory, clubId, country = 'china') {
  return directory.get(clubKey(clubId, country)) || `同好会 #${clubId}`;
}

export function mediaUrl(value) {
  if (!value) return '';
  if (/^(?:https?:|data:|blob:|\/)/i.test(value)) return value;
  return `../${String(value).replace(/^\.\//, '')}`;
}
