import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const list = read('Galgame_events/galgameonly_list.html');
const showcase = read('Galgame_events/Beijing_Galonly_showcase.html');
const merchandise = read('Galgame_events/Beijing_Galonly_merchandise.html');
const map = read('Galgame_events/Beijing_galo_map/beitou-visitor-v0.1.html');
const fixturePath = path.join(root, 'scripts/fixtures/beijing-galonly-demo-catalog.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

assert.match(list, /<a\s+href="Beijing_Galonly_showcase\.html">活动展示<\/a>/, '活动列表应指向北京展示页');
assert.doesNotMatch(list, /href=["']galo_poster\.html["']/, '活动列表不应再暴露旧海报入口');
assert.ok(fs.existsSync(path.join(root, 'Galgame_events/galo_poster.html')), '历史 galo_poster.html 应保留');

// The merchandise form is an operational P0 surface.  PHP/FastCGI failures
// must be rendered as an actionable message instead of JSON.parse's opaque
// "Unexpected token <" error.
assert.match(merchandise, /function readJsonResponse\(response\)/, '制品表单应统一处理 API JSON 响应');
assert.match(merchandise, /服务器返回了非 JSON 响应（HTTP /, '制品表单应明确提示非 JSON 的 PHP 或网关错误');
assert.match(merchandise, /return readJsonResponse\(response\);/, '制品提交应通过统一 JSON 响应处理器');
assert.match(merchandise, /function showError\(id, message\)\s*\{[\s\S]*?n\.hidden\s*=\s*!message;/, '制品表单必须解除错误容器的 hidden 属性，否则加载失败只会留下空白面板');
assert.match(merchandise, /event\.event_code\s*\|\|\s*''\)\.toLowerCase\(\)\s*===\s*'beijing'/, '裸链接应能从活动列表定位北京活动，而不是要求用户手工拼接参数');
assert.match(merchandise, /action=get_merchandise&application_id='\s*\+\s*applicationId/, '制品读取应使用当前用户的申请 ID，避免 Go 的 event_id 查询路径误报申请不存在');
assert.ok(!merchandise.includes("fetch(merchandiseUrl, { credentials: 'same-origin' }).then(function (r) { return readJsonResponse(r); }).catch(function () { return { success: false }; })"), '制品申请读取失败必须保留真实错误信息，不能吞成笼统的加载失败');
assert.match(merchandise, /action=get_application/, '制品表单应读取申请主记录，以取得状态与阶段字段');
assert.match(merchandise, /applicationId\s*=\s*parseInt\(beijingEvent\.user_application_id,\s*10\)\s*\|\|\s*0/, '裸链接应使用活动列表返回的当前用户申请 ID，避免 Go 的 event_id 查询路径误报申请不存在');
const normalizerSource = merchandise.match(/function normalizeMerchandiseApplication\(applicationData, merchandiseData\)\s*\{[\s\S]*?\n\s{4}\}/);
assert.ok(normalizerSource, '制品表单应包含 PHP/Go 双响应格式归一化函数');
const normalizeMerchandiseApplication = Function(`return (${normalizerSource[0]});`)();
const normalizedGoApplication = normalizeMerchandiseApplication(
  { success: true, application: { id: 64, event_id: 3, status: 'approved', phase: 1, merchandise_version: 0 } },
  { success: true, application_id: 64, merchandise_items: [{ name: '测试制品' }], merchandise_attachments: ['menu.pdf'], version: 2 }
);
assert.equal(normalizedGoApplication.id, 64, 'Go 扁平制品响应归一化后应保留申请主记录');
assert.equal(normalizedGoApplication.status, 'approved', 'Go 扁平制品响应归一化后应保留审核状态');
assert.deepEqual(normalizedGoApplication.merchandise_items, [{ name: '测试制品' }], 'Go 扁平制品响应中的制品列表应进入表单');
assert.deepEqual(normalizedGoApplication.merchandise_attachments, ['menu.pdf'], 'Go 扁平制品响应中的附件应进入表单');
assert.equal(normalizedGoApplication.merchandise_version, 2, 'Go 扁平制品响应的 version 应映射为 merchandise_version');

for (const token of ['北京', 'BEIJING', '视觉小说', 'ONLY 2.0', 'AN AUTUMN DAY · VISITOR GUIDE']) {
  assert.ok(showcase.includes(token), `展示页缺少 canonical logo 文本：${token}`);
}
for (const token of ['mapExpandedToolbar', '收起地图', 'pointer:coarse', 'useMobileExpansion']) {
  assert.ok(showcase.includes(token), `展示页缺少页内地图退出能力：${token}`);
}
assert.doesNotMatch(showcase, /G·O/, '展示页不应继续使用临时 G·O logo');
assert.match(showcase, /id="exitMapFullscreen"[^>]+aria-label="收起地图"[^>]*>\s*<svg/, '收起控件应为侧边单图标按钮');
assert.doesNotMatch(showcase, /打开完整地图|fullscreen-open/, '展示页不应再提供完整地图跳转入口');
assert.doesNotMatch(showcase, /@media\(min-width:681px\)\{#expandMap\{display:none\}\}/, '桌面端应恢复全屏展开入口');
assert.ok(showcase.includes('查看北京 GalOnly 的活动信息、场馆分区和参展摊位'), '展示页应使用游客导向的活动简介');
assert.doesNotMatch(showcase, /先从一张海报认识这场聚会|受控尺寸|发布说明/, '展示页不应包含内部或实现导向文案');
assert.match(showcase, /https:\/\/free\.picui\.cn\/free\/19469\/2026\/09\/16\/6aaaa61f0b8eb\.png/, '展示页必须使用北京图床海报');
assert.match(showcase, /data-local-src="Beijing_galo_map\/海报\.png"/, '展示页必须保留本地海报回退');
assert.match(showcase, /src="Beijing_galo_map\/beitou-visitor-v0\.1\.html(?:\?[^\"]*)?"/, '展示页必须嵌入地图 demo');
const showcaseMapURL = showcase.match(/data-map-src="([^"]+)"/)?.[1] || '';
assert.match(showcaseMapURL, /^Beijing_galo_map\/beitou-visitor-v0\.1\.html\?g-f-final=20260919-010000&codex_release=[^&]+&embed=showcase$/, '展示页必须嵌入带 release 标记的当前地图发布版本');
assert.equal((showcase.match(/codex_release=/g) || []).length, 1, '展示页只能声明一次地图 release 标记');
assert.doesNotMatch(showcase, /map-rev=20260917-050000/, '展示页不得继续引用旧的嵌套地图版本');
assert.match(showcase, /<iframe[^>]+title="[^"]+"/, '地图 iframe 必须有可访问标题');
assert.match(showcase, /height:clamp\(520px,72vh,900px\)/, '桌面地图必须有受控高度');
assert.match(showcase, /height:clamp\(480px,74dvh,760px\)/, '移动地图必须有受控高度');
for (const token of ['mapLoading', 'mapError', 'expandMap', 'prefers-reduced-motion', ':focus-visible', 'function toggleTheme']) {
  assert.ok(showcase.includes(token), `展示页缺少 ${token} 状态或控件`);
}

for (const token of ['<span class="brand-mark">', 'BEIJING', '视觉小说', 'ONLY 2.0', 'AN AUTUMN DAY · VISITOR GUIDE']) {
  assert.ok(map.includes(token), `地图页缺少 canonical logo 内容：${token}`);
}
for (const token of [
  "eventId: 'beijing'", "eventCode: 'beijing'", 'action=map_public&event_code=beijing', 'map_state', 'map_capability',
  'map_save_draft', 'map_publish', 'map_export', 'MAP_CAN_EDIT', '导入前摘要', 'exportRemoteProject', 'saveRemoteProject',
  'publishRemoteProject', 'L.ensurePlaceholders', 'placeholderBooth', 'map_upload_image', 'window.THREE', 'avatarUrl',
  'avatarField', 'openAvatarCrop', 'data-avatar-image-upload', "searchParams.set('asset','avatar')", 'profile-avatar-image', 'booth-avatar-image',
  "runtimeVersion: '0.185.1'",
  'prefers-reduced-motion', ':focus-visible', 'SPDX-License-Identifier: MIT', 'data-action="viewer-settings"',
  'viewerSettingsDialog', 'viewerSettingsForm', 'viewerWallHeight', 'viewerWallThickness', 'viewerDoorHeight',
  'viewerCutHeight', 'applyViewerSettings', 'resetViewerSettings', 'viewerStorageKey'
]) {
  assert.ok(map.includes(token), `地图页缺少交付能力或安全标记：${token}`);
}
assert.match(map, /function publicSyncSignature\(project\)/, '公开地图应为轮询结果生成稳定摘要');
assert.match(map, /const syncSignature=publicSyncSignature\(project\),changed=syncSignature!==lastPublicSyncSignature;/, '地图更新提示必须先比较本次摘要是否变化');
assert.match(map, /if\(changed\)toast\('北京 GalOnly 地图已更新'\)/, '地图内容未变化时不应重复弹出更新提示');
assert.doesNotMatch(map, /applyRemoteProject\(project\);toast\('北京 GalOnly 地图已更新'\)/, '地图轮询成功后不应无条件弹出更新提示');
assert.doesNotMatch(map, /setInterval\(\(\)=>\{if\(!document\.hidden\)readPublicApi\(\);\},10000\)/, '游客地图不应每十秒被动读取公开数据');
assert.doesNotMatch(map, /document\.addEventListener\('visibilitychange',\(\)=>\{if\(!document\.hidden\)readPublicApi\(\);\}\)/, '切回页面不应自动读取公开数据');
assert.doesNotMatch(map, /window\.addEventListener\('pageshow',\(\)=>readPublicApi\(\)\)/, '页面恢复显示不应自动读取公开数据');
assert.match(map, /readPublicApi\(\);\nreadCapability\(\);/, '游客地图首次打开仍应读取一次公开数据');
assert.match(map, /if\(!window\.MAP_CAN_EDIT&&!window\.MAP_ADMIN_APPLIED\)applyRemoteProject\(project\)/, '管理员编辑时公开地图响应不得覆盖服务器草稿');
assert.match(map, /const draftRevision=Number\(payload\.draft\?\.revision\|\|0\),publishedRevision=Number\(payload\.published\?\.revision\|\|0\),useDraft=!!payload\.draft\?\.project&&draftRevision>publishedRevision/, '管理员页面不得优先载入落后于已发布版本的旧草稿');
assert.match(map, /window\.BOOTH_EDITOR\?\.setCapability\)window\.BOOTH_EDITOR\.setCapability\(window\.MAP_CAN_EDIT===true\)/, '编辑器晚初始化时仍应重新应用地图权限');
assert.match(map, /\.search-field:focus-within\{border-color:#9bb8dd;box-shadow:0 0 0 2px rgba\(48,107,198,\.12\)\}/, '搜索框焦点状态应使用低调的蓝色容器样式');
assert.match(map, /\.search-field input:focus-visible,\.search-field input:focus\{outline:0;outline-offset:0;box-shadow:none\}/, '搜索框不应显示主题全局的黄色大焦点边框');
assert.match(map, /case 'directory':if\(matchMedia\('\(max-width:680px\)'\)\.matches&&selected\)closeDetail\(\);showDirectory\(true\);if\(!matchMedia\('\(max-width:680px\)'\)\.matches\)\$\('search'\)\.focus\(\);break;/, '切换全部摊位后应保持搜索框可直接输入');
for (const token of ['tableIds', 'tableToBooth', 'focusTables', 'mergeBooth', 'ed-table-picker', '已分配桌位', '多桌摊位']) {
  assert.ok(map.includes(token), `地图页缺少多桌摊位能力：${token}`);
}
assert.match(map, /function tablePicker\(booth\)\{const groups=new Map\(\)/, '编辑器桌位选择器应按区域分组');
assert.match(map, /data-table-section/, '编辑器桌位选择器应为每个区域提供独立行');
assert.match(map, /data-product-image-upload/, '编辑器应提供制品图片上传控件');
assert.match(map, /data-avatar-image-upload/, '编辑器应提供头像上传控件');
assert.match(map, /const safeUrl=raw=>\{if\(!raw\)return null;/, '编辑器头像字段必须使用自身作用域的 URL 校验函数');
assert.match(map, /function editorTableKey\(id\)\{return String\(id\|\|''\)\.trim\(\)\.toUpperCase\(\);\}/, '编辑器桌位绑定应使用统一的大小写和空白规范');
assert.match(map, /const before=d\.booths\.length;d\.booths=d\.booths\.filter\(item=>!item\.placeholder\|\|!tableIdsOfEditor\(item\)\.some\(id=>realAssigned\.has\(editorTableKey\(id\)\)\)\);/, '真实摊位重新绑定桌位后必须移除同桌位的旧占位资料');
assert.match(map, /A\.setData\(q\.catalog\);ensureEditorCatalog\(\);/, '载入草稿后必须先清理与真实摊位冲突的占位桌位');
assert.doesNotMatch(map, /syncPublicContent|publicEditorContentFields|publicEditorBoothIsReal/, '地图编辑器不得从公开申请资料回填摊位');
assert.match(map, /aspect-ratio:1/, '头像裁剪区域应为正方形');
assert.match(map, /512,512/, '头像裁剪输出应为 512 × 512');
assert.match(map, /image\/webp/, '头像裁剪应输出 WebP');
assert.doesNotMatch(map, /class="profile-avatar"><span/, '游客详情不应回退到旧的文字头像');
assert.doesNotMatch(map, /class="booth-avatar"[^>]*>\$\{esc\(b\.avatarText\)\}/, '游客列表不应回退到旧的文字头像');
assert.match(map, /PicUI 图床/, '制品图片上传应说明默认使用 PicUI 图床');
assert.match(map, /rotate\(-dx,-dy,-da\)/, '双指拖动应沿手指方向旋转地图');
assert.match(map, /function tableLabel\(booth\)/, '多桌摊位应有统一桌号展示格式');
assert.match(map, /start\+'~'\+ids\[end\]/, '连续桌号应压缩为范围显示');
assert.doesNotMatch(map, /externalBoothApiUrl|externalBoothEventKey|readExternalMerchants|mergeExternalMerchants|MAP_EXTERNAL_SYNC_STATUS/, '地图浏览器不得再同步外部摊位或 CloudBase 资料');
assert.doesNotMatch(map, /galonly_public\.php/, '地图浏览器不得通过兼容摊位接口建立地图资料关联');
assert.match(map, /function collapseDuplicatePlaceholderBindings\(project\)/, '公开地图应提供占位桌位重复绑定的本地兜底清理');
assert.match(map, /const explicitMerges=new Map\(\[\['C06','C07'\]\]\)/, '占位资料只有在明确合并关系中才允许清理');
assert.match(map, /project\.settings\?\.placeholderMerges/, '地图可以通过项目设置声明其他明确的占位合并关系');
assert.doesNotMatch(map, /other\.placeholder&&tableIdsOf\(other\)\.length>ids\.size/, '不能再按桌位集合包含关系自动删除占位资料');
assert.match(map, /const project=collapseDuplicatePlaceholderBindings\(payload\.map\.project\)/, '公开地图应只使用地图项目并先应用桌位重复绑定兜底');
assert.equal(map.includes('nameLeaders'), false, '摊位名不应继续使用折线弹出标签');
assert.equal(map.includes('leader:named'), false, '摊位名不应继续携带折线引导线');
assert.equal(map.includes('id="venueGuideButton"'), false, '地图不应继续显示场馆分区 / 实拍浮动按钮');
assert.equal(map.includes('⌖ 场馆分区 / 实拍'), false, '地图不应继续包含已移除的场馆分区 / 实拍按钮文案');
for (const token of ['地图内容准备中', '场馆分区 · 现场实拍参考', '这些设置只影响你当前设备上的观看方式']) {
  assert.ok(map.includes(token), `地图页缺少游客导向文案：${token}`);
}
for (const forbidden of ['地图资料待发布，审核用户发布真实项目后会显示在这里', '本地几何投影 · WebGL 已中断', 'Three.js r']) {
  assert.equal(map.includes(forbidden), false, `地图页仍包含过时的公开状态文案：${forbidden}`);
}
assert.match(map, /realBoothCount=input\.booths\.filter\(b=>!b\?\.placeholder\)\.length/, '地图校验应只限制真实摊位数量，不能把编辑器占位计入上限');
assert.doesNotMatch(map, /assignedTables\.has\(tableId\)/, '历史重复桌位不应阻塞地图编辑器');
assert.match(map, /if\(!validTableIds\.has\(tableId\)\)throw Error\(id\+' 的桌位编号不存在：'/, '不存在的桌位应与重复分配分开提示');
assert.match(map, /catalog\.demo===true\?'虚构 demo（仅可保存草稿，不能发布）'/, 'demo 项目必须被发布流程拦截');
for (const tableId of ['A01', 'A08', 'B01', 'B08', 'C01', 'C08', 'D01', 'D08', 'E01', 'E08', 'F01', 'F08', 'G01', 'G05', 'G08', 'G09', 'G12', 'H01', 'H03', 'S01', 'S02', 'O01', 'O04', 'O05']) assert.ok(map.includes(tableId), `地图应包含桌位 ${tableId}`);
assert.match(map, /const centralLetters=\['F','E','D','C','B','A'\]/, '中央桌位应按编号表从左到右使用 F/E/D/C/B/A 六组');
assert.match(map, /number=row==='A'\?4-j:5\+j/, '中央每组应按北侧 04→01、南侧 05→08 排号');
assert.match(map, /const legacySpecial=new Map\(\[\s*\['E01','H01'\],\['E02','H02'\],\['E03','H03'\]/s, '旧 E 区编号应迁移为 H01–H03');
assert.match(map, /\['G08',-32\.775,-10\.22,0,'B',false\].*\['G05',-28\.875,-10\.22,0,'B',false\]/s, 'G 区北侧横排应按 G08→G05 排列并保留作业区');
assert.match(map, /\['G12',-33\.78,-5\.45,-Math\.PI\/2,'A',true\].*\['G09',-33\.78,-9\.20,-Math\.PI\/2,'A',true\]/s, 'G 区左列应按 G09→G12 的物理顺序排列且不带作业区');
assert.match(map, /\['G01',-27\.87,-5\.45,Math\.PI\/2,'A',true\].*\['G04',-27\.87,-9\.20,Math\.PI\/2,'A',true\]/s, 'G 区右列应按 G04→G01 的物理顺序排列且不带作业区');
assert.match(map, /L\.specs\.push\(\{id:'O05',x:41\.111907,z:11\.830694,rotation:0,row:'A',group:11,central:false\}\)/, 'O05 应沿用原小舞台独立桌位置，仅重连编号');
assert.match(map, /L\.upgrad[eE]Catalog=d=>L\.reconcileNumberCatalog\(d\)/, '旧目录和桌位编号应自动迁移到编号表');
assert.match(map, /const oldRevision=Number\(p\.settings\?\.numberingRevision\|\|0\);if\(oldRevision<1\)p\.catalog=L\.upgradeCatalog\(p\.catalog\)/, '已经使用新编号表的项目不得再次迁移桌位编号');
assert.match(map, /legacyPlaceholder=.*这是地图编辑器的待填写位置/, '旧版占位资料应在编号迁移时恢复占位标记');
assert.match(map, /const numberingRevision=Number\(project\?\.settings\?\.numberingRevision\|\|0\),normalizedCatalog=numberingRevision>=1\?clone\(project\.catalog\|\|project\):L\.upgradeCatalog\(project\.catalog\|\|project\);/, '公开项目载入时应按编号版本恢复旧版占位标记');
assert.match(map, /function project\(\)\{const d=clone\(A\.data\);return \{schemaVersion:5/, '保存草稿时必须保留占位记录及其原有资料');
assert.doesNotMatch(map, /function project\(\)\{const d=clone\(A\.data\);d\.booths=d\.booths\.filter\(b=>!b\.placeholder\)/, '保存草稿不得静默丢弃占位记录');
assert.match(map, /function positionMoveError\(id,x,z\)/, '已有布局提示不能阻塞无关桌位移动');
assert.match(map, /布局提示（仍可继续编辑）/, '布局冲突必须明确提示但不能锁死全局编辑');
assert.match(map, /const localEditor=location\.protocol==='file:'\|\|\['localhost','127\.0\.0\.1','::1'\]\.includes\(location\.hostname\),initialProject=localEditor\?\(saved\|\|embedded\):null;/, '正式站点不得使用旧本机草稿覆盖服务器地图');
assert.match(map, /for\(let i=1;i<=12;i\+\+\)\{const id='G'\+String\(i\)\.padStart\(2,'0'\);legacySpecial\.set\(id,id\);\}/, 'G01–G12 必须保持独立编号');
assert.doesNotMatch(map, /\['G01','O05'\]/, 'G01 不得再被错误迁移为 O05');
assert.match(map, /L\.specs\.push\(\{id:'S01',x:29\.8,z:-1\.5,rotation:-Math\.PI\/2,row:'A',group:9,central:false\},\{id:'S02',x:29\.8,z:\.1,rotation:-Math\.PI\/2,row:'A',group:9,central:false\}\)/, 'S 区两张竖向桌应保留');
assert.match(map, /displayOnly=spec\.displayOnly===true/, 'F 区应支持展示桌模式');
assert.match(map, /const collisionChecksEnabled=false/, '固定展位不应启用碰撞箱阻塞检查');
assert.match(map, /if\(collisionChecksEnabled&&\(polys\.some/, '墙柱和既有设施碰撞检查必须保持可追溯的关闭开关');
assert.match(map, /if\(collisionChecksEnabled\)for\(let i=0;i<bs\.length;i\+\+\)/, '固定展位不应因作业区重叠被阻塞');
assert.equal(map.includes('超出中央布展范围'), false, '不应继续检测中央分区范围');
assert.equal(map.includes('超出对应场地分区'), false, '不应继续检测各摊位分区范围');
assert.equal(map.includes('超出当前分区范围'), false, '不应继续追加当前分区范围检查');
assert.match(map, /state\.zones&&!b\.displayOnly/, '展示桌不应渲染作业区色带');
assert.match(map, /state\.chairs&&!b\.displayOnly/, '展示桌不应渲染摊主座椅');
assert.match(map, /s\.boxes&&!b\.displayOnly/, '展示桌不应渲染桌下备货箱');
assert.match(map, /L\.specs\.push\(\{id:'O05',x:41\.111907,z:11\.830694,rotation:0,row:'A',group:11,central:false\}\)/, 'O05 应位于小舞台原独立桌位置');
assert.match(map, /const gStageWallIds=new Set\(\['W011','W012','W013'\]\)/, 'G 区只应移除封闭舞台的内部三段墙，外围结构墙必须保留');
assert.match(map, /D\.walls=D\.walls\.filter\(w=>!gStageWallIds\.has\(w\.id\)\)/, 'G 区墙体调整应限定在舞台内部三段墙');
assert.equal(map.includes('[DEBUG-east-wall]'), false, '交付页面不得残留墙体诊断着色代码');
assert.equal(map.includes('window.VENUE_DATA.renderFloor=['), false, '主场地底板应恢复使用完整场地边界');
assert.match(map, /baseBuild\(\{\.\.\.data,displayFloor:data\.renderFloor\|\|data\.displayFloor\}/, '主场地渲染不应继续使用包含右下凸出的厚底板');
assert.match(map, /D\.renderFloor\|\|D\.displayFloor/, '底板边缘不应套到右下开放式舞台');
assert.match(map, /box\('G 区小舞台地面',38\.611907,10\.180694,5,3\.3,-\.034,\.006/, 'G 区应在 O 区南侧 5 × 3.3 米区域使用贴地舞台面');
assert.match(map, /box\('G 区舞台台面',39\.511907,12\.54,3\.2,\.72,\.006,\.17/, 'G 区低台应靠近南侧后墙');
assert.match(map, /box\('G 区舞台背景',39\.611907,13\.30,3,\.12,\.17,1\.72/, 'G 区舞台背景应贴近南侧后墙，不得挡在 G01 前方');
assert.match(map, /box\('G 区舞台屏幕',39\.811907,13\.23,2\.6,\.06,\.58,\.94/, 'G 区屏幕应位于背景墙前侧');
assert.match(map, /name:'东南 · 小舞台'/, '小舞台说明应与编号区分开');
assert.match(map, /const eastWallIds=new Set\(\['W001','W014','W015','W017','EAST-WALL-NORTH','EAST-WALL-SOUTH'\]\)/, '入口应移除重叠旧墙后统一重建');
assert.match(map, /openNorth=4\.530694\+u,openSouth=-1\.219306\+u/, '入口开口应随东侧通道整体移动并保持 5.75 米宽');
assert.match(map, /\{id:'EAST-WALL-NORTH',a:\[x,10\.180694\],b:\[x,openNorth\]\}/, '入口北侧墙必须恢复到开口边缘');
assert.match(map, /\{id:'EAST-WALL-SOUTH',a:\[x,openSouth\],b:\[x,-12\.430324\]\}/, '入口南侧墙必须从开口边缘连续恢复到建筑南端');
assert.equal(map.includes("W018-NE-EAST"), false, '不得重复生成与 W017 重叠的东侧补墙');
assert.doesNotMatch(map, /\['F01',-42\.1,-7\.2|\['F09',-28\.75,-6\.45/, '中央 F 区不应残留楼梯区旧坐标');

const publicText = map.replace(/data:image\/[^;"']+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA]');
for (const forbidden of [
  'window.BOOTH_CATALOG=', 'beitou-b1-demo', '资料为演示填充', '游客导览交互原型', 'V0.1 / LIVING VENUE',
  'ABOUT THIS DEMO', 'CREATOR STUDIO / V0.1', 'G·O', 'beijing-map-poster-override', 'sourceHandles', 'hexHandle',
  'eventReference', '场地.dwg', 'DWG', 'Excel', 'CAD-derived', 'runtimeSources', 'cdn.jsdelivr.net', 'unpkg.com',
  'vendor/three', 'scrollIntoView', 'data:image/webp;base64,', 'document.cookie'
]) {
  assert.equal(publicText.includes(forbidden), false, `地图公开内容仍包含交付前字符串：${forbidden}`);
}
assert.equal(publicText.includes('C:\\Users\\'), false, '地图公开内容不应包含本机用户路径');
assert.equal(publicText.includes('E:\\VNFest'), false, '地图公开内容不应包含本机项目路径');
assert.equal((publicText.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi) || []).length, 0, '地图公开内容不应包含内部 UUID');
assert.doesNotMatch(publicText, /游客\s+\d+/, '场景预览不应暴露旧的演示访客数量');
assert.equal((map.match(/src="https:\/\/free\.picui\.cn\/free\/19469\/2026\/09\/16\/6aaaa61f0b8eb\.png"/g) || []).length, 2, '两个海报位置必须统一使用北京图床');
assert.equal((map.match(/data-local-src="海报\.png"/g) || []).length, 2, '两个海报位置必须保留本地回退');
assert.equal((map.match(/data:image\/[^;]+;base64,/g) || []).length, 14, '正式场地参考照片应保留 14 张');
const photoBlock = map.match(/<script type="application\/json" id="photo-reference-data">([\s\S]*?)<\/script>/);
assert.ok(photoBlock, '正式场地参考照片数据块缺失');
assert.equal(JSON.parse(photoBlock[1]).length, 14, '正式场地参考照片数量改变');
assert.equal(map.includes('id="emptyMap"'), false, '未发布状态不应显示居中的地图资料卡片');
assert.equal(map.includes('empty-map'), false, '未发布状态卡片的冗余样式应移除');
assert.equal(map.includes('beitou-galonly-demo-catalog.json'), false, '公开地图不应引用开发 fixture');
assert.equal(fixture.demo, true, '开发 fixture 必须显式标记 demo');
assert.equal(fixture.eventId, 'beijing', '开发 fixture 必须使用北京活动标识');

console.log('Beijing GalOnly delivery cleanup contract: ok');
