import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Col, DatePicker, Descriptions, Divider, Drawer, Empty, Form, Input, InputNumber,
  List, Modal, Popconfirm, Row, Select, Space, Statistic, Tag, Upload, message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, normalizeError } from '../api.js';
import { useClubManager } from '../context.jsx';
import { ErrorState, LoadingState, PageHeading } from '../components.jsx';
import { clubKey, formatDate, mediaUrl } from '../model.js';

/* Label maps mirror the previous club_manager.html wording. */
const projectTypes = { publication: '刊物企划', activity: '活动企划', content: '内容征集', recruit: '协力招募', other: '其他企划' };
const projectStatuses = { draft: '草稿', collecting: '征集中', ongoing: '进行中', completed: '已完成', archived: '已归档' };
const itemTypes = { submission: '投稿', registration: '报名', collaboration: '协力', survey: '问卷', voting: '投票', other: '其他' };
const participantStatuses = { submitted: '待审核', pending: '待审核', reviewing: '审核中', accepted: '已通过', rejected: '已拒绝', withdrawn: '已撤回' };
const PENDING_STATUSES = ['submitted', 'reviewing'];

const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const POSTER_MAX_BYTES = 2 * 1024 * 1024;
const CLUB_REQUIRED = '请先在上方选择一个同好会，再进入企划枢纽。';

const optionize = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));
const dateValue = (value) => value ? dayjs(value) : null;
const dateText = (value) => value?.format?.('YYYY-MM-DD') || null;
const clubIdOf = (club) => Number(club?.club_id ?? club?.id ?? 0);
const clubCountryOf = (club, fallback = 'china') => club?.country ?? club?.club_country ?? fallback;
const organizerIdOf = (project) => clubIdOf(project?.organizer_club) || Number(project?.organizer_club_id || 0);
const organizerCountryOf = (project) => (project?.organizer_club
  ? clubCountryOf(project.organizer_club)
  : (project?.organizer_country || 'china'));

/* Calendar-sync chip text, same rules as the pre-migration page. */
const projectSyncLabel = (project) => {
  if ((project.project_type || '') !== 'activity') return '非活动企划';
  if (!project.event_date && !project.deadline) return '未同步：缺少日期';
  return project.calendar_event_id ? `日历 #${Number(project.calendar_event_id)}` : '等待同步';
};

