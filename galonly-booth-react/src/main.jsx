import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import './styles.css';
import '../../css/button-shapes.css';

const EVENT_CODE = new URLSearchParams(window.location.search).get('event_code') || 'beijing';
const API = '../api/galonly_booths.php';

async function api(action, { method = 'GET', body, query = {}, formData } = {}) {
  const params = new URLSearchParams({ action, event_code: EVENT_CODE, ...query });
  const options = { method, credentials: 'include', headers: {} };
  if (formData) options.body = formData;
  else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${API}?${params}`, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { success: false, message: '服务器返回格式无效' }; }
  if (!response.ok || data.success === false) {
    const error = new Error(data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function clone(value) { return JSON.parse(JSON.stringify(value ?? {})); }

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCredentialCsv(booths) {
  const rows = [
    ['区域', '摊位组', '桌位', '摊位名称', '登录账号', '初始密码', '密码状态', '账号状态', '说明'],
    ...[...booths].sort((a, b) => String(a.booth_id || '').localeCompare(String(b.booth_id || ''), 'zh-CN', { numeric: true, sensitivity: 'base' })).map((booth) => {
      const account = booth.account || {};
      const passwordChanged = Boolean(account.password_changed);
      const initialPassword = passwordChanged ? '' : (account.initial_password || '');
      return [
        String(booth.booth_id || '').slice(0, 1).toUpperCase(),
        booth.booth_id || '',
        (booth.table_ids || []).join('、'),
        booth.profile?.name || '',
        account.username || '',
        initialPassword,
        passwordChanged ? '已修改' : (initialPassword ? '未修改' : '待重置'),
        account.status === 'active' ? '可登录' : '已停用',
        passwordChanged ? '初始密码不可恢复，请在控制台重置' : (initialPassword ? '' : '当前没有可显示的初始密码，请重置账号'),
      ];
    }),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  anchor.href = url;
  anchor.download = `beijing-galonly-booth-credentials-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uploadImageWithProgress(file, { boothId, asset = 'product', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ action: 'upload_image', event_code: EVENT_CODE });
    if (boothId) params.set('booth_id', boothId);
    params.set('asset', asset);
    const request = new XMLHttpRequest();
    request.open('POST', `${API}?${params}`);
    request.withCredentials = true;
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      let data = {};
      try { data = request.responseText ? JSON.parse(request.responseText) : {}; } catch { data = { success: false, message: '服务器返回格式无效' }; }
      if (request.status < 200 || request.status >= 300 || data.success === false) {
        const error = new Error(data.message || `上传失败（${request.status}）`);
        error.status = request.status;
        error.data = data;
        reject(error);
        return;
      }
      resolve(data);
    });
    request.addEventListener('error', () => reject(new Error('图片上传失败，请检查网络连接')));
    request.addEventListener('abort', () => reject(new Error('图片上传已取消')));
    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

function blankProduct() {
  return {
    id: `product-${Date.now()}`,
    name: '', priceCents: 0, kind: '制品', unit: '件', spec: '标准',
    description: '', status: 'available', badge: '', variants: ['标准'],
    imageUrl: null, note: '',
  };
}

function normalizeProfile(profile = {}) {
  const result = clone(profile);
  result.tags = Array.isArray(result.tags) ? result.tags : [];
  result.products = Array.isArray(result.products) ? result.products.map((item) => ({
    ...blankProduct(), ...item,
    variants: Array.isArray(item.variants) && item.variants.length ? item.variants : ['标准'],
  })) : [];
  result.contact = result.contact && typeof result.contact === 'object' ? result.contact : { label: '', url: null };
  return result;
}

function useNotice() {
  const [notice, setNotice] = useState(null);
  const show = (message, kind = 'success') => {
    setNotice({ message, kind });
    window.setTimeout(() => setNotice(null), 4200);
  };
  return [notice, show];
}

function Notice({ notice }) { return notice ? <div className={`notice ${notice.kind}`}>{notice.message}</div> : null; }

function Header({ title, subtitle, action }) {
  return <header className="masthead">
    <div><div className="eyebrow">BEIJING GALONLY · BOOTH PORTAL</div><h1>{title}</h1><p>{subtitle}</p></div>
    <div className="header-action">{action || <span className="event-pill">活动：北京 GalOnly</span>}</div>
  </header>;
}

