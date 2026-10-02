import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const list = read('Galgame_events/galgameonly_list.html');
const showcase = read('Galgame_events/Beijing_Galonly_showcase.html');
const map = read('Galgame_events/Beijing_galo_map/beitou-visitor-v0.1.html');

assert.match(list, /<a\s+href="Beijing_Galonly_showcase\.html">活动展示<\/a>/, '活动列表应指向北京展示页');
assert.doesNotMatch(list, /<a\s+href="galo_poster\.html">活动海报<\/a>/, '活动列表不应再暴露旧海报入口');
assert.ok(fs.existsSync(path.join(root, 'Galgame_events/galo_poster.html')), '历史 galo_poster.html 应保留');
assert.match(showcase, /https:\/\/free\.picui\.cn\/free\/19469\/2026\/09\/16\/6aaaa61f0b8eb\.png/, '展示页必须使用北京图床海报');
assert.match(showcase, /data-local-src="Beijing_galo_map\/海报\.png"/, '展示页必须保留本地海报回退');
assert.match(showcase, /src="Beijing_galo_map\/beitou-visitor-v0\.1\.html(?:\?[^\"]*)?"/, '展示页必须嵌入地图 demo');
const mapDataURL = showcase.match(/<iframe id="mapFrame"[^>]*\sdata-map-src="([^"]+)"[^>]*\ssrc="about:blank"/)?.[1];
assert.ok(mapDataURL, '展示页必须在 iframe data-map-src 中声明唯一地图 URL');
assert.match(showcase, /function resetFrame\(\)[\s\S]*?\$\('mapFrame'\)\.src=\$\('mapFrame'\)\.dataset\.mapSrc/, '展示页重载必须读取 iframe 的唯一 data-map-src');
assert.match(mapDataURL, /^Beijing_galo_map\/beitou-visitor-v0\.1\.html\?g-f-final=20260919-010000&codex_release=[^&]+&embed=showcase$/, '展示页必须嵌入带 release 标记的当前地图版本');
assert.equal((showcase.match(/codex_release=/g) || []).length, 1, '展示页只能声明一次地图 release 标记');
assert.doesNotMatch(showcase, /map-rev=20260917-050000/, '展示页不得继续引用旧的嵌套地图版本');
assert.match(showcase, /height:clamp\(520px,72vh,900px\)/, '桌面地图必须有受控高度');
assert.match(showcase, /height:clamp\(480px,74dvh,760px\)/, '移动地图必须有受控高度');
for (const token of ['mapLoading', 'mapError', 'expandMap', 'exitMapFullscreen', 'mapExpandedToolbar', 'fullscreenchange', 'map-is-expanded', 'pointer:coarse', 'aria-expanded="false"', 'prefers-reduced-motion', 'function toggleTheme']) {
  assert.ok(showcase.includes(token), `展示页缺少 ${token} 状态或控件`);
}
assert.doesNotMatch(showcase, /orientation\.lock\(['"]landscape/, '移动端不得被强制锁定为横屏');
assert.match(showcase, /useMobileExpansion\(\).*shell\.classList\.add\('is-expanded'\)/s, '移动端必须使用页内展开而非原生全屏');
assert.match(showcase, /\.map-expanded-toolbar\{[^}]*right:max\([^}]*left:auto[^}]*pointer-events:none[^}]*transform:translateY\(-50%\)/, '展开工具栏应固定在地图侧边，避免覆盖地图交互区');
assert.doesNotMatch(showcase, /map-expanded-toolbar\{[^}]*inset:/, '展开工具栏不应使用横向铺满地图的 inset 布局');
assert.doesNotMatch(showcase, /打开完整地图|fullscreen-open/, '展示页不应再提供完整地图跳转入口');
assert.doesNotMatch(showcase, /@media\(min-width:681px\)\{#expandMap\{display:none\}\}/, '桌面端应显示全屏展开按钮');
assert.match(map, /\.workspace\.show-directory \.legend\{[^}]*left:auto[^}]*right:24px[^}]*width:min\(240px,calc\(100% - 48px\)\)[^}]*justify-content:flex-end/, '全部摊位视图的图例应固定在地图右侧且限制宽度');
assert.doesNotMatch(map, /\.workspace\.show-directory \.legend\{[^}]*left:calc\(300px \+ 26px\)/, '全部摊位视图不应把图例推到侧栏右边并拉伸到整行');
assert.match(map, /eventId:\s*'beijing'/, '地图应使用稳定活动标识');
assert.doesNotMatch(map, /漫展游客导览演示|点击 59 个摊位/, '公开地图页不应继续显示旧演示元数据');
assert.match(map, /eventCode:\s*'beijing'/, '地图应使用 beijing event_code');
assert.match(map, /action=map_public&event_code=beijing/, '地图应连接 Go 公开接口');
assert.doesNotMatch(map, /icons\(\);setData\(window\.BOOTH_CATALOG\)/, '公开启动路径不得加载虚构目录');
assert.match(map, /realBoothCount=input\.booths\.filter\(b=>!b\?\.placeholder\)\.length/, '地图校验应允许少于 63 个真实摊位并忽略编辑器占位');
for (const token of ['tableIds', 'tableToBooth', 'focusTables', '多桌摊位', 'ed-table-picker']) assert.ok(map.includes(token), `地图缺少多桌摊位能力：${token}`);
for (const tableId of ['F07', 'F12']) assert.ok(map.includes(tableId), `地图缺少新增 F 区桌位 ${tableId}`);
assert.doesNotMatch(map, /scrollIntoView\(/, '嵌入地图不得使用不可控 scrollIntoView');
assert.match(map, /虚构 demo 项目不能发布|demo.*不能发布/, 'demo 项目必须被发布流程拦截');
assert.match(map, /map_state/, '地图必须包含登录状态同步接口');
assert.match(map, /导入前摘要/, '导入 JSON 前必须展示浏览器端摘要');
assert.match(map, /点击“确定”后才会保存为服务器草稿/, '确认导入前不得提交服务器草稿');

console.log('Beijing GalOnly showcase/map contract: ok');
