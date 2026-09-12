export const ROLE_LEVEL = { visitor: 0, external: 0.5, member: 1, manager: 2, representative: 3, super_admin: 4 };
export const ROLE_NAMES = { visitor: '访客', external: '外交成员（IEM）', member: '成员', manager: '管理员', representative: '负责人', super_admin: '超级管理员' };

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
  { key: 'recognition', label: '考核设置' },
  { key: 'jiangsu', label: '江苏专项', superAdmin: true },
  { key: 'users', label: '用户管理', superAdmin: true },
];

export const TAB_KEYS = TAB_META.map((item) => item.key);

export function initialTab() {
  const requested = new URLSearchParams(window.location.search).get('tab');
  return TAB_KEYS.includes(requested) ? requested : 'pending';
}

export function syncTabUrl(tab) {
  const url = new URL(window.location.href);
  if (tab === 'pending') url.searchParams.delete('tab');
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

export function getClubName(directory, clubId, country = 'china') {
  return directory.get(clubKey(clubId, country)) || `同好会 #${clubId}`;
}

export function mediaUrl(value) {
  if (!value) return '';
  if (/^(?:https?:|data:|blob:|\/)/i.test(value)) return value;
  return `../${String(value).replace(/^\.\//, '')}`;
}
