/* admin/club_manager_recognition.js - 考核设置 tab（同好会认可管理）
 * 由 club_manager.html 的 renderList('recognition') 分发调用。
 * 依赖页面全局：escapeHtml / icon / emptyHtml / formatDate / showToast /
 *               selectedClubId / selectedCountry / getClubName。
 * 档位（标准/进阶/专家）仅为编辑器可见范围闸门：保存时不含 tier 字段，
 * 后端按实际使用能力自动推导层级（见 docs/recognition-core-semantics.md §6）。
 */

// ==================== 常量 ====================
var RECOG_TYPE_LABEL = {
  assessment: '知识问答', activity: '活动签到', mission: '连续任务',
  submission: '作品提交', competition: '竞赛评选', award: '人工授予', external: '外部联动'
};
var RECOG_STATUS_LABEL = { draft: '草稿', published: '进行中', paused: '已暂停', archived: '已归档' };
var RECOG_DIFF_LABEL = { easy: '简单', normal: '普通', hard: '困难', extreme: '极难' };
var RECOG_BADGE_CATEGORY = {
  knowledge: '知识', skill: '技能', participation: '参与', contribution: '贡献',
  competition: '竞赛', honor: '荣誉', memorial: '纪念', joint: '联名'
};
var RECOG_VERIFY_LABEL = {
  auto: '自动验证', single_review: '单人审核', multi_review: '多人审核',
  owner_grant: '负责人签发', external_system: '外部系统证明', joint_issue: '联名签发',
  platform: '平台合作验证', batch_import: '名单导入'
};
var RECOG_CONNECTOR_TYPES = ['webhook', 'rest_api', 'discord', 'qq', 'csv', 'qr', 'claim_code', 'game', 'manual', 'event_platform'];
// 参与页路径（同好会考核，原「同好会试炼」）
var RECOG_EXAM_PAGE = '../exam/index.html';

// 五个标准模板：预填 type + 内容骨架（新人入门测试与知识问答重合，已并入知识问答）
var RECOG_TEMPLATES = [
  { key: 'quiz', label: '知识问答', type: 'assessment', difficulty: 'normal', desc: '题库答题，达到及格分自动签发徽章（新成员入门也可用，建议简单题型）' },
  { key: 'checkin', label: '活动签到', type: 'activity', difficulty: 'easy', desc: '线下活动凭兑换码签到，直接签发参与徽章' },
  { key: 'work', label: '作品提交', type: 'submission', difficulty: 'normal', desc: '参与者提交作品，审核通过后签发' },
  { key: 'memorial', label: '纪念徽章', type: 'activity', difficulty: 'easy', desc: '纪念性活动，兑换码领取纪念徽章' },
  { key: 'manual', label: '人工授予', type: 'award', difficulty: 'normal', desc: '由负责人按名单直接授予，无需参与流程' }
];

// 进阶档「即将开放」能力占位
var RECOG_ADVANCED_PLACEHOLDERS = ['随机题库', '限时作答', '多阶段流程', '前置徽章', '多审核员', '条件组合', '分级徽章'];
// 专家档「即将开放」能力占位
var RECOG_EXPERT_PLACEHOLDERS = ['身份绑定（Identity Link）', '联名徽章（多会同签）'];

// ==================== 状态 ====================
var RECOG = {
  clubId: 0, country: 'china',
  programs: [], badges: [], credentials: [], submissions: [], connectors: [],
  caps: null,
  editorOpen: false, editorProgramId: 0, editorTier: 'standard', editorImageUrl: '',
  badgeEditId: 0, badgeImageUrl: '',
  claimProgramId: 0,
  connectorsLoaded: false
};

// ==================== 样式（作用域化，不污染管理页全局） ====================
function recogEnsureStyles() {
  if (document.getElementById('recogScopedStyles')) return;
  var style = document.createElement('style');
  style.id = 'recogScopedStyles';
  style.textContent = [
    '.recog-root{--recog-gold:var(--accent-gold,#f4c95d);--recog-gold-bg:rgba(244,201,93,.12);--recog-gold-border:rgba(244,201,93,.3);--recog-purple:var(--accent-purple,#a78bfa);}',
    '.recog-head{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}',
    '.recog-head h2{margin:0;font-size:18px;color:var(--text-primary);display:flex;align-items:center;gap:8px}',
    '.recog-head h2 .svg-icon{color:var(--recog-gold)}',
    '.recog-club-tag{font-size:12px;padding:3px 10px;border-radius:999px;background:var(--recog-gold-bg);border:1px solid var(--recog-gold-border);color:var(--recog-gold)}',
    '.recog-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px}',
    '.recog-stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px 14px;text-align:center}',
    '.recog-stat .n{font-size:22px;font-weight:700;color:var(--recog-gold)}',
    '.recog-stat .l{font-size:12px;color:var(--text-secondary);margin-top:2px}',
    '.recog-tier-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}',
    '.recog-tier-chip{padding:8px 18px;border-radius:999px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text-secondary);cursor:pointer;font-size:13px;transition:var(--transition)}',
    '.recog-tier-chip small{display:block;font-size:11px;opacity:.75}',
    '.recog-tier-chip.active{border-color:var(--recog-gold-border);background:var(--recog-gold-bg);color:var(--recog-gold)}',
    '.recog-tier-chip:disabled{opacity:.5;cursor:not-allowed}',
    '.recog-fieldset{border:1px dashed var(--border-strong);border-radius:var(--radius-lg);padding:14px;margin-top:12px}',
    '.recog-fieldset>legend,.recog-fs-title{font-size:13px;font-weight:600;color:var(--recog-purple);margin-bottom:8px;display:flex;align-items:center;gap:6px}',
    '.recog-lock-item{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:4px 10px;margin:3px 4px 3px 0;background:var(--surface)}',
    '.recog-lock-item .svg-icon{width:12px;height:12px}',
    '.recog-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
    '.recog-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}',
    '.recog-tpl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}',
    '.recog-tpl{border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;cursor:pointer;background:var(--surface);transition:var(--transition)}',
    '.recog-tpl:hover{border-color:var(--recog-gold-border);background:var(--recog-gold-bg)}',
    '.recog-tpl b{display:block;font-size:13px;color:var(--text-primary);margin-bottom:4px}',
    '.recog-tpl span{font-size:12px;color:var(--text-secondary);line-height:1.5}',
    '.recog-qrow{border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-top:10px;background:var(--surface-raised)}',
    '.recog-qrow .qr-line{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center}',
    '.recog-badge-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:12px}',
    '.recog-badge-card{border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px;text-align:center;background:var(--surface);transition:var(--transition)}',
    '.recog-badge-card:hover{border-color:var(--recog-gold-border)}',
    '.recog-badge-img{width:64px;height:64px;border-radius:50%;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:linear-gradient(135deg,var(--recog-gold-bg),rgba(167,139,250,.15));border:2px solid var(--recog-gold-border)}',
    '.recog-badge-img img{width:100%;height:100%;object-fit:cover}',
    '.recog-badge-img .svg-icon{width:26px;height:26px;color:var(--recog-gold)}',
    '.recog-badge-name{font-size:13px;font-weight:600;color:var(--text-primary)}',
    '.recog-badge-meta{font-size:11px;color:var(--text-muted);margin-top:2px}',
    '.recog-img-preview{width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid var(--recog-gold-border);vertical-align:middle}',
    '.recog-crop-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center}',
    '.recog-crop-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;max-width:92vw}',
    '.recog-crop-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:10px}',
    '.recog-crop-viewport{position:relative;width:300px;height:300px;overflow:hidden;border-radius:8px;background:#111;touch-action:none;cursor:grab;max-width:80vw;max-height:80vw}',
    '.recog-crop-viewport img{position:absolute;user-select:none;pointer-events:none}',
    '.recog-crop-circle{position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 999px rgba(0,0,0,.45);border:2px solid rgba(244,201,93,.7);pointer-events:none}',
    '.recog-crop-zoom{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--text-secondary)}',
    '.recog-crop-zoom input{flex:1}',
    '.recog-crop-actions{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}',
    '.recog-token-box{margin-top:10px;padding:10px 12px;border-radius:var(--radius);background:var(--warning-bg);border:1px solid rgba(245,158,11,.3);font-size:12px;word-break:break-all;color:var(--text-primary)}',
    '.recog-docs{font-size:12px;color:var(--text-secondary);line-height:1.9;background:var(--surface-raised);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:10px}',
    '.recog-docs code{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px}',
    '.recog-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.recog-table th{text-align:left;color:var(--text-muted);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--border)}',
    '.recog-table td{padding:9px 10px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle}',
    '.recog-table tr:last-child td{border-bottom:none}',
    '.recog-table-wrap{overflow-x:auto}',
    '.recog-pill{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--border-strong);color:var(--text-secondary);white-space:nowrap}',
    '.recog-pill.gold{background:var(--recog-gold-bg);border-color:var(--recog-gold-border);color:var(--recog-gold)}',
    '.recog-pill.green{background:var(--success-bg);border-color:rgba(52,211,153,.3);color:var(--success)}',
    '.recog-pill.red{background:var(--danger-bg);border-color:rgba(239,68,68,.3);color:var(--danger)}',
    '.recog-pill.blue{background:var(--info-bg);border-color:rgba(56,189,248,.3);color:var(--info)}',
    '.recog-sub-text{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}',
    '.recog-sub-imgs{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}',
    '.recog-sub-imgs img{width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in}',
    '.recog-hidden{display:none!important}',
    // 行内题目编辑器：容器式选项（对齐题目设计器交互）
    '.recog-qrow .rq-area{margin-top:8px;display:flex;flex-direction:column;gap:6px}',
    '.recog-qrow .rq-opt{display:flex;gap:8px;align-items:center;flex-wrap:nowrap}',
    '.recog-qrow .rq-letter{width:26px;height:26px;border-radius:50%;border:1px solid var(--border-strong);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--text-secondary);cursor:pointer;flex-shrink:0;user-select:none;background:var(--surface)}',
    '.recog-qrow .rq-letter.correct{background:var(--success-bg,rgba(52,211,153,.15));border-color:rgba(52,211,153,.5);color:var(--success,#34d399)}',
    '.recog-qrow .rq-letter.no-mark{cursor:default;background:var(--recog-gold-bg);border-color:var(--recog-gold-border);color:var(--recog-gold)}',
    '.recog-qrow .rq-opt-input{flex:1;min-width:100px}',
    '.recog-qrow .rq-x{padding:2px 10px;flex-shrink:0}',
    '.recog-qrow .rq-hint{font-size:12px;color:var(--text-muted)}',
    '.recog-qrow .rq-drag{cursor:grab;color:var(--text-muted);font-size:13px;letter-spacing:-1px;user-select:none;flex-shrink:0;padding:0 2px}',
    '.recog-qrow .rq-order-row{cursor:grab}',
    '.recog-qrow .rq-order-row.dragging{opacity:.4}',
    '.recog-qrow .rq-drop-top{box-shadow:0 -2px 0 0 var(--recog-gold)}',
    '.recog-qrow .rq-drop-bottom{box-shadow:0 2px 0 0 var(--recog-gold)}',
    '@media (max-width:640px){.recog-grid2,.recog-grid3{grid-template-columns:1fr}}'
  ].join('\n');
  document.head.appendChild(style);
}

// ==================== 小工具 ====================
function recogApi(path, body) {
  var opts = { credentials: 'same-origin' };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return fetch('../api/' + path, opts).then(function (r) { return r.json(); });
}

function recogClubName() {
  if (typeof getClubName === 'function') return getClubName(RECOG.clubId, RECOG.country);
  return '同好会 #' + RECOG.clubId;
}

function recogDtToLocal(dt) {
  return dt ? String(dt).replace(' ', 'T').slice(0, 16) : '';
}

function recogLocalToDt(v) {
  return v ? v.replace('T', ' ') + ':00' : null;
}

function recogStatusPill(status) {
  var cls = status === 'published' ? 'green' : status === 'draft' ? 'blue' : status === 'paused' ? 'gold' : 'red';
  return '<span class="recog-pill ' + cls + '">' + escapeHtml(RECOG_STATUS_LABEL[status] || status) + '</span>';
}

function recogTierLabel(tier) {
  return tier === 'advanced' ? '进阶' : tier === 'expert' ? '专家' : '标准';
}