function Field({ label, hint, children, wide = false }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function AvatarEditor({ value, onChange, onUpload, saving = false }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const imageRef = useRef(null);
  const cropperRef = useRef(null);
  const sourceRef = useRef('');

  const closeCrop = () => {
    cropperRef.current?.destroy();
    cropperRef.current = null;
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    sourceRef.current = '';
    setSource('');
    setBusy(false);
    setProgress(0);
    setError('');
  };

  useEffect(() => () => {
    cropperRef.current?.destroy();
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
  }, []);

  useEffect(() => {
    if (!source || !imageRef.current) return undefined;
    cropperRef.current?.destroy();
    cropperRef.current = new Cropper(imageRef.current, {
      aspectRatio: 1,
      viewMode: 1,
      dragMode: 'move',
      autoCropArea: 1,
      cropBoxMovable: false,
      cropBoxResizable: false,
      toggleDragModeOnDblclick: false,
      background: false,
    });
    return () => {
      cropperRef.current?.destroy();
      cropperRef.current = null;
    };
  }, [source]);

  const chooseFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('图片不能超过 10MB');
      return;
    }
    const types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (file.type && !types.includes(file.type)) {
      setError('仅支持 JPEG、PNG、GIF、WebP 格式');
      return;
    }
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current);
    const nextSource = URL.createObjectURL(file);
    sourceRef.current = nextSource;
    setError('');
    setSource(nextSource);
  };

  const confirmCrop = async () => {
    const cropper = cropperRef.current;
    if (!cropper || !onUpload || busy) return;
    setBusy(true);
    setProgress(0);
    setError('');
    try {
      const canvas = cropper.getCroppedCanvas({ width: 512, height: 512, imageSmoothingQuality: 'high' });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error('头像裁剪失败，请重试');
      const file = new File([blob], `avatar-${Date.now()}.webp`, { type: 'image/webp' });
      const url = await onUpload(file, (next) => setProgress(next));
      if (!url) throw new Error('头像上传未返回图片地址');
      onChange(url);
      closeCrop();
    } catch (uploadError) {
      setError(uploadError.message || '头像上传失败，请重试');
      setBusy(false);
    }
  };

  return <div className="avatar-editor">
    <div className="avatar-editor-head">
      <div><strong>摊位头像</strong><small>公开显示在摊位详情、摊位列表和我的清单</small></div>
      {value ? <img className="avatar-preview" src={value} alt="当前摊位头像" /> : <span className="avatar-placeholder">暂无头像</span>}
    </div>
    <div className="avatar-editor-actions">
      <label className="button secondary avatar-file-button">{value ? '更换头像' : '上传头像'}<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" disabled={saving || busy} onChange={chooseFile} /></label>
      {value && <button className="button ghost" type="button" disabled={saving || busy} onClick={() => onChange(null)}>移除头像</button>}
    </div>
    <small className="avatar-help">选择图片后会先进行 1:1 正方形裁剪，确认裁剪并上传后仍需点击“保存资料”。</small>
    {error && <small className="avatar-error" role="alert">{error}</small>}
    {source && <div className="avatar-crop-backdrop" role="presentation">
      <div className="avatar-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="avatarCropTitle">
        <div className="avatar-crop-head"><div><strong id="avatarCropTitle">裁剪摊位头像</strong><small>拖动图片调整位置，滚轮或双指缩放</small></div><button className="text-button" type="button" disabled={busy} onClick={closeCrop} aria-label="关闭裁剪窗口">×</button></div>
        <div className="avatar-crop-frame"><img ref={imageRef} src={source} alt="头像裁剪预览" /></div>
        {busy && <div className="avatar-upload-progress" role="status" aria-live="polite"><span>头像上传中…</span><strong>{progress}%</strong><div><i style={{ width: `${progress}%` }} /></div></div>}
        {error && <small className="avatar-error">{error}</small>}
        <div className="avatar-crop-actions"><button className="button ghost" type="button" disabled={busy} onClick={closeCrop}>取消</button><button className="button primary" type="button" disabled={busy} onClick={confirmCrop}>{busy ? '上传中…' : '确认裁剪并上传'}</button></div>
      </div>
    </div>}
  </div>;
}

