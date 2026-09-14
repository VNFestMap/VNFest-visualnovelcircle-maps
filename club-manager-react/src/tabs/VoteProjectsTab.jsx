import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Descriptions, Divider, Empty, Input, InputNumber,
  List, Modal, Row, Select, Space, Spin, Statistic, Switch, Tabs, Tag, Typography, message,
} from 'antd';
import {
  CheckCircleOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined,
  ReloadOutlined, ShareAltOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import QRCode from 'qrcode';
import { api, normalizeError } from '../api.js';
import { useClubManager } from '../context.jsx';
import { ErrorState, LoadingState, PageHeading } from '../components.jsx';
import { clubKey, parseClubKey } from '../model.js';

const PROJECT_TYPES = { moe: '萌战', twelve: '十二器' };
const PROJECT_STATUSES = {
  draft: '草稿', running: '进行中', suspended: '已暂停', archived: '已归档', ended: '已结束', completed: '已结束',
};
const VISIBILITIES = { public: '公开', club_only: '同好会可见', unlisted: '不公开列出' };
const ELIGIBILITIES = { club_member: '同好会成员', public: '登录用户' };
const RESULT_VISIBILITIES = {
  live_rank_only: '仅显示实时排名', live_votes: '显示排名与票数', after_stage: '阶段结束后显示', after_event: '活动结束后显示', hidden: '隐藏结果',
};
const STAGE_TYPES = { nomination: '提名', qualifier: '海选', group_vote: '分组赛', bracket: '淘汰赛', final: '决赛', bonus: '加赛' };
const VOTE_MODES = { nomination: '提名', multi_select: '多选投票', score: '评分', match_single: '1v1 对阵' };
const STAGE_STATUSES = { pending: '待开放', open: '开放中', locked: '已锁定', reviewing: '待裁定', settled: '已结算', closed: '已关闭' };

const request = (path, body) => body === undefined ? api.get(path) : api.post(path, body);
const rowsOf = (payload) => Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.rows) ? payload.rows : []);
const parseConfig = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
};
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const labelOf = (map, value) => map[value] || value || '—';
const entryIdOf = (entry) => entry?.entry_id ?? entry?.id ?? entry?.candidate_id;
const entryTitleOf = (entry) => entry?.title_cn || entry?.title || entry?.name_cn || entry?.name || `候选 #${entryIdOf(entry) || '—'}`;
const entryWorkOf = (entry) => entry?.work_title_cn || entry?.work_title || entry?.work_name || entry?.subtitle || entry?.summary || '';
const entryImageOf = (entry) => entry?.image_url || entry?.cover_url || entry?.avatar_url || '';
const formatDate = (value) => {
  if (!value) return '未设置';
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};
const toDateTimeLocal = (value) => String(value || '').replace(' ', 'T').slice(0, 16);
const fromDateTimeLocal = (value) => {
  if (!value) return null;
  const raw = String(value).replace('T', ' ');
  return raw.length === 16 ? `${raw}:00` : raw;
};

function clubNameOf(clubs, id, country) {
  const club = clubs.find((item) => Number(item.club_id ?? item.id) === Number(id) && (item.country || 'china') === (country || 'china'));
  return club?.name || club?.display_name || club?.school || `同好会 #${id}`;
}

function stageConfigFor(stage) {
  const config = parseConfig(stage?.config_json);
  return {
    ...config,
    stage_type: stage?.stage_type || 'group_vote',
    title: stage?.title || '',
    starts_at: stage?.starts_at || '',
    ends_at: stage?.ends_at || '',
    vote_mode: stage?.vote_mode || 'multi_select',
    max_select: num(stage?.max_select, 1),
    advance_count: num(stage?.advance_count, 1),
    group_count: num(stage?.group_count, 1),
    score_min: num(stage?.score_min, 1),
    score_max: num(stage?.score_max, 10),
    allow_vote_change: Boolean(num(stage?.allow_vote_change)),
    result_visibility: stage?.result_visibility || config.result_visibility || 'live_rank_only',
    allow_zero_fill: Boolean(config.allow_zero_fill),
    bracket_size: num(config.bracket_size, 0),
    source_stage_id: num(config.source_stage_id, 0),
    tie_rule: config.tie_rule || 'manual',
  };
}

function allowedModes(projectType, stageType) {
  if (stageType === 'nomination') return ['nomination'];
  if (projectType === 'moe' && (stageType === 'bracket' || stageType === 'final')) return ['match_single'];
  return ['multi_select', 'score'];
}

function projectSummary(project) {
  if (!project) return '';
  return `${labelOf(PROJECT_TYPES, project.project_type)} · ${labelOf(PROJECT_STATUSES, project.status)} · ${project.year_label || '未设置年份'}`;
}

function useOperation() {
  const [busy, setBusy] = useState('');
  const run = useCallback(async (key, action, successText) => {
    if (busy) return false;
    setBusy(key);
    try {
      await action();
      if (successText) message.success(successText);
      return true;
    } catch (error) {
      message.error(normalizeError(error));
      return false;
    } finally {
      setBusy('');
    }
  }, [busy]);
  return { busy, run };
}