// ==================== 入口 ====================
async function renderRecognition() {
  recogEnsureStyles();
  var container = document.getElementById('listContainer');
  if (!selectedClubId || selectedClubId <= 0) {
    container.innerHTML = emptyHtml('pointer', '请先在上方选择一个具体的同好会，再管理其考核项目');
    return;
  }
  RECOG.clubId = selectedClubId;
  RECOG.country = selectedCountry || 'china';
  RECOG.editorOpen = false;
  RECOG.claimProgramId = 0;
  RECOG.connectorsLoaded = false;
  RECOG.connectors = [];

  container.innerHTML = '<div class="empty"><span class="loading-spinner"></span>加载考核数据中...</div>';

  var clubId = RECOG.clubId, country = RECOG.country;
  try {
    var results = await Promise.all([
      recogApi('recognition_programs.php?action=manage&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_programs.php?action=badge_list&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_credentials.php?action=club_list&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_admin.php?action=submissions&club_id=' + clubId + '&country=' + country + '&status=pending'),
      recogApi('recognition_programs.php?action=caps_reference')
    ]);
    var progs = results[0], badges = results[1], creds = results[2], subs = results[3], caps = results[4];
    if (!progs.success) {
      container.innerHTML = emptyHtml('noEntry', escapeHtml(progs.message || '无权管理该同好会的考核'));
      return;
    }
    RECOG.programs = progs.programs || [];
    RECOG.badges = (badges && badges.badges) || [];
    RECOG.credentials = (creds && creds.success && creds.credentials) || [];
    RECOG.submissions = (subs && subs.success && subs.submissions) || [];
    RECOG.caps = (caps && caps.success) ? caps : null;
  } catch (e) {
    container.innerHTML = emptyHtml('alert', '加载失败，请刷新重试');
    return;
  }
  recogRenderAll();
}

function recogRenderAll() {
  var container = document.getElementById('listContainer');
  var html = '<div class="recog-root">';
  html += recogHeadHtml();
  html += recogStatsHtml();
  html += recogProgramsHtml();
  html += '<div id="recogEditorCard"></div>';
  html += recogBadgesHtml();
  html += recogOpsHtml();
  html += '<div id="recogClaimCard"></div>';
  html += recogCredentialsHtml();
  html += '</div>';
  container.innerHTML = html;
}

// 仅刷新数据，不重建整页；编辑器打开时把编辑器 DOM 暂存后回填，
// 避免保存徽章/审核等操作把出题到一半的内容刷丢。
async function recogRefreshData() {
  if (!RECOG.editorOpen || !document.getElementById('recogEditorCard')) {
    await renderRecognition();
    return;
  }
  var clubId = RECOG.clubId, country = RECOG.country;
  var results;
  try {
    results = await Promise.all([
      recogApi('recognition_programs.php?action=manage&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_programs.php?action=badge_list&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_credentials.php?action=club_list&club_id=' + clubId + '&country=' + country),
      recogApi('recognition_admin.php?action=submissions&club_id=' + clubId + '&country=' + country + '&status=pending'),
      recogApi('recognition_programs.php?action=caps_reference')
    ]);
  } catch (e) { showToast('刷新数据失败，页面保持原状', 'error'); return; }
  var progs = results[0], badges = results[1], creds = results[2], subs = results[3], caps = results[4];
  if (!progs || !progs.success) { showToast(progs && progs.message || '刷新失败', 'error'); return; }
  RECOG.programs = progs.programs || [];
  RECOG.badges = (badges && badges.badges) || [];
  RECOG.credentials = (creds && creds.success && creds.credentials) || [];
  RECOG.submissions = (subs && subs.success && subs.submissions) || [];
  RECOG.caps = (caps && caps.success) ? caps : null;

  // 暂存编辑器节点（带事件监听一起保留），重绘其余区块后回填；
  // 节点先从旧容器移除，重绘产生的 innerHTML 替换不会碰它。
  var editorCard = document.getElementById('recogEditorCard');
  var editorDom = editorCard ? editorCard.firstElementChild : null;
  if (editorDom && editorDom.parentNode) editorDom.parentNode.removeChild(editorDom);
  recogRenderAll();
  if (editorDom) {
    var holder = document.getElementById('recogEditorCard');
    if (holder) holder.appendChild(editorDom);
    // 新建的徽章同步进编辑器的奖励徽章下拉，保留当前选中项；
    // 已选徽章被删时保留原值不重置，避免误清用户选择。
    var sel = document.getElementById('recogBadge');
    if (sel) {
      var cur = sel.value;
      var opts = '<option value="">— 选择徽章 —</option>' + RECOG.badges.map(function (b) {
        return '<option value="' + b.id + '">' + escapeHtml(b.name) + '</option>';
      }).join('');
      sel.innerHTML = opts;
      sel.value = cur;
    }
  }
}

// ==================== 头部与统计 ====================
function recogHeadHtml() {
  return '<div class="recog-head">' +
    '<h2>' + icon('star') + ' 同好会考核设置</h2>' +
    '<span class="recog-club-tag">' + (RECOG.country === 'japan' ? '日本 · ' : '') + escapeHtml(recogClubName()) + '</span>' +
    '<span style="flex:1"></span>' +
    '<button class="btn btn-ghost" onclick="renderRecognition()">' + icon('refresh') + ' 刷新</button>' +
  '</div>';
}

function recogStatsHtml() {
  var published = RECOG.programs.filter(function (p) { return p.status === 'published'; }).length;
  var issued = RECOG.programs.reduce(function (s, p) { return s + (parseInt(p.issued_total, 10) || 0); }, 0);
  var items = [
    { n: RECOG.programs.length, l: '考核项目' },
    { n: published, l: '进行中' },
    { n: issued, l: '累计签发' },
    { n: RECOG.badges.length, l: '成就徽章' },
    { n: RECOG.submissions.length, l: '待审核' },
    { n: RECOG.credentials.length, l: '凭证总数' }
  ];
  return '<div class="recog-stats">' + items.map(function (it) {
    return '<div class="recog-stat"><div class="n">' + it.n + '</div><div class="l">' + it.l + '</div></div>';
  }).join('') + '</div>';
}

// ==================== 项目表 ====================
function recogProgramsHtml() {
  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('book') + ' 考核项目 (' + RECOG.programs.length + ')</div>' +
    '<div class="section-sub">档位由实际使用的能力自动判定：标准能力 → 标准，启用有效期/限量等 → 进阶，配置外部接入 → 专家</div>';

  if (!RECOG.programs.length) {
    html += '<div style="text-align:center;padding:24px;color:var(--text-secondary);font-size:14px;">暂无考核项目，点击下方「新建考核」从模板开始</div>';
  } else {
    html += '<div class="recog-table-wrap"><table class="recog-table">' +
      '<tr><th>标题</th><th>类型</th><th>档位</th><th>状态</th><th>已签发</th><th>开放时间</th><th style="text-align:right">操作</th></tr>' +
      RECOG.programs.map(function (p) {
        var actions = '';
        if (p.status === 'draft') actions += '<button class="btn btn-sm btn-primary" onclick="recogPublishProgram(' + p.id + ')">发布</button> ';
        if (p.status === 'published') actions += '<button class="btn btn-sm btn-ghost" onclick="recogProgramStatus(' + p.id + ',\'paused\')">暂停</button> ';
        if (p.status === 'paused') actions += '<button class="btn btn-sm btn-ghost" onclick="recogProgramStatus(' + p.id + ',\'published\')">恢复</button> ';
        if (p.status !== 'archived') actions += '<button class="btn btn-sm btn-ghost" onclick="recogProgramStatus(' + p.id + ',\'archived\')">归档</button> ';
        actions += '<button class="btn btn-sm btn-ghost" onclick="recogEditProgram(' + p.id + ')">编辑</button> ';
        if (p.status !== 'archived') actions += '<button class="btn btn-sm btn-ghost" onclick="recogShowClaim(' + p.id + ')">兑换码</button> ';
        if (p.type === 'assessment') actions += '<button class="btn btn-sm btn-ghost" onclick="recogQuizSync(' + p.id + ',this)">同步战绩</button> ';
        actions += '<button class="btn btn-sm btn-ghost" onclick="recogShowProgramQr(' + p.id + ')" title="参与入口二维码">二维码</button> ';
        actions += '<button class="btn btn-sm btn-ghost" onclick="recogCopyCheckin(' + p.id + ')" title="复制参与入口">' + icon('clipboard') + '</button>';
        return '<tr>' +
          '<td><strong>' + escapeHtml(p.title) + '</strong></td>' +
          '<td>' + escapeHtml(RECOG_TYPE_LABEL[p.type] || p.type) + '</td>' +
          '<td><span class="recog-pill gold">' + recogTierLabel(p.tier) + '</span></td>' +
          '<td>' + recogStatusPill(p.status) + '</td>' +
          '<td>' + (p.issued_total || 0) + '</td>' +
          '<td style="font-size:12px;color:var(--text-secondary)">' + (p.open_at ? formatDate(p.open_at) : '长期') + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + actions + '</td>' +
        '</tr>';
      }).join('') + '</table></div>';
  }

  html += '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn btn-primary" onclick="recogOpenCreate()">' + icon('star') + ' 新建考核</button>' +
  '</div></div>';
  return html;
}

// ==================== 编辑器 ====================
function recogOpenCreate() {
  RECOG.editorOpen = true;
  RECOG.editorProgramId = 0;
  RECOG.editorTier = 'standard';
  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('edit') + ' 新建考核 · 选择模板</div>' +
    '<div class="section-sub">模板会预填类型与完成规则骨架，创建后可在编辑器中继续调整</div>' +
    '<div class="recog-tpl-grid">' +
      RECOG_TEMPLATES.map(function (t) {
        return '<div class="recog-tpl" onclick="recogUseTemplate(\'' + t.key + '\')">' +
          '<b>' + escapeHtml(t.label) + '</b><span>' + escapeHtml(t.desc) + '</span></div>';
      }).join('') +
    '</div>' +
    '<div style="margin-top:12px"><button class="btn btn-ghost" onclick="recogCloseEditor()">取消</button></div>' +
  '</div>';
  document.getElementById('recogEditorCard').innerHTML = html;
  document.getElementById('recogEditorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function recogUseTemplate(key) {
  var tpl = RECOG_TEMPLATES.find(function (t) { return t.key === key; });
  if (!tpl) return;
  recogRenderEditor({
    programId: 0,
    type: tpl.type,
    title: tpl.label === '知识问答' ? '' : tpl.label,
    intro: tpl.desc,
    participant_difficulty: tpl.difficulty,
    content: null,
    tplKey: key
  });
}

async function recogEditProgram(programId) {
  var card = document.getElementById('recogEditorCard');
  card.innerHTML = '<div class="section-card"><div class="empty"><span class="loading-spinner"></span>载入考核内容...</div></div>';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    var res = await recogApi('recognition_programs.php?action=detail&id=' + programId);
    if (!res || !res.success) {
      card.innerHTML = '<div class="section-card">' + emptyHtml('alert', escapeHtml((res && res.message) || '载入失败')) + '</div>';
      return;
    }
    var p = res.program, v = res.version;
    var manageRow = RECOG.programs.find(function (x) { return x.id === programId; });
    recogRenderEditor({
      programId: programId,
      type: p.type,
      title: p.title,
      intro: p.intro || '',
      participant_difficulty: p.participant_difficulty || 'normal',
      max_attempts: p.max_attempts || 0,
      cooldown_minutes: p.cooldown_minutes || 0,
      open_at: p.open_at,
      close_at: p.close_at,
      content: (v && v.content) || null,
      versionNo: v ? v.version_no : '',
      versionStatus: v ? v.status : '',
      tier: manageRow ? manageRow.tier : 'standard'
    });
  } catch (e) {
    card.innerHTML = '<div class="section-card">' + emptyHtml('alert', '载入失败，请重试') + '</div>';
  }
}

