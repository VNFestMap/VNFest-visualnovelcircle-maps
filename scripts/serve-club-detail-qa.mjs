// Local fixtures only. No business requests are forwarded to production.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const sampleFile = path.join(
  root,
  "scripts/fixtures/club-detail/public-samples.json",
);
const publicSamples = JSON.parse(fs.readFileSync(sampleFile, "utf8")).samples;
const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
const bridge = app.slice(
  app.indexOf("// The index remains the owner"),
  app.indexOf("// ====== 同好会绑定申请弹窗 ======"),
);
const adapter = app.slice(
  app.indexOf("function apiClubToDetailClub("),
  app.indexOf("async function refreshClubDetailAfterMembershipApply("),
);
const sampleData = publicSamples.map((s) => ({
  ...s.club,
  logo_url: s.club.logo_url?.replace(
    "./assets/",
    "./scripts/fixtures/club-detail/assets/",
  ),
  can_apply: false,
}));
const state = new Map();
const failures = new Set();
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
};
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
function harness() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>方案 A · 正式组件本地验收</title><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/theme-tokens.css"><link rel="stylesheet" href="/css/club-detail.css"><style>body{margin:0;padding:24px;background:var(--md-surface-container-low,#f5f5f5);font-family:inherit}.qa-toolbar{display:flex;gap:12px;flex-wrap:wrap;padding-bottom:24px}label{display:flex;gap:8px;align-items:center}select,button{min-height:36px}#qaAction{padding:20px}</style><h1>方案 A · 正式组件本地验收</h1><p>当前页面使用正式 React 组件与首页桥接代码。身份、压力资料和业务操作为本地演示。</p><div class="qa-toolbar"><label>样本<select id="sample"><option value="0">川渝联合 · 公开稀疏资料</option><option value="1">VNFest · 公开完整资料</option><option value="2">京大 · 日本资料</option><option value="3">压力样本 · 长文本 / 12 推荐 / 45 留言</option><option value="4">演示公开联系方式</option><option value="5">演示相同 ID · 日本</option></select></label><label>身份<select id="role"><option value="guest">访客</option><option value="logged">已登录未加入</option><option value="pending">申请审核中</option><option value="member">成员</option><option value="manager">管理者</option><option value="representative">负责人</option><option value="external">外部成员</option></select></label><label>主题<select id="theme"><option value="light">浅色</option><option value="dark">深色</option></select></label><label>语言<select id="language"><option value="zh">中文</option><option value="ja">日本語</option></select></label><label>请求状态<select id="failure"><option value="none">正常</option><option value="rec">推荐失败一次</option><option value="comments">留言失败一次</option><option value="wiki">维基失败一次</option><option value="delay">延迟请求</option><option value="publish">发表失败</option><option value="copy">复制失败</option></select></label><button id="open">打开同好会详情</button><button id="switch">切换到京大</button><button id="sameId">切换相同 ID 日本样本</button></div><p id="qaAction" role="status"></p><div id="clubDetailModal" class="club-detail-layout-a" aria-hidden="true"><div class="club-detail-modal-card" role="dialog" aria-modal="true" aria-labelledby="clubDetailTitle"><button id="clubDetailClose" class="club-detail-modal-close" aria-label="关闭同好会详情弹窗">×</button><div id="clubDetailContent"></div></div></div><script>
const initial=${JSON.stringify(sampleData).replace(/</g, "\\u003c")};
const stress={id:990,country:'china',name:'视觉小说与 Galgame 同好会联合交流研究社团 · 长名称与多地区压力样本',type:'region',province:'四川',provinces:['四川','重庆','甘肃','北京','上海'],school:'本地演示学校',remark:('这是一段用于验证长介绍的本地演示资料。与志同道合的伙伴一起分享视觉小说、交流作品与创作经验。\\n').repeat(12),verified:0,created_at:'2020-01-01',external_links:'官网: https://example.org/'+('very-long-path-').repeat(20)+'\\nQQ群：演示群号',info_hidden:true,info:''};
const publicContact={...initial[0],id:991,name:'公开联系方式 · 本地演示',info_hidden:false,info:'123456789（本地演示）'};
const sameId={...stress,id:990,country:'japan',name:'同 ID 日本社团 · 隔离请求压力样本',province:'京都府',prefecture:'京都府',provinces:[]};
const samples=[...initial,stress,publicContact,sameId];
let State={bandoriRows:[],japanRows:[]};let currentUser;let currentLang='zh';const CONFIG={PUBLIC_BASE_URL:'https://www.map.vnfest.top'};
const Utils={formatCreatedAt:v=>v,resolveMediaUrl:v=>v};const __=key=>({detailUnfilled:'未填写',listNoName:'未命名',detailRegistered:'已登记'})[key]||key;
const getClubProvinceLabel=club=>(club.provinces?.length?club.provinces:[club.province]).join('、');const formatJapanPrefectureName=v=>v;
const getClubMembership=(id,country)=>currentUser.memberships.find(m=>m.club_id===id&&m.country===country);const isClubMember=(id,country)=>{const m=getClubMembership(id,country);return m?.status==='active'&&m.role!=='external';};const canManageClub=(id,country)=>{const m=getClubMembership(id,country);return m?.status==='active'&&['manager','representative'].includes(m.role);};const hasRole=()=>false;
const operation=name=>document.getElementById('qaAction').textContent='本地演示入口：'+name;const openMembershipApplyModal=()=>operation('申请绑定');const openClubEditor=()=>operation('编辑同好会');const openMemberList=()=>operation('成员名单 / 转让');const confirmLeaveClub=()=>operation('退出同好会');
${adapter}
${bridge}
document.getElementById('theme').onchange=e=>document.documentElement.setAttribute('data-theme',e.target.value);
function openSample(index){let club={...samples[index]};const role=document.getElementById('role').value;currentLang=document.getElementById('language').value;currentUser={logged_in:role!=='guest',user:{id:10},memberships:[]};if(!['guest','logged'].includes(role)){currentUser.memberships=[{club_id:club.id,country:club.country,status:role==='pending'?'pending':'active',role:role==='pending'?'member':role}];}club.can_apply=!['guest','pending','member','manager','representative','external'].includes(role);club.membership_status=role==='pending'?'pending':null;club.info_hidden=club.info_hidden&&!['pending','member','manager','representative'].includes(role);if(!club.info_hidden&&!club.info)club.info='演示联系方式（仅本地身份样本）';State.bandoriRows=club.country==='china'?[club]:[];State.japanRows=club.country==='japan'?[club]:[];const failure=document.getElementById('failure').value;document.cookie='qaFailure='+failure+';path=/';document.cookie='qaRole='+role+';path=/';document.cookie='qaToken='+Date.now()+';path=/';if(failure==='copy'){navigator.clipboard.writeText=()=>Promise.reject(new Error('fixture clipboard failure'));}showClubDetail(apiClubToDetailClub(club,club.country));}
document.getElementById('open').onclick=()=>openSample(Number(document.getElementById('sample').value));document.getElementById('switch').onclick=()=>openSample(2);document.getElementById('sameId').onclick=()=>openSample(5);
</script></html>`;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const cookies = Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim().split("=")),
  );
  const fail = cookies.qaFailure;
  const token = cookies.qaToken;
  const id = Number(url.searchParams.get("club_id"));
  const country = url.searchParams.get("country") || "china";
  if (url.pathname === "/qa") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(harness());
  }
  const failKey = token + url.pathname;
  if (
    ((fail === "rec" && url.pathname.includes("club_recommendations")) ||
      (fail === "comments" && url.pathname.includes("club_comments")) ||
      (fail === "wiki" && url.pathname === "/wiki/index.json")) &&
    !failures.has(failKey)
  ) {
    failures.add(failKey);
    return json(res, { success: false }, 503);
  }
  if (fail === "delay" && url.pathname.startsWith("/api/club_"))
    await new Promise((resolve) => setTimeout(resolve, 1400));
  if (url.pathname === "/api/club_recommendations.php")
    return json(res, {
      success: true,
      data:
        id === 990
          ? Array.from({ length: 12 }, (_, i) => ({
              id: i + 1,
              title: "本地演示作品 " + (i + 1) + " · 长标题",
              image_url: "",
              rating: i % 3 === 0 ? null : 8.5,
            }))
          : [],
    });
  if (url.pathname === "/api/club_moe_king.php") {
    const publicMoe = publicSamples.find(
      (s) => s.club.id === id && s.club.country === country,
    )?.moe?.data;
    return json(res, {
      success: true,
      data:
        id === 990
          ? {
              name: "本地演示萌王",
              image_url: "",
              summary: "长简介用于验证完整阅读与换行。".repeat(25),
            }
          : publicMoe
            ? {
                ...publicMoe,
                image_url: publicMoe.image_url?.replace(
                  "./assets/",
                  "./scripts/fixtures/club-detail/assets/",
                ),
              }
            : null,
    });
  }
  if (url.pathname === "/api/club_comments.php") {
    const key = country + ":" + id;
    if (!state.has(key))
      state.set(
        key,
        id === 990
          ? Array.from({ length: 45 }, (_, i) => ({
              id: 500 + i,
              user_id: i % 2 === 0 ? 10 : 11,
              username: i % 2 === 0 ? "演示自己" : "演示成员乙",
              content:
                "本地演示留言 " + (i + 1) + "：用于验证列表分页与成员操作。",
              created_at: "2026-09-30 12:00",
            }))
          : [],
      );
    const rows = state.get(key);
    const action = url.searchParams.get("action");
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (fail === "publish")
        return json(res, { success: false, message: "fixture failure" }, 503);
      if (action === "add") {
        const addKey = (body.country || "china") + ":" + body.club_id;
        const list = state.get(addKey) || [];
        list.unshift({
          id: Date.now(),
          user_id: 10,
          username: "演示自己",
          content: body.content,
          created_at: "2026-09-30 12:30",
        });
        state.set(addKey, list);
      }
      if (action === "delete")
        for (const [key, list] of state)
          state.set(
            key,
            list.filter((c) => c.id !== body.id),
          );
      return json(res, { success: true });
    }
    const page = Number(url.searchParams.get("page")) || 1;
    return json(res, {
      success: true,
      data: rows.slice((page - 1) * 20, page * 20),
      page,
      limit: 20,
      total: rows.length,
    });
  }
  if (url.pathname === "/wiki/index.json")
    return json(
      res,
      JSON.parse(fs.readFileSync(path.join(root, "wiki/index.json"), "utf8")),
    );
  if (url.pathname === "/api/auth.php")
    return json(res, { logged_in: false, user: null, memberships: [] });
  if (url.pathname === "/api/clubs.php")
    return json(res, {
      success: true,
      data: sampleData.filter((c) => c.country === "china"),
    });
  if (url.pathname === "/api/clubs_japan.php")
    return json(res, {
      success: true,
      data: sampleData.filter((c) => c.country === "japan"),
    });
  if (url.pathname.startsWith("/api/"))
    return json(res, { success: true, data: [], memberships: [], total: 0 });
  const file = path.resolve(root, "." + url.pathname);
  if (
    !file.startsWith(root + path.sep) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, {
    "content-type":
      (mime[path.extname(file)] || "application/octet-stream") +
      "; charset=utf-8",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});
server.listen(5190, "127.0.0.1", () =>
  console.log(
    "Local detail QA: http://127.0.0.1:5190/qa; real index: http://127.0.0.1:5190/index.html?guest=1",
  ),
);