export default function VoteProjectsTab() {
  const { selected, managedClubs, refreshVersion } = useClubManager();
  const { busy, run } = useOperation();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailTab, setDetailTab] = useState('overview');
  const [workbenchTab, setWorkbenchTab] = useState('nomination');
  const [activeStageId, setActiveStageId] = useState(null);
  const [stageEntries, setStageEntries] = useState({});
  const [projectEditor, setProjectEditor] = useState(null);
  const [stageEditor, setStageEditor] = useState(null);
  const [shareData, setShareData] = useState(null);
  const [tieData, setTieData] = useState(null);
  const [tieChoices, setTieChoices] = useState({});
  const [results, setResults] = useState(null);
  const [king, setKing] = useState(null);
  const [poolFilter, setPoolFilter] = useState('active');
  const [poolQuery, setPoolQuery] = useState('');
  const [poolPage, setPoolPage] = useState(1);
  const [poolGroup, setPoolGroup] = useState('all');
  const [poolExpanded, setPoolExpanded] = useState(false);
  const [selectedEntryIds, setSelectedEntryIds] = useState([]);

  const clubs = useMemo(() => managedClubs.filter((club) => !club.all && Number(club.club_id ?? club.id) > 0), [managedClubs]);
  const selectedKey = selected.clubId > 0 ? clubKey(selected.clubId, selected.country) : 'all';
  const clubOptions = useMemo(() => clubs.map((club) => {
    const id = Number(club.club_id ?? club.id);
    const country = club.country || 'china';
    return {
      value: clubKey(id, country),
      label: `${country === 'japan' ? '日本 · ' : '中国 · '}${club.name || club.display_name || club.school || `同好会 #${id}`}`,
    };
  }), [clubs]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await request('vote_projects.php?action=my_manageable');
      setProjects(rowsOf(payload));
    } catch (loadError) {
      setError(normalizeError(loadError, '赛事活动加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setDetailLoading(true);
    setError('');
    try {
      const base = await request(`vote_projects.php?action=get&id=${encodeURIComponent(id)}`);
      const project = base.data ? { ...base.data, can_manage: base.can_manage !== false && base.data.can_manage !== false } : base.data;
      const flowRequest = request(`vote_stages.php?action=flow_status&project_id=${encodeURIComponent(id)}`).catch((flowError) => ({
        error: normalizeError(flowError, '流程工作台暂不可用'), pools: [],
      }));
      const [nominations, matches, flow] = await Promise.all([
        request(`vote_nominations.php?action=list&project_id=${encodeURIComponent(id)}`),
        request(`vote_matches.php?action=list&project_id=${encodeURIComponent(id)}`),
        flowRequest,
      ]);
      const stages = Array.isArray(base.stages) ? base.stages : [];
      const stageMatchResults = await Promise.all(stages
        .filter((stage) => ['bracket', 'final'].includes(stage.stage_type))
        .map((stage) => request(`vote_matches.php?action=list&stage_id=${encodeURIComponent(stage.id)}`).catch(() => ({ data: [] }))));
      const matchMap = new Map();
      [...rowsOf(matches), ...stageMatchResults.flatMap(rowsOf)].forEach((match) => matchMap.set(String(match.id), match));
      setDetail({
        project,
        stages,
        entries: rowsOf(nominations),
        matches: [...matchMap.values()],
        flow: { ...flow, pools: Array.isArray(flow?.pools) ? flow.pools : [], flowUnavailable: Boolean(flow.error) },
      });
      setActiveStageId((current) => stages.some((stage) => String(stage.id) === String(current)) ? current : stages[0]?.id || null);
      setWorkbenchTab((current) => current === 'nomination' || stages.some((stage) => String(stage.id) === String(current)) ? current : 'nomination');
      setStageEntries({});
      setResults(null);
      setKing(null);
    } catch (loadError) {
      setDetail(null);
      setError(normalizeError(loadError, '赛事活动详情加载失败'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects, refreshVersion]);

  const visibleProjects = useMemo(() => projects.filter((project) => {
    const sameClub = selected.clubId <= 0 || (Number(project.club_id) === Number(selected.clubId) && (project.country || 'china') === (selected.country || 'china'));
    const needle = query.trim().toLowerCase();
    return sameClub
      && (typeFilter === 'all' || project.project_type === typeFilter)
      && (statusFilter === 'all' || project.status === statusFilter)
      && (!needle || `${project.title || ''}${project.description || ''}`.toLowerCase().includes(needle));
  }), [projects, query, selected, statusFilter, typeFilter]);

  useEffect(() => {
    if (!visibleProjects.length) {
      setProjectId(null);
      setDetail(null);
      return;
    }
    if (!visibleProjects.some((project) => String(project.id) === String(projectId))) setProjectId(visibleProjects[0].id);
  }, [projectId, visibleProjects]);
  useEffect(() => { if (projectId) loadDetail(projectId); }, [loadDetail, projectId]);

  const selectedProject = detail?.project || visibleProjects.find((project) => String(project.id) === String(projectId));
  const canManageProject = selectedProject ? selectedProject.can_manage !== false : false;
  const activeStage = detail?.stages?.find((stage) => String(stage.id) === String(activeStageId)) || null;
  const activePool = detail?.flow?.pools?.find((pool) => String(pool.stage_id) === String(activeStageId)) || null;
  const entryById = useMemo(() => {
    const all = [...(detail?.entries || []), ...Object.values(stageEntries).flatMap((cache) => cache.rows || [])];
    return new Map(all.map((entry) => [String(entryIdOf(entry)), entry]));
  }, [detail?.entries, stageEntries]);

  useEffect(() => {
    if (!selectedProject?.id) return;
    try {
      const raw = window.localStorage.getItem(`vote-project-selected-${selectedProject.id}`);
      setSelectedEntryIds(raw ? JSON.parse(raw).map(Number).filter(Boolean) : []);
    } catch { setSelectedEntryIds([]); }
  }, [selectedProject?.id]);
  useEffect(() => {
    if (!selectedProject?.id) return;
    try { window.localStorage.setItem(`vote-project-selected-${selectedProject.id}`, JSON.stringify(selectedEntryIds)); } catch { /* storage is optional */ }
  }, [selectedEntryIds, selectedProject?.id]);

  const loadStageEntries = useCallback(async (stageId, force = false) => {
    if (!stageId || (!force && stageEntries[stageId])) return;
    try {
      const payload = await request(`vote_stages.php?action=stage_entries&stage_id=${encodeURIComponent(stageId)}`);
      setStageEntries((current) => ({ ...current, [stageId]: { rows: rowsOf(payload), loadedAt: Date.now() } }));
    } catch (loadError) {
      message.error(normalizeError(loadError, '候选池加载失败'));
    }
  }, [stageEntries]);
  useEffect(() => {
    if (detailTab === 'workbench' && workbenchTab !== 'nomination') loadStageEntries(workbenchTab);
  }, [detailTab, loadStageEntries, workbenchTab]);

  const reloadDetail = useCallback(async () => {
    if (projectId) await loadDetail(projectId);
    await loadProjects();
  }, [loadDetail, loadProjects, projectId]);

  const openCreate = () => setProjectEditor({
    mode: 'create', project_type: 'twelve', suffix: '', club_id: selected.clubId > 0 ? selected.clubId : Number(clubs[0]?.club_id ?? clubs[0]?.id ?? 0),
    country: selected.clubId > 0 ? selected.country : clubs[0]?.country || 'china', title: '', year_label: String(new Date().getFullYear()),
    visibility: 'public', eligibility_mode: 'club_member', result_visibility: 'live_rank_only', description: '', guest_vote: false,
  });
  const openEdit = () => {
    if (!selectedProject || !canManageProject) return;
    setProjectEditor({ mode: 'edit', ...selectedProject, suffix: '', guest_vote: Number(selectedProject.guest_vote) === 1 });
  };

  const saveProject = async () => {
    if (projectEditor?.mode === 'edit' && !canManageProject) { message.error('当前活动仅可查看，不能修改'); return; }
    if (!projectEditor) return;
    const generatedTitle = projectEditor.project_type === 'twelve' && projectEditor.suffix?.trim()
      ? `${projectEditor.title?.trim() || '十二器'} ${projectEditor.suffix.trim()}` : projectEditor.title?.trim();
    if (!generatedTitle) { message.error('请填写活动标题或十二器名称后缀'); return; }
    if (!projectEditor.club_id || !projectEditor.country) { message.error('请选择所属同好会'); return; }
    const payload = {
      project_type: projectEditor.project_type,
      club_id: Number(projectEditor.club_id), country: projectEditor.country,
      title: generatedTitle, year_label: projectEditor.year_label?.trim() || String(new Date().getFullYear()),
      visibility: projectEditor.visibility, eligibility_mode: projectEditor.eligibility_mode,
      result_visibility: projectEditor.result_visibility, description: projectEditor.description?.trim() || '',
      guest_vote: projectEditor.guest_vote ? 1 : 0, config: projectEditor.config || {},
    };
    const isEdit = projectEditor.mode === 'edit';
    let response = null;
    const ok = await run('project-save', async () => {
      response = await request(isEdit ? `vote_projects.php?action=update&id=${encodeURIComponent(projectEditor.id)}` : 'vote_projects.php?action=create', payload);
    }, isEdit ? '活动设置已保存' : '赛事活动已创建');
    if (ok) {
      const createdId = projectEditor.id || response?.data?.id || response?.id;
      setProjectEditor(null);
      await loadProjects();
      if (createdId) { setProjectId(createdId); await loadDetail(createdId); }
    }
  };

  const confirmProjectAction = (action, title, content) => {
    if (!selectedProject || !canManageProject) return;
    if (action === 'publish' && !detail?.stages?.length) { message.warning('请先配置赛程阶段再发布活动'); return; }
    Modal.confirm({
      title, content, okText: action === 'delete' ? '删除' : '确认', okButtonProps: action === 'delete' ? { danger: true } : undefined, cancelText: '取消',
      onOk: async () => {
        const ok = await run(`project-${action}`, () => request(`vote_projects.php?action=${action}&id=${encodeURIComponent(selectedProject.id)}`, {}), '操作已完成');
        if (ok) { setDetail(null); setProjectId(null); await loadProjects(); }
      },
    });
  };

  const openShare = async () => {
    if (!selectedProject || !canManageProject) return;
    try {
      const payload = await request(`vote_projects.php?action=share&id=${encodeURIComponent(selectedProject.id)}`, {});
      const target = selectedProject.project_type === 'moe' ? '/moe/contest.html' : '/twelve/contest.html';
      const link = new URL(`${target}?id=${encodeURIComponent(selectedProject.id)}&share=${encodeURIComponent(payload.share_token)}`, window.location.origin).href;
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 180 });
      setShareData({ link, qr, guest: Number(payload.guest_vote) === 1, status: payload.status });
    } catch (shareError) { message.error(normalizeError(shareError, '分享信息生成失败')); }
  };

  const openStage = (stage) => {
    if (!selectedProject || !canManageProject) return;
    setStageEditor({ id: stage.id, project_id: selectedProject.id, ...stageConfigFor(stage) });
  };
  const saveStage = async () => {
    if (!canManageProject) { message.error('当前活动仅可查看，不能修改阶段'); return; }
    if (!stageEditor?.title?.trim()) { message.error('请填写阶段标题'); return; }
    const modes = allowedModes(selectedProject.project_type, stageEditor.stage_type);
    if (!modes.includes(stageEditor.vote_mode)) { message.error('当前阶段类型不支持该投票模式'); return; }
    const groupCount = num(stageEditor.group_count, 1);
    const advanceCount = num(stageEditor.advance_count, 0);
    if (groupCount <= 0) { message.error('分组数必须大于 0'); return; }
    if (stageEditor.stage_type === 'group_vote' && advanceCount > 0 && advanceCount % groupCount !== 0) { message.error('分组投票的晋级数量必须能被分组数整除'); return; }
    const knownCount = stageEditor.stage_type === 'nomination' ? detail.entries.length : (stageEntries[stageEditor.id]?.rows?.length || activePool?.entry_count || detail.entries.length);
    if (advanceCount > knownCount && knownCount > 0) { message.error(`晋级数量不能超过已知候选数量（${knownCount}）`); return; }
    const config = {
      allow_zero_fill: Boolean(stageEditor.allow_zero_fill), bracket_size: num(stageEditor.bracket_size),
      source_stage_id: num(stageEditor.source_stage_id), tie_rule: stageEditor.tie_rule || 'manual',
    };
    const previous = detail.stages.find((stage) => String(stage.id) === String(stageEditor.id));
    const previousForm = stageConfigFor(previous);
    const coreFields = ['stage_type', 'starts_at', 'vote_mode', 'max_select', 'advance_count', 'group_count', 'score_min', 'score_max', 'allow_vote_change', 'allow_zero_fill', 'bracket_size', 'source_stage_id', 'tie_rule'];
    const coreChanged = coreFields.some((field) => String(previousForm[field] ?? '') !== String(field === 'allow_zero_fill' ? Boolean(stageEditor[field]) : stageEditor[field] ?? ''));
    const flowPool = detail.flow?.pools?.find((pool) => String(pool.stage_id) === String(stageEditor.id));
    const hasPool = Boolean(flowPool);
    if (hasPool && coreChanged && flowPool.can_rebuild === false) {
      message.warning('该阶段已有投票、对阵或结果，只能修改标题、截止时间和结果可见性；请撤销核心配置变更后再保存。');
      return;
    }
    const action = hasPool && coreChanged ? 'update_and_rebuild' : 'update';
    const payload = {
      id: Number(stageEditor.id), stage_type: stageEditor.stage_type, title: stageEditor.title.trim(),
      starts_at: fromDateTimeLocal(stageEditor.starts_at), ends_at: fromDateTimeLocal(stageEditor.ends_at),
      vote_mode: stageEditor.vote_mode, max_select: num(stageEditor.max_select, 1), advance_count: advanceCount,
      group_count: groupCount, score_min: num(stageEditor.score_min, 1), score_max: num(stageEditor.score_max, 10),
      allow_vote_change: stageEditor.allow_vote_change ? 1 : 0, result_visibility: stageEditor.result_visibility, config,
    };
    const ok = await run(`stage-save-${stageEditor.id}`, () => request(`vote_stages.php?action=${action}&id=${encodeURIComponent(stageEditor.id)}`, payload), action === 'update_and_rebuild' ? '阶段已更新并重建' : '阶段已保存');
    if (ok) { setStageEditor(null); await reloadDetail(); }
  };

  const runStageAction = (action, stage) => {
    if (!canManageProject) return;
    const labels = { open: '开放', lock: '锁定', settle: '结算', resolve_tie: '裁定平票' };
    if (action === 'resolve_tie') { openLegacyTie(stage); return; }
    Modal.confirm({
      title: `${labels[action] || '执行操作'}：${stage.title}`, content: action === 'settle' ? '确认结算这个阶段？结算后将按当前投票结果生成结果。' : undefined,
      okText: '确认', cancelText: '取消', onOk: async () => {
        const ok = await run(`stage-${action}-${stage.id}`, () => request(`vote_stages.php?action=${action}&id=${encodeURIComponent(stage.id)}`, {}), `${labels[action] || '阶段操作'}完成`);
        if (ok) await reloadDetail();
      },
    });
  };

  const runPoolAction = (action, pool, stage) => {
    if (!canManageProject) return;
    if (action === 'resolve_flow_tie') { openFlowTie(pool, stage); return; }
    if (action === 'rebuild_from_nomination_and_open') {
      Modal.confirm({ title: `生成海选池：${stage.title}`, content: '将使用已通过的提名生成海选池并打开海选。若已有活动数据，后端会拒绝危险重建。确认继续？', okText: '生成并开放', cancelText: '取消', onOk: async () => {
        const project = selectedProject.id;
        const ok = await run(`pool-rebuild-${stage.id}`, () => request(`vote_stages.php?action=rebuild_from_nomination_and_open&project_id=${encodeURIComponent(project)}`, { project_id: Number(project) }), '海选池已生成并开放');
        if (ok) await reloadDetail();
      } });
      return;
    }
    const matchAction = action === 'generate_matches' || action === 'settle_by_votes';
    const path = matchAction ? `vote_matches.php?action=${action === 'generate_matches' ? 'generate' : action}` : `vote_stages.php?action=${action}&pool_id=${encodeURIComponent(pool.id)}`;
    const body = matchAction ? { stage_id: Number(stage.id) } : { pool_id: Number(pool.id) };
    const label = { open_pool: '开放阶段池', settle_pool: '结算阶段池', generate_next_pool: '生成下一阶段', generate_matches: '生成对阵', settle_by_votes: '按票结算' }[action] || '执行操作';
    Modal.confirm({ title: `${label}：${stage.title}`, content: action === 'settle_by_votes' ? '确认按当前票数结算所有可判定对阵？平票会保留到人工裁定。' : undefined, okText: '确认', cancelText: '取消', onOk: async () => {
      const ok = await run(`pool-${action}-${pool.id}`, () => request(path, body), `${label}完成`);
      if (ok) await reloadDetail();
    } });
  };

  const removeEntry = (entry, action) => {
    if (!canManageProject) return;
    const label = action === 'remove' ? '排除' : '恢复';
    Modal.confirm({ title: `${label}候选：${entryTitleOf(entry)}`, content: action === 'remove' ? '排除后将不再进入活动候选池，确认继续？' : undefined, okText: '确认', cancelText: '取消', onOk: async () => {
      const ok = await run(`entry-${action}-${entryIdOf(entry)}`, () => request(`vote_nominations.php?action=${action}`, { entry_id: Number(entryIdOf(entry)) }), `${label}完成`);
      if (ok) await reloadDetail();
    } });
  };

  const batchEntryAction = (action) => {
    if (!canManageProject || !selectedEntryIds.length) return;
    const entries = (detail?.entries || []).filter((entry) => selectedEntryIds.includes(Number(entryIdOf(entry))));
    const label = action === 'remove' ? '排除' : '恢复';
    Modal.confirm({ title: `${label} ${entries.length} 个候选`, content: '批量操作会立即更新提名池状态，确认继续？', okText: '确认', cancelText: '取消', onOk: async () => {
      const ok = await run(`entries-${action}`, async () => { for (const entry of entries) await request(`vote_nominations.php?action=${action}`, { entry_id: Number(entryIdOf(entry)) }); }, `已${label} ${entries.length} 个候选`);
      if (ok) { setSelectedEntryIds([]); await reloadDetail(); }
    } });
  };

  const openManualMatch = (match, winnerId) => {
    if (!canManageProject || !winnerId) return;
    const winner = entryById.get(String(winnerId));
    Modal.confirm({ title: '确认手动判定对阵', content: `将「${entryTitleOf(winner)}」设为胜者？`, okText: '确认结算', cancelText: '取消', onOk: async () => {
      const ok = await run(`match-settle-${match.id}`, () => request(`vote_matches.php?action=settle&id=${encodeURIComponent(match.id)}`, { winner_entry_id: Number(winnerId) }), '对阵已结算');
      if (ok) await reloadDetail();
    } });
  };

  const openFlowTie = (pool, stage) => {
    const runtime = pool?.runtime || {};
    const groups = Array.isArray(runtime.tie_breaks) ? runtime.tie_breaks : [];
    if (!groups.length) { message.info('当前没有可裁定的同分组'); return; }
    setTieChoices({});
    setTieData({ kind: 'flow', pool, stage, groups });
  };
  const openLegacyTie = (stage) => {
    const tie = parseConfig(stage.config_json).tie_break;
    if (!tie?.candidate_entry_ids?.length) { message.info('未找到平票候选信息，请重新结算后再试'); return; }
    setTieChoices({ legacy: [] });
    setTieData({ kind: 'legacy', stage, groups: [{ group_key: '晋级名额', slots: num(tie.slots, 1), entry_ids: tie.candidate_entry_ids }] });
  };
  const submitTie = async () => {
    if (!tieData) return;
    const decisions = tieData.groups.map((group, index) => ({ group_key: group.group_key, entry_ids: tieChoices[index] || [] }));
    for (const [index, group] of tieData.groups.entries()) {
      if ((tieChoices[index] || []).length !== Math.max(1, num(group.slots, 1))) { message.error(`${group.group_key || '分组'} 需要选择 ${group.slots || 1} 项`); return; }
    }
    const ok = await run('tie-submit', () => tieData.kind === 'flow'
      ? request(`vote_stages.php?action=resolve_flow_tie&pool_id=${encodeURIComponent(tieData.pool.id)}`, { decisions })
      : request(`vote_stages.php?action=resolve_tie&id=${encodeURIComponent(tieData.stage.id)}`, { entry_ids: decisions[0].entry_ids }), '平票裁定已提交');
    if (ok) { setTieData(null); await reloadDetail(); }
  };

  const loadResults = async () => {
    const stage = [...(detail?.stages || [])].reverse().find((item) => item.stage_type === 'final') || detail?.stages?.[detail.stages.length - 1];
    if (!stage) { message.info('当前活动还没有决赛阶段'); return; }
    try {
      const payload = await request(`vote_votes.php?action=results&stage_id=${encodeURIComponent(stage.id)}`);
      setResults({ stage, payload, rows: rowsOf(payload) });
      if (selectedProject.project_type === 'moe') {
        try {
          const stored = await request(`club_moe_king.php?action=get&club_id=${encodeURIComponent(selectedProject.club_id)}&country=${encodeURIComponent(selectedProject.country || 'china')}`);
          setKing(stored.data || null);
        } catch { setKing(null); }
      }
    } catch (resultError) { message.error(normalizeError(resultError, '决赛结果读取失败')); }
  };
  const syncChampion = async (row) => {
    if (!row || !selectedProject || !canManageProject) return;
    const ok = await run('sync-champion', () => request('club_moe_king.php?action=set', {
      club_id: Number(selectedProject.club_id), country: selectedProject.country || 'china', character_id: Number(row.source_id || row.entry_id || row.id || 0),
      name: row.title || row.title_cn || `entry-${row.entry_id || row.id}`, name_cn: row.title_cn || row.title || '', image_url: row.image_url || '', summary: '由萌战决赛结果同步',
    }), '萌王已同步');
    if (ok) await loadResults();
  };

  if (loading) return <LoadingState label="正在加载赛事活动…" />;
  if (error && !detail) return <ErrorState description={error} onRetry={loadProjects} />;
  if (!selected.clubId && !managedClubs.some((club) => club.all)) return <section className="cm-page" data-component="赛事活动"><PageHeading title="赛事活动" /><Empty description="当前账号没有可管理的同好会。" /></section>;

  const resetFilters = () => { setQuery(''); setTypeFilter('all'); setStatusFilter('all'); };
  const detailItems = [
    { key: 'overview', label: '概览与设置' },
    { key: 'workbench', label: '赛程工作台' },
    { key: 'awards', label: '结果与奖项' },
  ];

  return (
    <section className="cm-page cm-vote-page" data-component="赛事活动">
      <PageHeading title="赛事活动" description="管理萌战与十二器的活动设置、阶段流程、投票结果和奖项。" action={<Space wrap><Button icon={<ReloadOutlined />} onClick={reloadDetail} loading={Boolean(busy)}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => projectEditor?.mode === 'create' ? setProjectEditor(null) : openCreate()} disabled={!clubs.length}>新建赛事活动</Button></Space>} />
      {error && <Alert type="warning" showIcon message={error} closable onClose={() => setError('')} />}
      {selectedProject && !canManageProject && <Alert type="info" showIcon message="当前活动为只读状态" description="后端未授予当前身份的管理权限；设置、阶段、候选、结算和奖项操作已禁用。" />}
      <Row gutter={[12, 12]} className="cm-stat-row">
        <Col xs={12} md={6}><Statistic title="可管理活动" value={visibleProjects.length} /></Col>
        <Col xs={12} md={6}><Statistic title="进行中" value={visibleProjects.filter((project) => project.status === 'running').length} /></Col>
        <Col xs={12} md={6}><Statistic title="萌战" value={visibleProjects.filter((project) => project.project_type === 'moe').length} /></Col>
        <Col xs={12} md={6}><Statistic title="十二器" value={visibleProjects.filter((project) => project.project_type === 'twelve').length} /></Col>
      </Row>
      <div className="cm-vote-layout">
        <Card className="cm-vote-project-list" title={<Space className="cm-vote-card-title">活动列表 <Tag>{visibleProjects.length}</Tag></Space>}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索活动标题" allowClear />
            <Space wrap><Select value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: '全部类型' }, ...Object.entries(PROJECT_TYPES).map(([value, label]) => ({ value, label }))]} /><Select value={statusFilter} onChange={setStatusFilter} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(PROJECT_STATUSES).map(([value, label]) => ({ value, label }))]} /></Space>
          </Space>
          {projectEditor?.mode === 'create' && <ProjectEditorForm editor={projectEditor} setEditor={setProjectEditor} clubs={clubs} clubOptions={clubOptions} onSave={saveProject} onCancel={() => setProjectEditor(null)} saving={busy === 'project-save'} />}
          <Divider />
          {visibleProjects.length ? <List dataSource={visibleProjects} renderItem={(project) => <List.Item className={`cm-vote-project-item${String(project.id) === String(projectId) ? ' is-active' : ''}`}><button type="button" className="cm-vote-project-button" onClick={() => setProjectId(project.id)} aria-pressed={String(project.id) === String(projectId)}><span className={`cm-vote-type-mark is-${project.project_type}`}>{project.project_type === 'moe' ? '萌' : '12'}</span><span className="cm-vote-project-copy"><strong>{project.title || '未命名活动'}</strong><small>{clubNameOf(clubs, project.club_id, project.country)} · {labelOf(PROJECT_STATUSES, project.status)}</small></span><Tag color={project.status === 'running' ? 'green' : undefined}>{labelOf(PROJECT_TYPES, project.project_type)}</Tag></button></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query || typeFilter !== 'all' || statusFilter !== 'all' ? '没有符合当前筛选条件的活动' : '暂无可管理赛事活动'}>{(query || typeFilter !== 'all' || statusFilter !== 'all') && <Button size="small" onClick={resetFilters}>清除筛选</Button>}</Empty>}
        </Card>

        <div className="cm-vote-detail">
          {detailLoading || (selectedProject && !detail) ? <Card><Spin /> 正在加载活动详情…</Card> : selectedProject && detail ? <>
            <Card className="cm-vote-detail-head">
              <div className="cm-vote-detail-heading"><div><Tag color={selectedProject.project_type === 'moe' ? 'volcano' : 'purple'}>{labelOf(PROJECT_TYPES, selectedProject.project_type)}</Tag><Typography.Title level={3}>{selectedProject.title}</Typography.Title><Typography.Text type="secondary">{projectSummary(selectedProject)} · {clubNameOf(clubs, selectedProject.club_id, selectedProject.country)}</Typography.Text></div><Space wrap><Button icon={<ShareAltOutlined />} onClick={openShare} disabled={!canManageProject}>分享</Button><Button icon={<EditOutlined />} onClick={openEdit} disabled={!canManageProject}>设置</Button>{selectedProject.status === 'draft' && <Button type="primary" onClick={() => confirmProjectAction('publish', '发布活动', '发布后活动会进入进行中状态，确认继续？')} disabled={!canManageProject}>发布</Button>}{selectedProject.status === 'running' && <Button onClick={() => confirmProjectAction('archive', '归档活动', '归档后将停止新的投票，确认继续？')} disabled={!canManageProject}>归档</Button>}<Button danger icon={<DeleteOutlined />} onClick={() => confirmProjectAction('delete', '删除活动', '删除活动会移除其配置和运营数据，确认继续？')} disabled={!canManageProject}>删除</Button></Space></div>
            </Card>
            <Tabs className="cm-vote-tabs" activeKey={detailTab} onChange={setDetailTab} items={detailItems} />
            {detailTab === 'overview' && <OverviewPanel project={selectedProject} editor={projectEditor?.mode === 'edit' ? projectEditor : null} setEditor={setProjectEditor} clubs={clubs} clubOptions={clubOptions} onEdit={openEdit} onSave={saveProject} onCancel={() => setProjectEditor(null)} canManage={canManageProject} saving={busy === 'project-save'} />}
            {detailTab === 'workbench' && <WorkbenchPanel detail={detail} project={selectedProject} canManage={canManageProject} workbenchTab={workbenchTab} setWorkbenchTab={(value) => { setWorkbenchTab(value); setActiveStageId(value === 'nomination' ? null : value); if (value !== 'nomination') { setPoolPage(1); setPoolGroup('all'); setPoolFilter('active'); setPoolQuery(''); setPoolExpanded(false); } }} activeStage={activeStage} activePool={activePool} activeStageId={activeStageId} stageEntries={stageEntries} stageEditor={stageEditor} setStageEditor={setStageEditor} onEditStage={openStage} onCloseStageEditor={() => setStageEditor(null)} onSaveStage={saveStage} stageSaving={Boolean(busy.startsWith('stage-save-'))} onStageAction={runStageAction} onPoolAction={runPoolAction} entries={detail.entries} selectedEntryIds={selectedEntryIds} setSelectedEntryIds={setSelectedEntryIds} poolFilter={poolFilter} setPoolFilter={(value) => { setPoolFilter(value); setPoolPage(1); }} poolQuery={poolQuery} setPoolQuery={(value) => { setPoolQuery(value); setPoolPage(1); }} poolPage={poolPage} setPoolPage={setPoolPage} poolGroup={poolGroup} setPoolGroup={(value) => { setPoolGroup(value); setPoolPage(1); }} poolExpanded={poolExpanded} setPoolExpanded={setPoolExpanded} onEntryAction={removeEntry} onBatchEntryAction={batchEntryAction} onLoadEntries={loadStageEntries} entryById={entryById} onManualMatch={openManualMatch} />}
            {detailTab === 'awards' && <AwardsPanel project={selectedProject} results={results} king={king} canManage={canManageProject} onLoad={loadResults} onSync={syncChampion} />}
          </> : <Card><Empty description="请选择一个赛事活动" /></Card>}
        </div>
      </div>

      <Modal title="分享活动" open={Boolean(shareData)} onCancel={() => setShareData(null)} footer={null} destroyOnClose>
        {shareData && <Space direction="vertical" className="cm-vote-share" align="center"><img src={shareData.qr} alt="活动分享二维码" width="180" height="180" /><Input value={shareData.link} readOnly addonAfter={<Button type="text" icon={<CopyOutlined />} onClick={() => { if (!navigator.clipboard?.writeText) { message.info('当前浏览器不支持自动复制，请手动复制链接'); return; } navigator.clipboard.writeText(shareData.link).then(() => message.success('链接已复制')).catch(() => message.info('自动复制失败，请手动复制链接')); }} />} /><Alert type={shareData.guest ? 'success' : 'info'} showIcon message={shareData.guest ? '已开启免登录投票' : '访客需要登录并满足参与资格'} description={shareData.status === 'running' ? '活动处于进行中，分享链接可以直接进入活动详情。' : '活动发布并处于进行中后，分享链接可用于参与投票。'} /></Space>}
      </Modal>
      <Modal title="平票裁定" open={Boolean(tieData)} onCancel={() => setTieData(null)} onOk={submitTie} okText="提交裁定" cancelText="取消" confirmLoading={busy === 'tie-submit'} destroyOnClose>
        {tieData && <Space direction="vertical" className="cm-vote-tie" size={16}>{tieData.groups.map((group, index) => <div key={`${group.group_key}-${index}`}><Typography.Text strong>{group.group_key || `分组 ${index + 1}`} · 请选择 {group.slots || 1} 项</Typography.Text><Checkbox.Group value={tieChoices[index] || []} onChange={(value) => setTieChoices((current) => ({ ...current, [index]: value }))} options={(group.entry_ids || []).map((id) => ({ value: Number(id), label: entryTitleOf(entryById.get(String(id))) }))} /></div>)}</Space>}
      </Modal>
    </section>
  );
}

