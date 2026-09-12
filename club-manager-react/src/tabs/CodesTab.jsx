import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DatePicker, Form, InputNumber, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, KeyOutlined } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeading, SectionHeading } from '../components.jsx';
import { formatDate } from '../model.js';
import { useClubManager } from '../context.jsx';

export default function CodesTab() {
  const { selected, messageApi, refreshVersion } = useClubManager();
  const [form] = Form.useForm();
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(async () => {
    if (selected.clubId <= 0) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await api.get(`club_codes.php?action=list&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`);
      setCodes(result.codes || []);
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [refreshVersion, selected]);
  useEffect(() => { load(); }, [load]);

  const copy = async (value) => {
    try { await navigator.clipboard.writeText(value); messageApi.success(`已复制：${value}`); }
    catch { messageApi.error('复制失败，请手动复制'); }
  };
  const generate = async ({ maxUses, expiresAt }) => {
    setSubmitting(true);
    try {
      const result = await api.post('club_codes.php?action=generate', {
        club_id: selected.clubId, country: selected.country, max_uses: maxUses,
        expires_at: expiresAt ? `${expiresAt.format('YYYY-MM-DD HH:mm')}:00` : null,
      });
      messageApi.success(`绑定码已生成：${result.code?.code || ''}`);
      await load();
    } catch (submitError) { messageApi.error(normalizeError(submitError)); }
    finally { setSubmitting(false); }
  };
  const revoke = async (id) => {
    try { await api.post('club_codes.php?action=revoke', { code_id: id }); messageApi.success('绑定码已禁用'); await load(); }
    catch (revokeError) { messageApi.error(normalizeError(revokeError)); }
  };

  if (selected.clubId <= 0) return <section className="cm-page"><PageHeading title="绑定码" /><EmptyPanel description="请先在左侧选择一个同好会" /></section>;
  return (
    <section className="cm-page" data-component="同好会绑定码">
      <PageHeading title="绑定码" description="生成后分享给成员，输入绑定码即可直接加入同好会。" />
      <Card className="cm-panel" title={<SectionHeading title="生成新绑定码" />}>
        <Form form={form} layout="inline" initialValues={{ maxUses: 50 }} onFinish={generate}>
          <Form.Item label="使用次数上限" name="maxUses" rules={[{ required: true }]}><InputNumber min={1} max={999} /></Form.Item>
          <Form.Item label="过期时间" name="expiresAt"><DatePicker showTime format="YYYY-MM-DD HH:mm" /></Form.Item>
          <Form.Item><Button size="small" type="primary" htmlType="submit" icon={<KeyOutlined />} loading={submitting}>生成绑定码</Button></Form.Item>
        </Form>
      </Card>
      <Card className="cm-panel" title={<SectionHeading title={`已生成绑定码（${codes.length}）`} />}>
        {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} onRetry={load} /> : !codes.length ? <EmptyPanel description="暂无绑定码" /> : (
          <Table rowKey="id" pagination={false} scroll={{ x: 640 }} dataSource={codes} columns={[
            { title: '绑定码', dataIndex: 'code', render: (value) => <Typography.Text code copyable>{value}</Typography.Text> },
            { title: '使用', render: (_, row) => `${row.use_count} / ${row.max_uses}` },
            { title: '过期时间', dataIndex: 'expires_at', render: (value) => value ? formatDate(value) : '—' },
            { title: '状态', render: (_, row) => <Tag color={row.is_active && !row.is_expired && !row.is_full ? 'success' : 'default'}>{!row.is_active ? '已禁用' : row.is_expired ? '已过期' : row.is_full ? '已满' : '启用'}</Tag> },
            { title: '操作', render: (_, row) => <Space size={6}><Button size="small" icon={<CopyOutlined />} onClick={() => copy(row.code)}>复制</Button>{row.is_active && !row.is_expired && !row.is_full && <Popconfirm title="确定禁用此绑定码？" onConfirm={() => revoke(row.id)}><Button size="small" danger>禁用</Button></Popconfirm>}</Space> },
          ]} />
        )}
      </Card>
    </section>
  );
}