export default function ProjectsTab() {
  const { selected, managedClubs, refreshVersion } = useClubManager();
  const hasClub = selected.clubId > 0;
  const allClubs = useMemo(() => managedClubs.filter((club) => !club.all && clubIdOf(club) > 0), [managedClubs]);
  const [data, setData] = useState({ projects: [], items: [], participations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [projectEditor, setProjectEditor] = useState(null);
  const [itemEditor, setItemEditor] = useState(null);
  const [reviewNotes, setReviewNotes] = useState({});
  const [saving, setSaving] = useState(false);
  const [projectForm] = Form.useForm();
  const [itemForm] = Form.useForm();

  const selectedKey = clubKey(selected.clubId, selected.country);

  const load = useCallback(async () => {
    if (!hasClub) { setData({ projects: [], items: [], participations: [] }); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const [projects, items, participations] = await Promise.all([
        api.get('projects.php?include_deleted=1'), api.get('project_items.php?include_deleted=1'),
        api.get('project_participations.php?include_withdrawn=1'),
      ]);
      /* The APIs are asked for deleted rows only so an organiser can still see
         history; soft-deleted rows must never render. */
      setData({
        projects: (projects.projects || projects.data || []).filter((project) => !project.deleted_at),
        items: (items.items || items.data || []).filter((item) => !item.deleted_at),
        participations: participations.participations || participations.data || [],
      });
    } catch (err) { setError(normalizeError(err)); } finally { setLoading(false); }
  }, [hasClub, refreshVersion, selected.clubId, selected.country]);
  useEffect(() => { load(); }, [load]);

  const related = useMemo(() => data.projects.filter((project) => {
    if (project.deleted_at) return false;
    const organizerKey = clubKey(organizerIdOf(project), organizerCountryOf(project));
    if (organizerKey === selectedKey) return true;
    return (project.participant_clubs || []).some((club) => clubKey(clubIdOf(club), clubCountryOf(club)) === selectedKey);
  }), [data.projects, selectedKey]);

  const filtered = related.filter((project) => (status === 'all' || project.status === status)
    && (type === 'all' || project.project_type === type)
    && (!query || `${project.title || ''}${project.summary || ''}`.toLowerCase().includes(query.toLowerCase())));
  const selectedProject = related.find((project) => String(project.id) === String(selectedId)) || null;
  const selectedItems = data.items.filter((item) => String(item.project_id) === String(selectedId) && !item.deleted_at);
  const selectedParticipations = data.participations.filter((item) => String(item.project_id) === String(selectedId) && item.status !== 'withdrawn');
  const canManageSelected = Boolean(selectedProject) && Number(organizerIdOf(selectedProject)) === selected.clubId
    && organizerCountryOf(selectedProject) === selected.country;

  const pendingTotal = related.reduce((sum, project) => sum + data.participations.filter((entry) => String(entry.project_id) === String(project.id)
    && PENDING_STATUSES.includes(entry.status || 'submitted')).length, 0);
  const activityTotal = related.filter((project) => project.project_type === 'activity').length;
  const jointTotal = related.filter((project) => (project.participant_clubs || []).length > 0).length;
  const syncWarnTotal = related.filter((project) => project.project_type === 'activity' && !project.calendar_event_id).length;

  /* Joint-participation options deliberately exclude the selected club, which is
     always the organiser of anything created from this tab. */
  const clubOptions = allClubs
    .filter((club) => clubKey(clubIdOf(club), clubCountryOf(club)) !== selectedKey)
    .map((club) => {
      const id = clubIdOf(club);
      const country = clubCountryOf(club);
      const name = club.name || club.school || `同好会 #${id}`;
      return { value: clubKey(id, country), label: `${country === 'japan' ? '日本 · ' : ''}${name}`, club: { id, country, name } };
    });

  const openProject = (project = null) => {
    const participantKeys = (project?.participant_clubs || []).map((club) => clubKey(clubIdOf(club), clubCountryOf(club)));
    projectForm.setFieldsValue(project ? { ...project, participant_clubs: participantKeys, deadline: dateValue(project.deadline), event_date: dateValue(project.event_date), event_date_end: dateValue(project.event_date_end) } : { project_type: 'activity', status: 'draft', participant_clubs: [] });
    setProjectEditor(project || {});
  };
  const saveProject = async () => {
    const values = await projectForm.validateFields(); setSaving(true);
    try {
      const organizer = { id: selected.clubId, country: selected.country };
      const participant_clubs = (values.participant_clubs || []).map((key) => clubOptions.find((item) => item.value === key)?.club).filter(Boolean);
      const payload = {
        ...values, organizer_club: organizer, participant_clubs,
        is_joint: participant_clubs.length > 0,
        deadline: dateText(values.deadline), event_date: dateText(values.event_date), event_date_end: dateText(values.event_date_end),
      };
      if (projectEditor?.id) Object.assign(payload, { id: projectEditor.id, ph_method: 'PUT' });
      await api.post('projects.php', payload); message.success(projectEditor?.id ? '企划已更新' : '企划已创建'); setProjectEditor(null); await load();
    } catch (err) { if (err?.errorFields) return; message.error(normalizeError(err)); } finally { setSaving(false); }
  };
  const removeProject = async (id) => { try { await api.post('projects.php', { ph_method: 'DELETE', id }); message.success('企划已删除'); setSelectedId(null); await load(); } catch (err) { message.error(normalizeError(err)); } };

  const uploadPoster = async ({ file, onSuccess, onError }) => {
    if (!POSTER_TYPES.includes(file.type)) { message.error('仅支持 JPEG / PNG / GIF / WebP 宣传图'); onError?.(new Error('unsupported type')); return; }
    if (file.size > POSTER_MAX_BYTES) { message.error('宣传图不能超过 2MB'); onError?.(new Error('too large')); return; }
    try {
      const form = new FormData();
      form.append('id', `project_${projectEditor?.id || Date.now()}`);
      form.append('country', selected.country);
      form.append('image', file);
      const result = await api.upload('club_avatar.php?scope=event', form);
      const url = result.image_url || result.url;
      projectForm.setFieldValue('cover_image', url);
      message.success('宣传图已上传，保存后同步');
      onSuccess?.(result);
    } catch (err) { onError?.(err); message.error(normalizeError(err)); }
  };

  const openItem = (item = null) => { itemForm.setFieldsValue(item ? { ...item, deadline: dateValue(item.deadline) } : { type: 'submission', status: 'open' }); setItemEditor(item || {}); };
  const saveItem = async () => {
    const values = await itemForm.validateFields(); setSaving(true);
    try {
      const payload = { ...values, project_id: selectedId, deadline: dateText(values.deadline) };
      if (itemEditor?.id) Object.assign(payload, { id: itemEditor.id, ph_method: 'PUT' });
      await api.post('project_items.php', payload); message.success('子项目已保存'); setItemEditor(null); await load();
    } catch (err) { if (!err?.errorFields) message.error(normalizeError(err)); } finally { setSaving(false); }
  };
  const removeItem = async (id) => { try { await api.post('project_items.php', { ph_method: 'DELETE', id }); await load(); } catch (err) { message.error(normalizeError(err)); } };
  const review = async (entry, nextStatus) => {
    try {
      await api.post('project_participations.php', { ph_method: 'PUT', id: Number(entry.id), status: nextStatus, review_note: reviewNotes[entry.id] || '' });
      message.success('审核结果已保存'); setReviewNotes((current) => ({ ...current, [entry.id]: '' })); await load();
    } catch (err) { message.error(normalizeError(err)); }
  };

  if (!hasClub) return <section className="cm-page" data-component="同好会企划枢纽"><PageHeading title="企划枢纽" /><Empty description={CLUB_REQUIRED} /></section>;
  if (loading) return <LoadingState label="正在加载企划枢纽…" />;
  if (error) return <ErrorState description={error} onRetry={load} />;
  return (
    <section className="cm-page" data-component="同好会企划枢纽">
      <PageHeading title="企划枢纽" description="管理同好会企划、子项目、联合社团与参与申请。" action={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openProject()}>新建企划</Button>} />
      <Row gutter={[12, 12]} className="cm-stat-row">
        <Col xs={12} md={6}><Statistic title="关联企划" value={related.length} /></Col>
        <Col xs={12} md={6}><Statistic title="活动企划" value={activityTotal} /></Col>
        <Col xs={12} md={6}><Statistic title="待审核" value={pendingTotal} /></Col>
        <Col xs={12} md={6}><Statistic title="联合企划" value={jointTotal} suffix={syncWarnTotal ? `${syncWarnTotal} 个同步提示` : undefined} /></Col>
      </Row>
      <Card className="cm-toolbar">
        <Space wrap size={8}>
          <Input.Search allowClear size="small" placeholder="搜索企划" onSearch={setQuery} onChange={(event) => setQuery(event.target.value)} />
          <Select size="small" aria-label="按类型筛选" value={type} onChange={setType} options={[{ value: 'all', label: '全部类型' }, ...optionize(projectTypes)]} />
          <Select size="small" aria-label="按状态筛选" value={status} onChange={setStatus} options={[{ value: 'all', label: '全部状态' }, ...optionize(projectStatuses)]} />
        </Space>
      </Card>
      {filtered.length ? <Row gutter={[16, 16]}>{filtered.map((project) => (
        <Col xs={24} md={12} xl={8} key={project.id}>
          <Card hoverable cover={project.cover_image ? <img className="cm-project-cover" src={mediaUrl(project.cover_image)} alt="" /> : null} onClick={() => setSelectedId(project.id)}>
            <Card.Meta title={project.title} description={project.summary || '暂无简介'} />
            <Space className="cm-card-tags" wrap>
              <Tag>{projectTypes[project.project_type] || project.project_type}</Tag>
              <Tag color="red">{projectStatuses[project.status] || project.status}</Tag>
              <Tag color={Number(organizerIdOf(project)) === selected.clubId && organizerCountryOf(project) === selected.country ? 'blue' : 'default'}>
                {Number(organizerIdOf(project)) === selected.clubId && organizerCountryOf(project) === selected.country ? '发起组织' : '联合参加'}
              </Tag>
              <Tag>联合 {(project.participant_clubs || []).length}</Tag>
            </Space>
            <div className="cm-project-sync">{projectSyncLabel(project)}</div>
          </Card>
        </Col>
      ))}</Row> : <Empty description="当前筛选下没有企划" />}
      <Drawer
        title={selectedProject?.title || '企划详情'} width={680} open={Boolean(selectedProject)} onClose={() => setSelectedId(null)}
        extra={canManageSelected && <Space size={6}><Button size="small" icon={<EditOutlined />} onClick={() => openProject(selectedProject)}>编辑</Button><Popconfirm title="确认删除此企划？" onConfirm={() => removeProject(selectedProject.id)}><Button size="small" danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space>}
      >
        {selectedProject && <>
          <Descriptions column={2} items={[
            { key: 'type', label: '类型', children: projectTypes[selectedProject.project_type] || selectedProject.project_type },
            { key: 'status', label: '状态', children: projectStatuses[selectedProject.status] || selectedProject.status },
            { key: 'sync', label: '日历同步', children: projectSyncLabel(selectedProject) },
            { key: 'date', label: '活动日期', children: `${selectedProject.event_date || '未设置'}${selectedProject.event_date_end ? ` 至 ${selectedProject.event_date_end}` : ''}` },
            { key: 'deadline', label: '截止日期', children: selectedProject.deadline || '未设置' },
            { key: 'organizer', label: '发起组织', children: selectedProject.organizer_club?.name || '未绑定同好会' },
          ]} />
          <p>{selectedProject.description || selectedProject.summary || '暂无详细说明'}</p>
          {(selectedProject.results_description || selectedProject.results_link) && <p className="cm-project-results">成果：{selectedProject.results_description || ''} {selectedProject.results_link && <a href={selectedProject.results_link} target="_blank" rel="noopener noreferrer">打开链接</a>}</p>}
          {!canManageSelected && <Tag className="cm-project-chip">联合参加视图</Tag>}
          <Divider orientation="left">子项目</Divider>
          {canManageSelected && <Button icon={<PlusOutlined />} onClick={() => openItem()}>添加子项目</Button>}
          <List dataSource={selectedItems} locale={{ emptyText: '暂无子项目' }} renderItem={(item) => (
            <List.Item actions={canManageSelected ? [<Button type="link" onClick={() => openItem(item)}>编辑</Button>, <Popconfirm title="确认删除？" onConfirm={() => removeItem(item.id)}><Button danger type="link">删除</Button></Popconfirm>] : []}>
              <List.Item.Meta title={item.label} description={`${itemTypes[item.type] || item.type} · ${item.status === 'closed' ? '已关闭' : '开放中'} · ${item.deadline || '无截止日期'}`} />
            </List.Item>
          )} />
          <Divider orientation="left">参与申请</Divider>
          <List dataSource={selectedParticipations} locale={{ emptyText: '暂无参与申请' }} renderItem={(entry) => (
            <List.Item actions={canManageSelected && PENDING_STATUSES.includes(entry.status || 'submitted') ? [
              <Input key="note" aria-label={`审核备注 #${entry.id}`} placeholder="审核备注（可选）" value={reviewNotes[entry.id] || ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value }))} />,
              <Button key="accept" type="link" onClick={() => review(entry, 'accepted')}>通过</Button>,
              <Button key="reject" danger type="link" onClick={() => review(entry, 'rejected')}>拒绝</Button>,
            ] : []}>
              <List.Item.Meta
                title={entry.display_name || entry.username || `申请 #${entry.id}`}
                description={`${participantStatuses[entry.status] || entry.status} · ${entry.participant_type === 'club' ? '同好会参与' : '个人参与'} · ${formatDate(entry.created_at)}${entry.review_note ? ` · 审核备注：${entry.review_note}` : ''}`}
              />
            </List.Item>
          )} />
        </>}
      </Drawer>
      <Modal title={projectEditor?.id ? '编辑企划' : '新建企划'} open={projectEditor !== null} onCancel={() => setProjectEditor(null)} onOk={saveProject} confirmLoading={saving} width={760} destroyOnHidden>
        <Form layout="vertical" form={projectForm}>
          <Row gutter={16}>
            <Col span={16}><Form.Item name="title" label="企划名称" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="project_type" label="类型"><Select options={optionize(projectTypes)} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="status" label="状态"><Select options={optionize(projectStatuses)} /></Form.Item></Col>
            <Col span={8}><Form.Item name="event_date" label="开始日期"><DatePicker /></Form.Item></Col>
            <Col span={8}><Form.Item name="event_date_end" label="结束日期"><DatePicker /></Form.Item></Col>
          </Row>
          <Form.Item name="deadline" label="截止日期"><DatePicker /></Form.Item>
          <Form.Item name="summary" label="摘要"><Input /></Form.Item>
          <Form.Item name="description" label="详细说明"><Input.TextArea rows={4} /></Form.Item>
          <Form.Item name="results_description" label="成果说明"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="results_link" label="成果链接"><Input /></Form.Item>
          <Form.Item name="participant_clubs" label="联合同好会" extra="选择后该企划即为联合企划，发起组织仍为当前同好会。"><Select mode="multiple" options={clubOptions} /></Form.Item>
          <Form.Item name="cover_image" label="海报"><Input addonAfter={<Upload showUploadList={false} customRequest={uploadPoster} accept="image/jpeg,image/png,image/gif,image/webp"><Button type="text" icon={<UploadOutlined />}>上传</Button></Upload>} /></Form.Item>
        </Form>
      </Modal>
      <Modal title={itemEditor?.id ? '编辑子项目' : '添加子项目'} open={itemEditor !== null} onCancel={() => setItemEditor(null)} onOk={saveItem} confirmLoading={saving} destroyOnHidden>
        <Form layout="vertical" form={itemForm}>
          <Form.Item name="label" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="type" label="类型"><Select options={optionize(itemTypes)} /></Form.Item>
          <Form.Item name="status" label="状态"><Input /></Form.Item>
          <Form.Item name="deadline" label="截止日期"><DatePicker /></Form.Item>
          <Form.Item name="max_slots" label="名额"><InputNumber min={0} /></Form.Item>
          <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