function ProfileForm({ value, onChange, onUpload, onAvatarUpload, saving = false }) {
  const profile = normalizeProfile(value);
  const [uploadingIndex, setUploadingIndex] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const setField = (key, next) => onChange({ ...profile, [key]: next });
  const setProduct = (index, key, next) => setField('products', profile.products.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: next } : item));
  const removeProduct = (index) => setField('products', profile.products.filter((_, itemIndex) => itemIndex !== index));
  const uploadProduct = async (index, file) => {
    if (!file || !onUpload) return;
    setUploadingIndex(index);
    setUploadProgress(0);
    try {
      const image = await onUpload(file, (progress) => setUploadProgress(progress));
      if (image) setProduct(index, 'imageUrl', image);
    } catch (error) { window.alert(error.message); }
    finally { setUploadingIndex(null); setUploadProgress(0); }
  };
  return <div className="profile-editor">
    <div className="form-grid">
      <Field label="展示名称"><input value={profile.name || ''} onChange={(event) => setField('name', event.target.value)} placeholder="地图上展示的名称" /></Field>
      <Field label="社团 / 摊主名称"><input value={profile.circleName || ''} onChange={(event) => setField('circleName', event.target.value)} placeholder="可留空" /></Field>
      <div className="avatar-field wide"><AvatarEditor value={profile.avatarUrl || ''} onChange={(next) => setField('avatarUrl', next || null)} onUpload={onAvatarUpload} saving={saving} /></div>
      <Field label="一句话介绍" wide><input value={profile.tagline || ''} onChange={(event) => setField('tagline', event.target.value)} placeholder="让游客快速了解你们" /></Field>
      <Field label="详细介绍" wide><textarea rows="4" value={profile.description || ''} onChange={(event) => setField('description', event.target.value)} placeholder="作品、社团、活动内容等" /></Field>
      <Field label="公告" wide><textarea rows="3" value={profile.announcement || ''} onChange={(event) => setField('announcement', event.target.value)} placeholder="现场安排、领取方式等" /></Field>
      <Field label="标签" hint="用逗号分隔"><input value={(profile.tags || []).join(', ')} onChange={(event) => setField('tags', event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))} placeholder="视觉小说, 周边" /></Field>
      <Field label="营业状态"><select value={profile.status || 'open'} onChange={(event) => setField('status', event.target.value)}><option value="open">营业中</option><option value="preparing">准备中</option><option value="rest">暂时离席</option></select></Field>
      <Field label="联系方式名称"><input value={profile.contact?.label || ''} onChange={(event) => setField('contact', { ...profile.contact, label: event.target.value })} placeholder="如：微博 / QQ群 / 主页" /></Field>
      <Field label="联系方式链接" wide><input value={profile.contact?.url || ''} onChange={(event) => setField('contact', { ...profile.contact, url: event.target.value || null })} placeholder="https://... 或同源相对地址" /></Field>
    </div>
    <section className="products-section">
      <div className="section-heading"><div><div className="eyebrow">PRODUCTS</div><h3>制品与展示品</h3></div><button className="button secondary" type="button" onClick={() => setField('products', [...profile.products, blankProduct()])}>＋ 添加制品</button></div>
      {profile.products.length === 0 && <div className="empty-inline">暂未填写制品。可以先保存摊位介绍，之后再补充。</div>}
      <div className="product-list">{profile.products.map((product, index) => <article className="product-editor" key={`${product.id}-${index}`}>
        <div className="product-title"><strong>制品 {index + 1}</strong><button className="text-button danger" type="button" onClick={() => removeProduct(index)}>删除</button></div>
        <div className="form-grid compact">
          <Field label="制品 ID"><input value={product.id || ''} onChange={(event) => setProduct(index, 'id', event.target.value)} /></Field>
          <Field label="名称"><input value={product.name || ''} onChange={(event) => setProduct(index, 'name', event.target.value)} /></Field>
          <Field label="价格（元）" hint="支持两位小数，免费填 0"><input type="number" min="0" max="1000000" step="0.01" value={((product.priceCents ?? 0) / 100).toFixed(2)} onChange={(event) => setProduct(index, 'priceCents', Math.round(Number(event.target.value || 0) * 100))} /></Field>
          <Field label="状态"><select value={product.status || 'available'} onChange={(event) => setProduct(index, 'status', event.target.value)}><option value="available">有货</option><option value="sold_out">售罄</option><option value="display_only">仅展示</option></select></Field>
          <Field label="类型"><input value={product.kind || ''} onChange={(event) => setProduct(index, 'kind', event.target.value)} /></Field>
          <Field label="单位"><input value={product.unit || ''} onChange={(event) => setProduct(index, 'unit', event.target.value)} /></Field>
          <Field label="规格"><input value={product.spec || ''} onChange={(event) => setProduct(index, 'spec', event.target.value)} /></Field>
          <Field label="版本" hint="多个版本用逗号分隔"><input value={(product.variants || []).join(', ')} onChange={(event) => setProduct(index, 'variants', event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))} /></Field>
          <Field label="制品说明" wide><textarea rows="3" value={product.description || ''} onChange={(event) => setProduct(index, 'description', event.target.value)} /></Field>
          <Field label="备注" wide><input value={product.note || ''} onChange={(event) => setProduct(index, 'note', event.target.value)} placeholder="可选" /></Field>
          <Field label="图片" wide><div className="image-field">{product.imageUrl ? <img src={product.imageUrl} alt="制品预览" /> : <span className="image-placeholder">尚未上传</span>}<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" disabled={uploadingIndex === index} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; uploadProduct(index, file); }} /><small>上传后优先使用连携图床；本地备份仍会保留。</small>{uploadingIndex === index && <div className="upload-progress" role="status" aria-live="polite"><div className="upload-progress-head"><span>图片上传中</span><strong>{uploadProgress}%</strong></div><div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div><small>请保持页面打开，上传完成后会自动更新预览。</small></div>}</div></Field>
        </div>
      </article>)}</div>
    </section>
    <div className="save-row"><span className="save-note">保存后资料立即显示在公开地图，不需要额外审核。</span><button className="button primary" type="button" disabled={saving} onClick={() => onChange({ ...profile, __submit: true })}>{saving ? '保存中…' : '保存资料'}</button></div>
  </div>;
}