function recogRenderEditor(opts) {
  RECOG.editorOpen = true;
  RECOG.editorProgramId = opts.programId || 0;
  RECOG.editorTier = opts.tier || 'standard';
  RECOG.editorTplKey = opts.tplKey || '';

  var typeOptions = Object.keys(RECOG_TYPE_LABEL).map(function (t) {
    return '<option value="' + t + '"' + (t === opts.type ? ' selected' : '') + '>' + RECOG_TYPE_LABEL[t] + '</option>';
  }).join('');
  var diffOptions = Object.keys(RECOG_DIFF_LABEL).map(function (d) {
    return '<option value="' + d + '"' + (d === (opts.participant_difficulty || 'normal') ? ' selected' : '') + '>' + RECOG_DIFF_LABEL[d] + '</option>';
  }).join('');
  var badgeOptions = RECOG.badges.map(function (b) {
    return '<option value="' + b.id + '">' + escapeHtml(b.name) + '（' + (RECOG_BADGE_CATEGORY[b.category] || b.category) + '）</option>';
  }).join('');

  var content = opts.content || null;
  var rules = (content && content.rules) || {};
  var awardBadgeId = parseInt(((rules.award || {}).badge_id) || 0, 10);
  // 及格分按卷面累计分比较：已配置用已存值；新考核按题库分值总和的 60% 预估
  var hasPassRule = false;
  var passScore = 60;
  (rules.conditions || []).forEach(function (c) { if (c.op === 'score_gte') { passScore = parseInt(c.value, 10) || 0; hasPassRule = true; } });
  if (!hasPassRule) {
    var quizQs = (content && content.quiz && content.quiz.questions) || [];
    if (quizQs.length) {
      var fullScore = 0;
      quizQs.forEach(function (q) { fullScore += parseInt(q.points, 10) || 10; });
      passScore = Math.round(fullScore * 0.6);
    }
  }
  var claimEnabled = !!(content && content.claim && content.claim.enabled);
  // 考试设置（schema v2 settings；v1 快照兼容：乱序取顶层 quiz.shuffle）
  RECOG._quizSettings = (content && content.quiz && content.quiz.settings) || {
    shuffle: !!(content && content.quiz && content.quiz.shuffle),
    shuffle_options: false, pick_count: 0, time_limit: 0, multiple_partial: false, result_mode: 'immediate'
  };
  var ttlDays = parseInt(opts.credential_ttl_days || 0, 10);
  var maxIssuance = parseInt(opts.max_issuance || 0, 10);

  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('edit') + (opts.programId ? ' 编辑考核 #' + opts.programId : ' 新建考核') +
      (opts.versionNo ? ' <span class="recog-pill blue">当前版本 ' + escapeHtml(opts.versionNo) + '（' + escapeHtml(opts.versionStatus === 'draft' ? '草稿' : '已发布') + '）</span>' : '') +
    '</div>' +
    '<div class="section-sub">' + escapeHtml((RECOG.caps && RECOG.caps.note) || '层级不落库：保存时按实际使用能力自动判定') + '</div>' +

    // 档位选择器（仅控制编辑器可见范围）
    '<div class="recog-tier-row">' +
      '<button type="button" class="recog-tier-chip' + (RECOG.editorTier === 'standard' ? ' active' : '') + '" data-tier="standard" onclick="recogSetTier(\'standard\')">标准档<small>题库 / 及格线 / 兑换码 / 审核</small></button>' +
      '<button type="button" class="recog-tier-chip' + (RECOG.editorTier === 'advanced' ? ' active' : '') + '" data-tier="advanced" onclick="recogSetTier(\'advanced\')">进阶档<small>＋凭证有效期 / 限量签发</small></button>' +
      '<button type="button" class="recog-tier-chip' + (RECOG.editorTier === 'expert' ? ' active' : '') + '" data-tier="expert" onclick="recogSetTier(\'expert\')">专家档<small>＋外部事件接入（Connector）</small></button>' +
    '</div>' +

    // 基本信息（所有档位）
    '<div class="recog-grid2">' +
      '<div class="form-group"><label>标题 *</label><input id="recogTitle" class="form-input" maxlength="100" value="' + escapeHtml(opts.title || '') + '" placeholder="例如：社内知识问答考核"></div>' +
      '<div class="form-group"><label>类型</label><select id="recogType" class="form-input" onchange="recogOnTypeChange()">' + typeOptions + '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>介绍</label><textarea id="recogIntro" class="form-input" rows="2" placeholder="向参与者展示考核说明">' + escapeHtml(opts.intro || '') + '</textarea></div>' +
    '<div class="recog-grid3">' +
      '<div class="form-group" id="recogDiffGroup"><label>参与者难度</label><select id="recogDiff" class="form-input">' + diffOptions + '</select></div>' +
      '<div class="form-group" id="recogAttemptsGroup"><label>尝试次数（0=不限）</label><input id="recogAttempts" class="form-input" type="number" min="0" value="' + (opts.max_attempts || 0) + '"></div>' +
      '<div class="form-group" id="recogCooldownGroup"><label>冷却分钟（0=无）</label><input id="recogCooldown" class="form-input" type="number" min="0" value="' + (opts.cooldown_minutes || 0) + '"></div>' +
      '<div class="form-group"><label>开放时间（可选）</label><input id="recogOpenAt" class="form-input" type="datetime-local" value="' + recogDtToLocal(opts.open_at) + '"></div>' +
      '<div class="form-group"><label>截止时间（可选）</label><input id="recogCloseAt" class="form-input" type="datetime-local" value="' + recogDtToLocal(opts.close_at) + '"></div>' +
      '<div class="form-group"><label>奖励徽章 *</label><select id="recogBadge" class="form-input">' +
        '<option value="">— 选择徽章 —</option>' + badgeOptions +
      '</select></div>' +
    '</div>';

  if (!RECOG.badges.length) {
    html += '<div class="section-sub" style="margin-bottom:0">' + icon('alert') + ' 该同好会还没有徽章，请先在下方「成就徽章」区创建，再回来选择奖励徽章</div>';
  }

  // 标准档分区
  html += '<div class="recog-fieldset" id="recogFsStandard">' +
    '<div class="recog-fs-title">' + icon('check') + ' 标准能力</div>' +
    '<div id="recogQuizBlock"></div>' +
    '<div class="recog-grid3">' +
      '<div class="form-group" id="recogPassGroup"><label>及格分（卷面累计分）</label><input id="recogPass" class="form-input" type="number" min="0" value="' + passScore + '"><span class="form-hint" id="recogPassHint"></span></div>' +
      '<div class="form-group" id="recogClaimGroup"><label>兑换码领取</label><select id="recogClaim" class="form-input"><option value="1"' + (claimEnabled ? ' selected' : '') + '>启用（现场兑换/签到）</option><option value="0"' + (!claimEnabled ? ' selected' : '') + '>关闭</option></select></div>' +
    '</div>' +
  '</div>';

  // 进阶档分区
  html += '<div class="recog-fieldset recog-hidden" id="recogFsAdvanced">' +
    '<div class="recog-fs-title">' + icon('shield') + ' 进阶能力</div>' +
    '<div class="recog-grid3">' +
      '<div class="form-group"><label>凭证有效期（天，0=永久）</label><input id="recogTtl" class="form-input" type="number" min="0" value="' + ttlDays + '"><span class="form-hint">到期后凭证转「已过期」，验证页可查历史</span></div>' +
      '<div class="form-group"><label>签发总量上限（0=不限）</label><input id="recogMaxIssue" class="form-input" type="number" min="0" value="' + maxIssuance + '"><span class="form-hint">达到上限后不再签发新凭证</span></div>' +
    '</div>' +
    '<div style="margin-top:6px">' +
      RECOG_ADVANCED_PLACEHOLDERS.map(function (name) {
        return '<span class="recog-lock-item">' + icon('lock') + escapeHtml(name) + ' · 即将开放</span>';
      }).join('') +
    '</div>' +
  '</div>';

  // 专家档分区
  html += '<div class="recog-fieldset recog-hidden" id="recogFsExpert">' +
    '<div class="recog-fs-title">' + icon('bot') + ' 专家能力 · 外部事件接入（Connector）</div>' +
    '<div class="section-sub" style="margin-bottom:8px">将外部系统（机器人 / 游戏平台 / 活动平台）的事实事件接入考核，满足规则后自动签发。Connector 归属同好会，可被多个项目共享。</div>' +
    '<div id="recogConnectorArea"><button class="btn btn-ghost" onclick="recogLoadConnectors(true)">' + icon('refresh') + ' 载入 Connector 管理</button></div>' +
    '<div style="margin-top:10px">' +
      RECOG_EXPERT_PLACEHOLDERS.map(function (name) {
        return '<span class="recog-lock-item">' + icon('lock') + escapeHtml(name) + ' · 即将开放</span>';
      }).join('') +
    '</div>' +
  '</div>';

  html += '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn btn-primary" onclick="recogSaveProgram(true)">' + icon('check') + ' 保存并发布</button>' +
    '<button class="btn" onclick="recogSaveProgram(false)">保存草稿</button>' +
    '<button class="btn btn-ghost" onclick="recogCloseEditor()">取消</button>' +
  '</div></div>';

  document.getElementById('recogEditorCard').innerHTML = html;

  // 徽章预选
  if (awardBadgeId) document.getElementById('recogBadge').value = String(awardBadgeId);
  // 题目行：先由 recogOnTypeChange 创建题库容器，再回填已有题目
  window._recogQuestions = [];
  recogOnTypeChange();
  var questions = (content && content.quiz && content.quiz.questions) || [];
  if (questions.length) {
    var holder = document.getElementById('recogQuestions');
    if (holder) holder.innerHTML = '';
    window._recogQuestions = [];
    questions.forEach(function (q) { recogAddQuestionRow(q); });
  }
  recogUpdatePassHint();
  recogSetTier(RECOG.editorTier, true);
  document.getElementById('recogEditorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 卷面总分实时统计：得分与及格线均按题目分值累计，随题库增删改即时更新
function recogUpdatePassHint() {
  var holder = document.getElementById('recogQuestions');
  var hint = document.getElementById('recogPassHint');
  if (!holder || !hint) return;
  var sum = 0, count = 0;
  holder.querySelectorAll('.recog-qrow').forEach(function (row) {
    var stem = row.querySelector('.rq-text');
    if (!stem || !stem.value.trim()) return;
    count++;
    var pts = row.querySelector('.rq-points');
    sum += parseInt(pts ? pts.value : '0', 10) || 0;
  });
  hint.textContent = count
    ? '当前 ' + count + ' 题 · 卷面总分 ' + sum + ' 分（得分与及格线均按此累计）'
    : '添加题目后按卷面总分设置及格线';
}

function recogOnTypeChange() {
  var type = document.getElementById('recogType').value;
  var quizBlock = document.getElementById('recogQuizBlock');
  var passGroup = document.getElementById('recogPassGroup');
  var claimGroup = document.getElementById('recogClaimGroup');
  var isQuiz = type === 'assessment';
  passGroup.style.display = isQuiz ? '' : 'none';
  claimGroup.style.display = (type === 'activity' || type === 'mission') ? '' : 'none';
  // 设置随类型差异化：难度仅答题/任务类有意义；尝试次数与冷却只作用于判分答题
  var diffVisible = isQuiz || type === 'mission';
  var diffGroup = document.getElementById('recogDiffGroup');
  var attGroup = document.getElementById('recogAttemptsGroup');
  var cdGroup = document.getElementById('recogCooldownGroup');
  if (diffGroup) diffGroup.style.display = diffVisible ? '' : 'none';
  if (attGroup) attGroup.style.display = isQuiz ? '' : 'none';
  if (cdGroup) cdGroup.style.display = isQuiz ? '' : 'none';
  if (isQuiz) {
    if (!quizBlock.dataset.ready) {
      quizBlock.dataset.ready = '1';
      quizBlock.innerHTML =
        '<div class="form-group" style="margin-bottom:10px"><label>考试设置</label>' +
          '<div class="recog-grid3">' +
            '<div class="form-group"><label>题目乱序</label><select id="recogSkShuffle" class="form-input"><option value="0">关</option><option value="1">开</option></select></div>' +
            '<div class="form-group"><label>选项乱序</label><select id="recogSkShuffleOpt" class="form-input"><option value="0">关</option><option value="1">开</option></select></div>' +
            '<div class="form-group"><label>抽题数量（0=全部）</label><input id="recogSkPick" class="form-input" type="number" min="0" value="0"></div>' +
            '<div class="form-group"><label>限时（分钟，0=不限，≤180）</label><input id="recogSkTimeLimit" class="form-input" type="number" min="0" max="180" value="0"></div>' +
            '<div class="form-group"><label>多选半分</label><select id="recogSkPartial" class="form-input"><option value="0">关（全对才得分）</option><option value="1">开（选对得分、选错扣分）</option></select></div>' +
            '<div class="form-group"><label>成绩显示</label><select id="recogSkResultMode" class="form-input"><option value="immediate">立即显示分数与解析</option><option value="pass_only">只显示通过/未通过</option><option value="hidden">交卷后不显示</option></select></div>' +
          '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:6px"><label>题库</label>' +
        '<div class="qd-hint" style="font-size:12px;color:var(--text-muted);margin-bottom:6px">题目较多时建议使用「题目设计器」：独立页面逐题编辑、支持预览与 JSON 导入导出</div>' +
        '<div id="recogQuestions"></div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-ghost" onclick="recogAddQuestionRow()">+ 添加题目</button>' +
          '<button type="button" class="btn" onclick="recogOpenDesigner()">✎ 打开题目设计器</button>' +
        '</div></div>';
      // 回填已有考试设置（编辑时）
      var sk = RECOG._quizSettings || {};
      document.getElementById('recogQuestions').addEventListener('input', recogUpdatePassHint);
      document.getElementById('recogSkShuffle').value = sk.shuffle ? '1' : '0';
      document.getElementById('recogSkShuffleOpt').value = sk.shuffle_options ? '1' : '0';
      document.getElementById('recogSkPick').value = parseInt(sk.pick_count, 10) || 0;
      document.getElementById('recogSkTimeLimit').value = parseInt(sk.time_limit, 10) || 0;
      document.getElementById('recogSkPartial').value = sk.multiple_partial ? '1' : '0';
      document.getElementById('recogSkResultMode').value = sk.result_mode || 'immediate';
      if (!window._recogQuestions || !window._recogQuestions.length) recogAddQuestionRow();
    }
    quizBlock.style.display = '';
  } else {
    quizBlock.style.display = 'none';
  }
}

function recogSetTier(tier, silent) {
  if (RECOG.editorTier !== tier && !silent) RECOG.editorTier = tier;
  document.querySelectorAll('.recog-tier-chip').forEach(function (c) {
    c.classList.toggle('active', c.dataset.tier === RECOG.editorTier);
  });
  var adv = document.getElementById('recogFsAdvanced');
  var exp = document.getElementById('recogFsExpert');
  if (adv) adv.classList.toggle('recog-hidden', RECOG.editorTier === 'standard');
  if (exp) exp.classList.toggle('recog-hidden', RECOG.editorTier !== 'expert');
  if (RECOG.editorTier === 'expert' && !RECOG.connectorsLoaded) recogLoadConnectors(false);
}

// ---- 题目行编辑器（容器式选项，交互对齐题目设计器；富字段经 dataset.qExtra 透传） ----
var RQ_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
var RQ_MAX_OPTIONS = 20;
var RQ_MAX_BLANKS = 10;

function recogQTypeLabel(t) {
  return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断'
    : t === 'fill_blank' ? '填空' : t === 'order' ? '排序' : '多空填空';
}

// 每行草稿数据（row._rq）：输入实时写入，切类型/增删选项时重渲染不丢内容
function recogQDraft(row, q) {
  if (!row._rq) {
    q = q || {};
    row._rq = {
      options: Array.isArray(q.options) ? q.options.map(String) : ['', ''],
      answer: Array.isArray(q.answer) ? q.answer.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return !isNaN(n); }) : [],
      answer_text: q.answer_text || '',
      answer_texts: Array.isArray(q.answer_texts) && q.answer_texts.length ? q.answer_texts.map(String) : ['', '']
    };
    if (q.type === 'judge') row._rq.options = ['对', '错'];
  }
  return row._rq;
}