function ProjectEditorForm({ editor, setEditor, clubs, clubOptions, onSave, onCancel, saving }) {
  const [clubQuery, setClubQuery] = useState('');
  const update = (key, value) => setEditor((current) => ({ ...current, [key]: value }));
  const filteredClubs = clubOptions.filter((option) => !clubQuery.trim() || option.label.toLowerCase().includes(clubQuery.trim().toLowerCase()));
  const preview = editor.project_type === 'twelve' ? `${editor.title?.trim() || '十二器'}${editor.suffix?.trim() ? ` ${editor.suffix.trim()}` : ''}` : (editor.title?.trim() || '萌战赛事');
  return <div className={`cm-vote-form cm-vote-inline-form ${editor.mode === 'edit' ? 'is-editing' : ''}`}>
    <div className="cm-vote-inline-heading"><div><Typography.Text strong>{editor.mode === 'create' ? '新建赛事活动' : '活动设置'}</Typography.Text><Typography.Text type="secondary">{editor.mode === 'create' ? '先建立草稿，再在赛程工作台中配置阶段。' : '设置保存后会继续留在当前活动详情。'}</Typography.Text></div>{editor.mode === 'create' && <Button type="text" onClick={onCancel}>收起新建</Button>}</div>
    <div className="cm-vote-type-switch" role="group" aria-label="赛事类型"><button type="button" className={editor.project_type === 'twelve' ? 'is-active' : ''} onClick={() => update('project_type', 'twelve')}>十二器</button><button type="button" className={editor.project_type === 'moe' ? 'is-active' : ''} onClick={() => update('project_type', 'moe')}>萌战</button></div>
    <div className="cm-vote-form-grid">
      <label>所属同好会<Input aria-label="搜索同好会" placeholder="搜索当前可管理同好会" value={clubQuery} onChange={(event) => setClubQuery(event.target.value)} /><Select aria-label="所属同好会" showSearch optionFilterProp="label" value={clubKey(editor.club_id, editor.country)} disabled={editor.mode === 'edit' || clubs.length <= 1} onChange={(value) => { const parsed = parseClubKey(value); update('club_id', parsed.clubId); update('country', parsed.country); }} options={filteredClubs} /></label>
      <label>活动标题<Input value={editor.title} onChange={(event) => update('title', event.target.value)} maxLength={120} placeholder={editor.project_type === 'twelve' ? '例如：2026 十二器' : '例如：2026 萌战'} /></label>
      {editor.project_type === 'twelve' && <label>名称后缀<Input aria-label="十二器名称后缀" value={editor.suffix || ''} onChange={(event) => update('suffix', event.target.value)} maxLength={40} placeholder="例如：春季篇" /><small className="cm-vote-form-note">实时预览：{preview}</small></label>}
      <label>年份<Input value={editor.year_label} onChange={(event) => update('year_label', event.target.value)} maxLength={32} /></label>
      <label>地区<Select value={editor.country || 'china'} onChange={(value) => update('country', value)} disabled={editor.mode === 'edit'} options={[{ value: 'china', label: '中国' }, { value: 'japan', label: '日本' }]} /></label>
      <label>可见性<Select value={editor.visibility} onChange={(value) => update('visibility', value)} options={Object.entries(VISIBILITIES).map(([value, label]) => ({ value, label }))} /></label>
      <label>参与资格<Select value={editor.eligibility_mode} onChange={(value) => update('eligibility_mode', value)} options={Object.entries(ELIGIBILITIES).map(([value, label]) => ({ value, label }))} /></label>
      <label>默认结果显示<Select value={editor.result_visibility} onChange={(value) => update('result_visibility', value)} options={Object.entries(RESULT_VISIBILITIES).map(([value, label]) => ({ value, label }))} /></label>
    </div>
    <label>活动说明<Input.TextArea value={editor.description} onChange={(event) => update('description', event.target.value)} rows={3} maxLength={1000} showCount /></label>
    <label className="cm-vote-switch-row"><Switch checked={Boolean(editor.guest_vote)} onChange={(value) => update('guest_vote', value)} />允许分享链接免登录投票</label>
    <Space wrap><Button type="primary" onClick={onSave} loading={saving}>{editor.mode === 'create' ? '创建草稿' : '保存活动设置'}</Button><Button onClick={onCancel}>取消</Button></Space>
  </div>;
}

