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
// 参与页路径（Phase 3 改名 trial→exam 时仅需更新此处）
var RECOG_EXAM_PAGE = '../trial/index.html';

// 六个标准模板：预填 type + 内容骨架
var RECOG_TEMPLATES = [
  { key: 'quiz', label: '知识问答', type: 'assessment', difficulty: 'normal', desc: '题库答题，达到及格分自动签发徽章' },
  { key: 'newbie', label: '新人入门测试', type: 'assessment', difficulty: 'easy', desc: '面向新成员的基础测试，建议简单题型' },
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
    '.recog-hidden{display:none!important}',
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
        actions += '<button class="btn btn-sm btn-ghost" onclick="recogCopyCheckin(' + p.id + ')" title="复制参与入口（可制二维码）">' + icon('clipboard') + '</button>';
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
  var passScore = 60;
  (rules.conditions || []).forEach(function (c) { if (c.op === 'score_gte') passScore = parseInt(c.value, 10) || 60; });
  var claimEnabled = !!(content && content.claim && content.claim.enabled);
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
      '<div class="form-group"><label>参与者难度</label><select id="recogDiff" class="form-input">' + diffOptions + '</select></div>' +
      '<div class="form-group"><label>尝试次数（0=不限）</label><input id="recogAttempts" class="form-input" type="number" min="0" value="' + (opts.max_attempts || 0) + '"></div>' +
      '<div class="form-group"><label>冷却分钟（0=无）</label><input id="recogCooldown" class="form-input" type="number" min="0" value="' + (opts.cooldown_minutes || 0) + '"></div>' +
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
      '<div class="form-group" id="recogPassGroup"><label>及格分（满分 100）</label><input id="recogPass" class="form-input" type="number" min="0" max="100" value="' + passScore + '"></div>' +
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
  recogSetTier(RECOG.editorTier, true);
  document.getElementById('recogEditorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function recogOnTypeChange() {
  var type = document.getElementById('recogType').value;
  var quizBlock = document.getElementById('recogQuizBlock');
  var passGroup = document.getElementById('recogPassGroup');
  var claimGroup = document.getElementById('recogClaimGroup');
  var isQuiz = type === 'assessment';
  passGroup.style.display = isQuiz ? '' : 'none';
  claimGroup.style.display = (type === 'activity' || type === 'mission') ? '' : 'none';
  if (isQuiz) {
    if (!quizBlock.dataset.ready) {
      quizBlock.dataset.ready = '1';
      quizBlock.innerHTML = '<div class="form-group" style="margin-bottom:6px"><label>题库</label>' +
        '<div id="recogQuestions"></div>' +
        '<button type="button" class="btn btn-ghost" style="margin-top:8px" onclick="recogAddQuestionRow()">+ 添加题目</button></div>';
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

// ---- 题目行编辑器（迁移自 trial.js 的 qq-* 逻辑，支持填空） ----
function recogAddQuestionRow(q) {
  var holder = document.getElementById('recogQuestions');
  if (!holder) return;
  q = q || {};
  var div = document.createElement('div');
  div.className = 'recog-qrow';
  var typeSel = ['single', 'multiple', 'judge', 'fill_blank'].map(function (t) {
    var label = t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : '填空';
    return '<option value="' + t + '"' + ((q.type || 'single') === t ? ' selected' : '') + '>' + label + '</option>';
  }).join('');
  var optionsVal = (q.options || []).join('|');
  var answerVal = Array.isArray(q.answer) ? q.answer.join(',') : '';
  div.innerHTML =
    '<div class="form-group" style="margin-bottom:6px"><input class="form-input rq-text" placeholder="题干" value="' + escapeHtml(q.question || '') + '"></div>' +
    '<div class="qr-line">' +
      '<select class="form-input rq-type" style="width:96px">' + typeSel + '</select>' +
      '<input class="form-input rq-options" style="flex:1;min-width:160px" placeholder="选项，用 | 分隔（判断题自动为 对/错）" value="' + escapeHtml(optionsVal) + '">' +
      '<input class="form-input rq-answer" style="width:120px" placeholder="答案序号" value="' + escapeHtml(answerVal) + '" title="选择题填正确答案序号（多选用逗号分隔）；填空题此处填参考答案">' +
      '<button type="button" class="btn btn-sm btn-danger" onclick="recogDelQuestion(this)">删除</button>' +
    '</div>';
  var syncRow = function () {
    var t = div.querySelector('.rq-type').value;
    var opt = div.querySelector('.rq-options');
    var ans = div.querySelector('.rq-answer');
    if (t === 'judge') { opt.value = '对|错'; opt.disabled = true; } else { opt.disabled = false; }
    if (t === 'fill_blank') { opt.style.display = 'none'; ans.placeholder = '参考答案（文本）'; }
    else { opt.style.display = ''; ans.placeholder = '答案序号'; }
  };
  div.querySelector('.rq-type').addEventListener('change', syncRow);
  holder.appendChild(div);
  if (window._recogQuestions) window._recogQuestions.push(div);
  syncRow();
}

function recogDelQuestion(btn) {
  var row = btn.closest('.recog-qrow');
  if (window._recogQuestions) {
    var i = window._recogQuestions.indexOf(row);
    if (i >= 0) window._recogQuestions.splice(i, 1);
  }
  row.remove();
}

function recogCollectQuestions() {
  var questions = [];
  var rows = document.querySelectorAll('#recogQuestions .recog-qrow');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var text = row.querySelector('.rq-text').value.trim();
    if (!text) continue;
    var qtype = row.querySelector('.rq-type').value;
    if (qtype === 'fill_blank') {
      var answerText = row.querySelector('.rq-answer').value.trim();
      if (!answerText) { showToast('第 ' + (questions.length + 1) + ' 题填空题缺少参考答案', 'error'); return null; }
      questions.push({ type: 'fill_blank', question: text, answer_text: answerText, points: 10 });
      continue;
    }
    var options = qtype === 'judge' ? ['对', '错'] :
      row.querySelector('.rq-options').value.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (options.length < 2) { showToast('第 ' + (questions.length + 1) + ' 题选项不足', 'error'); return null; }
    var answer = (row.querySelector('.rq-answer').value || '').split(',')
      .map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return !isNaN(n); });
    if (!answer.length) { showToast('第 ' + (questions.length + 1) + ' 题未设置答案', 'error'); return null; }
    for (var k = 0; k < answer.length; k++) {
      if (answer[k] < 0 || answer[k] >= options.length) { showToast('第 ' + (questions.length + 1) + ' 题答案序号越界（0-' + (options.length - 1) + '）', 'error'); return null; }
    }
    if (qtype === 'single' && answer.length !== 1) { showToast('第 ' + (questions.length + 1) + ' 题单选题只能有一个答案', 'error'); return null; }
    questions.push({ type: qtype, question: text, options: options, answer: answer, points: 10 });
  }
  return questions;
}

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
    content.quiz = { questions: questions, shuffle: false };
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
    participant_difficulty: document.getElementById('recogDiff').value,
    max_attempts: parseInt(document.getElementById('recogAttempts').value, 10) || 0,
    cooldown_minutes: parseInt(document.getElementById('recogCooldown').value, 10) || 0,
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
    if (r.success) await renderRecognition();
  } catch { showToast('网络错误', 'error'); }
}