function recogAddQuestionRow(q) {
  var holder = document.getElementById('recogQuestions');
  if (!holder) return;
  q = q || {};
  var div = document.createElement('div');
  div.className = 'recog-qrow';
  recogQDraft(div, q);
  // 设计器回传的富字段（题干图/选项图）存 dataset，行内不编辑图片，
  // 收集时由 recogCollectQuestions 合并，避免保存时丢失。
  var extra = {};
  if (q.image) extra.image = q.image;
  if (q.option_images && q.option_images.length) extra.option_images = q.option_images;
  if (Object.keys(extra).length) div.dataset.qExtra = JSON.stringify(extra);
  div.innerHTML =
    '<div class="form-group" style="margin-bottom:6px"><input class="form-input rq-text" placeholder="题干" value="' + escapeHtml(q.question || '') + '"></div>' +
    '<div class="qr-line">' +
      '<select class="form-input rq-type" style="width:96px" onchange="recogQTypeChange(this)">' +
        ['single', 'multiple', 'judge', 'fill_blank', 'order', 'fill_multi'].map(function (t) {
          return '<option value="' + t + '"' + ((q.type || 'single') === t ? ' selected' : '') + '>' + recogQTypeLabel(t) + '</option>';
        }).join('') +
      '</select>' +
      '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">分值 <input class="form-input rq-points" style="width:70px" type="number" min="1" max="100" value="' + (parseInt(q.points, 10) || 10) + '" title="本题分值（1–100）"></span>' +
      '<button type="button" class="btn btn-sm btn-danger" style="margin-left:auto" onclick="recogDelQuestion(this)">删除</button>' +
    '</div>' +
    '<div class="rq-area"></div>' +
    '<div class="form-group" style="margin-bottom:0;margin-top:8px"><input class="form-input rq-expl" placeholder="答案说明（可选，交卷后随解析展示）" value="' + escapeHtml(q.explanation || '') + '"></div>';
  holder.appendChild(div);
  if (window._recogQuestions) window._recogQuestions.push(div);
  recogRenderQArea(div);
  recogUpdatePassHint();
}

function recogRenderQArea(row) {
  var area = row.querySelector('.rq-area');
  if (!area) return;
  var t = row.querySelector('.rq-type').value;
  var d = recogQDraft(row, {});
  var html = '';
  if (t === 'fill_blank') {
    html = '<div class="rq-opt"><input class="form-input" style="flex:1" value="' + escapeHtml(d.answer_text) + '"' +
      ' placeholder="参考答案（判分忽略大小写与首尾空格）" oninput="recogQAnswerTextInput(this)"></div>';
  } else if (t === 'fill_multi') {
    html = d.answer_texts.map(function (txt, bi) {
      return '<div class="rq-opt"><span class="rq-letter no-mark">' + (bi + 1) + '</span>' +
        '<input class="form-input rq-opt-input" data-bi="' + bi + '" value="' + escapeHtml(txt) + '" placeholder="第 ' + (bi + 1) + ' 空参考答案" oninput="recogQBlankInput(this)">' +
        (d.answer_texts.length > 1 ? '<button type="button" class="btn btn-sm btn-danger rq-x" onclick="recogQDelBlank(this)" title="删除该空">×</button>' : '') +
      '</div>';
    }).join('') +
    (d.answer_texts.length < RQ_MAX_BLANKS ? '<button type="button" class="btn btn-sm btn-ghost" onclick="recogQAddBlank(this)" style="align-self:flex-start">+ 加一个空</button>' : '');
  } else if (t === 'order') {
    html = d.options.map(function (opt, oi) {
      return '<div class="rq-opt rq-order-row" draggable="true">' +
        '<span class="rq-drag" title="拖动调整顺序">⋮⋮</span>' +
        '<span class="rq-letter no-mark">' + (oi + 1) + '</span>' +
        '<input class="form-input rq-opt-input" data-oi="' + oi + '" value="' + escapeHtml(opt) + '" placeholder="选项 ' + (oi + 1) + '" oninput="recogQOptInput(this)">' +
        '<button type="button" class="btn btn-sm" onclick="recogQMoveOpt(this,-1)" title="上移">↑</button>' +
        '<button type="button" class="btn btn-sm" onclick="recogQMoveOpt(this,1)" title="下移">↓</button>' +
        (d.options.length > 2 ? '<button type="button" class="btn btn-sm btn-danger rq-x" onclick="recogQDelOpt(this)" title="删除选项">×</button>' : '') +
      '</div>';
    }).join('') +
    (d.options.length < RQ_MAX_OPTIONS ? '<button type="button" class="btn btn-sm btn-ghost" onclick="recogQAddOpt(this)" style="align-self:flex-start">+ 添加选项</button>' : '') +
    '<div class="rq-hint">选项当前排列即正确答案（1 在最前）：拖动或用 ↑↓ 调整</div>';
  } else {
    html = d.options.map(function (opt, oi) {
      var correct = d.answer.indexOf(oi) >= 0;
      var letter = t === 'judge' ? (oi === 0 ? '✓' : '✗') : RQ_LETTERS[oi];
      return '<div class="rq-opt">' +
        '<span class="rq-letter' + (correct ? ' correct' : '') + '" data-oi="' + oi + '" onclick="recogQMarkAnswer(this)" title="设为正确答案">' + letter + '</span>' +
        '<input class="form-input rq-opt-input" data-oi="' + oi + '" value="' + escapeHtml(opt) + '" placeholder="选项 ' + letter + '"' + (t === 'judge' ? ' readonly' : '') + ' oninput="recogQOptInput(this)">' +
        (t !== 'judge' && d.options.length > 2 ? '<button type="button" class="btn btn-sm btn-danger rq-x" onclick="recogQDelOpt(this)" title="删除选项">×</button>' : '') +
      '</div>';
    }).join('') +
    (t !== 'judge' && d.options.length < RQ_MAX_OPTIONS ? '<button type="button" class="btn btn-sm btn-ghost" onclick="recogQAddOpt(this)" style="align-self:flex-start">+ 添加选项</button>' : '') +
    '<div class="rq-hint">' + (t === 'multiple' ? '点字母设为正确答案，多选可标记多个' : t === 'judge' ? '点 ✓/✗ 设为正确答案' : '点字母设为正确答案') + '</div>';
  }
  area.innerHTML = html;
  if (t === 'order') recogQBindOrderDrag(row);
}

// qExtra 里的选项图：与选项数组同增删移（长度一致才同步，收集时长度不一致会被丢弃）
function recogQOptImages(row) {
  try {
    var extra = row.dataset.qExtra ? JSON.parse(row.dataset.qExtra) : null;
    if (extra && Array.isArray(extra.option_images) && extra.option_images.length === row._rq.options.length) return extra.option_images;
  } catch (e) {}
  return null;
}

function recogQSaveOptImages(row, imgs) {
  if (!imgs || !imgs.some(function (u) { return u; })) return;
  var extra = {};
  try { extra = row.dataset.qExtra ? JSON.parse(row.dataset.qExtra) : {}; } catch (e) {}
  extra.option_images = imgs;
  row.dataset.qExtra = JSON.stringify(extra);
}

function recogQTypeChange(sel) {
  var row = sel.closest('.recog-qrow');
  var d = recogQDraft(row, {});
  var t = sel.value;
  if (t === 'judge') { d.options = ['对', '错']; d.answer = []; }
  else if (t === 'fill_blank') { d.answer = []; }
  else if (t === 'fill_multi') {
    d.answer = [];
    if (!d.answer_texts.length) d.answer_texts = ['', ''];
  } else {
    if (t === 'single' && d.answer.length > 1) d.answer = [d.answer[0]];
    d.answer = d.answer.filter(function (a) { return a >= 0 && a < d.options.length; });
    if (t !== 'order' && d.options.length < 2) d.options = ['', ''];
  }
  recogRenderQArea(row);
}

function recogQMarkAnswer(span) {
  var row = span.closest('.recog-qrow');
  var d = row._rq;
  var t = row.querySelector('.rq-type').value;
  var oi = parseInt(span.dataset.oi, 10);
  if (t === 'multiple') {
    var idx = d.answer.indexOf(oi);
    if (idx >= 0) d.answer.splice(idx, 1); else d.answer.push(oi);
  } else {
    d.answer = (d.answer.length === 1 && d.answer[0] === oi) ? [] : [oi];
  }
  recogRenderQArea(row);
}

function recogQOptInput(input) {
  input.closest('.recog-qrow')._rq.options[parseInt(input.dataset.oi, 10)] = input.value;
}