function OverviewPanel({ project, editor, setEditor, clubs, clubOptions, onEdit, onSave, onCancel, canManage, saving }) {
  return <Space direction="vertical" size={12} className="cm-vote-stack"><Card title="概览与设置" extra={!editor && <Button size="small" icon={<EditOutlined />} onClick={onEdit} disabled={!canManage}>编辑设置</Button>}>
    {editor ? <ProjectEditorForm editor={editor} setEditor={setEditor} clubs={clubs} clubOptions={clubOptions} onSave={onSave} onCancel={onCancel} saving={saving} /> : <Descriptions column={{ xs: 1, sm: 2 }} size="small"><Descriptions.Item label="类型">{labelOf(PROJECT_TYPES, project.project_type)}</Descriptions.Item><Descriptions.Item label="状态">{labelOf(PROJECT_STATUSES, project.status)}</Descriptions.Item><Descriptions.Item label="年份">{project.year_label || '未设置'}</Descriptions.Item><Descriptions.Item label="所属同好会">{project.club_name || `同好会 #${project.club_id}`} · {project.country === 'japan' ? '日本' : '中国'}</Descriptions.Item><Descriptions.Item label="可见性">{labelOf(VISIBILITIES, project.visibility)}</Descriptions.Item><Descriptions.Item label="参与资格">{labelOf(ELIGIBILITIES, project.eligibility_mode)}</Descriptions.Item><Descriptions.Item label="结果显示">{labelOf(RESULT_VISIBILITIES, project.result_visibility)}</Descriptions.Item><Descriptions.Item label="分享投票">{Number(project.guest_vote) === 1 ? '已开启' : '未开启'}</Descriptions.Item><Descriptions.Item label="说明" span={2}>{project.description || '暂无说明'}</Descriptions.Item></Descriptions>}
  </Card></Space>;
}

