import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './styles.css';

const POSTS_API = '/api/posts.php';
const IMAGES_API = '/api/post_images.php';
const CONTENT_MAX = 280;
const IMAGES_MAX = 4;

// ---------------------------------------------------------------- utilities

async function apiGet(action, params = {}) {
  const query = new URLSearchParams({ action, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
  const res = await fetch(`${POSTS_API}?${query}`, { credentials: 'same-origin' });
  const payload = await res.json().catch(() => null);
  if (!payload) throw new Error('响应解析失败');
  if (!payload.success) {
    const message = payload.error && payload.error.message ? payload.error.message : '请求失败';
    const error = new Error(message);
    error.code = payload.error && payload.error.code;
    throw error;
  }
  return payload.data;
}

async function apiPost(action, payload = {}) {
  const res = await fetch(`${POSTS_API}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('响应解析失败');
  if (!data.success) {
    const message = data.error && data.error.message ? data.error.message : '请求失败';
    const error = new Error(message);
    error.code = data.error && data.error.code;
    throw error;
  }
  return data.data;
}

const MESSAGES_API = '/api/messages.php';

async function messagesApi(action, params = {}) {
  const query = new URLSearchParams({ action, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
  const res = await fetch(`${MESSAGES_API}?${query}`, { credentials: 'same-origin' });
  const payload = await res.json().catch(() => null);
  if (!payload) throw new Error('响应解析失败');
  if (!payload.success) {
    const message = payload.message || (payload.error && payload.error.message) || '请求失败';
    const error = new Error(message);
    error.code = payload.error && payload.error.code;
    throw error;
  }
  return payload.data;
}

async function messagesPost(action, payload = {}) {
  const res = await fetch(`${MESSAGES_API}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('响应解析失败');
  if (!data.success) {
    const message = data.message || (data.error && data.error.message) || '请求失败';
    const error = new Error(message);
    error.code = data.error && data.error.code;
    throw error;
  }
  return data.data;
}

function makeUploadToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'post-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function relTime(value) {
  if (!value) return '';
  const then = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return String(value);
  const diff = Math.max(0, Date.now() - then.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${then.getMonth() + 1}月${then.getDate()}日`;
  return `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日`;
}

function fullTime(value) {
  if (!value) return '';
  const then = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日 ${pad(then.getHours())}:${pad(then.getMinutes())}`;
}

function linkify(text) {
  const parts = [];
  const regex = /(https?:\/\/[^\s<>"]+)/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) });
    parts.push({ type: 'link', value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

// ---------------------------------------------------------------- toast

const toastListeners = new Set();
function showToast(message, kind = 'info') {
  toastListeners.forEach((fn) => fn({ id: Date.now() + Math.random(), message, kind }));
}

function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const listener = (item) => {
      setItems((prev) => [...prev.slice(-3), item]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== item.id)), 3200);
    };
    toastListeners.add(listener);
    return () => toastListeners.delete(listener);
  }, []);
  return (
    <div className="pt-toasts" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`pt-toast pt-toast-${item.kind}`}>{item.message}</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- icons

function Icon({ path, size = 20, filled = false, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 9c.7-3.6 3.8-6 7.5-6s6.8 2.4 7.5 6',
  back: 'M20 12H4m0 0 6-6m-6 6 6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  reply: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.25-3.4-.7L4 21l1.7-4.3A8.5 8.5 0 1 1 21 11.5Z',
  repost: 'M4.5 9 7.5 6l3 3m-3-3v9m0 0a3 3 0 0 0 3 3h4m3-7 3 3-3 3m3-3V8m0 5a3 3 0 0 0-3-3h-4',
  heart: 'M12 20.5s-7.8-4.6-9.3-9.2C1.6 8 3.4 4.9 6.6 4.9c2 0 3.7 1.1 4.6 2.7l.8 1.4.8-1.4c.9-1.6 2.6-2.7 4.6-2.7 3.2 0 5 3.1 3.9 6.4-1.5 4.6-9.3 9.2-9.3 9.2Z',
  image: 'M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm2.5 9.5 3.5-4 2.5 3 2-2.5L19 16M9 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.2-1.2',
  feather: 'M20 4c-5 0-11 2-13.5 7.5L4 20l8.5-2.5C18 15 20 9 20 4Zm-5 5-8 8',
  users: 'M16 19c0-2.8-1.8-5-4-5s-4 2.2-4 5m4-8.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Zm6.5 8.5c-.2-2-1.2-3.7-2.7-4.4M16.5 5.3a3 3 0 0 1 0 5.9',
  map: 'M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Zm0 0v13m6-10.5v13',
  club: 'M12 3 4 7.5v2.2l8-4.5 8 4.5V7.5L12 3ZM6 10.5V19m12-8.5V19M6 19h12M10.5 19v-4h3v4',
  calendar: 'M8 2.5v3m8-3v3M3.5 9.5h17M5 5h14A1.5 1.5 0 0 1 20.5 6.5V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5Z',
  check: 'M4.5 12.5l4.5 4.5L19.5 6.5',
  message: 'M3.5 5.5h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm.5 1.5 8.2 6.4a1 1 0 0 0 1.23 0L20 7',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm9.5 3-4.9-4.9',
};

function Avatar({ src, name, size = 48 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (!src || failed) {
    return (
      <span className="pt-avatar pt-avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return (
    <img
      className="pt-avatar"
      style={{ width: size, height: size }}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function CharRing({ count, max }) {
  const ratio = Math.min(1, count / max);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const remaining = max - count;
  const color = remaining < 0 ? 'var(--pt-danger)' : remaining <= 20 ? 'var(--pt-warning)' : 'var(--pt-accent)';
  return (
    <span className={`pt-char-ring ${remaining < 0 ? 'is-over' : ''}`}>
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--pt-line-strong)" strokeWidth="2" />
        {count > 0 && (
          <circle
            cx="11" cy="11" r={radius} fill="none"
            stroke={color} strokeWidth="2" strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
            transform="rotate(-90 11 11)"
          />
        )}
      </svg>
      {remaining <= 20 && <span className="pt-char-ring-num">{remaining}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- crop modal

function CropModal({ src, aspectRatio = null, outputWidth = 1280, outputHeight = null, title = '裁剪图片', onCropped, onCancel }) {
  const imgRef = useRef(null);
  const cropperRef = useRef(null);

  useEffect(() => {
    if (!src || typeof window.Cropper !== 'function' || !imgRef.current) return undefined;
    cropperRef.current = new window.Cropper(imgRef.current, {
      aspectRatio: aspectRatio || NaN,
      viewMode: 1,
      dragMode: 'move',
      autoCropArea: 1,
      cropBoxMovable: !aspectRatio,
      cropBoxResizable: !aspectRatio,
      toggleDragModeOnDblclick: false,
      background: false,
    });
    return () => {
      if (cropperRef.current) { cropperRef.current.destroy(); cropperRef.current = null; }
    };
  }, [src, aspectRatio]);

  const confirm = () => {
    const cropper = cropperRef.current;
    if (!cropper) return;
    const options = aspectRatio
      ? { width: outputWidth, height: outputHeight || undefined, imageSmoothingQuality: 'high' }
      : { maxWidth: 4096, maxHeight: 4096, imageSmoothingQuality: 'high' };
    const canvas = cropper.getCroppedCanvas(options);
    if (!canvas) { showToast('裁剪失败，请重试', 'warn'); return; }
    canvas.toBlob((blob) => {
      if (blob) onCropped(blob);
      else showToast('裁剪失败，请重试', 'warn');
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className="pt-modal pt-crop-modal" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="pt-modal-panel pt-crop-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pt-modal-head">
          <span>{title}</span>
          <button type="button" className="pt-icon-btn" onClick={onCancel} aria-label="关闭" style={{ marginLeft: 'auto' }}>
            <Icon path={PATHS.close} size={18} />
          </button>
        </div>
        <div className="pt-crop-container">
          <img ref={imgRef} src={src} alt="" crossOrigin="anonymous" />
        </div>
        <p className="pt-crop-hint">拖动图片调整位置{aspectRatio ? '' : '，拖动裁剪框边角调整范围'}</p>
        <div className="pt-edit-actions">
          <button type="button" className="pt-follow-btn is-following" onClick={onCancel}>取消</button>
          <button type="button" className="pt-btn pt-btn-primary" onClick={confirm}>确认裁剪</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- composer

function Composer({ user, clubs, placeholder, replyTo, quoted, onPosted, autoFocus = false, compact = false }) {
  const [content, setContent] = useState('');
  const [images, setImages] = useState([]);
  const [uploadToken, setUploadToken] = useState(() => makeUploadToken());
  const [clubId, setClubId] = useState('');
  const [clubMenuOpen, setClubMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cropSrc, setCropSrc] = useState(null);
  const cropQueueRef = useRef([]);
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const clubRef = useRef(null);

  const selectedClub = clubs.find((c) => String(c.membership_id) === String(clubId)) || null;

  useEffect(() => {
    if (!clubMenuOpen) return undefined;
    const close = (e) => { if (clubRef.current && !clubRef.current.contains(e.target)) setClubMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [clubMenuOpen]);

  const pickClub = (id) => {
    setClubId(id === '' ? '' : id);
    setClubMenuOpen(false);
  };

  const remaining = CONTENT_MAX - [...content].length;
  const canPublish = !busy && remaining >= 0 && (content.trim() !== '' || images.length > 0);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(compact ? 44 : 52, el.scrollHeight)}px`;
  }, [compact]);

  useEffect(() => { resize(); }, [content, resize]);
  useEffect(() => { if (autoFocus && textareaRef.current) textareaRef.current.focus(); }, [autoFocus]);

  const uploadImageFile = async (file) => {
    const form = new FormData();
    form.append('image', file);
    form.append('upload_token', uploadToken);
    const res = await fetch(IMAGES_API, { method: 'POST', credentials: 'same-origin', body: form });
    const data = await res.json().catch(() => null);
    if (!data || !data.success) {
      showToast((data && data.error && data.error.message) || '图片上传失败', 'warn');
      return;
    }
    const att = data.data.attachment;
    setImages((prev) => [...prev, { id: att.id, url: att.url, path: att.relative_path }]);
  };

  const processCropQueue = () => {
    const file = cropQueueRef.current.shift();
    if (!file) {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.type === 'image/gif') {
      // GIF 裁剪会丢失动画，直接上传原图
      setUploading(true);
      uploadImageFile(file).finally(processCropQueue);
      return;
    }
    setCropSrc(URL.createObjectURL(file));
  };

  const pickFiles = (files) => {
    if (!files || !files.length) return;
    const room = IMAGES_MAX - images.length;
    if (room <= 0) { showToast(`一条动态最多 ${IMAGES_MAX} 张图片`, 'warn'); return; }
    setUploading(true);
    cropQueueRef.current = Array.from(files).slice(0, room);
    processCropQueue();
  };

  const removeImage = async (item) => {
    setImages((prev) => prev.filter((x) => x.id !== item.id));
    try {
      await fetch(`${IMAGES_API}?action=delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch (e) { /* 未绑定前删除失败不阻塞 */ }
  };

  const publish = async () => {
    if (!canPublish) return;
    setBusy(true);
    try {
      await apiPost('create', {
        content: content.trim(),
        images: images.map((x) => x.path),
        upload_token: images.length ? uploadToken : '',
        club_membership_id: clubId || undefined,
        reply_to_id: replyTo ? replyTo.id : undefined,
        quoted_post_id: quoted ? quoted.id : undefined,
      });
      setContent('');
      setImages([]);
      setUploadToken(makeUploadToken());
      showToast(replyTo ? '回复已发布' : quoted ? '转发已发布' : '动态已发布', 'ok');
      if (onPosted) onPosted();
    } catch (e) {
      showToast(e.message || '发布失败', 'warn');
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="pt-composer pt-composer-guest">
        <p>登录后即可发布动态、点赞和回复。</p>
        <a className="pt-btn pt-btn-primary" href="/login.html">前往登录</a>
      </div>
    );
  }

  return (
    <div className={`pt-composer ${compact ? 'pt-composer-compact' : ''}`}>
      {quoted && <QuoteCard post={quoted} compact />}
      <div className="pt-composer-main">
        <Avatar src={user.avatar_url} name={user.nickname} size={44} />
        <div className="pt-composer-body">
          <textarea
            ref={textareaRef}
            className="pt-composer-text"
            placeholder={placeholder || '有什么新鲜事？'}
            value={content}
            maxLength={CONTENT_MAX + 40}
            onChange={(e) => setContent(e.target.value)}
          />
          {images.length > 0 && (
            <div className="pt-composer-previews">
              {images.map((item) => (
                <div key={item.id} className="pt-preview">
                  <img src={item.url} alt="" />
                  <button type="button" className="pt-preview-remove" onClick={() => removeImage(item)} aria-label="移除图片">
                    <Icon path={PATHS.close} size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pt-composer-bar">
            <button type="button" className="pt-icon-btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading || images.length >= IMAGES_MAX} title="添加图片">
              <Icon path={PATHS.image} />
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={(e) => pickFiles(e.target.files)} />
            {clubs.length > 0 && (
              <div className="pt-club-picker" ref={clubRef}>
                <button
                  type="button"
                  className={`pt-club-btn ${clubId ? 'is-active' : ''}`}
                  onClick={() => setClubMenuOpen(true)}
                  title="关联同好会"
                >
                  <Icon path={PATHS.club} size={15} />
                  <span>{selectedClub ? selectedClub.name : '关联同好会'}</span>
                </button>
                {clubMenuOpen && (
                  <ClubPickerModal
                    clubs={clubs}
                    value={clubId}
                    onPick={pickClub}
                    onClose={() => setClubMenuOpen(false)}
                  />
                )}
              </div>
            )}
            <div className="pt-composer-submit">
              {content.length > 0 && <CharRing count={[...content].length} max={CONTENT_MAX} />}
              <button type="button" className="pt-btn pt-btn-primary" onClick={publish} disabled={!canPublish}>
                {busy ? '发布中…' : replyTo ? '回复' : quoted ? '转发' : '发布'}
              </button>
            </div>
          </div>
        </div>
      </div>
      {cropSrc && (
        <CropModal
          src={cropSrc}
          title="裁剪动态图片"
          onCropped={(blob) => {
            setCropSrc(null);
            setUploading(true);
            const file = new File([blob], 'crop.jpg', { type: 'image/jpeg' });
            uploadImageFile(file).finally(processCropQueue);
          }}
          onCancel={() => {
            setCropSrc(null);
            URL.revokeObjectURL(cropSrc);
            processCropQueue();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- quote card

function QuoteCard({ post, compact = false }) {
  if (!post) return null;
  return (
    <div className={`pt-quote ${compact ? 'pt-quote-compact' : ''}`}>
      <div className="pt-quote-head">
        <Avatar src={post.author.avatar_url} name={post.author.nickname} size={20} />
        <span className="pt-name">{post.author.nickname}</span>
        <span className="pt-handle">{post.author.handle}</span>
        <span className="pt-dot">·</span>
        <span className="pt-time">{relTime(post.created_at)}</span>
      </div>
      <div className="pt-quote-text">{post.content}</div>
      {post.images.length > 0 && !compact && (
        <div className={`pt-imggrid pt-imggrid-${Math.min(post.images.length, 4)}`}>
          {post.images.slice(0, 4).map((src) => (
            <div key={src} className="pt-imgcell"><img src={src} alt="" loading="lazy" /></div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- post card

function PostActions({ post, user, onLike, onQuote, onReply }) {
  return (
    <div className="pt-actions">
      <button type="button" className="pt-action pt-action-reply" onClick={onReply} title="回复">
        <Icon path={PATHS.reply} size={17} />
        <span>{post.reply_count > 0 ? post.reply_count : ''}</span>
      </button>
      <button type="button" className="pt-action pt-action-repost" onClick={onQuote} title="引用转发" disabled={!user}>
        <Icon path={PATHS.repost} size={17} />
        <span>{post.repost_count > 0 ? post.repost_count : ''}</span>
      </button>
      <button
        type="button"
        className={`pt-action pt-action-like ${post.liked ? 'is-liked' : ''}`}
        onClick={onLike}
        title={post.liked ? '取消点赞' : '点赞'}
        disabled={!user}
      >
        <Icon path={PATHS.heart} size={17} filled={post.liked} />
        <span>{post.like_count > 0 ? post.like_count : ''}</span>
      </button>
    </div>
  );
}

function PostCard({ post, user, onChanged, onOpen, onQuote, lightbox, onOpenUser }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const openAuthor = (e) => {
    e.stopPropagation();
    if (onOpenUser && post.author && post.author.username) onOpenUser(post.author.username);
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const like = async (e) => {
    e.stopPropagation();
    if (!user) { showToast('请先登录后再点赞', 'warn'); return; }
    const action = post.liked ? 'unlike' : 'like';
    try {
      const data = await apiPost(action, { id: post.id });
      onChanged({ ...post, liked: !!data.liked, like_count: data.like_count });
    } catch (err) {
      showToast(err.message || '操作失败', 'warn');
    }
  };

  const copyLink = async (e) => {
    e.stopPropagation();
    const url = `${location.origin}/column/post/${post.id}/`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制', 'ok');
    } catch (err) {
      showToast('复制失败', 'warn');
    }
    setMenuOpen(false);
  };

  const remove = async (e) => {
    e.stopPropagation();
    if (!window.confirm('确定删除这条动态吗？删除后不可恢复。')) { setMenuOpen(false); return; }
    setMenuOpen(false);
    try {
      await apiPost('delete', { id: post.id });
      showToast('动态已删除', 'ok');
      onChanged(null);
    } catch (err) {
      showToast(err.message || '删除失败', 'warn');
    }
  };

  const openQuote = (e) => { e.stopPropagation(); if (onQuote) onQuote(post.quoted_post); };

  return (
    <article
      className="pt-post"
      onClick={() => onOpen && onOpen(post)}
    >
      <span className="pt-avatar-link" onClick={openAuthor} role="button" tabIndex={-1} aria-label="查看个人空间">
        <Avatar src={post.author.avatar_url} name={post.author.nickname} size={48} />
      </span>
      <div className="pt-post-main">
        <div className="pt-post-head">
          <span className="pt-name pt-clickable" onClick={openAuthor}>{post.author.nickname}</span>
          <span className="pt-handle pt-clickable" onClick={openAuthor}>{post.author.handle}</span>
          {post.club && <span className="pt-club-badge" title={`同好会 · ${post.club.name}`}>{post.club.name}</span>}
          <span className="pt-dot">·</span>
          <span className="pt-time" title={fullTime(post.created_at)}>{relTime(post.created_at)}</span>
          <div className="pt-post-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button type="button" className="pt-icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="更多">
              <Icon path={PATHS.more} size={16} />
            </button>
            {menuOpen && (
              <div className="pt-menu">
                <button type="button" onClick={copyLink}><Icon path={PATHS.link} size={15} />复制链接</button>
                {post.capabilities.delete && (
                  <button type="button" className="pt-menu-danger" onClick={remove}><Icon path={PATHS.trash} size={15} />删除</button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="pt-post-text">
          {linkify(post.content).map((part, i) => part.type === 'link'
            ? <a key={i} href={part.value} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{part.value}</a>
            : <span key={i}>{part.value}</span>)}
        </div>
        {post.images.length > 0 && (
          <div className={`pt-imggrid pt-imggrid-${Math.min(post.images.length, 4)}`}>
            {post.images.slice(0, 4).map((src, i) => (
              <div
                key={src}
                className="pt-imgcell"
                onClick={(e) => { e.stopPropagation(); if (lightbox) lightbox(post.images, i); }}
              >
                <img src={src} alt="" loading="lazy" />
              </div>
            ))}
          </div>
        )}
        {post.quoted_post_id && (
          post.quoted_post
            ? <div className="pt-quote-wrap" onClick={openQuote}><QuoteCard post={post.quoted_post} /></div>
            : <div className="pt-quote pt-quote-deleted">引用的动态已被删除</div>
        )}
        <PostActions
          post={post}
          user={user}
          onLike={like}
          onQuote={(e) => { e.stopPropagation(); if (onQuote) onQuote(post); }}
          onReply={(e) => { e.stopPropagation(); if (onOpen) onOpen(post); }}
        />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- lightbox

function Lightbox({ state }) {
  if (!state) return null;
  const { images, index, onClose } = state;
  return createPortal((
    <div className="pt-lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button type="button" className="pt-lightbox-close" aria-label="关闭" onClick={onClose}><Icon path={PATHS.close} size={22} /></button>
      <img src={images[index]} alt="" onClick={(e) => e.stopPropagation()} />
      {images.length > 1 && (
        <div className="pt-lightbox-count">{index + 1} / {images.length}</div>
      )}
    </div>
  ), document.body);
}

// ---------------------------------------------------------------- feed hook

function useCursorFeed(fetcher, deps) {
  const [posts, setPosts] = useState([]);
  const [nextBeforeId, setNextBeforeId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const sentinelRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetcher();
      setPosts(data.posts);
      setNextBeforeId(data.next_before_id);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  const loadMore = useCallback(async () => {
    if (loadingMore || nextBeforeId === null || loading) return;
    setLoadingMore(true);
    try {
      const data = await fetcher(nextBeforeId);
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.posts.filter((p) => !seen.has(p.id))];
      });
      setNextBeforeId(data.next_before_id);
    } catch (e) {
      showToast(e.message || '加载更多失败', 'warn');
    } finally {
      setLoadingMore(false);
    }
  }, [fetcher, loadingMore, nextBeforeId, loading]);

  useEffect(() => { load(); }, deps || [load]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: '600px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const updatePost = useCallback((updated) => {
    if (!updated) return;
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const removePost = useCallback((id) => {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { posts, nextBeforeId, loading, loadingMore, error, sentinelRef, load, updatePost, removePost };
}

function FeedPage({ user, clubs, refreshKey, onQuote, lightbox, navigate, onOpenUser }) {
  const [tab, setTab] = useState('all'); // all | following
  const fetcher = useCallback(
    (beforeId) => apiGet('feed', { before_id: beforeId, limit: 20, scope: tab === 'following' ? 'following' : '' }),
    [tab]
  );
  const feed = useCursorFeed(fetcher, [refreshKey, tab]);

  const openPost = (post) => navigate(`/column/post/${post.id}/`);

  return (
    <div className="pt-page">
      <div className="pt-tabs">
        <button type="button" className={`pt-tab ${tab === 'all' ? 'is-active' : ''}`} onClick={() => setTab('all')}>
          为你推荐
        </button>
        <button type="button" className={`pt-tab ${tab === 'following' ? 'is-active' : ''}`} onClick={() => setTab('following')}>
          关注
        </button>
      </div>
      <Composer user={user} clubs={clubs} onPosted={() => feed.load()} />
      <PostList
        posts={feed.posts}
        user={user}
        onChanged={feed.updatePost}
        onOpen={openPost}
        onQuote={onQuote}
        lightbox={lightbox}
        onOpenUser={onOpenUser}
        loading={feed.loading}
        error={feed.error}
        emptyText={tab === 'following' ? '关注一些用户后，这里会显示他们的动态' : '还没有动态，来发第一条吧！'}
      />
      <div ref={feed.sentinelRef} className="pt-sentinel">
        {feed.loadingMore && <span>加载中…</span>}
        {!feed.loadingMore && !feed.loading && feed.nextBeforeId === null && feed.posts.length > 0 && <span>已经到底啦</span>}
      </div>
    </div>
  );
}

function PostList({ posts, user, onChanged, onOpen, onQuote, lightbox, onOpenUser, loading, error, emptyText }) {
  if (loading) return <div className="pt-empty">加载中…</div>;
  if (error) return <div className="pt-empty pt-empty-error">{error}</div>;
  if (!posts.length) return <div className="pt-empty">{emptyText || '暂时没有内容'}</div>;
  return (
    <>
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          user={user}
          onChanged={onChanged}
          onOpen={onOpen}
          onQuote={onQuote}
          lightbox={lightbox}
          onOpenUser={onOpenUser}
        />
      ))}
    </>
  );
}

function DetailPage({ id, user, clubs, refreshKey, onQuote, lightbox, navigate, onOpenUser }) {
  const [post, setPost] = useState(null);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('detail', { id });
      setPost(data.post);
      setReplies(data.replies || []);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading) return <div className="pt-empty">加载中…</div>;
  if (error || !post) return <div className="pt-empty pt-empty-error">{error || '动态不存在'}</div>;

  const likeMain = async (updated) => setPost(updated);
  const openPost = (p) => navigate(`/column/post/${p.id}/`);

  return (
    <div className="pt-page">
      {post.reply_to_post && (
        <div className="pt-detail-parent">
          <PostCard post={post.reply_to_post} user={user} onChanged={() => {}} onOpen={openPost} onQuote={onQuote} lightbox={lightbox} onOpenUser={onOpenUser} />
        </div>
      )}
      <PostCard post={post} user={user} onChanged={likeMain} onOpen={null} onQuote={onQuote} lightbox={lightbox} onOpenUser={onOpenUser} />
      <div className="pt-detail-meta">
        <span>{fullTime(post.created_at)}</span>
        <span>·</span>
        <span>{post.reply_count} 条回复</span>
      </div>
      <Composer user={user} clubs={clubs} replyTo={post} autoFocus onPosted={load} placeholder={`回复 @${post.author.username}`} />
      {replies.length ? (
        replies.map((reply) => (
          <PostCard
            key={reply.id}
            post={reply}
            user={user}
            onChanged={(updated) => setReplies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
            onOpen={openPost}
            onQuote={onQuote}
            lightbox={lightbox}
            onOpenUser={onOpenUser}
          />
        ))
      ) : (
        <div className="pt-empty">还没有回复</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- follow & profile

function FollowButton({ viewer, targetId, isFollowing, onChange, small = false }) {
  const [busy, setBusy] = useState(false);
  if (!viewer) {
    return (
      <a className="pt-btn pt-btn-primary pt-btn-sm" href="/login.html" onClick={(e) => { e.stopPropagation(); }}>关注</a>
    );
  }
  const toggle = async (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const data = await apiPost(isFollowing ? 'unfollow' : 'follow', { id: targetId });
      onChange && onChange(!!data.following, data.followers);
    } catch (err) {
      showToast(err.message || '操作失败', 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={`pt-follow-btn ${isFollowing ? 'is-following' : 'is-not-following'} ${small ? 'pt-follow-btn-sm' : ''} ${busy ? 'is-busy' : ''}`}
      onClick={toggle}
    >
      {isFollowing ? '已关注' : '关注'}
    </button>
  );
}

function ProfilePage({ username, viewer, refreshKey, onQuote, lightbox, navigate, onOpenUser, onBump }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('posts');

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('profile', { username });
      setProfile(data.user);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => { loadProfile(); }, [loadProfile, refreshKey]);

  const fetcher = useCallback(
    (beforeId) => apiGet('user_timeline', { username, tab, before_id: beforeId, limit: 20 }),
    [username, tab]
  );
  const feed = useCursorFeed(fetcher, [refreshKey, tab, profile && profile.id]);

  const joinDate = useMemo(() => {
    if (!profile || !profile.created_at) return '';
    const d = new Date(String(profile.created_at).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月加入`;
  }, [profile]);

  const [editOpen, setEditOpen] = useState(false);
  const [followListType, setFollowListType] = useState(null); // 'following' | 'followers'
  if (loading && !profile) return <div className="pt-empty">加载中…</div>;
  if (error || !profile) return <div className="pt-empty pt-empty-error">{error || '用户不存在'}</div>;

  const updateFollow = (following) => {
    setProfile((prev) => ({
      ...prev,
      is_following: following,
      stats: { ...prev.stats, followers: prev.stats.followers + (following ? 1 : -1) },
    }));
  };

  const openPost = (p) => navigate(`/column/post/${p.id}/`);

  return (
    <div className="pt-page pt-profile">
      <div
        className={`pt-profile-banner ${profile.banner_url ? 'has-image' : ''}`}
        style={profile.banner_url ? { backgroundImage: `url(${profile.banner_url})` } : undefined}
        aria-hidden="true"
      />
      <div className="pt-profile-head">
        <span className="pt-profile-avatar">
          <Avatar src={profile.avatar_url} name={profile.nickname} size={80} />
        </span>
        <div className="pt-profile-actions">
          {profile.is_self
            ? <button type="button" className="pt-follow-btn is-editing" onClick={() => setEditOpen(true)}>编辑资料</button>
            : (
              <span className="pt-profile-action-group">
                {profile.is_friend && (
                  <button type="button" className="pt-follow-btn is-following" onClick={() => navigate(`/column/messages/${profile.id}/`)}>发私信</button>
                )}
                <FollowButton viewer={viewer} targetId={profile.id} isFollowing={profile.is_following} onChange={updateFollow} />
              </span>
            )}
        </div>
        <div className="pt-profile-names">
          <h1 className="pt-profile-name">{profile.nickname}</h1>
          <span className="pt-handle">{profile.handle}</span>
        </div>
        {profile.bio && <p className="pt-profile-bio">{profile.bio}</p>}
        <div className="pt-profile-meta">
          {joinDate && (
            <span className="pt-profile-joined">
              <Icon path={PATHS.calendar} size={15} />
              {joinDate}
            </span>
          )}
        </div>
        <div className="pt-profile-stats">
          <button type="button" className="pt-profile-stat" onClick={() => setFollowListType('following')}>
            <b>{profile.stats.following}</b> 正在关注
          </button>
          <button type="button" className="pt-profile-stat" onClick={() => setFollowListType('followers')}>
            <b>{profile.stats.followers}</b> 关注者
          </button>
          <span className="pt-profile-stat"><b>{profile.stats.posts}</b> 动态</span>
        </div>
      </div>
      <div className="pt-tabs">
        <button type="button" className={`pt-tab ${tab === 'posts' ? 'is-active' : ''}`} onClick={() => setTab('posts')}>动态</button>
        <button type="button" className={`pt-tab ${tab === 'replies' ? 'is-active' : ''}`} onClick={() => setTab('replies')}>回复</button>
      </div>
      <PostList
        posts={feed.posts}
        user={viewer}
        onChanged={feed.updatePost}
        onOpen={openPost}
        onQuote={onQuote}
        lightbox={lightbox}
        onOpenUser={onOpenUser}
        loading={feed.loading || (profile && !feed.posts.length && feed.loading)}
        error={feed.error}
        emptyText={tab === 'replies' ? '还没有发表过回复' : profile.is_self ? '你还没有发过动态' : 'TA 还没有发过动态'}
      />
      <div ref={feed.sentinelRef} className="pt-sentinel">
        {feed.loadingMore && <span>加载中…</span>}
        {!feed.loadingMore && !feed.loading && feed.nextBeforeId === null && feed.posts.length > 0 && <span>已经到底啦</span>}
      </div>
      {editOpen && (
        <EditProfileModal
          profile={profile}
          onClose={() => setEditOpen(false)}
          onSaved={(patch) => { setProfile((prev) => ({ ...prev, ...patch })); }}
        />
      )}
      {followListType && (
        <FollowListModal
          username={profile.username}
          type={followListType}
          viewer={viewer}
          onClose={() => setFollowListType(null)}
          onOpenUser={onOpenUser}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- follow list modal

function FollowListModal({ username, type, viewer, onClose, onOpenUser }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiGet('follow_list', { username, type })
      .then((data) => { if (!cancelled) setUsers(data.users || []); })
      .catch((e) => { if (!cancelled) setError(e.message || '加载失败'); });
    return () => { cancelled = true; };
  }, [username, type]);

  const title = type === 'followers' ? '关注者' : '正在关注';

  const updateFollow = (targetId, following) => {
    setUsers((prev) => prev.map((u) => (u.id === targetId ? { ...u, is_following: following } : u)));
  };

  return (
    <div className="pt-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="pt-modal-panel pt-follow-list-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pt-modal-head">
          <button type="button" className="pt-icon-btn" onClick={onClose} aria-label="关闭"><Icon path={PATHS.close} size={18} /></button>
          <span>{title}</span>
        </div>
        {users === null ? (
          <div className="pt-empty">加载中…</div>
        ) : error ? (
          <div className="pt-empty pt-empty-error">{error}</div>
        ) : users.length ? (
          <div className="pt-follow-list">
            {users.map((u) => (
              <div key={u.id} className="pt-side-user pt-follow-row">
                <button type="button" className="pt-side-user-main" onClick={() => { onClose(); onOpenUser && onOpenUser(u.username); }}>
                  <Avatar src={u.avatar_url} name={u.nickname} size={44} />
                  <span className="pt-side-user-text">
                    <span className="pt-name">{u.nickname}</span>
                    <span className="pt-handle">{u.handle}</span>
                    {u.bio && <span className="pt-search-user-bio">{u.bio}</span>}
                  </span>
                </button>
                {(!viewer || viewer.id !== u.id) && (
                  <FollowButton
                    viewer={viewer}
                    targetId={u.id}
                    isFollowing={u.is_following}
                    small
                    onChange={(following) => updateFollow(u.id, following)}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="pt-empty">{type === 'followers' ? '还没有人关注 TA' : 'TA 还没有关注任何人'}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- edit profile modal

function EditProfileModal({ profile, onClose, onSaved }) {
  const [nickname, setNickname] = useState(profile.nickname);
  const [bio, setBio] = useState(profile.bio || '');
  const [bannerUrl, setBannerUrl] = useState(profile.banner_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cropSrc, setCropSrc] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const close = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  const uploadBannerBlob = async (blob, filename) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('image', new File([blob], filename, { type: 'image/jpeg' }));
      const res = await fetch('/api/user_banner.php', { method: 'POST', credentials: 'same-origin', body: form });
      const data = await res.json().catch(() => null);
      if (!data || !data.success) throw new Error((data && data.error && data.error.message) || '横幅上传失败');
      setBannerUrl(data.data.banner_url);
      onSaved({ banner_url: data.data.banner_url });
      showToast('横幅已更新', 'ok');
    } catch (e) {
      showToast(e.message || '横幅上传失败', 'warn');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const uploadBanner = async (file) => {
    if (!file) return;
    if (file.type === 'image/gif') { await uploadBannerBlob(file, 'banner.gif'); return; }
    setCropSrc(URL.createObjectURL(file));
  };

  const removeBanner = async () => {
    try {
      const res = await fetch('/api/user_banner.php?action=remove', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!data || !data.success) throw new Error('移除失败');
      setBannerUrl('');
      onSaved({ banner_url: '' });
      showToast('横幅已移除', 'ok');
    } catch (e) {
      showToast(e.message || '移除失败', 'warn');
    }
  };

  const save = async () => {
    const nick = nickname.trim();
    if (!nick) { showToast('昵称不能为空', 'warn'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/auth.php?action=update_profile', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick, profile_bio: bio.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.success) throw new Error((data && data.message) || '保存失败');
      showToast('资料已保存', 'ok');
      onSaved({ nickname: nick, bio: bio.trim() });
      onClose();
    } catch (e) {
      showToast(e.message || '保存失败', 'warn');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="pt-modal-panel pt-edit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pt-modal-head">
          <button type="button" className="pt-icon-btn" onClick={onClose} aria-label="关闭"><Icon path={PATHS.close} size={18} /></button>
          <span>编辑资料</span>
        </div>
        <div className="pt-edit-banner" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined}>
          <button type="button" className="pt-edit-banner-btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>
            {uploading ? '上传中…' : '上传横幅图片'}
          </button>
          {bannerUrl && (
            <button type="button" className="pt-edit-banner-btn is-danger" onClick={removeBanner}>移除</button>
          )}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(e) => uploadBanner(e.target.files && e.target.files[0])} />
        </div>
        {cropSrc && (
          <CropModal
            src={cropSrc}
            aspectRatio={3}
            outputWidth={1200}
            outputHeight={400}
            title="裁剪空间横幅"
            onCropped={(blob) => {
              setCropSrc(null);
              uploadBannerBlob(blob, 'banner.jpg');
            }}
            onCancel={() => { setCropSrc(null); URL.revokeObjectURL(cropSrc); }}
          />
        )}
        <label className="pt-edit-field">
          <span className="pt-edit-label">昵称</span>
          <input className="pt-edit-input" value={nickname} maxLength={30} onChange={(e) => setNickname(e.target.value)} />
        </label>
        <label className="pt-edit-field">
          <span className="pt-edit-label">简介</span>
          <textarea className="pt-edit-input pt-edit-bio" value={bio} maxLength={300} rows={3} placeholder="介绍一下你的同好会或自己…" onChange={(e) => setBio(e.target.value)} />
          <span className="pt-edit-count">{[...bio].length}/300</span>
        </label>
        <div className="pt-edit-actions">
          <button type="button" className="pt-follow-btn is-following" onClick={onClose}>取消</button>
          <button type="button" className="pt-btn pt-btn-primary" onClick={save} disabled={saving || !nickname.trim()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- search page

function SearchPage({ query, viewer, navigate, onOpenUser }) {
  const [input, setInput] = useState(query);
  const [keyword, setKeyword] = useState(query);
  const [tab, setTab] = useState('posts');
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  useEffect(() => { setInput(query); setKeyword(query); }, [query]);

  const submit = (e) => {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    navigate(`/column/search/?q=${encodeURIComponent(q)}`);
  };

  useEffect(() => {
    if (!keyword) { setUsers([]); return undefined; }
    let cancelled = false;
    setUsersLoading(true);
    apiGet('search', { q: keyword })
      .then((data) => { if (!cancelled) setUsers(data.users || []); })
      .catch(() => { if (!cancelled) setUsers([]); })
      .finally(() => { if (!cancelled) setUsersLoading(false); });
    return () => { cancelled = true; };
  }, [keyword]);

  const fetcher = useCallback(
    (beforeId) => apiGet('search', { q: keyword, before_id: beforeId, limit: 20 }),
    [keyword]
  );
  const feed = useCursorFeed(fetcher, [keyword, tab]);

  const updateFollow = (targetId, following) => {
    setUsers((prev) => prev.map((u) => (u.id === targetId ? { ...u, is_following: following } : u)));
  };

  return (
    <div className="pt-page">
      <form className="pt-search-box" onSubmit={submit}>
        <Icon path={PATHS.search} size={17} />
        <input
          value={input}
          placeholder="搜索动态或用户"
          onChange={(e) => setInput(e.target.value)}
        />
        {input && (
          <button type="button" className="pt-icon-btn" onClick={() => setInput('')}>
            <Icon path={PATHS.close} size={14} />
          </button>
        )}
      </form>
      {!keyword ? (
        <div className="pt-empty">输入关键词搜索动态和用户</div>
      ) : (
        <div>
          <div className="pt-tabs">
            <button type="button" className={`pt-tab ${tab === 'posts' ? 'is-active' : ''}`} onClick={() => setTab('posts')}>动态</button>
            <button type="button" className={`pt-tab ${tab === 'users' ? 'is-active' : ''}`} onClick={() => setTab('users')}>用户</button>
          </div>
          {tab === 'users' ? (
            usersLoading ? <div className="pt-empty">加载中…</div> : (
              users.length ? (
                <div className="pt-search-users">
                  {users.map((u) => (
                    <div key={u.id} className="pt-side-user pt-search-user">
                      <button type="button" className="pt-side-user-main" onClick={() => onOpenUser && onOpenUser(u.username)}>
                        <Avatar src={u.avatar_url} name={u.nickname} size={44} />
                        <span className="pt-side-user-text">
                          <span className="pt-name">{u.nickname}</span>
                          <span className="pt-handle">{u.handle}</span>
                          {u.bio && <span className="pt-search-user-bio">{u.bio}</span>}
                        </span>
                      </button>
                      {(!viewer || viewer.id !== u.id) && (
                        <span className="pt-user-actions">
                          {u.is_friend && (
                            <button type="button" className="pt-icon-btn pt-dm-btn" title="发私信" onClick={() => navigate(`/column/messages/${u.id}/`)}>
                              <Icon path={PATHS.message} size={16} />
                            </button>
                          )}
                          <FollowButton
                            viewer={viewer}
                            targetId={u.id}
                            isFollowing={u.is_following}
                            small
                            onChange={(following) => updateFollow(u.id, following)}
                          />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : <div className="pt-empty">没有找到相关用户</div>
            )
          ) : (
            <div>
              <PostList
                posts={feed.posts}
                user={viewer}
                onChanged={feed.updatePost}
                onOpen={(p) => navigate(`/column/post/${p.id}/`)}
                onQuote={() => {}}
                lightbox={null}
                onOpenUser={onOpenUser}
                loading={feed.loading}
                error={feed.error}
                emptyText="没有找到相关动态"
              />
              <div ref={feed.sentinelRef} className="pt-sentinel">
                {feed.loadingMore && <span>加载中…</span>}
                {!feed.loadingMore && !feed.loading && feed.nextBeforeId === null && feed.posts.length > 0 && <span>已经到底啦</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- layout

function LeftNav({ user, route, navigate, onCompose, dmUnread = 0 }) {
  const profilePath = user ? `/column/user/${encodeURIComponent(user.username)}/` : '/column/my/';
  const items = [
    { key: 'feed', label: '首页', icon: PATHS.home, path: '/column/' },
    { key: 'search', label: '搜索', icon: PATHS.search, path: '/column/search/' },
    { key: 'messages', label: '消息', icon: PATHS.message, path: '/column/messages/', badge: dmUnread },
    { key: 'user', label: '个人空间', icon: PATHS.profile, path: profilePath },
  ];
  return (
    <nav className="pt-leftnav">
      <div className="pt-leftnav-scroll">
        <a className="pt-logo" href="/index.html" title="返回地图">
          <Icon path={PATHS.feather} size={26} />
        </a>
        <div className="pt-nav-items">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`pt-nav-item ${route === item.key ? 'is-active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="pt-nav-icon-wrap">
                <Icon path={item.icon} size={22} />
                {item.badge > 0 && <span className="pt-nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>}
              </span>
              <span className="pt-nav-label">{item.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="pt-btn pt-btn-primary pt-btn-compose" onClick={onCompose}>
          <span className="pt-nav-label">发动态</span>
          <Icon path={PATHS.feather} size={18} className="pt-compose-icon" />
        </button>
      </div>
      {user && (
        <button type="button" className="pt-userchip" onClick={() => navigate(profilePath)} title={user.handle}>
          <Avatar src={user.avatar_url} name={user.nickname} size={38} />
          <span className="pt-userchip-text">
            <span className="pt-name">{user.nickname}</span>
            <span className="pt-handle">{user.handle}</span>
          </span>
        </button>
      )}
    </nav>
  );
}

function ColumnHeader({ title, showBack, indexOnly = false, navigate }) {
  return (
    <div className={`pt-col-header ${indexOnly ? 'pt-col-header-index' : ''}`}>
      {showBack && (
        <button type="button" className="pt-icon-btn" onClick={() => navigate('/column/')} aria-label="返回">
          <Icon path={PATHS.back} size={19} />
        </button>
      )}
      <span className="pt-col-title">{title}</span>
    </div>
  );
}

function MobileBottomNav({ route, navigate, onCompose, user, dmUnread = 0 }) {
  const profilePath = user ? `/column/user/${encodeURIComponent(user.username)}/` : '/column/my/';
  const items = [
    { key: 'feed', label: '首页', icon: PATHS.home, path: '/column/' },
    { key: 'search', label: '搜索', icon: PATHS.search, path: '/column/search/' },
    { key: 'messages', label: '消息', icon: PATHS.message, path: '/column/messages/', badge: dmUnread },
    { key: 'user', label: '空间', icon: PATHS.profile, path: profilePath },
  ];
  return (
    <nav className="pt-bottomnav">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`pt-bottomnav-item ${route === item.key ? 'is-active' : ''}`}
          onClick={() => navigate(item.path)}
        >
          <span className="pt-nav-icon-wrap">
            <Icon path={item.icon} size={22} />
            {item.badge > 0 && <span className="pt-nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function RightSidebar({ user, navigate, onOpenUser }) {
  const [suggested, setSuggested] = useState([]);
  useEffect(() => {
    let cancelled = false;
    apiGet('suggested')
      .then((data) => { if (!cancelled) setSuggested(data.users || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user && user.id]);

  const updateFollow = (targetId, following) => {
    setSuggested((prev) => prev.map((u) => (u.id === targetId ? { ...u, is_following: following } : u)));
  };

  return (
    <aside className="pt-right">
      <div className="pt-side-card">
        <h3 className="pt-side-title">同好会动态</h3>
        <p className="pt-side-desc">这里是 VNFest 同好会分享活动日常的地方。发布动态时可以选择署名你所在的同好会。</p>
        <div className="pt-side-links">
          <a href="/club_square.html"><Icon path={PATHS.club} size={16} />活动广场</a>
          <a href="/index.html"><Icon path={PATHS.map} size={16} />返回地图</a>
        </div>
      </div>
      {suggested.length > 0 && (
        <div className="pt-side-card">
          <h3 className="pt-side-title">推荐关注</h3>
          <div className="pt-side-clubs">
            {suggested.map((u) => (
              <div key={u.id} className="pt-side-user">
                <button type="button" className="pt-side-user-main" onClick={() => onOpenUser && onOpenUser(u.username)}>
                  <Avatar src={u.avatar_url} name={u.nickname} size={36} />
                  <span className="pt-side-user-text">
                    <span className="pt-name">{u.nickname}</span>
                    <span className="pt-handle">{u.handle}</span>
                  </span>
                </button>
                <span className="pt-user-actions">
                  {u.is_friend && (
                    <button type="button" className="pt-icon-btn pt-dm-btn" title="发私信" onClick={() => navigate(`/column/messages/${u.id}/`)}>
                      <Icon path={PATHS.message} size={16} />
                    </button>
                  )}
                  <FollowButton
                    viewer={user}
                    targetId={u.id}
                    isFollowing={u.is_following}
                    small
                    onChange={(following) => updateFollow(u.id, following)}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- club picker modal

function ClubPickerModal({ clubs, value, onPick, onClose }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    const close = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const keyword = query.trim().toLowerCase();
  const filtered = keyword ? clubs.filter((c) => c.name.toLowerCase().includes(keyword)) : clubs;
  const pick = (id) => { onPick(id); onClose(); };
  return (
    <div className="pt-modal pt-club-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="pt-modal-panel pt-club-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pt-modal-head">
          <span>关联同好会</span>
          <button type="button" className="pt-icon-btn" onClick={onClose} aria-label="关闭" style={{ marginLeft: 'auto' }}>
            <Icon path={PATHS.close} size={18} />
          </button>
        </div>
        <div className="pt-club-search">
          <Icon path={PATHS.search} size={15} />
          <input value={query} placeholder="搜索你的同好会" onChange={(e) => setQuery(e.target.value)} autoFocus />
        </div>
        <div className="pt-club-list">
          <button type="button" className={`pt-club-option ${!value ? 'is-selected' : ''}`} onClick={() => pick('')}>
            <span>不关联</span>
            {!value && <Icon path={PATHS.check} size={15} />}
          </button>
          {filtered.map((club) => (
            <button
              key={club.membership_id}
              type="button"
              className={`pt-club-option ${String(value) === String(club.membership_id) ? 'is-selected' : ''}`}
              onClick={() => pick(club.membership_id)}
            >
              <span className="pt-club-option-main">
                <span className="pt-name">{club.name}</span>
                <span className="pt-handle">{club.country === 'japan' ? '日本' : '中国'} · {club.role === 'representative' ? '代表' : club.role === 'manager' ? '管理' : '成员'}</span>
              </span>
              {String(value) === String(club.membership_id) && <Icon path={PATHS.check} size={15} />}
            </button>
          ))}
          {filtered.length === 0 && <div className="pt-empty pt-empty-sm">没有匹配的同好会</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- messages

function MessagesPage({ viewer, navigate, onOpenUser, refreshKey }) {
  const [conversations, setConversations] = useState(null);
  const [friends, setFriends] = useState([]);

  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    messagesApi('list').then((data) => { if (!cancelled) setConversations(data.conversations || []); }).catch(() => { if (!cancelled) setConversations([]); });
    messagesApi('friends').then((data) => { if (!cancelled) setFriends(data.friends || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [viewer, refreshKey]);

  if (!viewer) {
    return (
      <div className="pt-empty">
        <span>登录后即可使用私信与好友功能。</span>
        <a className="pt-btn pt-btn-primary pt-btn-sm" href="/login.html">前往登录</a>
      </div>
    );
  }

  return (
    <div className="pt-page">
      {friends.length > 0 && (
        <div className="pt-friends-strip">
          <div className="pt-friends-label">好友</div>
          <div className="pt-friends-row">
            {friends.map((f) => (
              <button key={f.id} type="button" className="pt-friend-item" onClick={() => navigate(`/column/messages/${f.id}/`)} title={f.handle}>
                <Avatar src={f.avatar_url} name={f.nickname} size={52} />
                <span className="pt-friend-name">{f.nickname}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {conversations === null ? (
        <div className="pt-empty">加载中…</div>
      ) : conversations.length ? (
        conversations.map((conv) => (
          <button
            key={conv.conversation_id}
            type="button"
            className="pt-conv-row"
            onClick={() => navigate(`/column/messages/${conv.user.id}/`)}
          >
            <Avatar src={conv.user.avatar_url} name={conv.user.nickname} size={48} />
            <span className="pt-conv-main">
              <span className="pt-conv-top">
                <span className="pt-name">{conv.user.nickname}</span>
                <span className="pt-handle">{conv.user.handle}</span>
                {conv.last_message && <span className="pt-time">· {relTime(conv.last_message.created_at)}</span>}
              </span>
              {conv.last_message && (
                <span className={`pt-conv-preview ${conv.unread ? 'is-unread' : ''}`}>
                  {conv.last_message.mine ? '我：' : ''}{conv.last_message.content}
                </span>
              )}
            </span>
            {conv.unread > 0 && <span className="pt-conv-unread">{conv.unread > 99 ? '99+' : conv.unread}</span>}
          </button>
        ))
      ) : (
        <div className="pt-empty">
          {friends.length ? '点击上方好友开始私信' : '和互相关注的好友互发私信。还没有好友？去关注别人并互相关注吧！'}
        </div>
      )}
    </div>
  );
}

function ThreadPage({ userId, viewer, navigate, refreshKey, lightbox }) {
  const [messages, setMessages] = useState(null);
  const [other, setOther] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingImages, setPendingImages] = useState([]);
  const [uploadToken, setUploadToken] = useState(() => makeUploadToken());
  const bottomRef = useRef(null);
  const lastIdRef = useRef(0);
  const imgFileRef = useRef(null);

  const uploadImageFile = async (blob) => {
    const form = new FormData();
    form.append('image', new File([blob], 'dm.jpg', { type: 'image/jpeg' }));
    form.append('upload_token', uploadToken);
    const res = await fetch(IMAGES_API, { method: 'POST', credentials: 'same-origin', body: form });
    const data = await res.json().catch(() => null);
    if (!data || !data.success) {
      showToast((data && data.error && data.error.message) || '图片上传失败', 'warn');
      return;
    }
    const att = data.data.attachment;
    setPendingImages((prev) => (prev.length >= IMAGES_MAX ? prev : [...prev, { id: att.id, url: att.url, path: att.relative_path }]));
  };

  const removePendingImage = async (item) => {
    setPendingImages((prev) => prev.filter((x) => x.id !== item.id));
    try {
      await fetch(`${IMAGES_API}?action=delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
    } catch (e) { /* 忽略 */ }
  };

  const markRead = useCallback((cid) => {
    if (!cid) return;
    messagesPost('read', { conversation_id: cid }).catch(() => {});
  }, []);

  const scrollToEnd = () => {
    requestAnimationFrame(() => { if (bottomRef.current) bottomRef.current.scrollIntoView({ block: 'end' }); });
  };

  useEffect(() => {
    if (!viewer) return undefined;
    let cancelled = false;
    messagesApi('thread', { user_id: userId })
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages || []);
        setOther(data.other || null);
        setConversationId(data.conversation_id || null);
        lastIdRef.current = data.messages && data.messages.length ? data.messages[data.messages.length - 1].id : 0;
        markRead(data.conversation_id);
        scrollToEnd();
      })
      .catch((e) => { if (!cancelled) showToast(e.message || '加载失败', 'warn'); });
    return () => { cancelled = true; };
  }, [viewer, userId, refreshKey, markRead]);

  useEffect(() => {
    if (!viewer || !conversationId) return undefined;
    const timer = setInterval(() => {
      if (document.hidden) return;
      messagesApi('thread', { user_id: userId, after_id: lastIdRef.current })
        .then((data) => {
          const fresh = data.messages || [];
          if (fresh.length) {
            setMessages((prev) => {
              const seen = new Set((prev || []).map((m) => m.id));
              return [...(prev || []), ...fresh.filter((m) => !seen.has(m.id))];
            });
            lastIdRef.current = Math.max(lastIdRef.current, ...fresh.map((m) => m.id));
            scrollToEnd();
          }
          markRead(conversationId);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [viewer, userId, conversationId, markRead]);

  if (!viewer) {
    return (
      <div className="pt-empty">
        <span>登录后即可使用私信。</span>
        <a className="pt-btn pt-btn-primary pt-btn-sm" href="/login.html">前往登录</a>
      </div>
    );
  }
  if (messages === null) return <div className="pt-empty">加载中…</div>;

  const send = async () => {
    const content = text.trim();
    if ((!content && !pendingImages.length) || sending) return;
    if ([...content].length > 1000) { showToast('消息不能超过 1000 字', 'warn'); return; }
    setSending(true);
    try {
      const data = await messagesPost('send', {
        to_user_id: userId,
        content,
        images: pendingImages.map((x) => x.path),
        upload_token: pendingImages.length ? uploadToken : '',
      });
      setMessages((prev) => [...(prev || []), data.message]);
      setConversationId(data.conversation_id);
      lastIdRef.current = Math.max(lastIdRef.current, data.message.id);
      setText('');
      setPendingImages([]);
      setUploadToken(makeUploadToken());
      markRead(data.conversation_id);
      scrollToEnd();
    } catch (e) {
      showToast(e.message || '发送失败', 'warn');
    } finally {
      setSending(false);
    }
  };

  // 按天分组：渲染时在前一条日期不同处插入分隔
  let lastDay = '';
  const openOlder = async () => {
    if (loadingMore || !messages.length) return;
    setLoadingMore(true);
    try {
      const data = await messagesApi('thread', { user_id: userId, before_id: messages[0].id });
      if (data.messages && data.messages.length) setMessages((prev) => [...data.messages, ...(prev || [])]);
    } catch (e) {
      showToast(e.message || '加载失败', 'warn');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="pt-page pt-thread">
      <div className="pt-thread-header">
        {other && (
          <button type="button" className="pt-thread-other" onClick={() => navigate(`/column/user/${encodeURIComponent(other.username)}/`)}>
            <Avatar src={other.avatar_url} name={other.nickname} size={36} />
            <span className="pt-name">{other.nickname}</span>
            <span className="pt-handle">{other.handle}</span>
          </button>
        )}
      </div>
      <div className="pt-thread-body">
        {messages.length >= 50 && (
          <button type="button" className="pt-thread-older" onClick={openOlder} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '查看更早的消息'}
          </button>
        )}
        {messages.map((m) => {
          const day = (m.created_at || '').slice(0, 10);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = m.sender_id === viewer.id;
          return (
            <div key={m.id}>
              {showDay && <div className="pt-thread-day">{dayLabel(m.created_at)}</div>}
              <div className={`pt-dm-row ${mine ? 'is-mine' : ''}`}>
                {!mine && other && <Avatar src={other.avatar_url} name={other.nickname} size={34} />}
                <div className={`pt-dm-bubble ${mine ? 'is-mine' : ''}`}>
                  {m.images && m.images.length > 0 && (
                    <div className={`pt-dm-imgs pt-dm-imgs-${Math.min(m.images.length, 4)}`}>
                      {m.images.map((src, i) => (
                        <img key={src} src={src} alt="" loading="lazy" onClick={() => lightbox(m.images, i)} />
                      ))}
                    </div>
                  )}
                  {m.content}
                  <span className="pt-dm-time">{(m.created_at || '').slice(11, 16)}</span>
                </div>
                {mine && <Avatar src={viewer.avatar_url} name={viewer.nickname} size={34} />}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form
        className="pt-thread-input"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        {pendingImages.length > 0 && (
          <div className="pt-thread-previews">
            {pendingImages.map((item) => (
              <span key={item.id} className="pt-thread-preview">
                <img src={item.url} alt="" />
                <button type="button" onClick={() => removePendingImage(item)} aria-label="移除图片">
                  <Icon path={PATHS.close} size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="pt-thread-input-row">
          <button type="button" className="pt-icon-btn" onClick={() => imgFileRef.current && imgFileRef.current.click()} disabled={pendingImages.length >= IMAGES_MAX} title="发送图片">
            <Icon path={PATHS.image} size={19} />
          </button>
          <input ref={imgFileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            setSending(true);
            uploadImageFile(file).finally(() => setSending(false));
            e.target.value = '';
          }} />
          <textarea
            value={text}
            placeholder={`发私信给 ${other ? other.nickname : '对方'}…`}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button type="submit" className="pt-btn pt-btn-primary pt-btn-sm" disabled={sending || (!text.trim() && !pendingImages.length)}>
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}

function dayLabel(value) {
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(today.getTime() - 86400000);
  if (isSameDay(d, today)) return '今天';
  if (isSameDay(d, yesterday)) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---------------------------------------------------------------- mobile topbar sync

function TopBarSync({ title, showBack, navigate }) {
  useEffect(() => {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const sub = topbar.querySelector('.topbar-sub');
    if (sub) sub.textContent = title;
    document.title = `${title} · VNFest`;
    let back = topbar.querySelector('.pt-topbar-back');
    if (showBack) {
      if (!back) {
        back = document.createElement('button');
        back.className = 'pt-topbar-back';
        back.setAttribute('aria-label', '返回');
        back.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12H4m0 0 6-6m-6 6 6 6"/></svg>';
        back.addEventListener('click', () => navigate('/column/'));
        topbar.insertBefore(back, topbar.firstChild);
      }
      back.style.display = 'inline-flex';
    } else if (back) {
      back.style.display = 'none';
    }
  }, [title, showBack, navigate]);
  return null;
}

// ---------------------------------------------------------------- quote modal

function QuoteModal({ post, user, clubs, onClose, onPosted }) {
  useEffect(() => {
    const close = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="pt-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="pt-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pt-modal-head">
          <button type="button" className="pt-icon-btn" onClick={onClose} aria-label="关闭"><Icon path={PATHS.close} size={18} /></button>
          <span>{post ? '引用转发' : '发动态'}</span>
        </div>
        {post && (
          <div className="pt-modal-quoted">
            <div className="pt-thread-line">正在引用 <span className="pt-handle">@{post.author.username}</span> 的动态</div>
            <QuoteCard post={post} />
          </div>
        )}
        <Composer user={user} clubs={clubs} quoted={post} autoFocus placeholder="添加你的评论" onPosted={() => { onPosted(); onClose(); }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- app

function parseRoute(pathname) {
  const path = pathname.replace(/\/?$/, '/');
  let match = path.match(/^\/column\/post\/(\d+)\/?$/);
  if (match) return { name: 'detail', id: Number(match[1]) };
  match = path.match(/^\/column\/user\/([^/]+)\/?$/);
  if (match) return { name: 'user', username: decodeURIComponent(match[1]) };
  let dmMatch = path.match(/^\/column\/messages\/(\d+)\/?$/);
  if (dmMatch) return { name: 'thread', userId: Number(dmMatch[1]) };
  if (/^\/column\/messages\/?$/.test(path)) return { name: 'messages' };
  if (/^\/column\/search\/?$/.test(path)) {
    return { name: 'search', query: new URLSearchParams(location.search).get('q') || '' };
  }
  if (/^\/column\/my\/?$/.test(path)) return { name: 'mine' };
  return { name: 'feed' };
}

function App() {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  const [boot, setBoot] = useState({ loading: true, user: null, clubs: [] });
  const [refreshKey, setRefreshKey] = useState(0);
  const [quoteTarget, setQuoteTarget] = useState(null);
  const [lightboxState, setLightboxState] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const navigate = useCallback((path) => {
    history.pushState({}, '', path);
    setRoute(parseRoute(path));
    setLightboxState(null);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => { setRoute(parseRoute(location.pathname)); setLightboxState(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiGet('bootstrap')
      .then((data) => { if (!cancelled) setBoot({ loading: false, user: data.user, clubs: data.clubs || [] }); })
      .catch(() => { if (!cancelled) setBoot({ loading: false, user: null, clubs: [] }); });
    return () => { cancelled = true; };
  }, []);

  const { user, clubs } = boot;
  const [dmUnread, setDmUnread] = useState(0);
  useEffect(() => {
    if (!user) { setDmUnread(0); return undefined; }
    let inFlight = false;
    const tick = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      messagesApi('unread_count')
        .then((data) => setDmUnread(data.unread || 0))
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    tick();
    const timer = setInterval(tick, 8000);
    return () => clearInterval(timer);
  }, [user]);

  const bump = () => setRefreshKey((k) => k + 1);
  const openLightbox = (images, index) => setLightboxState({ images, index, onClose: () => setLightboxState(null) });
  const askCompose = () => (user ? setComposeOpen(true) : showToast('请先登录后再发动态', 'warn'));
  const openUser = useCallback((username) => navigate(`/column/user/${encodeURIComponent(username)}/`), [navigate]);

  // /column/my/ 兼容跳转到自己的个人空间
  const effectiveRoute = route.name === 'mine' && user
    ? { name: 'user', username: user.username }
    : route;

  const title = effectiveRoute.name === 'detail' ? '动态'
    : effectiveRoute.name === 'user' ? '个人空间'
    : effectiveRoute.name === 'search' ? '搜索'
    : effectiveRoute.name === 'messages' ? '消息'
    : effectiveRoute.name === 'thread' ? '私信'
    : '同好会动态';

  return (
    <>
      <div className="pt-app">
        <LeftNav user={user} route={effectiveRoute.name} navigate={navigate} onCompose={askCompose} dmUnread={dmUnread} />
        <TopBarSync title={title} showBack={effectiveRoute.name === 'detail' || effectiveRoute.name === 'thread'} navigate={navigate} />
        <main className="pt-center" key={`${effectiveRoute.name}-${effectiveRoute.id || effectiveRoute.username || effectiveRoute.query || ''}`}>
          <ColumnHeader
            title={title}
            showBack={effectiveRoute.name === 'detail'}
            indexOnly={effectiveRoute.name === 'feed' || effectiveRoute.name === 'search' || effectiveRoute.name === 'messages' || effectiveRoute.name === 'user' || effectiveRoute.name === 'mine'}
            navigate={navigate}
          />
        {boot.loading ? (
          <div className="pt-empty">加载中…</div>
        ) : (
          <>
            {effectiveRoute.name === 'feed' && (
              <FeedPage user={user} clubs={clubs} refreshKey={refreshKey} onQuote={(post) => user && setQuoteTarget(post)} lightbox={openLightbox} navigate={navigate} onOpenUser={openUser} />
            )}
            {effectiveRoute.name === 'detail' && (
              <DetailPage id={effectiveRoute.id} user={user} clubs={clubs} refreshKey={refreshKey} onQuote={(post) => user && setQuoteTarget(post)} lightbox={openLightbox} navigate={navigate} onOpenUser={openUser} />
            )}
            {effectiveRoute.name === 'user' && (
              <ProfilePage username={effectiveRoute.username} viewer={user} refreshKey={refreshKey} onQuote={(post) => user && setQuoteTarget(post)} lightbox={openLightbox} navigate={navigate} onOpenUser={openUser} onBump={bump} />
            )}
            {effectiveRoute.name === 'search' && (
              <SearchPage query={effectiveRoute.query} viewer={user} navigate={navigate} onOpenUser={openUser} />
            )}
            {effectiveRoute.name === 'messages' && (
              <MessagesPage viewer={user} navigate={navigate} onOpenUser={openUser} refreshKey={refreshKey} />
            )}
            {effectiveRoute.name === 'thread' && (
              <ThreadPage userId={effectiveRoute.userId} viewer={user} navigate={navigate} refreshKey={refreshKey} lightbox={openLightbox} />
            )}
          </>
        )}
        </main>
        <RightSidebar user={user} navigate={navigate} onOpenUser={openUser} />
        <MobileBottomNav route={effectiveRoute.name} navigate={navigate} onCompose={askCompose} user={user} dmUnread={dmUnread} />
      </div>
      {(composeOpen || quoteTarget) && (
        <QuoteModal
          post={quoteTarget}
          user={user}
          clubs={clubs}
          onClose={() => { setComposeOpen(false); setQuoteTarget(null); }}
          onPosted={bump}
        />
      )}
      <button type="button" className="pt-fab" onClick={askCompose} aria-label="发动态" title="发动态">
        <Icon path={PATHS.feather} size={24} />
      </button>
      <Lightbox state={lightboxState} />
      <ToastHost />
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