function recogQAddOpt(btn) {
  var row = btn.closest('.recog-qrow');
  var d = row._rq;
  if (d.options.length >= RQ_MAX_OPTIONS) return;
  d.options.push('');
  recogRenderQArea(row);
  var inputs = row.querySelectorAll('.rq-opt-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function recogQDelOpt(btn) {
  var row = btn.closest('.recog-qrow');
  var d = row._rq;
  var input = btn.closest('.rq-opt').querySelector('.rq-opt-input');
  var oi = input ? parseInt(input.dataset.oi, 10) : -1;
  if (oi < 0 || oi >= d.options.length) return;
  var imgs = recogQOptImages(row);
  if (imgs) imgs.splice(oi, 1);
  d.options.splice(oi, 1);
  d.answer = d.answer.filter(function (a) { return a !== oi; }).map(function (a) { return a > oi ? a - 1 : a; });
  recogQSaveOptImages(row, imgs);
  recogRenderQArea(row);
}

function recogQMoveOpt(btn, dir) {
  var row = btn.closest('.recog-qrow');
  var d = row._rq;
  var input = btn.closest('.rq-opt').querySelector('.rq-opt-input');
  var oi = input ? parseInt(input.dataset.oi, 10) : -1;
  var ni = oi + dir;
  if (oi < 0 || ni < 0 || ni >= d.options.length) return;
  var imgs = recogQOptImages(row);
  var tmp = d.options[oi]; d.options[oi] = d.options[ni]; d.options[ni] = tmp;
  if (imgs) { var ti = imgs[oi]; imgs[oi] = imgs[ni]; imgs[ni] = ti; }
  recogQSaveOptImages(row, imgs);
  recogRenderQArea(row);
}

function recogQAnswerTextInput(input) {
  input.closest('.recog-qrow')._rq.answer_text = input.value;
}

function recogQBlankInput(input) {
  input.closest('.recog-qrow')._rq.answer_texts[parseInt(input.dataset.bi, 10)] = input.value;
}

function recogQAddBlank(btn) {
  var row = btn.closest('.recog-qrow');
  var d = row._rq;
  if (d.answer_texts.length >= RQ_MAX_BLANKS) return;
  d.answer_texts.push('');
  recogRenderQArea(row);
  var inputs = row.querySelectorAll('.rq-opt-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function recogQDelBlank(btn) {
  var row = btn.closest('.recog-qrow');
  var input = btn.closest('.rq-opt').querySelector('.rq-opt-input');
  if (input) row._rq.answer_texts.splice(parseInt(input.dataset.bi, 10), 1);
  recogRenderQArea(row);
}

// 排序行拖拽（HTML5 DnD，↑↓ 按钮仍可用作触屏后备）
var RQ_DRAG = null;
function recogQBindOrderDrag(row) {
  var area = row.querySelector('.rq-area');
  if (!area || area.dataset.dragBound) return;
  area.dataset.dragBound = '1';
  area.addEventListener('dragstart', function (e) {
    var r = e.target.closest('.rq-order-row');
    if (!r) return;
    RQ_DRAG = r;
    r.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', 'order'); } catch (err) {}
    e.dataTransfer.effectAllowed = 'move';
  });
  area.addEventListener('dragend', function () {
    if (RQ_DRAG) { RQ_DRAG.classList.remove('dragging'); RQ_DRAG = null; }
    area.querySelectorAll('.rq-drop-top,.rq-drop-bottom').forEach(function (el) { el.classList.remove('rq-drop-top', 'rq-drop-bottom'); });
  });
  area.addEventListener('dragover', function (e) {
    if (!RQ_DRAG) return;
    var r = e.target.closest('.rq-order-row');
    if (!r || r === RQ_DRAG) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var rect = r.getBoundingClientRect();
    area.querySelectorAll('.rq-drop-top,.rq-drop-bottom').forEach(function (el) { el.classList.remove('rq-drop-top', 'rq-drop-bottom'); });
    r.classList.add(e.clientY < rect.top + rect.height / 2 ? 'rq-drop-top' : 'rq-drop-bottom');
  });
  area.addEventListener('drop', function (e) {
    if (!RQ_DRAG) return;
    e.preventDefault();
    var r = e.target.closest('.rq-order-row');
    if (r && r !== RQ_DRAG) {
      var rows = Array.prototype.slice.call(area.querySelectorAll('.rq-order-row'));
      var from = rows.indexOf(RQ_DRAG);
      var to = rows.indexOf(r);
      var rect = r.getBoundingClientRect();
      if (e.clientY >= rect.top + rect.height / 2) to++;
      if (to > from) to--;
      recogQMoveOrderOpt(row, from, to);
      return;
    }
    if (RQ_DRAG) { RQ_DRAG.classList.remove('dragging'); RQ_DRAG = null; }
    area.querySelectorAll('.rq-drop-top,.rq-drop-bottom').forEach(function (el) { el.classList.remove('rq-drop-top', 'rq-drop-bottom'); });
  });
}

function recogQMoveOrderOpt(row, from, to) {
  if (from === to || from < 0 || to < 0) return;
  var d = row._rq;
  var imgs = recogQOptImages(row);
  var moved = d.options.splice(from, 1)[0];
  d.options.splice(to, 0, moved);
  if (imgs) { var mi = imgs.splice(from, 1)[0]; imgs.splice(to, 0, mi); }
  recogQSaveOptImages(row, imgs);
  recogRenderQArea(row);
}

function recogDelQuestion(btn) {
  var row = btn.closest('.recog-qrow');
  if (window._recogQuestions) {
    var i = window._recogQuestions.indexOf(row);
    if (i >= 0) window._recogQuestions.splice(i, 1);
  }
  row.remove();
  recogUpdatePassHint();
}

function recogCollectQuestions() {
  var questions = [];
  var rows = document.querySelectorAll('#recogQuestions .recog-qrow');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var text = row.querySelector('.rq-text').value.trim();
    if (!text) continue;
    var qtype = row.querySelector('.rq-type').value;
    var points = parseInt(row.querySelector('.rq-points').value, 10);
    if (isNaN(points) || points < 1 || points > 100) { showToast('第 ' + (questions.length + 1) + ' 题分值需在 1–100 之间', 'error'); return null; }
    var explanation = row.querySelector('.rq-expl').value.trim();
    var d = recogQDraft(row, {});
    // 设计器富字段（题干图/选项图）：行内只改题干、选项、答案、分值、说明，图片原样保留
    var extra = null;
    try { extra = row.dataset.qExtra ? JSON.parse(row.dataset.qExtra) : null; } catch (e) { extra = null; }
    var q = null;
    if (qtype === 'fill_blank') {
      var answerText = String(d.answer_text || '').trim();
      if (!answerText) { showToast('第 ' + (questions.length + 1) + ' 题填空题缺少参考答案', 'error'); return null; }
      q = { type: 'fill_blank', question: text, answer_text: answerText, points: points, explanation: explanation };
    } else if (qtype === 'fill_multi') {
      var texts = (d.answer_texts || []).map(function (s) { return String(s || '').trim(); });
      if (!texts.length) { showToast('第 ' + (questions.length + 1) + ' 题多空填空至少需要一个空', 'error'); return null; }
      for (var bi = 0; bi < texts.length; bi++) {
        if (!texts[bi]) { showToast('第 ' + (questions.length + 1) + ' 题第 ' + (bi + 1) + ' 个空缺少参考答案', 'error'); return null; }
      }
      q = { type: 'fill_multi', question: text, answer_texts: texts, points: points, explanation: explanation };
    } else if (qtype === 'order') {
      // 空选项直接报错而非静默剔除：顺序即答案，剔除会让序号与选项图错位
      var orderOpts = (d.options || []).map(function (s) { return String(s || '').trim(); });
      for (var oo = 0; oo < orderOpts.length; oo++) {
        if (!orderOpts[oo]) { showToast('第 ' + (questions.length + 1) + ' 题有空选项，请填写或删除', 'error'); return null; }
      }
      if (orderOpts.length < 2) { showToast('第 ' + (questions.length + 1) + ' 题选项不足（至少 2 个）', 'error'); return null; }
      q = { type: 'order', question: text, options: orderOpts, points: points, explanation: explanation };
    } else {
      var options = (d.options || []).map(function (s) { return String(s || '').trim(); });
      for (var vo = 0; vo < options.length; vo++) {
        if (!options[vo]) { showToast('第 ' + (questions.length + 1) + ' 题有空选项，请填写或删除', 'error'); return null; }
      }
      if (options.length < 2) { showToast('第 ' + (questions.length + 1) + ' 题选项不足（至少 2 个）', 'error'); return null; }
      var answer = (d.answer || []).filter(function (n) { return n >= 0 && n < options.length; });
      if (!answer.length) { showToast('第 ' + (questions.length + 1) + ' 题未设置答案（点击选项前的字母）', 'error'); return null; }
      if (qtype === 'single' && answer.length !== 1) { showToast('第 ' + (questions.length + 1) + ' 题单选题只能有一个答案', 'error'); return null; }
      q = { type: qtype, question: text, options: options, answer: answer, points: points, explanation: explanation };
    }
    if (extra && extra.image) q.image = extra.image;
    if (extra && extra.option_images && extra.option_images.length === (q.options || []).length) q.option_images = extra.option_images;
    questions.push(q);
  }
  return questions;
}

// ---- 题目设计器（独立页面）数据交换：localStorage 回传 + 回到本页自动导入 ----
var RECOG_QD_IN = 'recog_qd_input';
var RECOG_QD_OUT = 'recog_qd_output';

function recogCollectEditorSettings() {
  if (!document.getElementById('recogSkShuffle')) return {};
  return {
    shuffle: document.getElementById('recogSkShuffle').value === '1',
    shuffle_options: document.getElementById('recogSkShuffleOpt').value === '1',
    pick_count: parseInt(document.getElementById('recogSkPick').value, 10) || 0,
    time_limit: parseInt(document.getElementById('recogSkTimeLimit').value, 10) || 0,
    multiple_partial: document.getElementById('recogSkPartial').value === '1',
    result_mode: document.getElementById('recogSkResultMode').value
  };
}

function recogApplyDesignerSettings(s) {
  if (!document.getElementById('recogSkShuffle')) return;
  document.getElementById('recogSkShuffle').value = s.shuffle ? '1' : '0';
  document.getElementById('recogSkShuffleOpt').value = s.shuffle_options ? '1' : '0';
  document.getElementById('recogSkPick').value = String(parseInt(s.pick_count, 10) || 0);
  document.getElementById('recogSkTimeLimit').value = String(parseInt(s.time_limit, 10) || 0);
  document.getElementById('recogSkPartial').value = s.multiple_partial ? '1' : '0';
  document.getElementById('recogSkResultMode').value = ['immediate', 'pass_only', 'hidden'].indexOf(s.result_mode) >= 0 ? s.result_mode : 'immediate';
}

function recogOpenDesigner() {
  var questions = recogCollectQuestions(); // 校验失败会弹提示并返回 null，此时带空卷打开
  var payload = { ts: Date.now(), quiz: { questions: questions === null ? [] : questions, settings: recogCollectEditorSettings() } };
  try { localStorage.setItem(RECOG_QD_IN, JSON.stringify(payload)); } catch (e) {}
  // 携带同好会上下文，供设计器上传题目图片时鉴权使用
  window.open('quiz_designer.html?club=' + RECOG.clubId + '&country=' + encodeURIComponent(RECOG.country || 'china'), '_blank');
  showToast('设计器已打开，完成后点右上角「完成」，回到本页自动导入', 'success', 'check');
}

function recogImportFromDesigner() {
  try {
    var out = JSON.parse(localStorage.getItem(RECOG_QD_OUT) || 'null');
    var inn = JSON.parse(localStorage.getItem(RECOG_QD_IN) || 'null');
    if (!out || !out.quiz || !Array.isArray(out.quiz.questions) || !out.quiz.questions.length) return false;
    if (inn && out.ts <= inn.ts) return false; // 无新结果或已导入过
    var holder = document.getElementById('recogQuestions');
    if (!holder) return false;
    // 消费标记：把输入时间戳推到输出之后，避免重复导入
    localStorage.setItem(RECOG_QD_IN, JSON.stringify({ ts: out.ts, consumed: true }));
    holder.innerHTML = '';
    window._recogQuestions = [];
    out.quiz.questions.forEach(function (q) { recogAddQuestionRow(q); });
    recogApplyDesignerSettings(out.quiz.settings || {});
    recogUpdatePassHint();
    return true;
  } catch (e) { return false; }
}

// 从设计器标签页切回时自动导入（仅当考核编辑器开着）
window.addEventListener('focus', function () {
  if (!document.getElementById('recogQuestions')) return;
  if (recogImportFromDesigner()) showToast('已从题目设计器导入题目与考试设置', 'success', 'check');
});

// ---- 保存 ----
function recogCollectPayload() {
  var type = document.getElementById('recogType').value;
  var title = document.getElementById('recogTitle').value.trim();
  if (!title) { showToast('请填写考核标题', 'error'); return null; }
  var badgeId = parseInt(document.getElementById('recogBadge').value, 10);
  if (!badgeId) { showToast('请选择奖励徽章（可在下方「成就徽章」区先创建）', 'error'); return null; }

  var verification = type === 'submission' ? 'single_review'
    : type === 'award' ? 'owner_grant'
    : type === 'competition' ? 'single_review'
    : type === 'external' ? 'external_system'
    : 'auto';
  var rules = { logic: 'all', conditions: [], award: { badge_id: badgeId, verification_level: verification } };
  var content = { rules: rules };

  if (type === 'assessment') {
    var questions = recogCollectQuestions();
    if (questions === null) return null;
    if (!questions.length) { showToast('知识问答至少需要一道题', 'error'); return null; }
    var pickCount = parseInt(document.getElementById('recogSkPick').value, 10) || 0;
    if (pickCount > questions.length) { showToast('抽题数量不能超过总题数（' + questions.length + '）', 'error'); return null; }
    content.quiz = {
      questions: questions,
      settings: {
        shuffle: document.getElementById('recogSkShuffle').value === '1',
        shuffle_options: document.getElementById('recogSkShuffleOpt').value === '1',
        pick_count: pickCount,
        time_limit: parseInt(document.getElementById('recogSkTimeLimit').value, 10) || 0,
        multiple_partial: document.getElementById('recogSkPartial').value === '1',
        result_mode: document.getElementById('recogSkResultMode').value
      }
    };
    rules.conditions.push({ op: 'score_gte', value: parseInt(document.getElementById('recogPass').value, 10) || 60 });
  } else if (type === 'submission') {
    rules.conditions.push({ op: 'submission_approved' });
  } else if (type === 'activity' || type === 'mission') {
    content.claim = { enabled: document.getElementById('recogClaim').value === '1' };
  }

  var payload = {
    club_id: RECOG.clubId,
    country: RECOG.country,
    type: type,
    title: title,
    intro: document.getElementById('recogIntro').value.trim(),
    // 无难度的类型（活动/作品/竞赛/授予/外部联动）统一回写 normal，避免旧值残留在参与端接口
    participant_difficulty: (type === 'assessment' || type === 'mission')
      ? document.getElementById('recogDiff').value : 'normal',
    // 尝试次数与冷却只作用于答题判分，其余类型清零
    max_attempts: type === 'assessment' ? (parseInt(document.getElementById('recogAttempts').value, 10) || 0) : 0,
    cooldown_minutes: type === 'assessment' ? (parseInt(document.getElementById('recogCooldown').value, 10) || 0) : 0,
    open_at: recogLocalToDt(document.getElementById('recogOpenAt').value),
    close_at: recogLocalToDt(document.getElementById('recogCloseAt').value),
    content: content
  };

  // 进阶档字段：只有展开进阶分区时才写入（避免误触自动升档）
  if (RECOG.editorTier !== 'standard') {
    payload.credential_ttl_days = parseInt(document.getElementById('recogTtl').value, 10) || 0;
    payload.max_issuance = parseInt(document.getElementById('recogMaxIssue').value, 10) || 0;
  }
  return payload;
}

async function recogSaveProgram(publishAfter) {
  var payload = recogCollectPayload();
  if (!payload) return;

  try {
    var res;
    if (RECOG.editorProgramId) {
      payload.program_id = RECOG.editorProgramId;
      res = await recogApi('recognition_programs.php?action=update', payload);
    } else {
      res = await recogApi('recognition_programs.php?action=create', payload);
    }
    if (!res || !res.success) { showToast((res && res.message) || '保存失败', 'error'); return; }

    var programId = RECOG.editorProgramId || res.program_id;
    if (!publishAfter) {
      showToast('草稿已保存' + (res.tier ? '（档位：' + recogTierLabel(res.tier) + '）' : ''), 'success', 'check');
      await renderRecognition();
      return;
    }
    var pub = await recogApi('recognition_programs.php?action=publish', { program_id: programId });
    showToast(pub.success ? '已发布 ' + (pub.version_no || '') : (pub.message || '发布失败'), pub.success ? 'success' : 'error');
    await renderRecognition();
  } catch (e) {
    showToast('网络错误', 'error');
  }
}

function recogCloseEditor() {
  RECOG.editorOpen = false;
  var card = document.getElementById('recogEditorCard');
  if (card) card.innerHTML = '';
}

// ==================== 项目操作 ====================
async function recogPublishProgram(programId) {
  try {
    var r = await recogApi('recognition_programs.php?action=publish', { program_id: programId });
    showToast(r.success ? '已发布 ' + (r.version_no || '') : (r.message || '发布失败'), r.success ? 'success' : 'error');
    if (r.success) await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
}

async function recogProgramStatus(programId, status) {
  if (status === 'archived' && !confirm('确定归档该考核？归档后参与者不可见，已签发凭证不受影响。')) return;
  try {
    var r = await recogApi('recognition_programs.php?action=set_status', { program_id: programId, status: status });
    showToast(r.success ? '状态已更新' : (r.message || '操作失败'), r.success ? 'success' : 'error');
    if (r.success) await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
}

async function recogQuizSync(programId, btn) {
  if (btn) btn.disabled = true;
  try {
    var r = await recogApi('recognition_events.php?action=quiz_sync', { program_id: programId, limit: 500 });
    showToast(r.success ? r.message : (r.message || '同步失败'), r.success ? 'success' : 'error');
    if (r.success) await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

function recogCopyCheckin(programId) {
  var url = location.origin + location.pathname.replace(/admin\/.*$/, '') + RECOG_EXAM_PAGE.replace('../', '') + '#/program/' + programId;
  function done() { showToast('参与入口已复制，可制作成二维码', 'success', 'clipboard'); }
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(function () { prompt('参与入口（可制作成二维码）：', url); });
  else prompt('参与入口（可制作成二维码）：', url);
}

// ==================== 参与入口二维码 ====================
function recogQrUrl(programId) {
  return location.origin + location.pathname.replace(/admin\/.*$/, '') + RECOG_EXAM_PAGE.replace('../', '') + '#/program/' + programId;
}

function recogShowProgramQr(programId) {
  var p = RECOG.programs.find(function (x) { return x.id === programId; });
  recogShowQrModal(p ? p.title : '考核参与入口', recogQrUrl(programId));
}

// 画到 canvas（依赖 js/vendor/qrcode.min.js 提供的全局 qrcode）
function recogDrawQr(canvas, text, sizePx) {
  if (typeof qrcode !== 'function') return false;
  try {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var margin = 2;
    var cell = Math.max(2, Math.floor(sizePx / (n + margin * 2)));
    var real = (n + margin * 2) * cell;
    canvas.width = real;
    canvas.height = real;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, real, real);
    ctx.fillStyle = '#111111';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
    return true;
  } catch (e) { return false; }
}

function recogShowQrModal(title, url) {
  var old = document.getElementById('recogQrMask');
  if (old) old.remove();
  var mask = document.createElement('div');
  mask.className = 'recog-crop-mask';
  mask.id = 'recogQrMask';
  mask.innerHTML = '<div class="recog-crop-box" style="text-align:center;max-width:360px">' +
    '<div class="recog-crop-title" style="justify-content:center">' + escapeHtml(title || '扫码参与') + '</div>' +
    '<div id="recogQrCanvasWrap" style="display:flex;justify-content:center;padding:12px;background:#fff;border-radius:8px;border:1px solid var(--border)"></div>' +
    '<div style="margin-top:10px;font-size:12px;color:var(--text-secondary);word-break:break-all">' + escapeHtml(url) + '</div>' +
    '<div class="recog-crop-actions" style="justify-content:center">' +
      '<button class="btn btn-ghost" data-url="' + escapeHtml(url) + '" onclick="recogCopyText(this.dataset.url)">复制链接</button>' +
      '<button class="btn" onclick="recogCloseQrModal()">关闭</button>' +
    '</div></div>';
  document.body.appendChild(mask);
  mask.addEventListener('click', function (e) { if (e.target === mask) recogCloseQrModal(); });
  var canvas = document.createElement('canvas');
  canvas.style.width = '240px';
  canvas.style.height = '240px';
  canvas.style.imageRendering = 'pixelated';
  document.getElementById('recogQrCanvasWrap').appendChild(canvas);
  if (!recogDrawQr(canvas, url, 240)) {
    document.getElementById('recogQrCanvasWrap').innerHTML = '<div style="padding:40px;color:var(--danger,#e11d48)">二维码生成失败，请刷新页面重试</div>';
  }
}

function recogCloseQrModal() {
  var mask = document.getElementById('recogQrMask');
  if (mask) mask.remove();
}

// ==================== 徽章面板 ====================
function recogBadgesHtml() {
  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('star') + ' 成就徽章 (' + RECOG.badges.length + ')</div>' +
    '<div class="section-sub">徽章是考核签发给参与者的成就证明，图片将展示在用户的成就区与凭证验证页</div>' +

    '<div class="recog-grid2" style="margin-top:10px">' +
      '<div class="form-group"><label>徽章名称 *</label><input id="recogBadgeName" class="form-input" maxlength="60" placeholder="例如：周年活动纪念"></div>' +
      '<div class="form-group"><label>类别</label><select id="recogBadgeCategory" class="form-input">' +
        Object.keys(RECOG_BADGE_CATEGORY).map(function (c) { return '<option value="' + c + '">' + RECOG_BADGE_CATEGORY[c] + '</option>'; }).join('') +
      '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>描述</label><textarea id="recogBadgeDesc" class="form-input" rows="2" placeholder="这枚徽章代表什么"></textarea></div>' +
    '<div class="form-group"><label>徽章图片（JPEG/PNG/GIF/WebP，选择后自定义裁剪，无大小限制）</label>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<input type="file" id="recogBadgeImage" accept="image/jpeg,image/png,image/gif,image/webp" onchange="recogUploadBadgeImage(this)">' +
        '<span id="recogBadgePreview"></span>' +
      '</div>' +
    '</div>' +
    '<input type="hidden" id="recogBadgeEditId" value="0">' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" onclick="recogSaveBadge()">' + icon('check') + ' <span id="recogBadgeSaveLabel">创建徽章</span></button>' +
      '<button class="btn btn-ghost recog-hidden" id="recogBadgeCancelEdit" onclick="recogResetBadgeForm()">取消编辑</button>' +
    '</div>';

  if (RECOG.badges.length) {
    html += '<div class="recog-badge-grid">' + RECOG.badges.map(function (b) {
      var img = b.image_url
        ? '<img src="../' + escapeHtml(b.image_url) + '" alt="' + escapeHtml(b.name) + '">'
        : icon('star');
      return '<div class="recog-badge-card">' +
        '<div class="recog-badge-img">' + img + '</div>' +
        '<div class="recog-badge-name">' + escapeHtml(b.name) + '</div>' +
        '<div class="recog-badge-meta">' + (RECOG_BADGE_CATEGORY[b.category] || b.category) + ' · v' + (b.version || 1) + '</div>' +
        '<button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="recogEditBadge(' + b.id + ')">编辑</button>' +
      '</div>';
    }).join('') + '</div>';
  }
  html += '</div>';
  return html;
}

function recogEditBadge(badgeId) {
  var b = RECOG.badges.find(function (x) { return x.id === badgeId; });
  if (!b) return;
  document.getElementById('recogBadgeName').value = b.name || '';
  document.getElementById('recogBadgeCategory').value = b.category || 'participation';
  document.getElementById('recogBadgeDesc').value = b.description || '';
  document.getElementById('recogBadgeEditId').value = String(badgeId);
  RECOG.badgeImageUrl = b.image_url || '';
  document.getElementById('recogBadgePreview').innerHTML = b.image_url
    ? '<img class="recog-img-preview" src="../' + escapeHtml(b.image_url) + '">'
    : '';
  document.getElementById('recogBadgeSaveLabel').textContent = '保存修改';
  document.getElementById('recogBadgeCancelEdit').classList.remove('recog-hidden');
  document.getElementById('recogBadgeName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function recogResetBadgeForm() {
  document.getElementById('recogBadgeName').value = '';
  document.getElementById('recogBadgeCategory').value = 'participation';
  document.getElementById('recogBadgeDesc').value = '';
  document.getElementById('recogBadgeEditId').value = '0';
  document.getElementById('recogBadgeImage').value = '';
  document.getElementById('recogBadgePreview').innerHTML = '';
  document.getElementById('recogBadgeSaveLabel').textContent = '创建徽章';
  document.getElementById('recogBadgeCancelEdit').classList.add('recog-hidden');
  RECOG.badgeImageUrl = '';
}

async function recogUploadBadgeImage(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  var preview = document.getElementById('recogBadgePreview');
  preview.innerHTML = '<span class="form-hint">读取图片…</span>';
  try {
    var dataUrl = await new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    var img = new Image();
    await new Promise(function (resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    recogOpenCropModal(img, file.type);
    preview.innerHTML = '';
  } catch (e) {
    preview.innerHTML = '';
    showToast('图片读取失败，请更换文件', 'error');
  }
}

// ---------- 徽章裁剪弹窗：1:1 圆形预览，拖动平移，滚轮/滑杆缩放 ----------
function recogOpenCropModal(img, mime) {
  var old = document.getElementById('recogCropModal');
  if (old) old.remove();
  var VP = 300;  // 裁剪视口尺寸（展示用）
  var OUT = 512; // 输出尺寸（徽章展示为 64px 圆图，512 足够清晰）
  var minScale = Math.max(VP / img.naturalWidth, VP / img.naturalHeight); // 铺满视口的最小缩放
  var maxScale = minScale * 6;
  var scale = minScale;
  var ox = (VP - img.naturalWidth * scale) / 2;
  var oy = (VP - img.naturalHeight * scale) / 2;

  function clamp() {
    var w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ox = Math.min(0, Math.max(VP - w, ox));
    oy = Math.min(0, Math.max(VP - h, oy));
  }

  var wrap = document.createElement('div');
  wrap.id = 'recogCropModal';
  wrap.className = 'recog-crop-mask';
  wrap.innerHTML =
    '<div class="recog-crop-box">' +
      '<div class="recog-crop-title">裁剪徽章图片（1:1，徽章按圆形展示）</div>' +
      '<div class="recog-crop-viewport" id="recogCropVp">' +
        '<img id="recogCropImg" alt="" draggable="false">' +
        '<div class="recog-crop-circle"></div>' +
      '</div>' +
      '<div class="recog-crop-zoom"><span>缩放</span><input type="range" id="recogCropRange" min="100" max="600" value="100"></div>' +
      '<div class="recog-crop-actions">' +
        '<button type="button" class="btn btn-primary" id="recogCropOk">确认裁剪</button>' +
        '<button type="button" class="btn btn-ghost" id="recogCropCancel">取消</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  var vp = wrap.querySelector('#recogCropVp');
  var im = wrap.querySelector('#recogCropImg');
  var range = wrap.querySelector('#recogCropRange');
  im.src = img.src;

  function apply() {
    clamp();
    im.style.width = (img.naturalWidth * scale) + 'px';
    im.style.left = ox + 'px';
    im.style.top = oy + 'px';
    range.value = String(Math.round((scale - minScale) / (maxScale - minScale) * 500 + 100));
  }
  function setScale(s, cx, cy) {
    s = Math.min(maxScale, Math.max(minScale, s));
    // 以 (cx, cy) 为锚点缩放：该点对应的图像位置保持不变
    var px = (cx - ox) / scale, py = (cy - oy) / scale;
    scale = s;
    ox = cx - px * scale;
    oy = cy - py * scale;
    apply();
  }

  range.addEventListener('input', function () {
    var t = (parseInt(range.value, 10) - 100) / 500;
    setScale(minScale + t * (maxScale - minScale), VP / 2, VP / 2);
  });
  vp.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = vp.getBoundingClientRect();
    setScale(scale * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  var drag = null;
  vp.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, y: e.clientY, ox: ox, oy: oy };
    try { vp.setPointerCapture(e.pointerId); } catch (err) {}
  });
  vp.addEventListener('pointermove', function (e) {
    if (!drag) return;
    ox = drag.ox + (e.clientX - drag.x);
    oy = drag.oy + (e.clientY - drag.y);
    apply();
  });
  vp.addEventListener('pointerup', function () { drag = null; });
  vp.addEventListener('pointercancel', function () { drag = null; });

  wrap.querySelector('#recogCropCancel').addEventListener('click', function () { wrap.remove(); });
  wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector('#recogCropOk').addEventListener('click', function () {
    // 视口 → 原图坐标的映射；透明格式输出 PNG，其余白底 JPEG（体积更小）
    var sx = -ox / scale, sy = -oy / scale, ss = VP / scale;
    var canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    var ctx = canvas.getContext('2d');
    if (/png|gif|webp/.test(mime || '')) {
      ctx.drawImage(img, sx, sy, ss, ss, 0, 0, OUT, OUT);
      canvas.toBlob(function (blob) { wrap.remove(); if (blob) recogSendBadgeBlob(blob, 'png'); }, 'image/png');
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.drawImage(img, sx, sy, ss, ss, 0, 0, OUT, OUT);
      canvas.toBlob(function (blob) { wrap.remove(); if (blob) recogSendBadgeBlob(blob, 'jpg'); }, 'image/jpeg', 0.92);
    }
  });
  apply();
}

async function recogSendBadgeBlob(blob, ext) {
  var preview = document.getElementById('recogBadgePreview');
  preview.innerHTML = '<span class="form-hint">上传中…</span>';
  var fd = new FormData();
  fd.append('image', new File([blob], 'badge_crop.' + ext, { type: blob.type }));
  fd.append('club_id', String(RECOG.clubId));
  fd.append('country', RECOG.country);
  try {
    var r = await fetch('../api/badge_image.php?action=upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    var data = await r.json();
    if (!data.success) { preview.innerHTML = ''; showToast(data.message || '上传失败', 'error'); return; }
    RECOG.badgeImageUrl = data.image_url;
    preview.innerHTML = '<img class="recog-img-preview" src="../' + escapeHtml(data.image_url) + '">';
    showToast('图片已裁剪并上传，保存徽章后生效', 'success', 'check');
  } catch (e) {
    preview.innerHTML = '';
    showToast('上传失败，请重试', 'error');
  }
}

async function recogSaveBadge() {
  var name = document.getElementById('recogBadgeName').value.trim();
  if (!name) { showToast('请填写徽章名称', 'error'); return; }
  var editId = parseInt(document.getElementById('recogBadgeEditId').value, 10) || 0;
  var body = {
    club_id: RECOG.clubId,
    country: RECOG.country,
    name: name,
    category: document.getElementById('recogBadgeCategory').value,
    description: document.getElementById('recogBadgeDesc').value.trim()
  };
  try {
    var r;
    if (editId) {
      body.badge_id = editId;
      if (RECOG.badgeImageUrl) body.image_url = RECOG.badgeImageUrl;
      r = await recogApi('recognition_programs.php?action=badge_update', body);
    } else {
      body.image_url = RECOG.badgeImageUrl || '';
      r = await recogApi('recognition_programs.php?action=badge_create', body);
    }
    showToast(r.success ? (editId ? '徽章已更新' : '徽章已创建') : (r.message || '保存失败'), r.success ? 'success' : 'error');
    if (r.success) {
      RECOG.badgeImageUrl = '';
      // 局部刷新：不重建整页，避免把编辑器里出题到一半的内容刷丢；
      await recogRefreshData();
    }
  } catch { showToast('网络错误', 'error'); }
}

// ==================== 签发与审核 ====================
function recogOpsHtml() {
  var grantable = RECOG.programs.filter(function (p) { return p.type === 'award' || p.type === 'activity'; });
  var importable = RECOG.programs.filter(function (p) { return p.type === 'activity' || p.type === 'award'; });
  var programOptions = function (list, idAttr) {
    return '<select id="' + idAttr + '" class="form-input">' +
      (list.length ? list.map(function (p) { return '<option value="' + p.id + '">' + escapeHtml(p.title) + '</option>'; }).join('')
        : '<option value="">（暂无可用项目）</option>') +
    '</select>';
  };

  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('users') + ' 签发与审核</div>' +
    '<div class="recog-grid2">' +

    // 人工授予
    '<div class="recog-fieldset"><div class="recog-fs-title">' + icon('crown') + ' 人工授予</div>' +
      '<div class="form-group"><label>授予项目（award / activity）</label>' + programOptions(grantable, 'recogGrantProgram') + '</div>' +
      '<div class="form-group"><label>用户名（逗号分隔，单次最多 200 个）</label><textarea id="recogGrantNames" class="form-input" rows="2" placeholder="user_a, user_b"></textarea></div>' +
      '<button class="btn btn-primary" onclick="recogGrant()">' + icon('check') + ' 授予</button>' +
    '</div>' +

    // CSV 名单导入
    '<div class="recog-fieldset"><div class="recog-fs-title">' + icon('clipboard') + ' 名单批量导入（CSV）</div>' +
      '<div class="form-group"><label>导入项目（activity / award）</label>' + programOptions(importable, 'recogImportProgram') + '</div>' +
      '<div class="form-group"><label>用户名（每行一个或逗号分隔，单次最多 2000 人）</label><textarea id="recogImportCsv" class="form-input" rows="2" placeholder="user_a&#10;user_b"></textarea></div>' +
      '<button class="btn btn-primary" onclick="recogImportCsv()">' + icon('download') + ' 导入并签发</button>' +
    '</div>' +

    '</div>';

  // 待审核提交
  html += '<div class="recog-fieldset" style="margin-top:12px"><div class="recog-fs-title">' + icon('clock') + ' 待审核提交 (' + RECOG.submissions.length + ')</div>';
  if (!RECOG.submissions.length) {
    html += '<div style="color:var(--text-secondary);font-size:13px">暂无待审核的作品/材料提交</div>';
  } else {
    html += '<div class="recog-table-wrap"><table class="recog-table">' +
      '<tr><th>项目</th><th>参与者</th><th>提交内容</th><th>时间</th><th style="text-align:right">审核</th></tr>' +
      RECOG.submissions.map(function (s) {
        // content 兼容两种格式：新 JSON {text, images} 与旧纯文本
        var text = '', imgs = [];
        try {
          var parsed = JSON.parse(s.content || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            text = String(parsed.text || '');
            imgs = Array.isArray(parsed.images) ? parsed.images.map(String) : [];
          } else {
            text = String(s.content || '');
          }
        } catch (e) { text = String(s.content || ''); }
        if (!imgs.length && s.file_path) imgs = String(s.file_path).split('|').filter(Boolean);
        var holder = s.holder_nickname || s.holder_username || ('user#' + s.holder_user_id);
        return '<tr>' +
          '<td>' + escapeHtml(s.program_title || '') + '</td>' +
          '<td>' + escapeHtml(holder) + '</td>' +
          '<td><span class="recog-sub-text" title="' + escapeHtml(text) + '">' + (text ? escapeHtml(text) : '<span style="color:var(--text-muted)">（仅图片）</span>') + '</span>' +
            (imgs.length ? '<div class="recog-sub-imgs">' + imgs.map(function (u) {
              return '<a href="../' + escapeHtml(u) + '" target="_blank" rel="noopener" title="点击查看大图"><img src="../' + escapeHtml(u) + '" alt="作品图片" loading="lazy"></a>';
            }).join('') + '</div>' : '') + '</td>' +
          '<td style="font-size:12px;color:var(--text-secondary)">' + formatDate(s.created_at) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
            '<button class="btn btn-sm btn-primary" onclick="recogReviewDecision(' + s.id + ',\'approved\')">通过</button> ' +
            '<button class="btn btn-sm btn-danger" onclick="recogReviewDecision(' + s.id + ',\'rejected\')">驳回</button>' +
          '</td></tr>';
      }).join('') + '</table></div>';
  }
  html += '</div></div>';
  return html;
}

async function recogGrant() {
  var pid = parseInt(document.getElementById('recogGrantProgram').value, 10);
  if (!pid) { showToast('请选择授予项目', 'error'); return; }
  var names = document.getElementById('recogGrantNames').value.split(/[,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!names.length) { showToast('请填写至少一个用户名', 'error'); return; }
  try {
    var r = await recogApi('recognition_credentials.php?action=grant', { usernames: names, program_id: pid });
    if (!r.success) { showToast(r.message || '授予失败', 'error'); return; }
    showToast('已授予 ' + r.granted + ' 人' + (r.skipped && r.skipped.length ? '；跳过：' + r.skipped.join('、') : ''), 'success', 'check');
    document.getElementById('recogGrantNames').value = '';
    await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
}

async function recogImportCsv() {
  var pid = parseInt(document.getElementById('recogImportProgram').value, 10);
  if (!pid) { showToast('请选择导入项目', 'error'); return; }
  var csv = document.getElementById('recogImportCsv').value;
  if (!csv.trim()) { showToast('请填写参与名单', 'error'); return; }
  try {
    var r = await recogApi('recognition_admin.php?action=import_participants', { program_id: pid, csv: csv });
    if (!r.success) { showToast(r.message || '导入失败', 'error'); return; }
    showToast('已导入签发 ' + r.imported + ' 人' + (r.skipped_total ? '；跳过 ' + r.skipped_total + ' 人' : ''), 'success', 'check');
    document.getElementById('recogImportCsv').value = '';
    await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
}

async function recogReviewDecision(submissionId, decision) {
  var comment = decision === 'rejected' ? prompt('驳回原因（可选）：', '') || '' : '';
  try {
    var r = await recogApi('recognition_admin.php?action=review', { submission_id: submissionId, decision: decision, comment: comment });
    if (!r.success) { showToast(r.message || '审核失败', 'error'); return; }
    showToast(r.message || (decision === 'approved' ? '已通过' : '已驳回'), 'success', 'check');
    await recogRefreshData();
  } catch { showToast('网络错误', 'error'); }
}

// ==================== 兑换码 ====================
async function recogShowClaim(programId) {
  RECOG.claimProgramId = programId;
  var card = document.getElementById('recogClaimCard');
  var p = RECOG.programs.find(function (x) { return x.id === programId; });
  card.innerHTML = '<div class="section-card"><div class="empty"><span class="loading-spinner"></span>载入兑换码...</div></div>';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    var r = await recogApi('recognition_admin.php?action=claim_list&program_id=' + programId);
    var codes = (r && r.codes) || [];
    var redeemed = r ? r.redeemed : 0;
    var html = '<div class="section-card">' +
      '<div class="section-title">' + icon('key') + ' 兑换码 · ' + escapeHtml(p ? p.title : ('项目 #' + programId)) + '</div>' +
      '<div class="section-sub">线下活动先参与、后领取：现场展示签到二维码，参与者凭码在考核页兑换。已生成 ' + codes.length + ' 个，已核销 ' + redeemed + ' 个</div>' +
      '<div class="recog-grid3" style="align-items:end">' +
        '<div class="form-group"><label>生成数量（≤500）</label><input id="recogClaimCount" class="form-input" type="number" min="1" max="500" value="20"></div>' +
        '<div class="form-group"><label>有效期（小时，0=永久）</label><input id="recogClaimTtl" class="form-input" type="number" min="0" value="72"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-primary" onclick="recogGenCodes()">' + icon('key') + ' 生成兑换码</button>' +
          '<button class="btn" onclick="recogShowProgramQr(RECOG.claimProgramId)">签到二维码</button>' +
          '<button class="btn btn-ghost" onclick="recogCloseClaim()">关闭</button>' +
        '</div>' +
      '</div>' +
      '<div id="recogClaimResult"></div>';

    if (codes.length) {
      html += '<div class="recog-table-wrap" style="margin-top:10px"><table class="recog-table">' +
        '<tr><th>兑换码</th><th>状态</th><th>兑换人</th><th>过期时间</th></tr>' +
        codes.slice(0, 200).map(function (c) {
          var used = c.redeemed_by !== null && c.redeemed_by !== undefined;
          return '<tr>' +
            '<td style="font-family:monospace">' + escapeHtml(c.code) + '</td>' +
            '<td>' + (used ? '<span class="recog-pill green">已核销</span>' : '<span class="recog-pill">未使用</span>') + '</td>' +
            '<td>' + (used ? ('user#' + c.redeemed_by) : '—') + '</td>' +
            '<td style="font-size:12px;color:var(--text-secondary)">' + (c.expires_at ? formatDate(c.expires_at) : '永久') + '</td>' +
          '</tr>';
        }).join('') + '</table></div>';
      if (codes.length > 200) html += '<div class="section-sub">仅展示最近 200 条</div>';
    }
    html += '</div>';
    card.innerHTML = html;
  } catch (e) {
    card.innerHTML = '<div class="section-card">' + emptyHtml('alert', '载入失败') + '</div>';
  }
}

function recogCloseClaim() {
  RECOG.claimProgramId = 0;
  var card = document.getElementById('recogClaimCard');
  if (card) card.innerHTML = '';
}

async function recogGenCodes() {
  var pid = RECOG.claimProgramId;
  if (!pid) return;
  var count = parseInt(document.getElementById('recogClaimCount').value, 10) || 0;
  var ttl = parseInt(document.getElementById('recogClaimTtl').value, 10) || 0;
  if (count < 1 || count > 500) { showToast('数量需在 1-500 之间', 'error'); return; }
  try {
    var r = await recogApi('recognition_admin.php?action=claim_generate', { program_id: pid, count: count, ttl_hours: ttl });
    var box = document.getElementById('recogClaimResult');
    if (!r.success) { showToast(r.message || '生成失败', 'error'); return; }
    var shareUrl = location.origin + location.pathname.replace(/admin\/.*$/, '') + RECOG_EXAM_PAGE.replace('../', '') + '#/program/' + pid;
    box.innerHTML = '<div class="recog-token-box">' +
      '<strong>已生成 ' + r.codes.length + ' 个兑换码：</strong><br>' + escapeHtml(r.codes.join(', ')) +
      '<br><br><strong>签到入口（可制作成二维码）：</strong><br>' + escapeHtml(shareUrl) +
      '<br><button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="recogCopyText(this.dataset.t)" data-t="' + escapeHtml(r.codes.join(',')) + '">复制兑换码</button> ' +
      '<button class="btn btn-sm btn-ghost" onclick="recogCopyText(this.dataset.t)" data-t="' + escapeHtml(shareUrl) + '">复制签到入口</button> ' +
      '<button class="btn btn-sm btn-ghost" onclick="recogShowQrModal(\'签到二维码\', this.dataset.u)" data-u="' + escapeHtml(shareUrl) + '">显示二维码</button>' +
    '</div>';
    showToast('兑换码已生成', 'success', 'key');
    setTimeout(function () { recogShowClaim(pid); }, 1200);
  } catch { showToast('网络错误', 'error'); }
}

function recogCopyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { showToast('已复制', 'success', 'clipboard'); });
  else prompt('复制以下内容：', text);
}

// ==================== 已签发凭证 ====================
function recogCredentialsHtml() {
  var html = '<div class="section-card">' +
    '<div class="section-title">' + icon('shield') + ' 已签发凭证 (' + RECOG.credentials.length + ')</div>';
  if (!RECOG.credentials.length) {
    html += '<div style="text-align:center;padding:24px;color:var(--text-secondary);font-size:14px;">尚未签发凭证</div></div>';
    return html;
  }
  html += '<div class="recog-table-wrap"><table class="recog-table">' +
    '<tr><th>持有人</th><th>徽章</th><th>来源项目</th><th>验证强度</th><th>状态</th><th>可见性</th><th>签发时间</th></tr>' +
    RECOG.credentials.map(function (c) {
      var statusPill = c.status === 'active' ? '<span class="recog-pill green">有效</span>'
        : c.status === 'revoked' ? '<span class="recog-pill red">已撤销</span>'
        : c.status === 'expired' ? '<span class="recog-pill">已过期</span>'
        : c.status === 'superseded' ? '<span class="recog-pill blue">已替代</span>'
        : '<span class="recog-pill">' + escapeHtml(c.status || '') + '</span>';
      return '<tr>' +
        '<td>' + escapeHtml(c.holder_name || ('user#' + c.holder_user_id)) + '</td>' +
        '<td>' + escapeHtml(c.badge_name || '') + '</td>' +
        '<td><a href="javascript:void(0)" onclick="recogEditProgram(' + (c.program_id || 0) + ')">' + escapeHtml(c.program_title || '') + '</a></td>' +
        '<td style="font-size:12px">' + escapeHtml(RECOG_VERIFY_LABEL[c.verification_level] || c.verification_level || '') + '</td>' +
        '<td>' + statusPill + '</td>' +
        '<td style="font-size:12px">' + (String(c.public_visibility) === '1' || c.public_visibility === 'public' ? '公开' : '私密') + '</td>' +
        '<td style="font-size:12px;color:var(--text-secondary)">' + formatDate(c.issued_at) + '</td>' +
      '</tr>';
    }).join('') + '</table></div></div>';
  return html;
}

// ==================== Connector（专家档） ====================
async function recogLoadConnectors(scrollIntoView) {
  var area = document.getElementById('recogConnectorArea');
  if (!area) return;
  if (!RECOG.connectorsLoaded) {
    area.innerHTML = '<span class="form-hint">载入中…</span>';
    try {
      var r = await recogApi('recognition_events.php?action=connector_list&club_id=' + RECOG.clubId + '&country=' + RECOG.country);
      RECOG.connectors = (r && r.connectors) || [];
      RECOG.connectorsLoaded = true;
    } catch (e) {
      area.innerHTML = '<span class="form-hint">载入失败，请重试</span>';
      return;
    }
  }
  recogRenderConnectors();
  if (scrollIntoView) area.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function recogRenderConnectors() {
  var area = document.getElementById('recogConnectorArea');
  if (!area) return;
  var typeOptions = RECOG_CONNECTOR_TYPES.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('');

  var html = '<div class="recog-grid3">' +
    '<div class="form-group"><label>Connector 名称</label><input id="recogConnName" class="form-input" placeholder="例如：服务器 Discord 活动"></div>' +
    '<div class="form-group"><label>接入类型</label><select id="recogConnType" class="form-input">' + typeOptions + '</select></div>' +
    '<div class="form-group"><label>允许的事件类型（逗号分隔，留空=不限）</label><input id="recogConnEvents" class="form-input" placeholder="custom.' + RECOG.clubId + '.joined"></div>' +
  '</div>' +
  '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<label style="font-size:13px;color:var(--text-secondary);display:flex;align-items:center;gap:6px"><input type="checkbox" id="recogConnHmac"> 启用 HMAC 签名校验（推荐外部系统开启）</label>' +
    '<button class="btn btn-primary" onclick="recogCreateConnector()">' + icon('key') + ' 创建 Connector</button>' +
  '</div>' +
  '<div id="recogConnTokenBox"></div>';

  if (RECOG.connectors.length) {
    html += '<div class="recog-table-wrap" style="margin-top:10px"><table class="recog-table">' +
      '<tr><th>名称</th><th>类型</th><th>Token 前缀</th><th>状态</th><th>最近使用</th><th style="text-align:right">操作</th></tr>' +
      RECOG.connectors.map(function (c) {
        var revoked = !!c.revoked_at;
        return '<tr>' +
          '<td>' + escapeHtml(c.name) + '</td>' +
          '<td>' + escapeHtml(c.type) + '</td>' +
          '<td style="font-family:monospace;font-size:12px">' + escapeHtml(c.token_prefix || '') + '…</td>' +
          '<td>' + (revoked ? '<span class="recog-pill red">已吊销</span>' : '<span class="recog-pill green">启用</span>') + '</td>' +
          '<td style="font-size:12px;color:var(--text-secondary)">' + (c.last_used_at ? formatDate(c.last_used_at) : '从未') + '</td>' +
          '<td style="text-align:right">' + (revoked ? '' : '<button class="btn btn-sm btn-danger" onclick="recogRevokeConnector(' + c.id + ')">吊销</button>') + '</td>' +
        '</tr>';
      }).join('') + '</table></div>';
  } else {
    html += '<div style="color:var(--text-secondary);font-size:13px;margin-top:10px">该同好会还没有 Connector</div>';
  }

  html += '<div class="recog-docs">' +
    '<strong>接入说明</strong><br>' +
    '1. 事件端点：<code>POST ' + location.origin + '/api/recognition_events.php?action=submit</code><br>' +
    '2. 认证：请求头 <code>Authorization: Bearer &lt;token&gt;</code>（Token 只在创建时展示一次）<br>' +
    '3. 事件类型命名：平台标准事件（如 <code>assessment.completed</code>）或自定义 <code>custom.' + RECOG.clubId + '.&lt;name&gt;</code><br>' +
    '4. 幂等：请携带 <code>idempotency_key</code>，重复事件不会重复签发<br>' +
    '5. HMAC：启用后需附 <code>X-Recog-Signature</code> / <code>X-Recog-Timestamp</code> 头（密钥同样只展示一次）<br>' +
    '6. Connector 只提交事实事件，是否签发由考核规则引擎判定' +
  '</div>';

  area.innerHTML = html;
}

async function recogCreateConnector() {
  var name = document.getElementById('recogConnName').value.trim();
  if (!name) { showToast('请填写 Connector 名称', 'error'); return; }
  var eventsRaw = document.getElementById('recogConnEvents').value;
  var eventTypes = eventsRaw.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  var body = {
    club_id: RECOG.clubId,
    country: RECOG.country,
    name: name,
    type: document.getElementById('recogConnType').value,
    event_types: eventTypes,
    enable_hmac: document.getElementById('recogConnHmac').checked
  };
  try {
    var r = await recogApi('recognition_events.php?action=connector_create', body);
    if (!r.success) { showToast(r.message || '创建失败', 'error'); return; }
    RECOG.connectorsLoaded = false;
    await recogLoadConnectors(false);
    var box = document.getElementById('recogConnTokenBox');
    if (box) {
      box.innerHTML = '<div class="recog-token-box">' +
        '<strong>Token（只展示这一次，请立即保存）：</strong><br><code>' + escapeHtml(r.token) + '</code>' +
        (r.hmac_secret ? '<br><br><strong>HMAC 密钥：</strong><br><code>' + escapeHtml(r.hmac_secret) + '</code>' : '') +
        '<br><button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="recogCopyText(this.dataset.t)" data-t="' + escapeHtml(r.token) + '">复制 Token</button>' +
      '</div>';
    }
    showToast('Connector 已创建', 'success', 'key');
  } catch { showToast('网络错误', 'error'); }
}

async function recogRevokeConnector(connectorId) {
  if (!confirm('确定吊销该 Connector？吊销后其 Token 立即失效。')) return;
  try {
    var r = await recogApi('recognition_events.php?action=connector_revoke', { connector_id: connectorId });
    showToast(r.success ? '已吊销' : (r.message || '操作失败'), r.success ? 'success' : 'error');
    if (r.success) {
      RECOG.connectorsLoaded = false;
      await recogLoadConnectors(false);
    }
  } catch { showToast('网络错误', 'error'); }
}

// ==================== 暴露给页面 ====================
window.renderRecognition = renderRecognition;
window.recogOpenCreate = recogOpenCreate;
window.recogUseTemplate = recogUseTemplate;
window.recogEditProgram = recogEditProgram;
window.recogCloseEditor = recogCloseEditor;
window.recogSetTier = recogSetTier;
window.recogOnTypeChange = recogOnTypeChange;
window.recogAddQuestionRow = recogAddQuestionRow;
window.recogDelQuestion = recogDelQuestion;
window.recogQTypeChange = recogQTypeChange;
window.recogQMarkAnswer = recogQMarkAnswer;
window.recogQOptInput = recogQOptInput;
window.recogQAddOpt = recogQAddOpt;
window.recogQDelOpt = recogQDelOpt;
window.recogQMoveOpt = recogQMoveOpt;
window.recogQAnswerTextInput = recogQAnswerTextInput;
window.recogQBlankInput = recogQBlankInput;
window.recogQAddBlank = recogQAddBlank;
window.recogQDelBlank = recogQDelBlank;
window.recogSaveProgram = recogSaveProgram;
window.recogPublishProgram = recogPublishProgram;
window.recogProgramStatus = recogProgramStatus;
window.recogQuizSync = recogQuizSync;
window.recogCopyCheckin = recogCopyCheckin;
window.recogQrUrl = recogQrUrl;
window.recogShowProgramQr = recogShowProgramQr;
window.recogShowQrModal = recogShowQrModal;
window.recogCloseQrModal = recogCloseQrModal;
window.recogEditBadge = recogEditBadge;
window.recogResetBadgeForm = recogResetBadgeForm;
window.recogUploadBadgeImage = recogUploadBadgeImage;
window.recogSaveBadge = recogSaveBadge;
window.recogGrant = recogGrant;
window.recogImportCsv = recogImportCsv;
window.recogReviewDecision = recogReviewDecision;
window.recogShowClaim = recogShowClaim;
window.recogCloseClaim = recogCloseClaim;
window.recogGenCodes = recogGenCodes;
window.recogCopyText = recogCopyText;
window.recogLoadConnectors = recogLoadConnectors;
window.recogCreateConnector = recogCreateConnector;
window.recogRevokeConnector = recogRevokeConnector;