function WorkbenchPanel(props) {
  const {
    detail, project, canManage, workbenchTab, setWorkbenchTab, activeStage, activePool, activeStageId, stageEntries,
    stageEditor, setStageEditor, onEditStage, onCloseStageEditor, onSaveStage, stageSaving, onStageAction, onPoolAction, entries,
    selectedEntryIds, setSelectedEntryIds, poolFilter, setPoolFilter, poolQuery, setPoolQuery, poolPage, setPoolPage,
    poolGroup, setPoolGroup, poolExpanded, setPoolExpanded, onEntryAction, onBatchEntryAction, onLoadEntries, entryById, onManualMatch,
  } = props;
  const poolFor = (stage) => detail.flow?.pools?.find((pool) => String(pool.stage_id) === String(stage.id));
  const countFor = (stage) => poolFor(stage)?.entry_count ?? stageEntries[stage.id]?.rows?.length ?? (stage.stage_type === 'nomination' ? entries.length : 0);
  return <Space direction="vertical" size={12} className="cm-vote-stack cm-vote-workbench">
    {detail.flow?.flowUnavailable && <Alert type="warning" showIcon message="流程工作台暂不可用" description="流程状态接口不可用，但旧版候选、阶段和对阵查看能力仍可使用；恢复接口后刷新即可恢复流程池操作。" />}
    <Card className="cm-vote-pipeline-card" title="赛程流水线" extra={<Typography.Text type="secondary">按旧版纵向节奏管理候选流转</Typography.Text>}>
      <div className="cm-vote-pipeline"><PipelineStep active={workbenchTab === 'nomination'} label="提名" count={entries.length} onClick={() => setWorkbenchTab('nomination')} />{detail.stages.map((stage, index) => <React.Fragment key={stage.id}><span className="cm-vote-pipeline-arrow" aria-hidden="true">›</span><PipelineStep active={String(workbenchTab) === String(stage.id)} label={stage.title || labelOf(STAGE_TYPES, stage.stage_type)} sublabel={labelOf(STAGE_TYPES, stage.stage_type)} count={countFor(stage)} status={stage.status} onClick={() => setWorkbenchTab(stage.id)} /></React.Fragment>)}</div>
    </Card>
    <StageList detail={detail} project={project} canManage={canManage} activeStageId={activeStageId} onSelect={setWorkbenchTab} onEdit={onEditStage} stageEditor={stageEditor} setStageEditor={setStageEditor} onCloseStageEditor={onCloseStageEditor} onSaveStage={onSaveStage} stageSaving={stageSaving} onStageAction={onStageAction} onPoolAction={onPoolAction} />
    {workbenchTab === 'nomination' ? <NominationPool entries={entries} canManage={canManage} selectedEntryIds={selectedEntryIds} setSelectedEntryIds={setSelectedEntryIds} filter={poolFilter} setFilter={setPoolFilter} query={poolQuery} setQuery={setPoolQuery} page={poolPage} setPage={setPoolPage} expanded={poolExpanded} setExpanded={setPoolExpanded} onEntryAction={onEntryAction} onBatchAction={onBatchEntryAction} /> : activeStage ? <>
      <StagePool stage={activeStage} pool={activePool} rows={stageEntries[activeStage.id]?.rows || []} canManage={canManage} filter={poolFilter} setFilter={setPoolFilter} group={poolGroup} setGroup={setPoolGroup} onRefresh={() => onLoadEntries(activeStage.id, true)} onPoolAction={onPoolAction} onStageAction={onStageAction} />
      {['bracket', 'final'].includes(activeStage.stage_type) && <MatchWorkbench stage={activeStage} pool={activePool} matches={detail.matches.filter((match) => String(match.stage_id) === String(activeStage.id))} entryById={entryById} canManage={canManage} onPoolAction={onPoolAction} onManualMatch={onManualMatch} />}
    </> : <Card><Empty description="请选择一个阶段" /></Card>}
  </Space>;
}

