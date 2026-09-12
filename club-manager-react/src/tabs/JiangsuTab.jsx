import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Select, Table, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { api, normalizeError, request } from '../api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeading } from '../components.jsx';
import { useClubManager } from '../context.jsx';

const CITIES = ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁'];

export default function JiangsuTab() {
  const { messageApi, refreshVersion } = useClubManager();
  const [clubs, setClubs] = useState([]);
  const [cities, setCities] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api.get(`clubs.php?t=${Date.now()}`);
      const rows = (result.data || []).filter((club) => {
        const provinces = Array.isArray(club.provinces) && club.provinces.length ? club.provinces : club.province ? [club.province] : [];
        return provinces.some((value) => String(value).includes('江苏'));
      });
      setClubs(rows); setCities(Object.fromEntries(rows.map((club) => [club.id, CITIES.includes(String(club.city || '').replace(/市$/, '')) ? String(club.city).replace(/市$/, '') : ''])));
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [refreshVersion]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    setSaving(true); let passed = 0; let failed = 0;
    for (const club of clubs) {
      try { await request('clubs.php', { method: 'PUT', body: JSON.stringify({ id: Number(club.id), country: 'china', city: cities[club.id] || '', operation: 'jiangsu_city_bulk' }) }); passed += 1; }
      catch { failed += 1; }
    }
    if (failed) messageApi.error(`已保存 ${passed} 个，失败 ${failed} 个`);
    else messageApi.success(`已保存全部 ${passed} 个同好会`);
    setSaving(false); await load();
  };
  return (
    <section className="cm-page" data-component="江苏同好会专项设置">
      <PageHeading title="江苏专项" description="为江苏同好会指定所属地级市；留空时地图端继续按学校名自动匹配。" extra={<Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} disabled={!clubs.length} onClick={save}>保存全部</Button>} />
      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} onRetry={load} /> : !clubs.length ? <EmptyPanel description="暂无江苏同好会数据" /> : (
        <Card className="cm-panel"><Table rowKey="id" pagination={false} scroll={{ x: 640 }} dataSource={clubs} columns={[
          { title: 'ID', dataIndex: 'id', render: (value) => `#${value}` },
          { title: '组织', render: (_, row) => <Typography.Text strong>{row.name || row.school || '未命名'}</Typography.Text> },
          { title: '学校/组织', dataIndex: 'school', render: (value) => value || '—' },
          { title: '城市', render: (_, row) => <Select aria-label={`${row.name || row.school}所属城市`} value={cities[row.id] || ''} onChange={(value) => setCities((current) => ({ ...current, [row.id]: value }))} options={[{ value: '', label: '未设置（自动匹配）' }, ...CITIES.map((value) => ({ value, label: value }))]} /> },
        ]} /></Card>
      )}
    </section>
  );
}
