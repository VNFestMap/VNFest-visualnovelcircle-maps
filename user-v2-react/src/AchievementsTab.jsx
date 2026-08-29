import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar, Empty, Segmented, Spin, Switch, Tag, Typography, message } from 'antd';
import { LinkOutlined, TrophyOutlined } from '@ant-design/icons';

const { Text, Title } = Typography;

const API_BASE = './api/recognition_credentials.php';

const STATUS_META = {
  active: { label: '有效', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  revoked: { label: '已撤销', color: 'error' },
  superseded: { label: '已被替代', color: 'warning' },
};

const VERIFY_LABEL = {
  auto: '自动验证',
  single_review: '单人审核',
  multi_review: '多人审核',
  owner_grant: '负责人签发',
  external_system: '外部系统证明',
  joint_issue: '联名签发',
  platform: '平台合作验证',
  batch_import: '名单导入',
};

function resolveMediaUrl(url) {
  if (!url) return '';
  if (/^(https?:)?\/\//.test(url) || String(url).startsWith('data:')) return url;
  return `./${String(url).replace(/^\.?\//, '')}`;
}

async function readJson(resp, url) {
  const text = await resp.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`接口返回的不是 JSON：${url}（HTTP ${resp.status}）`);
    }
  }
  if (!resp.ok && !(data && typeof data === 'object')) {
    throw new Error(`接口请求失败：${url}（HTTP ${resp.status}）`);
  }
  return data;
}

export default function AchievementsTab({ themeTokens }) {
  const t = themeTokens;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState({ total: 0, active: 0, club_count: 0 });
  const [credentials, setCredentials] = useState([]);
  const [filter, setFilter] = useState('all');
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_BASE}?action=my`, { credentials: 'same-origin' });
      const data = await readJson(resp, `${API_BASE}?action=my`);
      if (!data.success) throw new Error(data.message || '加载成就失败');
      setSummary(data.summary || { total: 0, active: 0, club_count: 0 });
      setCredentials(data.credentials || []);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const filtered = credentials.filter((c) => {
      if (filter === 'active') return c.status === 'active';
      if (filter === 'history') return c.status !== 'active';
      return true;
    });
    const map = new Map();
    filtered.forEach((c) => {
      const key = `${c.issuer_club_id}:${c.issuer_country}`;
      if (!map.has(key)) map.set(key, { clubName: c.club_name, items: [] });
      map.get(key).items.push(c);
    });
    return [...map.values()];
  }, [credentials, filter]);

  const toggleVisibility = useCallback(async (cred, visible) => {
    try {
      const resp = await fetch(`${API_BASE}?action=set_visibility`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_uid: cred.credential_uid, public_visibility: visible ? 1 : 0 }),
      });
      const data = await readJson(resp, `${API_BASE}?action=set_visibility`);
      if (!data.success) throw new Error(data.message || '更新失败');
      setCredentials((prev) => prev.map((c) => (
        c.credential_uid === cred.credential_uid ? { ...c, public_visibility: visible ? 1 : 0 } : c
      )));
      messageApi.success(visible ? '凭证已设为公开' : '凭证已设为私密');
    } catch (err) {
      messageApi.error(err.message || '更新失败');
    }
  }, [messageApi]);

  const statCards = [
    { label: '徽章总数', value: summary.total },
    { label: '当前有效', value: summary.active },
    { label: '认可同好会', value: summary.club_count },
  ];

  return (
    <div className="ach-root">
      {contextHolder}
      <div className="ach-head">
        <Title level={4} style={{ margin: 0, color: t.textBright }}>我的成就</Title>
        <Text style={{ color: t.muted }}>
          通过同好会考核获得的成就徽章统一保存在这里，每一份凭证都可以公开验证来源。
        </Text>
      </div>

      <div className="ach-stats">
        {statCards.map((s) => (
          <div key={s.label} className="ach-stat-card" style={{ background: t.surface, borderColor: t.border }}>
            <span className="ach-stat-value" style={{ color: t.primary }}>{s.value}</span>
            <span className="ach-stat-label" style={{ color: t.muted }}>{s.label}</span>
          </div>
        ))}
      </div>

      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { label: '全部', value: 'all' },
          { label: '有效', value: 'active' },
          { label: '历史', value: 'history' },
        ]}
      />

      {loading ? (
        <div className="ach-loading"><Spin /></div>
      ) : error ? (
        <Empty description={<span style={{ color: t.muted }}>{error}</span>} />
      ) : groups.length === 0 ? (
        <Empty
          image={<TrophyOutlined style={{ fontSize: 48, color: t.soft }} />}
          description={<span style={{ color: t.muted }}>还没有获得成就徽章，去同好会考核看看吧</span>}
        />
      ) : (
        groups.map((group) => (
          <section key={group.clubName} className="ach-group">
            <h3 className="ach-group-title" style={{ color: t.text }}>{group.clubName}</h3>
            <div className="ach-grid">
              {group.items.map((cred) => (
                <AchievementCard
                  key={cred.credential_uid}
                  cred={cred}
                  themeTokens={t}
                  onToggleVisibility={toggleVisibility}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function AchievementCard({ cred, themeTokens: t, onToggleVisibility }) {
  const status = STATUS_META[cred.status] || { label: cred.status, color: 'default' };
  const isActive = cred.status === 'active';
  const issued = (cred.issued_at || '').slice(0, 10);

  return (
    <div className="ach-card" style={{ background: t.surface, borderColor: t.border }}>
      <div className="ach-card-top">
        {cred.badge_image ? (
          <Avatar size={64} src={resolveMediaUrl(cred.badge_image)} className="ach-badge-avatar" />
        ) : (
          <Avatar size={64} className="ach-badge-avatar ach-badge-fallback" style={{ background: t.overlay, color: t.amber }}>
            <TrophyOutlined style={{ fontSize: 26 }} />
          </Avatar>
        )}
        <div className="ach-card-info">
          <Text strong style={{ color: t.textBright, fontSize: 15 }}>{cred.badge_name}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{cred.program_title}</Text>
        </div>
        <Tag color={status.color}>{status.label}</Tag>
      </div>

      <div className="ach-card-meta">
        <span style={{ color: t.soft }}>
          {VERIFY_LABEL[cred.verification_level] || cred.verification_level} · {issued}
          {cred.expires_at ? ` · 至 ${String(cred.expires_at).slice(0, 10)}` : ''}
        </span>
      </div>

      <div className="ach-card-actions">
        <a
          className="ach-verify-link"
          href={`./verify.html?uid=${encodeURIComponent(cred.credential_uid)}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: t.primary }}
        >
          <LinkOutlined /> 验证页
        </a>
        {isActive && (
          <span className="ach-visibility">
            <Text style={{ color: t.muted, fontSize: 12 }}>{Number(cred.public_visibility) ? '公开' : '私密'}</Text>
            <Switch
              size="small"
              checked={Number(cred.public_visibility) === 1}
              onChange={(checked) => onToggleVisibility(cred, checked)}
            />
          </span>
        )}
      </div>
    </div>
  );
}
