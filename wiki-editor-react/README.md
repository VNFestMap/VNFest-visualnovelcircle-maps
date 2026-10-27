# Wiki 编辑工作区

入口保持 `admin/wiki_editor.html?club_key=china-119`，使用 React 18 与独立 Vite 构建。接口仍是 `/api/wiki.php` 的 get、save、upload，带同源凭证。

```powershell
npm --prefix wiki-editor-react ci
npm run wiki:editor:build
npm run wiki:editor:test
npm run wiki:editor:browser
npm run wiki:roundtrip:test
npm run wiki:browser
```

构建脚本将带哈希的资源同步到 `admin/wiki-editor-assets/`，再更新入口 HTML；仅清理上次构建清单中的旧资源。部署时应先放入资源，再替换入口，并保留旧版资源供已打开的页面使用。

- `src/model.js`：原始内容、按语言保存的 Markdown 缓冲、修改版本与发布版本。未编辑字段直接保留；旧 `body`、空日文翻译和旧草稿格式继续可读。
- `src/markdown.js`：结构化章节与受支持 Markdown 的往返转换。错误原文不会写回正文，两个语言的错误均会阻止发布。
- `src/App.jsx`：工作区、章节导航、草稿恢复、发布与编辑撤销；资料面板和内容编辑器分别在独立组件中。
- `src/Preview.jsx`：iframe 使用共享 `wiki/wiki-reader.js`、阅读样式和阅读交互脚本，响应布局以 iframe 的实际宽度为准。预览刷新保留阅读位置。
- `src/api.js`：JSON/非 JSON 错误处理、同源请求和图片校验。

发布只确认请求发出时的版本。请求期间继续编辑会保留未发布状态和本地草稿。恢复、导入、撤销也会递增版本，不能与正在发布的版本混淆。

正文按章编辑；可视化模式提供段落格式按钮、注释、图片设置；Markdown 支持 ##/### 标题、独立图片、段落和行内格式，复杂块语法会提示。它仍是现有结构化正文协议，不会把原有内容迁移成另一种富文本格式。

浏览器测试使用独立 Chrome profile 和本地隔离 API，覆盖延迟保存、语言切换、草稿恢复、撤销、新词条与权限失败。默认读取仓库 `wiki/content`，截图写入 `artifacts/wiki-editor-browser`。可用 `WIKI_EDITOR_FIXTURE_DIR` 指定内容快照、`WIKI_EDITOR_ARTIFACTS` 指定输出目录；均不会写真实社团接口。

前端版本用于防止本窗口保存竞态。多位负责人同时编辑同一词条时的服务端版本冲突检测仍需要 API 另行支持。