async function recogProgramStatus(programId, status) {
  if (status === 'archived' && !confirm('确定归档该考核？归档后参与者不可见，已签发凭证不受影响。')) return;
  try {
    var r = await recogApi('recognition_programs.php?action=set_status', { program_id: programId, status: status });
    showToast(r.success ? '状态已更新' : (r.message || '操作失败'), r.success ? 'success' : 'error');
    if (r.success) await renderRecognition();
  } catch { showToast('网络错误', 'error'); }
}

async function recogQuizSync(programId, btn) {
  if (btn) btn.disabled = true;
  try {
    var r = await recogApi('recognition_events.php?action=quiz_sync', { program_id: programId, limit: 500 });
    showToast(r.success ? r.message : (r.message || '同步失败'), r.success ? 'success' : 'error');
    if (r.success) await renderRecognition();
  } catch { showToast('网络错误', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

function recogCopyCheckin(programId) {
  var url = location.origin + location.pathname.replace(/admin\/.*$/, '') + RECOG_EXAM_PAGE.replace('../', '') + '#/program/' + programId;
  function done() { showToast('参与入口已复制，可制作成二维码', 'success', 'clipboard'); }
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(function () { prompt('参与入口（可制作成二维码）：', url); });
  else prompt('参与入口（可制作成二维码）：', url);
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
    '<div class="form-group"><label>徽章图片（JPEG/PNG/GIF/WebP，≤2MB）</label>' +
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
  if (file.size > 2 * 1024 * 1024) { showToast('图片不能超过 2MB', 'error'); input.value = ''; return; }
  var fd = new FormData();
  fd.append('image', file);
  fd.append('club_id', String(RECOG.clubId));
  fd.append('country', RECOG.country);
  var preview = document.getElementById('recogBadgePreview');
  preview.innerHTML = '<span class="form-hint">上传中…</span>';
  try {
    var r = await fetch('../api/badge_image.php?action=upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    var data = await r.json();
    if (!data.success) { preview.innerHTML = ''; showToast(data.message || '上传失败', 'error'); input.value = ''; return; }
    RECOG.badgeImageUrl = data.image_url;
    preview.innerHTML = '<img class="recog-img-preview" src="../' + escapeHtml(data.image_url) + '">';
    showToast('图片已上传，保存徽章后生效', 'success', 'check');
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
      await renderRecognition();
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
        var contentPreview = '';
        try { contentPreview = JSON.parse(s.content || '{}').text || s.content || ''; } catch (e) { contentPreview = s.content || ''; }
        var holder = s.holder_nickname || s.holder_username || ('user#' + s.holder_user_id);
        return '<tr>' +
          '<td>' + escapeHtml(s.program_title || '') + '</td>' +
          '<td>' + escapeHtml(holder) + '</td>' +
          '<td><span class="recog-sub-text" title="' + escapeHtml(String(contentPreview)) + '">' + escapeHtml(String(contentPreview)) + '</span>' +
            (s.file_path ? ' ' + icon('paperclip') : '') + '</td>' +
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
    await renderRecognition();
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
    await renderRecognition();
  } catch { showToast('网络错误', 'error'); }
}

async function recogReviewDecision(submissionId, decision) {
  var comment = decision === 'rejected' ? prompt('驳回原因（可选）：', '') || '' : '';
  try {
    var r = await recogApi('recognition_admin.php?action=review', { submission_id: submissionId, decision: decision, comment: comment });
    if (!r.success) { showToast(r.message || '审核失败', 'error'); return; }
    showToast(r.message || (decision === 'approved' ? '已通过' : '已驳回'), 'success', 'check');
    await renderRecognition();
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
      '<button class="btn btn-sm btn-ghost" onclick="recogCopyText(this.dataset.t)" data-t="' + escapeHtml(shareUrl) + '">复制签到入口</button>' +
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
window.recogSaveProgram = recogSaveProgram;
window.recogPublishProgram = recogPublishProgram;
window.recogProgramStatus = recogProgramStatus;
window.recogQuizSync = recogQuizSync;
window.recogCopyCheckin = recogCopyCheckin;
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