function Metrics({ metrics }) {
  const value = metrics || {};
  return <section className="metrics-card"><div className="section-heading"><div><div className="eyebrow">POPULARITY</div><h3>摊位受欢迎程度</h3></div><span className="muted">近 30 天趋势</span></div><div className="metric-grid"><Metric label="详情浏览" value={value.detail_views || 0} /><Metric label="独立访客" value={value.unique_viewers || 0} /><Metric label="当前收藏" value={value.favorites || 0} /><Metric label="联系方式点击" value={value.contact_clicks || 0} /><Metric label="制品点击" value={value.product_clicks || 0} /></div><div className="trend-list">{(value.trend || []).length ? value.trend.slice(-10).map((item) => <span key={`${item.day}-${item.metric_type}`} title={item.metric_type}>{item.day.slice(5)} · {item.count}</span>) : <span className="muted">还没有统计数据，公开地图上的浏览和点击会逐步汇总。</span>}</div></section>;
}

function Metric({ label, value }) { return <div className="metric"><strong>{Number(value).toLocaleString('zh-CN')}</strong><span>{label}</span></div>; }

function BoothDetail({ booth, saving, onProfileChange, onUpload, onAvatarUpload, onResetCredentials, onToggleAccount }) {
  const account = booth.account || {};
  const statusLabel = booth.profile?.status === 'rest' ? '暂时离席' : booth.profile?.status === 'preparing' ? '准备中' : '营业中';
  return <article className="booth-detail-card">
    <div className="booth-detail-head">
      <div><div className="eyebrow">SELECTED BOOTH</div><h2>{booth.booth_id}</h2><p>桌位：{(booth.table_ids || []).join(' · ') || '暂未分配'}　·　{booth.profile?.name || '尚未填写展示名称'}</p></div>
      <span className={`status-chip ${booth.profile?.status || 'open'}`}>{statusLabel}</span>
    </div>
    <ProfileForm value={booth.profile} onChange={onProfileChange} onUpload={onUpload} onAvatarUpload={onAvatarUpload} saving={saving} />
    <Metrics metrics={booth.metrics} />
    <section className="account-card">
      <div><div className="eyebrow">BOOTH ACCOUNT</div><h3>临时登录账号</h3></div>
      <div className="account-row"><code>{account.username}</code><span className={account.status === 'active' ? 'account-active' : 'account-disabled'}>{account.status === 'active' ? '可登录' : '已停用'}</span></div>
      {account.password_changed ? <p className="muted">摊主已修改初始密码；管理员只能重置，不能查看现密码。</p> : <div className="password-reveal"><span>初始密码</span><code>{account.initial_password || '密钥不可用，请重置'}</code></div>}
      <div className="account-actions"><button className="button secondary" type="button" onClick={onResetCredentials}>重置密码</button><button className="button ghost" type="button" onClick={onToggleAccount}>{account.status === 'active' ? '停用账号' : '启用账号'}</button></div>
    </section>
  </article>;
}