function PipelineStep({ active, label, sublabel, count, status, onClick }) {
  return <button type="button" className={`cm-vote-pipeline-step${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={active}><span className="cm-vote-pipeline-label">{label}</span>{sublabel && <small>{sublabel}</small>}<strong>{count}</strong>{status && <em>{labelOf(STAGE_STATUSES, status)}</em>}</button>;
}

function StageList({ detail, project, canManage, activeStageId, onSelect, onEdit, stageEditor, setStageEditor, onCloseStageEditor, onSaveStage, stageSaving, onStageAction, onPoolAction }) {
  const poolFor = (stage) => detail.flow?.pools?.find((pool) => String(pool.stage_id) === String(stage.id));
  return <Card className="cm-vote-stage-list" title="阶段管理" extra={<Typography.Text type="secondary">阶段池与投票状态来自流程 API</Typography.Text>}>
    {detail.stages.length ? detail.stages.map((stage) => {
      const pool = poolFor(stage);
      return <div className={`cm-vote-stage-row${String(stage.id) === String(activeStageId) ? ' is-active' : ''}`} key={stage.id} onClick={() => onSelect(stage.id)}>
        <div className="cm-vote-stage-main"><Tag>{labelOf(STAGE_TYPES, stage.stage_type)}</Tag><div><strong>{stage.title || '未命名阶段'}</strong><small>{labelOf(VOTE_MODES, stage.vote_mode)} · 晋级 {stage.advance_count || 0} · 截止 {formatDate(stage.ends_at)}</small></div></div>
        <div className="cm-vote-stage-meta"><Tag color={stage.status === 'open' ? 'green' : stage.status === 'reviewing' ? 'orange' : undefined}>{labelOf(STAGE_STATUSES, stage.status)}</Tag>{pool && <Tag color="blue">池 {pool.entry_count || 0}</Tag>}<Space wrap className="cm-vote-stage-actions"><Button size="small" icon={<EditOutlined />} onClick={(event) => { event.stopPropagation(); onEdit(stage); }} disabled={!canManage}>配置</Button>{stage.stage_type === 'qualifier' && !pool && <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={(event) => { event.stopPropagation(); onPoolAction('rebuild_from_nomination_and_open', { id: stage.id, project_id: project.id }, stage); }} disabled={!canManage}>生成海选池</Button>}{stage.status !== 'open' && stage.status !== 'settled' && <Button size="small" onClick={(event) => { event.stopPropagation(); onStageAction('open', stage); }} disabled={!canManage}>开放</Button>}{stage.status === 'open' && <Button size="small" onClick={(event) => { event.stopPropagation(); onStageAction('lock', stage); }} disabled={!canManage}>锁定</Button>}{stage.status === 'open' && !pool && <Button size="small" onClick={(event) => { event.stopPropagation(); onStageAction('settle', stage); }} disabled={!canManage}>结算</Button>}{stage.status === 'reviewing' && <Button size="small" type="primary" onClick={(event) => { event.stopPropagation(); onStageAction('resolve_tie', stage); }} disabled={!canManage}>阶段平票</Button>}{pool?.status === 'open' && <Button size="small" onClick={(event) => { event.stopPropagation(); onPoolAction('settle_pool', pool, stage); }} disabled={!canManage}>结算阶段池</Button>}{pool?.status === 'settled' && <Button size="small" onClick={(event) => { event.stopPropagation(); onPoolAction('generate_next_pool', pool, stage); }} disabled={!canManage}>生成下一池</Button>}</Space></div>
        {stageEditor && String(stageEditor.id) === String(stage.id) && <StageEditorInline editor={stageEditor} setEditor={setStageEditor} projectType={project.project_type} onSave={onSaveStage} onCancel={onCloseStageEditor} saving={stageSaving} />}
      </div>;
    }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无阶段" />}
  </Card>;
}

function StageEditorInline({ editor, setEditor, projectType, onSave, onCancel, saving }) {
  const update = (key, value) => setEditor?.((current) => ({ ...current, [key]: value }));
  const modes = allowedModes(projectType, editor.stage_type);
  const mode = editor.vote_mode;
  return <div className="cm-vote-stage-editor" onClick={(event) => event.stopPropagation()}><div className="cm-vote-inline-heading"><div><Typography.Text strong>阶段配置</Typography.Text><Typography.Text type="secondary">已有运行池时，核心配置会按后端规则触发安全重建保护。</Typography.Text></div><Button type="text" onClick={onCancel}>取消</Button></div><div className="cm-vote-form-grid">
    <label>阶段类型<Select value={editor.stage_type} onChange={(value) => { update('stage_type', value); update('vote_mode', allowedModes(projectType, value)[0]); }} options={Object.entries(STAGE_TYPES).map(([value, label]) => ({ value, label }))} /></label>
    <label>投票模式<Select value={mode} onChange={(value) => update('vote_mode', value)} options={modes.map((value) => ({ value, label: VOTE_MODES[value] }))} /></label>
    <label>阶段标题<Input value={editor.title} onChange={(event) => update('title', event.target.value)} /></label>
    <label>开始时间<Input type="datetime-local" value={toDateTimeLocal(editor.starts_at)} onChange={(event) => update('starts_at', event.target.value)} /></label>
    <label>截止时间<Input type="datetime-local" value={toDateTimeLocal(editor.ends_at)} onChange={(event) => update('ends_at', event.target.value)} /></label>
    <label>晋级数量<InputNumber min={0} value={editor.advance_count} onChange={(value) => update('advance_count', value)} /></label>
    {mode === 'nomination' && <label>每人可提名数量<InputNumber min={1} value={editor.max_select} onChange={(value) => update('max_select', value)} /></label>}
    {mode === 'multi_select' && <><label>每人最多选择<InputNumber min={1} value={editor.max_select} onChange={(value) => update('max_select', value)} /></label><label>分组数量<InputNumber min={1} value={editor.group_count} onChange={(value) => update('group_count', value)} /></label><label>每组晋级预览<InputNumber min={0} value={editor.group_count ? Math.floor(num(editor.advance_count) / num(editor.group_count, 1)) : 0} readOnly /></label></>}
    {mode === 'score' && <><label>评分下限<InputNumber min={0} value={editor.score_min} onChange={(value) => update('score_min', value)} /></label><label>评分上限<InputNumber min={1} value={editor.score_max} onChange={(value) => update('score_max', value)} /></label><label>分组数量<InputNumber min={1} value={editor.group_count} onChange={(value) => update('group_count', value)} /></label></>}
    {mode === 'match_single' && <label>对阵规模<InputNumber min={0} value={editor.bracket_size || 0} onChange={(value) => update('bracket_size', value)} placeholder="留空由萌战阶段推导" /></label>}
    <label>来源阶段 ID<InputNumber min={0} value={editor.source_stage_id || 0} onChange={(value) => update('source_stage_id', value)} /></label><label>结果显示<Select value={editor.result_visibility} onChange={(value) => update('result_visibility', value)} options={Object.entries(RESULT_VISIBILITIES).map(([value, label]) => ({ value, label }))} /></label>
  </div><Space wrap className="cm-vote-stage-toggles"><Switch checked={Boolean(editor.allow_vote_change)} onChange={(value) => update('allow_vote_change', value)} />允许改票<Switch checked={Boolean(editor.allow_zero_fill)} onChange={(value) => update('allow_zero_fill', value)} />零票补位<Space size={4}><Typography.Text type="secondary">平票：</Typography.Text><Select value={editor.tie_rule || 'manual'} onChange={(value) => update('tie_rule', value)} options={[{ value: 'manual', label: '人工裁定' }]} /></Space></Space><div className="cm-vote-form-note">分组数必须大于 0；分组赛的晋级数量必须能被分组数整除；保存时会兼容后端 `YYYY-MM-DD HH:mm:ss` 时间格式。</div><Button type="primary" onClick={onSave} loading={saving}>保存阶段</Button></div>;
}

function NominationPool({ entries, canManage, selectedEntryIds, setSelectedEntryIds, filter, setFilter, query, setQuery, page, setPage, expanded, setExpanded, onEntryAction, onBatchAction }) {
  const needle = query.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    const status = entry.entry_status || entry.status || 'approved';
    const selected = selectedEntryIds.includes(Number(entryIdOf(entry)));
    const matchesStatus = filter === 'active' ? status !== 'removed' : filter === 'removed' ? status === 'removed' : selected;
    return matchesStatus && (!needle || `${entryTitleOf(entry)} ${entryWorkOf(entry)} ${entry.source_note || entry.source || entry.nominator_name || ''}`.toLowerCase().includes(needle));
  });
  const pageSize = 16;
  const shown = expanded ? filtered : filtered.slice(0, page * pageSize);
  const visibleIds = shown.map((entry) => Number(entryIdOf(entry))).filter(Boolean);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedEntryIds.includes(id));
  const toggle = (id) => setSelectedEntryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const selectAll = () => setSelectedEntryIds((current) => allVisibleSelected ? current.filter((id) => !visibleIds.includes(id)) : [...new Set([...current, ...visibleIds])]);
  return <Card className="cm-vote-pool-card" title={<Space className="cm-vote-card-title">提名池 <Tag>{entries.length}</Tag></Space>} extra={<Space wrap><Button size="small" onClick={selectAll} disabled={!shown.length}>{allVisibleSelected ? '取消全选' : '全选有效候选'}</Button>{selectedEntryIds.length > 0 && <Button size="small" danger onClick={() => onBatchAction('remove')} disabled={!canManage}>批量排除 {selectedEntryIds.length}</Button>}{filter === 'removed' && selectedEntryIds.length > 0 && <Button size="small" onClick={() => onBatchAction('restore')} disabled={!canManage}>批量恢复</Button>}</Space>}>
    <div className="cm-vote-pool-toolbar"><Input.Search className="cm-vote-pool-search" value={query} onChange={(event) => setQuery(event.target.value)} allowClear placeholder="搜索提名标题、作品名或来源说明" /><Space wrap className="cm-vote-filter-tabs">{[['active', '有效'], ['selected', '已选'], ['removed', '已排除']].map(([value, label]) => <button type="button" key={value} className={filter === value ? 'is-active' : ''} onClick={() => { setFilter(value); setPage(1); }}>{label} <span>{value === 'removed' ? entries.filter((entry) => (entry.entry_status || entry.status) === 'removed').length : value === 'selected' ? entries.filter((entry) => selectedEntryIds.includes(Number(entryIdOf(entry)))).length : entries.filter((entry) => (entry.entry_status || entry.status) !== 'removed').length}</span></button>)}</Space></div>
    {shown.length ? <div className="cm-vote-candidate-grid">{shown.map((entry, index) => <CandidateCard key={entryIdOf(entry) || index} entry={entry} selected={selectedEntryIds.includes(Number(entryIdOf(entry)))} selectable={canManage} onClick={() => toggle(Number(entryIdOf(entry)))} canManage={canManage} onEntryAction={onEntryAction} />)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={needle ? '没有符合搜索条件的候选' : '当前筛选没有候选'} />}
    {filtered.length > shown.length && <div className="cm-vote-pool-footer"><Button onClick={() => setPage(page + 1)}>展开更多（每页 16 项）</Button><Button type="link" onClick={() => setExpanded(true)}>展开全部 {filtered.length} 项</Button></div>}
    {expanded && filtered.length > pageSize && <div className="cm-vote-pool-footer"><Button type="link" onClick={() => setExpanded(false)}>收起到分页</Button></div>}
  </Card>;
}

function CandidateCard({ entry, selected, selectable, onClick, canManage, onEntryAction }) {
  const removed = (entry.entry_status || entry.status) === 'removed';
  const image = entryImageOf(entry);
  return <article className={`cm-vote-candidate${selected ? ' is-selected' : ''}${removed ? ' is-removed' : ''}`}><button type="button" className="cm-vote-candidate-hit" onClick={onClick} disabled={!selectable}><span className="cm-vote-candidate-avatar">{image ? <img src={image} alt="" /> : <span>{String(entryTitleOf(entry)).slice(0, 2)}</span>}</span><span className="cm-vote-candidate-copy"><strong>{entryTitleOf(entry)}</strong><small>{entryWorkOf(entry) || '未填写作品信息'}</small><em>{entry.source_note || entry.source || entry.nominator_name || (removed ? '已排除' : '有效候选')}</em></span><span className="cm-vote-candidate-check" aria-hidden="true">{selected ? '✓' : ''}</span></button><div className="cm-vote-candidate-actions">{removed ? <Button type="link" size="small" onClick={() => onEntryAction(entry, 'restore')} disabled={!canManage}>恢复</Button> : <Button type="link" danger size="small" onClick={() => onEntryAction(entry, 'remove')} disabled={!canManage}>排除</Button>}</div></article>;
}

function StagePool({ stage, pool, rows, canManage, filter, setFilter, group, setGroup, onRefresh, onPoolAction, onStageAction }) {
  const groups = [...new Set(rows.map((row) => row.group_key).filter(Boolean))];
  const visible = rows.filter((row) => group === 'all' || row.group_key === group).sort((a, b) => num(a.rank || a.rank_no, 99999) - num(b.rank || b.rank_no, 99999) || num(b.votes || b.vote_count) - num(a.votes || a.vote_count) || num(a.seed_no, 99999) - num(b.seed_no, 99999) || num(entryIdOf(a), 99999) - num(entryIdOf(b), 99999));
  const runtime = pool?.runtime || {};
  const hasTie = (runtime.tie_breaks || []).length > 0;
  return <Card className="cm-vote-stage-pool" title={<Space className="cm-vote-card-title">阶段池 · {stage.title} <Tag color={pool?.status === 'open' ? 'green' : 'blue'}>{labelOf(STAGE_STATUSES, pool?.status || stage.status)}</Tag><Tag>{rows.length} 项</Tag></Space>} extra={<Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button>}>
    {pool && <div className="cm-vote-pool-summary"><span>候选 <strong>{pool.entry_count ?? rows.length}</strong></span><span>票数 <strong>{pool.vote_count ?? 0}</strong></span><span>结果 <strong>{pool.result_count ?? 0}</strong></span></div>}
    <Space wrap className="cm-vote-action-row">{stage.status === 'open' && <Button onClick={() => onStageAction('lock', stage)} disabled={!canManage}>锁定阶段</Button>}{pool?.status === 'pending' && <Button onClick={() => onPoolAction('open_pool', pool, stage)} disabled={!canManage}>开放阶段池</Button>}{pool?.status === 'open' && <Button onClick={() => onPoolAction('settle_pool', pool, stage)} disabled={!canManage}>结算阶段池</Button>}{pool?.status === 'settled' && <Button onClick={() => onPoolAction('generate_next_pool', pool, stage)} disabled={!canManage}>生成下一阶段池</Button>}{hasTie && <Button type="primary" onClick={() => onPoolAction('resolve_flow_tie', pool, stage)} disabled={!canManage}>处理流程平票</Button>}</Space>
    <div className="cm-vote-pool-toolbar"><Space wrap className="cm-vote-filter-tabs"><button type="button" className={filter === 'active' ? 'is-active' : ''} onClick={() => setFilter('active')}>全部候选</button><button type="button" className={filter === 'grouped' ? 'is-active' : ''} onClick={() => setFilter('grouped')}>按分组</button></Space><Select value={group} onChange={setGroup} options={[{ value: 'all', label: '全部分组' }, ...groups.map((value) => ({ value, label: value }))]} /></div>
    {visible.length ? <div className="cm-vote-stage-entry-list">{visible.map((entry, index) => <div className="cm-vote-stage-entry" key={entryIdOf(entry) || index}><Tag color="blue">#{entry.rank || entry.rank_no || index + 1}</Tag><div><strong>{entryTitleOf(entry)}</strong><small>{entry.group_key || '未分组'} · 种子 {entry.seed_no || '—'} · 来源排名 {entry.source_rank || '—'}</small></div><span className="cm-vote-stage-votes">{entry.votes ?? entry.vote_count ?? 0} 票</span></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无阶段池候选" />}
  </Card>;
}

function MatchWorkbench({ stage, pool, matches, entryById, canManage, onPoolAction, onManualMatch }) {
  const rounds = [...new Set(matches.map((match) => num(match.round_no, 1)))].sort((a, b) => a - b);
  const open = matches.filter((match) => match.status !== 'settled').length;
  const settled = matches.length - open;
  const pending = matches.filter((match) => !match.slot_a_entry_id || !match.slot_b_entry_id).length;
  const ties = matches.filter((match) => match.is_tie || (match.slot_a_votes != null && match.slot_a_votes === match.slot_b_votes && match.status !== 'settled')).length;
  const flowTies = [...(pool?.runtime?.tie_breaks || []), ...(pool?.runtime?.match_tie_breaks || [])];
  return <Card className="cm-vote-match-workbench" title={<Space className="cm-vote-card-title">对阵工作台 <Tag color="green">投票中 {open}</Tag><Tag color="blue">已结算 {settled}</Tag><Tag>待开放 {pending}</Tag></Space>} extra={<Space wrap><Button size="small" onClick={() => onPoolAction('generate_matches', pool || { id: stage.id }, stage)} disabled={!canManage}>生成对阵</Button><Button size="small" type="primary" onClick={() => onPoolAction('settle_by_votes', pool || { id: stage.id }, stage)} disabled={!canManage || !matches.length}>按票结算</Button></Space>}>
    {(pending > 0 || ties > 0 || flowTies.length > 0) && <Alert type="warning" showIcon message={`${ties ? `${ties} 场平票` : ''}${ties && pending ? ' · ' : ''}${pending ? `${pending} 场缺槽` : ''}${flowTies.length ? `${ties || pending ? ' · ' : ''}${flowTies.length} 项流程裁定` : ''}`} description="平票保留给人工裁定，缺槽对阵不会被自动判定。" action={flowTies.length > 0 ? <Button size="small" type="primary" onClick={() => onPoolAction('resolve_flow_tie', pool, stage)} disabled={!canManage}>处理流程平票</Button> : null} />}
    {rounds.length ? rounds.map((round) => <div className="cm-vote-round" key={round}><div className="cm-vote-round-heading"><Typography.Text strong>{round === rounds[rounds.length - 1] && rounds.length > 1 ? '冠军赛 / 决赛' : round === rounds.length - 1 ? '决赛' : `第 ${round} 轮`}</Typography.Text><Typography.Text type="secondary">{matches.filter((match) => num(match.round_no, 1) === round).length} 场</Typography.Text></div>{matches.filter((match) => num(match.round_no, 1) === round).map((match) => <MatchRow key={match.id} match={match} entryById={entryById} canManage={canManage} onManualMatch={onManualMatch} />)}</div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无对阵" />}
  </Card>;
}

function MatchRow({ match, entryById, canManage, onManualMatch }) {
  const a = entryById.get(String(match.slot_a_entry_id));
  const b = entryById.get(String(match.slot_b_entry_id));
  const tie = match.is_tie || (match.slot_a_votes != null && match.slot_a_votes === match.slot_b_votes && match.status !== 'settled');
  const winner = entryById.get(String(match.winner_entry_id));
  return <div className={`cm-vote-match-row${tie ? ' is-tie' : ''}${(!a || !b) ? ' is-missing' : ''}`}><div className="cm-vote-match-copy"><span className="cm-vote-match-label">{match.match_label || `第 ${match.match_no || 1} 场`}</span><strong>{entryTitleOf(a)} <b>vs</b> {entryTitleOf(b)}</strong><small>A {match.slot_a_votes ?? 0} 票 · B {match.slot_b_votes ?? 0} 票{winner ? ` · 胜者：${entryTitleOf(winner)}` : ''}</small></div><div className="cm-vote-match-actions">{tie && <Tag color="orange">平票待裁定</Tag>}{(!a || !b) && <Tag color="red">缺槽</Tag>}{match.status === 'settled' ? <Tag color="green">已结算</Tag> : <Space wrap><Button size="small" onClick={() => onManualMatch(match, match.slot_a_entry_id)} disabled={!canManage || !a}>判 A 胜</Button><Button size="small" onClick={() => onManualMatch(match, match.slot_b_entry_id)} disabled={!canManage || !b}>判 B 胜</Button></Space>}</div></div>;
}

function AwardsPanel({ project, results, king, canManage, onLoad, onSync }) {
  const rows = results?.rows || [];
  const champion = rows.find((row) => Number(row.rank_no) === 1) || rows[0];
  return <Space direction="vertical" size={12} className="cm-vote-stack"><Card title="结果与奖项" extra={<Button onClick={onLoad} icon={<ReloadOutlined />}>读取决赛结果</Button>}>{results ? <List dataSource={rows} renderItem={(row, index) => <List.Item actions={[project.project_type === 'moe' && index === 0 ? <Button key="sync" type="primary" size="small" onClick={() => onSync(row)} disabled={!canManage}>同步萌王</Button> : null]}><List.Item.Meta avatar={<Tag color={index === 0 ? 'gold' : undefined}>#{row.rank_no || index + 1}</Tag>} title={row.title_cn || row.title || `候选 #${row.entry_id}`} description={`票数 ${row.votes ?? 0}${row.score_avg != null ? ` · 平均分 ${Number(row.score_avg).toFixed(2)}` : ''}`} /></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="读取决赛结果后显示奖项" />}</Card>{project.project_type === 'moe' && <Card title="萌王同步状态"><Descriptions size="small" column={1}><Descriptions.Item label="当前冠军">{champion?.title_cn || champion?.title || '待定'}</Descriptions.Item><Descriptions.Item label="同好会记录">{king?.name_cn || king?.name || '尚未设置'}</Descriptions.Item><Descriptions.Item label="同步状态">{king ? '已存在记录，可覆盖同步' : '等待首次同步'}</Descriptions.Item></Descriptions>{champion && <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => onSync(champion)} disabled={!canManage}>将当前冠军同步到同好会</Button>}</Card>}</Space>;
}
