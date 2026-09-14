import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Form, Input, Modal, Pagination, Popconfirm, Select, Space, Tag } from 'antd';
import { EditOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import {
  ActionCluster, Chip, EmptyPanel, ErrorPanel, Identity, LoadingPanel, PageHeading, ProfileAvatar,
} from '../components.jsx';
import { applyRoleText, getClubName, getPermissionRole, permissionLevelMeta } from '../model.js';
import { useClubManager } from '../context.jsx';

const PAGE_SIZE = 20;

const statusLabel = (status) => (status === 'active' ? '正常' : status === 'disabled' ? '已禁用' : '已封禁');

function UserStatus({ status }) {
  const tone = status === 'active' ? 'success' : status === 'disabled' ? 'warning' : 'danger';
  return <Chip tone={tone}>{statusLabel(status)}</Chip>;
}

function PermissionLevel({ role }) {
  const meta = permissionLevelMeta(role);
  return (
    <span
      className={`cm-chip cm-permission-level cm-permission-level--${meta.key}`}
      title={`权限等级：${meta.label}`}
      aria-label={`权限等级：${meta.label}`}
    >
      <span className="cm-permission-level-mark" aria-hidden="true">{meta.mark}</span>
      {meta.label}
    </span>
  );
}

function MembershipSummary({ memberships, directory }) {
  if (!memberships.length) return <span className="cm-user-muted">未绑定同好会</span>;
  const visible = memberships.slice(0, 2);
  return (
    <div className="cm-user-memberships">
      {visible.map((membership) => (
        <span className="cm-user-membership" key={membership.id} title={`${getClubName(directory, membership.club_id, membership.country)} · ${applyRoleText(membership.role)}`}>
          <span className="cm-user-membership-name">{getClubName(directory, membership.club_id, membership.country)}</span>
          <span className="cm-user-membership-role">· {applyRoleText(membership.role)}</span>
        </span>
      ))}
      {memberships.length > visible.length && <span className="cm-chip cm-chip-more">+{memberships.length - visible.length}</span>}
    </div>
  );
}

export default function UsersTab() {
  const { auth, directory, messageApi, refreshVersion } = useClubManager();
  const [queryDraft, setQueryDraft] = useState('');
  const [filters, setFilters] = useState({ search: '', role: '', status: '', page: 1 });
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const params = new URLSearchParams({ action: 'list', page: String(filters.page), per_page: String(PAGE_SIZE) });
    if (filters.search) params.set('search', filters.search);
    if (filters.role) params.set('role', filters.role);
    if (filters.status) params.set('status', filters.status);
    try {
      const result = await api.get(`users.php?${params}`);
      setUsers(result.users || []);
      setTotal(Number(result.total ?? result.pagination?.total ?? 0));
    }
    catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [filters, refreshVersion]);
  useEffect(() => { load(); }, [load]);

  const openEditor = async (id) => {
    try {
      const result = await api.get(`users.php?action=get&id=${id}`);
      const user = result.user;
      setEditing(user); setEditorOpen(true);
      form.setFieldsValue({ nickname: user.nickname || '', role: user.role === 'super_admin' ? 'super_admin' : 'visitor', status: user.status || 'active' });
    } catch (editError) { messageApi.error(normalizeError(editError)); }
  };
  const save = async (values) => {
    try {
      const payload = { id: editing.id, status: values.status };
      if (values.nickname.trim()) payload.nickname = values.nickname.trim();
      const originalRole = editing.role === 'super_admin' ? 'super_admin' : 'visitor';
      if (values.role !== originalRole) payload.role = values.role;
      await api.post('users.php?action=update', payload);
      messageApi.success('用户信息已更新'); setEditorOpen(false); await load();
    } catch (saveError) { messageApi.error(normalizeError(saveError)); }
  };
  const ban = async (id) => {
    try { await api.post('users.php?action=delete', { id }); messageApi.success('用户已封禁'); await load(); }
    catch (banError) { messageApi.error(normalizeError(banError)); }
  };
  const membershipAction = async (path, body, success) => {
    try { await api.post(path, body); messageApi.success(success); await openEditor(editing.id); await load(); }
    catch (mutationError) { messageApi.error(normalizeError(mutationError)); }
  };

  return (
    <section className="cm-page" data-component="全站用户管理">
      <PageHeading title="用户管理" description="超级管理员可维护账号状态和同好会成员关系。" />
      <Card className="cm-toolbar">
        <Space wrap className="cm-filterbar" size={8}>
          <Input size="small" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} onPressEnter={() => setFilters((value) => ({ ...value, search: queryDraft, page: 1 }))} prefix={<SearchOutlined />} placeholder="搜索用户名、昵称、邮箱" allowClear style={{ width: 220 }} />
          <Select size="small" value={filters.role} onChange={(role) => setFilters((value) => ({ ...value, role, page: 1 }))} options={[{ value: '', label: '所有权限等级' }, { value: 'visitor', label: '访客' }, { value: 'member', label: '成员' }, { value: 'manager', label: '管理员' }, { value: 'representative', label: '负责人' }, { value: 'super_admin', label: '超级管理员' }, { value: 'external', label: '活动人员' }]} />
          <Select size="small" value={filters.status} onChange={(status) => setFilters((value) => ({ ...value, status, page: 1 }))} options={[{ value: '', label: '所有状态' }, { value: 'active', label: '正常' }, { value: 'disabled', label: '禁用' }, { value: 'banned', label: '封禁' }]} />
          <Button size="small" type="primary" onClick={() => setFilters((value) => ({ ...value, search: queryDraft, page: 1 }))}>搜索</Button>
          <Button size="small" onClick={() => { setQueryDraft(''); setFilters({ search: '', role: '', status: '', page: 1 }); }}>清除筛选</Button>
        </Space>
      </Card>
      {loading ? <LoadingPanel variant="table" rows={4} /> : error ? <ErrorPanel message={error} onRetry={load} /> : !users.length ? (
        <EmptyPanel
          description={filters.search || filters.role || filters.status ? '当前筛选条件无结果' : '暂无用户'}
          action={(filters.search || filters.role || filters.status) && (
            <Button size="small" onClick={() => { setQueryDraft(''); setFilters({ search: '', role: '', status: '', page: 1 }); }}>
              清除筛选
            </Button>
          )}
        />
      ) : (
        <div className="cm-user-list-shell">
          <div className="cm-user-table-wrap">
            <table className="cm-user-table">
              <caption className="cm-sr-only">全站用户管理列表</caption>
              <thead>
                <tr>
                  <th scope="col">用户</th>
                  <th scope="col">账号信息</th>
                  <th scope="col">权限等级</th>
                  <th scope="col">同好会关系</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="cm-user-table-actions-heading">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const displayRole = user.display_role || getPermissionRole(user);
                  const memberships = user.memberships || [];
                  return (
                    <tr className="cm-user-table-row" key={user.id}>
                      <td data-label="用户" className="cm-user-cell-primary">
                        <Identity
                          avatar={<ProfileAvatar value={user.avatar_url} name={user.username} size={34} />}
                          primary={user.username}
                          secondary={`#${user.id}`}
                        />
                      </td>
                      <td data-label="账号信息">
                        <div className="cm-user-account">
                          <span>{user.nickname || '未填写昵称'}</span>
                          <span className="cm-user-muted" title={user.email || '未填写邮箱'}>{user.email || '未填写邮箱'}</span>
                        </div>
                      </td>
                      <td data-label="权限等级"><PermissionLevel role={displayRole} /></td>
                      <td data-label="同好会关系"><MembershipSummary memberships={memberships} directory={directory} /></td>
                      <td data-label="状态"><UserStatus status={user.status} /></td>
                      <td data-label="操作" className="cm-user-table-actions">
                        <ActionCluster>
                          <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(user.id)}>编辑</Button>
                          {user.status !== 'banned' && (
                            <Popconfirm title={`确定封禁用户「${user.username}」？`} onConfirm={() => ban(user.id)}>
                              <Button size="small" danger icon={<StopOutlined />}>封禁</Button>
                            </Popconfirm>
                          )}
                        </ActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination size="small" current={filters.page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} showTotal={(value) => `共 ${value} 人`} onChange={(page) => setFilters((value) => ({ ...value, page }))} />
        </div>
      )}
      <Modal title="编辑用户" open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={() => form.submit()} destroyOnClose>
        {editing && <>
          <Form form={form} layout="vertical" onFinish={save} preserve={false}>
            <Form.Item label="用户名"><Input value={editing.username} disabled /></Form.Item>
            <Form.Item label="邮箱"><Input value={editing.email || ''} disabled /></Form.Item>
            <Form.Item name="nickname" label="昵称"><Input /></Form.Item>
            <Form.Item name="role" label="权限等级" extra="管理员、负责人、活动人员由有效同好会关系自动计算。"><Select disabled={Number(editing.id) === Number(auth.user.id)} options={[{ value: 'visitor', label: '访客' }, { value: 'super_admin', label: '超级管理员' }]} /></Form.Item>
            <Form.Item name="status" label="账号状态"><Select disabled={Number(editing.id) === Number(auth.user.id)} options={[{ value: 'active', label: '正常' }, { value: 'disabled', label: '已禁用' }, { value: 'banned', label: '已封禁' }]} /></Form.Item>
          </Form>
          {(editing.memberships || []).map((membership) => (
            <Card
              size="small" className="cm-membership-editor" key={membership.id}
              title={`${getClubName(directory, membership.club_id, membership.country)} · ${membership.country === 'japan' ? '日本' : '中国'}`}
              extra={<Tag>{membership.status === 'active' ? '正常' : membership.status}</Tag>}
            >
              {membership.status === 'active' && (
                <Space wrap size={8}>
                  <Select
                    size="small" defaultValue={membership.role} aria-label="成员角色"
                    onChange={(role) => setEditing((current) => ({ ...current, memberships: current.memberships.map((item) => item.id === membership.id ? { ...item, draftRole: role } : item) }))}
                    options={[{ value: 'member', label: '成员' }, { value: 'manager', label: '管理员' }, { value: 'representative', label: '负责人' }]}
                  />
                  <Popconfirm title="确定更新该成员角色？" onConfirm={() => membershipAction('membership.php?action=change_role', { membership_id: membership.id, role: membership.draftRole || membership.role }, '角色已更新')}>
                    <Button size="small">更新</Button>
                  </Popconfirm>
                  <Popconfirm title="确定将用户移出该同好会？" onConfirm={() => membershipAction('membership.php?action=kick', { membership_id: membership.id }, '已移出同好会')}>
                    <Button size="small" danger>踢出</Button>
                  </Popconfirm>
                </Space>
              )}
            </Card>
          ))}
        </>}
      </Modal>
    </section>
  );
}
