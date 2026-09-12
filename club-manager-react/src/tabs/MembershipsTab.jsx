import React, { useEffect, useMemo, useState } from 'react';
import { Button, Pagination, Popconfirm } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import {
  ActionCluster, DisclosureText, EmptyPanel, Identity, ManagementItem, MetaItem, MetaLine, ProfileAvatar,
  PageHeading, StatusChip, Timestamp,
} from '../components.jsx';
import { applyRoleText, getClubName } from '../model.js';
import { useClubManager } from '../context.jsx';

const descriptions = {
  pending: '审核本校成员提交的加入申请。',
  diplomatic: '处理外校同好会成员的交流申请。',
  approved: '查看已经通过审核的申请记录。',
};

const joinMethodText = (method) => (method === 'external_exchange'
  ? '外校成员交流申请'
  : method === 'school_code' ? '本校成员申请（有绑定码）' : '本校成员申请加入（未有绑定码）');

/* 历史记录可能跨越多个年份；分页只限制一次进入 DOM 的记录数，不改变
   接口返回的数据和排序，避免切换「已通过」时一次性创建成千上万行。 */
const APPROVED_PAGE_SIZE = 100;

export default function MembershipsTab({ mode }) {
  const { directory, scopedMemberships, reloadMemberships, messageApi } = useClubManager();
  const [busyId, setBusyId] = useState(null);
  const [approvedPage, setApprovedPage] = useState(1);
  const rows = useMemo(() => scopedMemberships.filter((item) => {
    const pending = (item.status || 'pending') === 'pending';
    const diplomatic = (item.join_method || '') === 'external_exchange';
    if (mode === 'pending') return pending && !diplomatic;
    if (mode === 'diplomatic') return pending && diplomatic;
    return item.status === 'active' || item.status === 'approved';
  }).slice().sort((a, b) => String(b.joined_at || '').localeCompare(String(a.joined_at || ''))), [mode, scopedMemberships]);

  const approvedPageCount = Math.max(1, Math.ceil(rows.length / APPROVED_PAGE_SIZE));
  const currentApprovedPage = Math.min(approvedPage, approvedPageCount);
  const visibleRows = mode === 'approved'
    ? rows.slice((currentApprovedPage - 1) * APPROVED_PAGE_SIZE, currentApprovedPage * APPROVED_PAGE_SIZE)
    : rows;

  useEffect(() => {
    setApprovedPage((current) => Math.min(current, approvedPageCount));
  }, [approvedPageCount, mode]);

  const act = async (action, item) => {
    setBusyId(item.id);
    try {
      await api.post(`membership.php?action=${action}`, { membership_id: item.id });
      messageApi.success(action === 'approve' ? '申请已通过' : '申请已拒绝');
      await reloadMemberships();
    } catch (error) {
      messageApi.error(normalizeError(error));
    } finally {
      setBusyId(null);
    }
  };

  const label = mode === 'pending' ? '待审核' : mode === 'diplomatic' ? '外交申请' : '已通过';
  return (
    <section className="cm-page" data-component={`同好会管理-${mode}`}>
      <PageHeading title={label} description={descriptions[mode]} />
      {!rows.length ? <EmptyPanel /> : <>
        <div
          className={`cm-management-list cm-membership-list is-${mode}`}
          data-total-records={rows.length}
          data-page-size={mode === 'approved' ? APPROVED_PAGE_SIZE : undefined}
        >
        {visibleRows.map((item) => {
          const isExternal = (item.join_method || '') === 'external_exchange';
          const contact = item.contact_account || item.qq_account || '未填写';
          const clubName = getClubName(directory, item.club_id, item.country);
          const status = <StatusChip status={item.status} />;
          const actions = mode !== 'approved' ? (
            <ActionCluster className="cm-review-actions">
              <Button
                size="small" type="primary" icon={<CheckOutlined />}
                loading={busyId === item.id} onClick={() => act('approve', item)}
              >通过</Button>
              <Popconfirm title="确定拒绝该申请？" onConfirm={() => act('reject', item)}>
                <Button size="small" danger icon={<CloseOutlined />} disabled={busyId === item.id}>拒绝</Button>
              </Popconfirm>
            </ActionCluster>
          ) : null;

          const summary = isExternal ? (
            <div className="cm-item-content-stack">
              <div className="cm-item-lead">
                <strong>{item.external_club_name || '未填写对方同好会'}</strong>
                <span className="cm-item-lead-note">外校交流</span>
              </div>
              <MetaLine>
                <MetaItem label="外校身份" value={item.external_club_role || '未填写'} />
                <MetaItem label="联系方式" value={contact} />
                <MetaItem label="申请时间" value={<Timestamp value={item.joined_at} />} />
              </MetaLine>
            </div>
          ) : (
            <div className="cm-item-content-stack">
              <MetaLine className="cm-membership-meta-primary">
                <MetaItem label="申请方式" value={joinMethodText(item.join_method)} />
                <MetaItem label="申请身份" value={applyRoleText(item.apply_role)} />
              </MetaLine>
              <MetaLine>
                <MetaItem label="联系方式" value={contact} />
                <MetaItem label="申请时间" value={<Timestamp value={item.joined_at} />} />
              </MetaLine>
            </div>
          );
          const details = isExternal ? <DisclosureText value={item.apply_reason} /> : null;

          return (
            <ManagementItem
              className={`cm-membership-item cm-membership-item-${mode}`}
              key={item.id}
              identity={(
                <Identity
                  avatar={<ProfileAvatar value={item.avatar_url} name={item.username} size={38} alt="" />}
                  primary={item.username || '未知用户'}
                  secondary={clubName}
                />
              )}
              status={status}
              context={<span className="cm-item-context-note">{mode === 'approved' ? '历史记录' : '待处理'}</span>}
              summary={summary}
              details={details}
              actions={actions}
            />
          );
        })}
        </div>
        {mode === 'approved' && rows.length > APPROVED_PAGE_SIZE && (
          <div className="cm-membership-pagination" aria-label="已通过记录分页">
            <Pagination
              current={currentApprovedPage}
              pageSize={APPROVED_PAGE_SIZE}
              total={rows.length}
              showLessItems
              showSizeChanger={false}
              showTotal={(total, range) => `第 ${range[0]}-${range[1]} 条，共 ${total} 条`}
              onChange={setApprovedPage}
            />
          </div>
        )}
      </>}
    </section>
  );
}
