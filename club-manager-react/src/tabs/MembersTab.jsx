import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Popconfirm } from 'antd';
import { CrownOutlined, UserDeleteOutlined } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import {
  ActionCluster, Chip, EmptyPanel, ErrorPanel, Identity, LoadingPanel, ManagementItem, MetaItem,
  MetaLine, PageHeading, ProfileAvatar,
} from '../components.jsx';
import { applyRoleText, formatDate, isSuperAdmin } from '../model.js';
import { useClubManager } from '../context.jsx';

export default function MembersTab() {
  const { auth, selected, messageApi, refreshVersion } = useClubManager();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const superAdmin = isSuperAdmin(auth);
  const myMembership = useMemo(() => (auth.memberships || []).find((item) =>
    Number(item.club_id) === selected.clubId && (item.country || 'china') === selected.country && item.status === 'active'), [auth, selected]);
  const myRole = myMembership?.role || '';
  // The API has already restricted this roster to a club the current account
  // manages. The group/contact account is needed for that roster workflow;
  // personal email and application details remain super-admin-only below.
  const canReadMemberContact = superAdmin || ['manager', 'representative'].includes(myRole);

  const load = useCallback(async () => {
    if (selected.clubId <= 0) { setMembers([]); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await api.get(`membership.php?action=members&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`);
      setMembers(result.members || []);
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [refreshVersion, selected]);
  useEffect(() => { load(); }, [load]);

  const mutate = async (path, body, success) => {
    setBusyId(body.membership_id || body.id);
    try { await api.post(path, body); messageApi.success(success); await load(); }
    catch (mutationError) { messageApi.error(normalizeError(mutationError)); }
    finally { setBusyId(null); }
  };

  if (selected.clubId <= 0) return <section className="cm-page"><PageHeading title="成员" /><EmptyPanel description="请先在左侧选择一个同好会" /></section>;
  return (
    <section className="cm-page" data-component="同好会成员管理">
      <PageHeading title="成员" description="管理同好会成员角色、通知接收和负责人归属。" />
      {loading ? <LoadingPanel variant="management" rows={2} /> : error ? <ErrorPanel message={error} onRetry={load} /> : !members.length ? <EmptyPanel description="暂无成员" /> : (
        <div className="cm-management-list cm-member-list">
          {members.map((member) => {
            const isSelf = Number(member.user_id) === Number(auth.user.id);
            const canChangeRole = !isSelf && (superAdmin || myRole === 'representative');
            const canKick = !isSelf && (superAdmin || myRole === 'representative' || (myRole === 'manager' && ['member', 'external'].includes(member.role)));
            const canTransfer = !isSelf && (superAdmin || myRole === 'representative') && !['representative', 'external'].includes(member.role);
            const canEmail = (superAdmin || myRole === 'representative') && ['representative', 'manager'].includes(member.role);
            const roleTone = member.role === 'representative' ? 'brand' : member.role === 'manager' ? 'warning' : undefined;
            const hasActions = canChangeRole || canTransfer || canKick;
            const memberSummary = (
              <MetaLine className="cm-member-meta-primary">
                {member.nickname && <MetaItem label="昵称" value={member.nickname} />}
                <MetaItem label="加入于" value={formatDate(member.joined_at)} />
              </MetaLine>
            );
            const contactAccount = member.contact_account || member.qq_account || '';
            const memberDetails = (canReadMemberContact || superAdmin) && (
              <MetaLine className="cm-member-meta-secondary">
                {superAdmin && member.email && <MetaItem label="邮箱" value={member.email} />}
                {canReadMemberContact && contactAccount && <MetaItem label="群号 / QQ" value={contactAccount} />}
                {superAdmin && member.apply_role && <MetaItem label="申请身份" value={applyRoleText(member.apply_role)} />}
                {superAdmin && member.is_student !== undefined && <MetaItem label="学生" value={Number(member.is_student) === 1 ? '是' : '否'} />}
              </MetaLine>
            );
            const memberSettings = canEmail && (
              <label className="cm-setting-line" title="仅控制本同好会的申请邮件；成员个人关闭邮件提醒后仍不会收到邮件">
                <Checkbox
                  checked={Number(member.application_email_enabled) !== 0}
                  disabled={busyId === member.id}
                  onChange={(event) => mutate('membership.php?action=set_application_email_recipient', { membership_id: member.id, enabled: Boolean(event.target.checked) }, '申请邮件设置已更新')}
                >接收申请邮件</Checkbox>
              </label>
            );
            const memberActions = hasActions ? (
              <ActionCluster className="cm-member-actions">
                {canChangeRole && member.role === 'member' && <Button size="small" onClick={() => mutate('membership.php?action=change_role', { membership_id: member.id, role: 'manager' }, '已升为管理员')}>升为管理</Button>}
                {canChangeRole && member.role === 'manager' && <Button size="small" onClick={() => mutate('membership.php?action=change_role', { membership_id: member.id, role: 'member' }, '已设为成员')}>设为成员</Button>}
                {canTransfer && (
                  <Popconfirm title={`确定将负责人转让给 ${member.username}？`} onConfirm={() => mutate('membership.php?action=transfer', { membership_id: member.id, club_id: selected.clubId }, '负责人已转让')}>
                    <Button size="small" type="primary" icon={<CrownOutlined />}>转让</Button>
                  </Popconfirm>
                )}
                {canKick && (
                  <Popconfirm title={`确定将 ${member.username} 移出同好会？`} onConfirm={() => mutate('membership.php?action=kick', { membership_id: member.id }, '成员已移除')}>
                    <Button size="small" danger icon={<UserDeleteOutlined />}>踢出</Button>
                  </Popconfirm>
                )}
              </ActionCluster>
            ) : null;
            return (
              <ManagementItem
                className="cm-member-item"
                key={member.id}
                identity={(
                  <Identity
                    avatar={<ProfileAvatar value={member.avatar_url} name={member.username} size={34} />}
                    primary={member.username || '未知'}
                  />
                )}
                summary={memberSummary}
                details={memberDetails}
                status={<Chip tone={roleTone}>{applyRoleText(member.role)}</Chip>}
                settings={memberSettings}
                actions={memberActions}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