function AdminApp() {
  const [booths, setBooths] = useState([]);
  const [selectedBoothId, setSelectedBoothId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [notice, show] = useNotice();
  const update = (boothId, patch) => setBooths((items) => items.map((item) => item.booth_id === boothId ? { ...item, ...patch } : item));
  const load = async () => {
    setLoading(true);
    try { const data = await api('admin_list'); setBooths(data.booths || []); }
    catch (error) { show(error.message, 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const groups = useMemo(() => {
    const result = {};
    booths.forEach((booth) => { const letter = (booth.booth_id || '#').slice(0, 1).toUpperCase(); (result[letter] ||= []).push(booth); });
    return Object.entries(result).map(([letter, items]) => [letter, items.sort((a, b) => String(a.booth_id || '').localeCompare(String(b.booth_id || ''), 'zh-CN', { numeric: true, sensitivity: 'base' }))]).sort(([a], [b]) => a.localeCompare(b));
  }, [booths]);
  useEffect(() => {
    if (!booths.some((booth) => booth.booth_id === selectedBoothId)) setSelectedBoothId(booths[0]?.booth_id || '');
  }, [booths, selectedBoothId]);
  const save = async (booth) => {
    setSaving(booth.booth_id);
    try {
      const data = await api('admin_save_profile', { method: 'POST', body: { event_code: EVENT_CODE, booth_id: booth.booth_id, base_version: booth.profile_version, profile: normalizeProfile(booth.profile) } });
      update(booth.booth_id, { profile: data.profile, profile_version: data.profile_version }); show(`${booth.booth_id} 资料已保存并公开`);
    } catch (error) { show(`${booth.booth_id}：${error.message}`, 'error'); }
    finally { setSaving(''); }
  };
  const upload = async (boothId, file, onProgress, asset = 'product') => {
    const data = await uploadImageWithProgress(file, { boothId, asset, onProgress });
    show(data.storage === 'picui' ? '图片已上传到连携图床' : '图片已保存（当前使用本地备份）');
    return data.url;
  };
  const uploadAvatar = async (boothId, file, onProgress) => upload(boothId, file, onProgress, 'avatar');
  const resetCredentials = async (booth) => {
    if (!window.confirm(`确认重置 ${booth.booth_id} 的摊位账号吗？旧会话会立即失效。`)) return;
    try {
      const data = await api('admin_reset_credentials', { method: 'POST', body: { event_code: EVENT_CODE, booth_id: booth.booth_id } });
      update(booth.booth_id, { account: { ...booth.account, username: data.username, password_changed: false, initial_password: data.temporary_password } });
      show(`${booth.booth_id} 新临时密码：${data.temporary_password}`);
    } catch (error) { show(error.message, 'error'); }
  };
  const updateAccount = async (booth, patch) => {
    try {
      const data = await api('admin_update_account', { method: 'POST', body: { event_code: EVENT_CODE, booth_id: booth.booth_id, ...patch } });
      update(booth.booth_id, { account: { ...booth.account, ...data } }); show(`${booth.booth_id} 账号设置已保存`);
    } catch (error) { show(error.message, 'error'); }
  };
  const selectedBooth = booths.find((booth) => booth.booth_id === selectedBoothId);
  const exportCredentials = () => {
    if (!booths.length) { show('暂无可导出的摊位账号，请先成功加载控制台数据', 'error'); return; }
    exportCredentialCsv(booths);
    const pending = booths.filter((booth) => !booth.account?.password_changed && booth.account?.initial_password).length;
    show(`已导出 ${booths.length} 个摊位组；其中 ${pending} 个仍含初始密码。请妥善保管 CSV 文件。`);
  };
  return <div className="page-shell admin-page"><Header title="摊位资料控制台" subtitle="按区域分组管理北京 GalOnly 的摊位资料、制品、账号和公开统计。" action={<div className="header-actions"><button className="button secondary" type="button" onClick={exportCredentials} disabled={!booths.length} title="下载可用的初始账号和密码">⇩ 一键导出账号密码</button><button className="button secondary" type="button" onClick={load}>↻ 刷新数据</button></div>} /><main><Notice notice={notice} /><div className="info-banner"><span className="status-dot" /> 仅超级管理员可打开　·　共 {booths.length} 个摊位组　·　地图坐标和桌位归属仍由“编辑展会”管理。<small>导出文件为 CSV，可直接用 Excel 打开；已修改的密码不会再次导出，请妥善保管明文初始密码。</small></div>{loading ? <div className="loading">正在读取摊位账号与资料…</div> : !selectedBooth ? <div className="loading">暂无摊位数据；请以超级管理员身份重新加载控制台。</div> : <div className="admin-workspace"><aside className="booth-sidebar" aria-label="摊位列表"><div className="sidebar-heading"><div><div className="eyebrow">BOOTH LIST</div><h2>摊位列表</h2></div><strong>{booths.length}</strong></div><div className="booth-tabs">{groups.map(([letter, items]) => <section className="booth-tab-group" key={letter}><div className="booth-tab-group-title"><span>{letter} 区</span><small>{items.length} 个</small></div>{items.map((booth) => <button className={`booth-tab ${booth.booth_id === selectedBoothId ? 'selected' : ''}`} type="button" key={booth.booth_id} onClick={() => setSelectedBoothId(booth.booth_id)}><span className="booth-tab-primary"><b>{booth.booth_id}</b><span className={`booth-tab-status ${booth.account?.status === 'active' ? 'active' : 'disabled'}`}>{booth.account?.status === 'active' ? '可登录' : '已停用'}</span></span><span className="booth-tab-name">{booth.profile?.name || '未填写展示名称'}</span><small>{(booth.table_ids || []).join(' · ') || '暂未分配桌位'}</small></button>)}</section>)}</div></aside><section className="booth-detail-pane" aria-label={`${selectedBooth.booth_id} 摊位详情`}><BoothDetail booth={selectedBooth} saving={saving === selectedBooth.booth_id} onProfileChange={(next) => next.__submit ? save(selectedBooth) : update(selectedBooth.booth_id, { profile: next })} onUpload={(file, onProgress) => upload(selectedBooth.booth_id, file, onProgress)} onAvatarUpload={(file, onProgress) => uploadAvatar(selectedBooth.booth_id, file, onProgress)} onResetCredentials={() => resetCredentials(selectedBooth)} onToggleAccount={() => updateAccount(selectedBooth, { status: selectedBooth.account?.status === 'active' ? 'disabled' : 'active', username: selectedBooth.account?.username })} /></section></div>}</main><footer>资料门户与公开地图共用北京活动的已发布摊位结构。敏感凭据不写入前端缓存。</footer></div>;
}

function PortalApp() {
  const [session, setSession] = useState(null);
  const [login, setLogin] = useState({ username: '', password: '' });
  const [passwords, setPasswords] = useState({ current_password: '', new_password: '' });
  const [profile, setProfile] = useState(null);
  const [version, setVersion] = useState(0);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, show] = useNotice();
  const load = async () => {
    try { const data = await api('me'); setSession({ ...data.account, booth_id: data.booth_id, table_ids: data.table_ids }); setProfile(data.profile); setVersion(data.profile_version); setMetrics(data.metrics); }
    catch (error) { if (error.status !== 401) show(error.message, 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const upload = async (file, onProgress, asset = 'product') => {
    const data = await uploadImageWithProgress(file, { asset, onProgress }); show(data.storage === 'picui' ? '图片已上传到连携图床' : '图片已保存（当前使用本地备份）'); return data.url;
  };
  const uploadAvatar = async (file, onProgress) => upload(file, onProgress, 'avatar');
  const submitProfile = async (next) => {
    if (!next.__submit) { setProfile(next); return; }
    setSaving(true);
    try { const data = await api('save_profile', { method: 'POST', body: { event_code: EVENT_CODE, booth_id: session.booth_id, base_version: version, profile: normalizeProfile(profile) } }); setProfile(data.profile); setVersion(data.profile_version); show('资料已保存并立即公开'); }
    catch (error) { show(error.message, 'error'); }
    finally { setSaving(false); }
  };
  const submitLogin = async (event) => {
    event.preventDefault();
    try { const data = await api('login', { method: 'POST', body: { event_code: EVENT_CODE, ...login } }); setSession({ ...data.account, booth_id: data.booth_id, table_ids: data.table_ids }); setProfile(data.profile); setVersion(data.profile_version); setMetrics((await api('metrics')).metrics); show('登录成功'); }
    catch (error) { show(error.message, 'error'); }
  };
  const changePassword = async (event) => {
    event.preventDefault();
    try { await api('change_password', { method: 'POST', body: passwords }); setPasswords({ current_password: '', new_password: '' }); show('密码已更新。之后管理员只能重置，无法查看新密码。'); }
    catch (error) { show(error.message, 'error'); }
  };
  const logout = async () => { await api('logout', { method: 'POST' }).catch(() => {}); setSession(null); setProfile(null); };
  return <div className="page-shell portal-page"><Header title="摊位资料填写" subtitle="填写介绍与制品信息，保存后会立即同步到公开地图。" action={session && <button className="button secondary" type="button" onClick={logout}>退出登录</button>} /><main><Notice notice={notice} />{loading ? <div className="loading">正在检查摊位登录状态…</div> : !session ? <section className="login-card"><div className="eyebrow">OWNER ACCESS</div><h2>登录你的摊位</h2><p>请使用活动方提供的摊位账号和临时密码。首次登录后建议立即修改密码。</p><form onSubmit={submitLogin}><Field label="摊位账号"><input autoComplete="username" value={login.username} onChange={(event) => setLogin({ ...login, username: event.target.value })} required placeholder="例如 BJG-F01" /></Field><Field label="密码"><input type="password" autoComplete="current-password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} required /></Field><button className="button primary full" type="submit">登录并填写资料</button></form></section> : <><div className="portal-intro"><div><span className="booth-code">{session.booth_id}</span><h2>{profile?.name || '摊位资料'}</h2><p>桌位：{session.table_ids?.join(' · ') || '由地图编辑器维护'}</p></div><span className="account-badge">账号：{session.username}</span></div><ProfileForm value={profile} onChange={submitProfile} onUpload={upload} onAvatarUpload={uploadAvatar} saving={saving} /><Metrics metrics={metrics} /><section className="password-card"><div className="section-heading"><div><div className="eyebrow">SECURITY</div><h3>修改登录密码</h3></div><span className="muted">至少 12 个字符</span></div><form className="password-form" onSubmit={changePassword}><Field label="当前密码"><input type="password" value={passwords.current_password} onChange={(event) => setPasswords({ ...passwords, current_password: event.target.value })} required /></Field><Field label="新密码"><input type="password" minLength="12" value={passwords.new_password} onChange={(event) => setPasswords({ ...passwords, new_password: event.target.value })} required /><small>密码不能少于 12 个字符</small></Field><button className="button secondary" type="submit">更新密码</button></form></section></>}</main><footer>资料保存立即公开；坐标、桌位归属和场地模型请联系活动管理员。</footer></div>;
}

const isAdminPage = window.location.pathname.endsWith('_admin.html') || window.location.pathname.endsWith('/admin.html');
createRoot(document.getElementById('root')).render(isAdminPage ? <AdminApp /> : <PortalApp />);
