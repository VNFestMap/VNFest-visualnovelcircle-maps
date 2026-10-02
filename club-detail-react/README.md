# 同好会详情 · 方案 A

首页真实详情弹窗的 React 18 实现。沿用 `js/app.js` 的账户状态及申请、考核、编辑、成员名单、转让、退出流程。组件首次打开时才加载，不为首页地图的首次显示加载 React。

## 维护与构建

```powershell
node club-detail-react/build.mjs
node --test scripts/test-club-detail-react.mjs
node scripts/test-club-detail-actions.mjs
node scripts/test-club-edit-contract.mjs
```

构建复用 `club-manager-react/node_modules` 已锁定的 React 18.3.1、React DOM 和 esbuild；没有新增运行时 CDN 或修改依赖文件。输出为 `js/club-detail-react.js`，样式位于 `css/club-detail.css`。修改输出后同步更新首页样式及桥接脚本的版本参数。

## 本地浏览器验收

```powershell
node scripts/serve-club-detail-qa.mjs
```

- `http://127.0.0.1:5190/qa`：正式组件和正式桥接代码的验收页，可选择样本、身份、语言、主题及请求失败场景。
- `http://127.0.0.1:5190/index.html?guest=1`：真实首页入口，使用同一套本地接口夹具。
- 本地服务只监听 `127.0.0.1`，业务请求全部在内存中模拟；不会向生产转发申请、留言、删除或成员操作。成员与负责人身份是显式演示数据。
- 公开样本和公开图片位于 `scripts/fixtures/club-detail/`，来自此次研究的已脱敏快照。隐藏联系方式未包含在夹具中。

## 行为与边界

- `country + id` 决定同好会及社区请求。关闭或切换时卸载 React，取消旧请求和局部状态。
- 资料与社区切换保留已加载资料和留言草稿；换同好会默认返回资料，清空草稿。
- 可见联系方式由 `info_hidden/infoHidden` 决定；成员身份不直接覆盖接口隐藏状态。不读取 `raw_text`，也不通过标题或原始说明提取联系人。
- 登记状态、成立时间读取 `verified/created_at`；缺失登记字段显示未知，不从 `verifyMeta` 反推。
- 当前账户的成员与管理权限通过原有函数传入。社区发表仍使用 `club_comments.php?action=add`；删除仍使用 `action=delete`。服务端继续做最终权限校验。
- 手机抽屉默认 62% 视口，可用按钮或拖拽柄展开至 92%；拖拽只作用于顶部柄，正文独立滚动。
- Tab/Shift+Tab 约束于弹窗；Escape 关闭并返回触发卡片；资料/社区使用方向键移动、Enter/Space 激活。
- 样式限定于详情组件，不修改其他弹窗、地图及管理表单的外观。

验收记录与关键截图保存在本地 `docs/club-detail-a/`（按仓库约定，该目录不进入 Git）。本次改动未部署。
