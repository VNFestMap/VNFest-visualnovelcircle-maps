import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar, Button, Card, Checkbox, DatePicker, Form, Input, Popconfirm, Radio,
  Select, Space, Typography, Upload,
} from 'antd';
import { DeleteOutlined, EyeOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, normalizeError, request } from '../api.js';
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeading, SectionHeading } from '../components.jsx';
import { getClubName, mediaUrl } from '../model.js';
import { useClubManager } from '../context.jsx';

const CHINA_PROVINCES = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆','香港','澳门','台湾'];
const JIANGSU_CITIES = ['南京','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁'];
const JAPAN_PREFECTURES = ['北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川','新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄'];
const PLATFORMS = ['B站','Twitter','Bangumi','微博','Discord','QQ','微信','GitHub','知乎','小红书','豆瓣','贴吧','Niconico','YouTube','Pixiv','Lofter','Fanbox','Patreon','Fantia','官网','其他'];

function parseLinks(value) {
  const rows = String(value || '').split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(': ');
    return separator > 0 ? { platform: line.slice(0, separator), url: line.slice(separator + 2) } : { platform: '', url: line };
  });
  while (rows.length < 3) rows.push({ platform: '', url: '' });
  return rows.slice(0, 3);
}

export default function SettingsTab() {
  const { selected, directory, messageApi, refreshVersion } = useClubManager();
  const [form] = Form.useForm();
  const [club, setClub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const provinces = Form.useWatch('provinces', form) || [];
  const endpoint = selected.country === 'japan' ? 'clubs_japan.php' : 'clubs.php';

  const load = useCallback(async () => {
    if (selected.clubId <= 0) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await api.get(`${endpoint}?t=${Date.now()}`);
      const value = (result.data || result.clubs || []).find((item) => Number(item.id) === selected.clubId);
      if (!value) throw new Error('未找到所选同好会');
      setClub(value);
      setLogoUrl(value.logo_url || '');
      const normalizedProvinces = Array.isArray(value.provinces) ? value.provinces : value.provinces ? String(value.provinces).split(/[、,，]/) : value.province ? [value.province] : [];
      form.setFieldsValue({
        name: value.name || getClubName(directory, selected.clubId, selected.country), type: value.type || 'school',
        school: value.school || '', created_at: value.created_at ? dayjs(String(value.created_at).slice(0, 10)) : null,
        info: value.info || '', remark: value.remark || '', provinces: normalizedProvinces.map((item) => String(item).replace(/省$/, '')),
        city: value.city || '', prefecture: value.prefecture || '', links: parseLinks(value.external_links),
        privacy: value.visible_by_default ? 'public' : value.protected ? 'protected' : 'members',
      });
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [directory, endpoint, form, refreshVersion, selected]);
  useEffect(() => { load(); }, [load]);

  const uploadAvatar = async (file) => {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) return messageApi.error('仅支持 JPEG/PNG/GIF/WebP');
    if (file.size > 2 * 1024 * 1024) return messageApi.error('图片不能超过 2MB');
    const body = new FormData(); body.append('id', String(selected.clubId)); body.append('country', selected.country); body.append('image', file);
    try { const result = await api.upload('club_avatar.php?scope=club', body); setLogoUrl(result.image_url || ''); messageApi.success('头像已上传，保存后生效'); }
    catch (uploadError) { messageApi.error(normalizeError(uploadError)); }
    return false;
  };

  const save = async (values) => {
    setSaving(true);
    try {
      const links = (values.links || []).filter((item) => item?.platform && item?.url).map((item) => `${item.platform}: ${String(item.url).trim().replace(/\/+$/, '')}`).join('\n');
      const payload = {
        id: selected.clubId, name: values.name.trim(), type: values.type, school: values.school?.trim() || '',
        created_at: values.created_at?.format('YYYY-MM-DD') || '', info: values.info.trim(), remark: values.remark?.trim() || '',
        logo_url: logoUrl, external_links: links, country: selected.country,
        visible_by_default: values.privacy === 'public', protected: values.privacy === 'protected',
      };
      if (selected.country === 'japan') payload.prefecture = values.prefecture || '';
      else {
        payload.provinces = values.provinces || [];
        payload.province = payload.provinces[0] || '';
        payload.city = payload.provinces.includes('江苏') ? values.city || '' : '';
      }
      await request(endpoint, { method: 'PUT', body: JSON.stringify(payload) });
      messageApi.success('同好会资料已更新'); await load();
    } catch (saveError) { messageApi.error(normalizeError(saveError)); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    try { await request(endpoint, { method: 'DELETE', body: JSON.stringify({ id: selected.clubId }) }); messageApi.success('同好会已删除'); setClub(null); }
    catch (removeError) { messageApi.error(normalizeError(removeError)); }
  };

  if (selected.clubId <= 0) return <section className="cm-page"><PageHeading title="设置" /><EmptyPanel description="请先在左侧选择一个同好会" /></section>;
  return (
    <section className="cm-page" data-component="同好会设置">
      <PageHeading title="设置" description="维护地图上展示的组织资料、联系方式和可见范围。" />
      {loading ? <LoadingPanel rows={8} /> : error ? <ErrorPanel message={error} onRetry={load} /> : !club ? <EmptyPanel description="同好会已删除或不存在" /> : (
        <Form form={form} layout="vertical" onFinish={save}>
          <Card className="cm-panel" title={<SectionHeading title="同好会头像" />}>
            <Space align="center" wrap size={10}>
              <Avatar className="cm-club-avatar" shape="square" size={64} src={mediaUrl(logoUrl)}>{String(form.getFieldValue('name') || '?')[0]}</Avatar>
              <Upload accept="image/jpeg,image/png,image/gif,image/webp" showUploadList={false} beforeUpload={uploadAvatar}><Button size="small" icon={<UploadOutlined />}>上传头像</Button></Upload>
              {logoUrl && <Button size="small" onClick={() => setLogoUrl('')}>移除</Button>}
            </Space>
          </Card>
          <Card className="cm-panel" title={<SectionHeading title="基本信息" />}>
            <div className="cm-form-grid">
              <Form.Item label="国家/地区"><Input disabled value={selected.country === 'japan' ? '日本' : '中国'} /></Form.Item>
              <Form.Item label="组织名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写组织名称' }]}><Input maxLength={80} /></Form.Item>
              <Form.Item label="类型" name="type"><Select options={[{ value: 'school', label: '高校同好会' }, { value: 'region', label: '地区高校联合' }, { value: 'vnfest', label: '视觉小说学园祭' }]} /></Form.Item>
              {selected.country === 'japan' ? <Form.Item label="都道府县" name="prefecture"><Select allowClear showSearch options={JAPAN_PREFECTURES.map((value) => ({ value, label: value }))} /></Form.Item> : <Form.Item label="省份" name="provinces"><Select mode="multiple" allowClear showSearch options={CHINA_PROVINCES.map((value) => ({ value, label: value }))} /></Form.Item>}
              {selected.country !== 'japan' && provinces.includes('江苏') && <Form.Item label="城市（江苏）" name="city"><Select allowClear options={JIANGSU_CITIES.map((value) => ({ value, label: value }))} /></Form.Item>}
              <Form.Item label="学校/组织" name="school"><Input maxLength={100} /></Form.Item>
              <Form.Item label="成立时间" name="created_at"><DatePicker /></Form.Item>
            </div>
          </Card>
          <Card className="cm-panel" title={<SectionHeading title="对外平台" />}>
            <Form.List name="links">{(fields) => <div className="cm-link-list">{fields.map(({ key, name }) => <Space className="cm-link-row" key={key} align="start"><Form.Item name={[name, 'platform']}><Select placeholder="选择平台" options={PLATFORMS.map((value) => ({ value, label: value }))} /></Form.Item><Form.Item name={[name, 'url']}><Input placeholder="链接 URL（https://…）" /></Form.Item></Space>)}</div>}</Form.List>
          </Card>
          <Card className="cm-panel" title={<SectionHeading title="联系信息" />}>
            <Form.Item label="联系方式" name="info" rules={[{ required: true, whitespace: true, message: '请填写联系方式' }]}><Input maxLength={200} /></Form.Item>
            <Form.Item label="详细介绍" name="remark"><Input.TextArea rows={4} /></Form.Item>
          </Card>
          <Card className="cm-panel" title={<SectionHeading title="可见范围" />}>
            <Form.Item name="privacy"><Radio.Group className="cm-privacy-group"><Radio value="public">公开显示联系方式</Radio><Radio value="members">成员以上级别可见</Radio><Radio value="protected">仅本同好会成员可见</Radio></Radio.Group></Form.Item>
          </Card>
          <div className="cm-sticky-actions">
            <Button size="small" type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>保存</Button>
            <Button size="small" onClick={load}>取消</Button>
            <Button size="small" icon={<EyeOutlined />} href="../index.html" target="_blank">在地图中查看</Button>
            <Popconfirm title="确定删除此同好会？" description="此操作不可撤销。" onConfirm={remove}><Button size="small" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>
          </div>
        </Form>
      )}
    </section>
  );
}
