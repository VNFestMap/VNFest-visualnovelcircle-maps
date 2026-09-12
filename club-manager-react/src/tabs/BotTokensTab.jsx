import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Form, Input, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, LinkOutlined, RobotOutlined } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeading, SectionHeading } from '../components.jsx';
import { formatDate, getClubName } from '../model.js';
import { useClubManager } from '../context.jsx';

export default function BotTokensTab() {
  const { selected, directory, messageApi, refreshVersion } = useClubManager();
  const [tokens, setTokens] = useState([]);
  const [newToken, setNewToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(async () => {
    if (selected.clubId <= 0) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await api.get(`bot.php?action=bot_tokens_list&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`);
      setTokens(result.tokens || []);
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [refreshVersion, selected]);
  useEffect(() => { load(); }, [load]);
  const create = async ({ name, approve }) => {
    setSubmitting(true); setNewToken('');
    try {
      const result = await api.post('bot.php?action=bot_tokens_create', {
        club_id: selected.clubId, country: selected.country, name: name?.trim() || 'AstrBot 接入', approve_membership: Boolean(approve),
      });
      setNewToken(result.token || '');
      messageApi.success('Bot token 已创建，请立即复制保存');
      await load();
    } catch (createError) { messageApi.error(normalizeError(createError)); }
    finally { setSubmitting(false); }
  };
  const revoke = async (id) => {
    try { await api.post('bot.php?action=bot_tokens_revoke', { token_id: id }); messageApi.success('Bot token 已吊销'); await load(); }
    catch (revokeError) { messageApi.error(normalizeError(revokeError)); }
  };
  const copy = async (value) => {
    try { await navigator.clipboard.writeText(value); messageApi.success('已复制'); }
    catch { messageApi.error('复制失败，请手动复制'); }
  };
  if (selected.clubId <= 0) return <section className="cm-page"><PageHeading title="Bot 接入" /><EmptyPanel description="请先在左侧选择一个同好会" /></section>;
  return (
    <section className="cm-page" data-component="同好会 Bot 接入">
      <PageHeading title="Bot 接入" description={`管理「${getClubName(directory, selected.clubId, selected.country)}」的 AstrBot 接入凭证。`} />
      <Card className="cm-panel" title={<SectionHeading title="GalgameMap 插件（beta0.6）" />}>
        <Space wrap size={8}>
          <Button size="small" type="primary" icon={<DownloadOutlined />} href="../downloads/astrbot_plugin_galgamemap_beta0.6.zip">下载插件压缩包</Button>
          <Button size="small" icon={<LinkOutlined />} href="../wiki/guide/#/astrbot/install-and-sync" target="_blank">查看详细使用说明</Button>
        </Space>
      </Card>
      <Card className="cm-panel" title={<SectionHeading title="创建 Bot 接入 token" />}>
        <Form layout="vertical" initialValues={{ name: 'AstrBot 接入', approve: false }} onFinish={create}>
          <div className="cm-form-grid compact">
            <Form.Item label="名称" name="name"><Input maxLength={80} /></Form.Item>
            <Form.Item name="approve" valuePropName="checked"><Checkbox>允许插件审批本同好会申请</Checkbox></Form.Item>
          </div>
          <Button size="small" type="primary" htmlType="submit" icon={<RobotOutlined />} loading={submitting}>创建 token</Button>
        </Form>
        {newToken && <Alert className="cm-token-alert" type="warning" showIcon message="明文 token 仅显示一次" description={<Space wrap size={6}><Typography.Text code>{newToken}</Typography.Text><Button size="small" icon={<CopyOutlined />} onClick={() => copy(newToken)}>复制</Button></Space>} />}
      </Card>
      <Card className="cm-panel" title={<SectionHeading title={`已创建 Bot token（${tokens.length}）`} />}>
        {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} onRetry={load} /> : !tokens.length ? <EmptyPanel description="暂无 Bot token" /> : <Table rowKey="id" pagination={false} scroll={{ x: 680 }} dataSource={tokens} columns={[
          { title: '名称', render: (_, row) => <><strong>{row.name || 'AstrBot 接入'}</strong><br /><Typography.Text type="secondary">{row.token_prefix || ''}…</Typography.Text></> },
          { title: '权限', render: (_, row) => (row.permissions || []).includes('approve_membership') ? '可审批' : '只读' },
          { title: '最近使用', dataIndex: 'last_used_at', render: (value) => value ? formatDate(value) : '—' },
          { title: '状态', render: (_, row) => <Tag color={row.active && !row.revoked_at ? 'success' : 'default'}>{row.active && !row.revoked_at ? '启用' : '已吊销'}</Tag> },
          { title: '操作', render: (_, row) => row.active && !row.revoked_at ? <Popconfirm title="确定吊销此 Bot token？" onConfirm={() => revoke(row.id)}><Button size="small" danger>吊销</Button></Popconfirm> : '—' },
        ]} />}
      </Card>
    </section>
  );
}
