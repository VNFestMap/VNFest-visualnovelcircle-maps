import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Input, Modal, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import { CloseOutlined, SearchOutlined, StarFilled } from '@ant-design/icons';
import { api, normalizeError } from '../api.js';
import { EmptyPanel, ErrorPanel, PageHeading, ProfileAvatar, SectionHeading } from '../components.jsx';
import { useClubManager } from '../context.jsx';

export const REC_SLOT_COUNT = 12;

export function buildRecommendationSlots(rows) {
  const slots = Array(REC_SLOT_COUNT).fill(null);
  for (const row of rows || []) {
    const position = Number(row.sort_order);
    if (Number.isInteger(position) && position >= 0 && position < REC_SLOT_COUNT && !slots[position]) slots[position] = row;
    else {
      const empty = slots.findIndex((entry) => !entry);
      if (empty >= 0) slots[empty] = row;
    }
  }
  return slots;
}

export default function RecommendationsTab() {
  const { selected, messageApi, refreshVersion } = useClubManager();
  const [rows, setRows] = useState([]);
  const [moeKing, setMoeKing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [targetSlot, setTargetSlot] = useState(null);
  const [movingSlot, setMovingSlot] = useState(null);
  const [draggedSlot, setDraggedSlot] = useState(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [moeQuery, setMoeQuery] = useState('');
  const [moeResults, setMoeResults] = useState([]);
  const [moeSearching, setMoeSearching] = useState(false);
  const slots = useMemo(() => buildRecommendationSlots(rows), [rows]);

  const load = useCallback(async () => {
    if (selected.clubId <= 0) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const [recommendations, king] = await Promise.all([
        api.get(`club_recommendations.php?action=list&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`),
        api.get(`club_moe_king.php?action=get&club_id=${selected.clubId}&country=${encodeURIComponent(selected.country)}`),
      ]);
      setRows(recommendations.data || []);
      setMoeKing(king.data || null);
    } catch (loadError) { setError(normalizeError(loadError)); }
    finally { setLoading(false); }
  }, [refreshVersion, selected]);
  useEffect(() => { load(); }, [load]);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true); setHasSearched(true);
    try { const result = await api.get(`bangumi_proxy.php?action=search&keyword=${encodeURIComponent(query.trim())}`); setResults(result.data || []); }
    catch (searchError) { messageApi.error(normalizeError(searchError)); setResults([]); }
    finally { setSearching(false); }
  };

  const add = async (item) => {
    const destination = targetSlot !== null && !slots[targetSlot] ? targetSlot : slots.findIndex((entry) => !entry);
    if (destination < 0) return messageApi.error('推荐榜已填满，请先移除或调整已有条目');
    let rating = Number(item.rating || 0);
    try {
      const detail = await api.get(`bangumi_proxy.php?action=get&id=${Number(item.bangumi_id)}`);
      rating = Number(detail.data?.rating?.score || detail.data?.score || rating);
    } catch { /* Search result rating remains the fallback. */ }
    try {
      await api.post('club_recommendations.php?action=add', {
        club_id: selected.clubId, country: selected.country, bangumi_id: Number(item.bangumi_id),
        title: item.title_cn || item.title, image_url: item.image_url || '', rating,
        summary: item.summary || '', position: destination + 1,
      });
      setTargetSlot(null); messageApi.success('已添加到推荐榜'); await load();
    } catch (addError) { messageApi.error(normalizeError(addError)); }
  };

  const persistSlots = async (nextSlots, previousSlots) => {
    setReorderBusy(true);
    setRows(nextSlots.flatMap((item, index) => item ? [{ ...item, sort_order: index }] : []));
    try {
      /* Body matches the pre-migration request: the API resolves the club from
         the entry ids, so only the twelve-slot payload is sent. */
      await api.post('club_recommendations.php?action=reorder', {
        slots: nextSlots.map((item) => item ? Number(item.id) : null),
      });
      messageApi.success('推荐位置已更新');
    } catch (moveError) {
      setRows(previousSlots.flatMap((item, index) => item ? [{ ...item, sort_order: index }] : []));
      messageApi.error(normalizeError(moveError));
    } finally { setReorderBusy(false); setMovingSlot(null); setDraggedSlot(null); }
  };

  const move = (from, to) => {
    if (reorderBusy || from === null || from === to || !slots[from]) return;
    const before = [...slots];
    const next = [...slots];
    [next[from], next[to]] = [next[to], next[from]];
    persistSlots(next, before);
  };
  const selectSlot = (index) => {
    if (reorderBusy) return;
    if (slots[index]) {
      if (movingSlot === null) setMovingSlot(index);
      else move(movingSlot, index);
      return;
    }
    if (movingSlot !== null) move(movingSlot, index);
    else setTargetSlot(index === targetSlot ? null : index);
  };

  const remove = async (id) => {
    try { await api.post('club_recommendations.php?action=remove', { id }); messageApi.success('已从推荐榜移除'); await load(); }
    catch (removeError) { messageApi.error(normalizeError(removeError)); }
  };

  const searchMoe = async () => {
    if (!moeQuery.trim()) return;
    setMoeSearching(true);
    try { const result = await api.get(`bangumi_proxy.php?action=search_character&keyword=${encodeURIComponent(moeQuery.trim())}`); setMoeResults(result.data || []); }
    catch (searchError) { messageApi.error(normalizeError(searchError)); setMoeResults([]); }
    finally { setMoeSearching(false); }
  };
  const setKing = async (item) => {
    try {
      await api.post('club_moe_king.php?action=set', {
        club_id: selected.clubId, country: selected.country, character_id: item.character_id,
        name: item.name || '', name_cn: item.name_cn || '', image_url: item.image_url || '', summary: item.summary || '',
      });
      messageApi.success('萌王已更新'); setMoeResults([]); await load();
    } catch (kingError) { messageApi.error(normalizeError(kingError)); }
  };
  const removeKing = async () => {
    try { await api.post('club_moe_king.php?action=remove', { club_id: selected.clubId, country: selected.country }); messageApi.success('萌王已移除'); await load(); }
    catch (kingError) { messageApi.error(normalizeError(kingError)); }
  };

  if (selected.clubId <= 0) return <section className="cm-page"><PageHeading title="神器榜" /><EmptyPanel description="请先在左侧选择一个同好会" /></section>;
  return (
    <section className="cm-page" data-component="同好会神器榜">
      <PageHeading title="神器榜" description="维护十二个固定推荐位置和本会萌王。" />
      {loading ? <div className="cm-tab-loading"><Spin /></div> : error ? <ErrorPanel message={error} onRetry={load} /> : <>
        <div className="cm-two-column">
          <Card className="cm-panel" title={<SectionHeading title="搜索 Bangumi" />}>
            <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} onSearch={search} enterButton={<SearchOutlined />} loading={searching} placeholder="搜索游戏名称" />
            <div className="cm-search-results">
              {!results.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasSearched ? '未找到相关结果' : '输入关键词开始搜索'} /> : results.map((item) => {
                const added = rows.some((row) => Number(row.bangumi_id) === Number(item.bangumi_id));
                return <div className="cm-search-row" key={item.bangumi_id}><ProfileAvatar className="cm-rec-cover" value={item.image_url} name={item.title_cn || item.title} shape="square" size={48} /><div><strong>{item.title_cn || item.title}</strong><Typography.Text type="secondary">{item.rating ? `评分 ${item.rating}` : item.air_date || ''}</Typography.Text></div><Button type="primary" size="small" disabled={added} onClick={() => add(item)}>{added ? '已添加' : `添加到${targetSlot === null ? '首个空位' : `第 ${targetSlot + 1} 位`}`}</Button></div>;
              })}
            </div>
          </Card>
          <Card className="cm-panel" title={<SectionHeading title={<>当前推荐榜 <Typography.Text type="secondary">（{slots.filter(Boolean).length} / 12）</Typography.Text></>} />}>
            <Typography.Paragraph type="secondary">点击空位后添加；桌面端可拖拽，手机端点击条目后再点击目标位置。</Typography.Paragraph>
            <div className="rec-list cm-recommendation-grid" role="list" aria-label="十二个推荐榜位置">
              {slots.map((item, index) => item ? (
                <div
                  className={`rec-card cm-rec-slot is-filled${movingSlot === index ? ' is-moving' : ''}`}
                  data-rec-slot={index} data-rank={index + 1} key={item.id} draggable
                  onDragStart={() => setDraggedSlot(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => move(draggedSlot, index)}
                  onClick={(event) => { if (!event.target.closest('button')) selectSlot(index); }} role="button" tabIndex={0} aria-pressed={movingSlot === index}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectSlot(index); }}
                >
                  <span className="cm-slot-number">{index + 1}</span><ProfileAvatar className="cm-rec-cover" value={item.image_url} name={item.title} shape="square" size={52} />
                  <div className="cm-slot-copy"><strong>{item.title}</strong>{item.rating ? <span><StarFilled /> {item.rating}</span> : null}</div>
                  <Button type="text" danger icon={<CloseOutlined />} aria-label={`移除第 ${index + 1} 位`} onClick={(event) => { event.stopPropagation(); Modal.confirm({ title: '确定从推荐榜移除？', okText: '确定', cancelText: '取消', onOk: () => remove(item.id) }); }} />
                </div>
              ) : (
                <button type="button" className={`rec-card rec-card-empty cm-rec-slot${targetSlot === index ? ' is-target' : ''}`} data-rec-slot={index} key={`empty-${index}`} onClick={() => selectSlot(index)}>
                  <span className="cm-slot-number">{index + 1}</span><span>空缺</span><small>{movingSlot === null ? '点击选择此位置' : '点击移动到这里'}</small>
                </button>
              ))}
            </div>
          </Card>
        </div>
        <Card className="cm-panel" title={<SectionHeading title="萌王" />}>
          {moeKing ? <div className="cm-search-row"><ProfileAvatar className="cm-character-avatar" value={moeKing.image_url} name={moeKing.name_cn || moeKing.name} shape="square" size={56} /><div><strong>{moeKing.name_cn || moeKing.name}</strong><Typography.Text type="secondary">当前萌王 · #{moeKing.character_id}</Typography.Text></div><Popconfirm title="确定移除当前萌王？" onConfirm={removeKing}><Button danger>移除</Button></Popconfirm></div> : <Typography.Paragraph type="secondary">暂未设置萌王</Typography.Paragraph>}
          <Input.Search value={moeQuery} onChange={(event) => setMoeQuery(event.target.value)} onSearch={searchMoe} loading={moeSearching} enterButton="搜索角色" placeholder="搜索 Bangumi 角色" />
          <div className="cm-search-results">{moeResults.map((item) => <div className="cm-search-row" key={item.character_id}><ProfileAvatar className="cm-character-avatar" value={item.image_url} name={item.name_cn || item.name} shape="square" size={48} /><div><strong>{item.name_cn || item.name || `角色 #${item.character_id}`}</strong><Typography.Text type="secondary">{String(item.summary || '').slice(0, 80)}</Typography.Text></div><Button onClick={() => setKing(item)}>设为萌王</Button></div>)}</div>
        </Card>
      </>}
    </section>
  );
}
