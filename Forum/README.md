# Forum 历史归档

Forum 已停止对外提供。历史帖子、回复、附件、通知和审计记录保留在服务器中，不公开展示，也不转换为专栏文章或评论。

旧页面：

- `forum-plaza.html`
- `forum-post.html`
- `forum-create.html`

这些入口只显示归档说明，并链接到 `/column/`。`api/forum.php` 在浏览器请求中返回 HTTP 410 和 `archived: true`，不再开放浏览、发帖、回复、点赞、收藏、举报或上传。

新内容请使用 `column/`：

- `index.html`：精选、最新文章和筛选
- `article.html?id={id}`：长文、相关文章和评论
- `write.html`：保存草稿、发布和编辑
- `my.html`：文章状态管理
- `series.html`：系列目录和文章列表

旧表和 `Forum/uploads/` 不删除。后续如需导出，使用管理员内部工具处理，不从公开 API 提供。
