<?php
// config.example.php - 配置模板
// 使用说明：复制此文件为 config.php 并填入真实配置

if (!defined('ADMIN_TOKEN')) {

define('ADMIN_TOKEN', 'your_secure_password_here');
define('BOT_API_KEY', 'your_private_bot_api_key_here');
define('DATA_PATH', __DIR__ . '/data/');
define('SITE_URL', 'https://yourdomain.com');

// ===== 专栏评论服务 =====
define('COLUMN_WALINE_SERVER_URL', getenv('COLUMN_WALINE_SERVER_URL') ?: '');
define('COLUMN_WALINE_SSO_SECRET', getenv('COLUMN_WALINE_SSO_SECRET') ?: '');
define('COLUMN_WALINE_ALLOWED_REDIRECTS', getenv('COLUMN_WALINE_ALLOWED_REDIRECTS') ?: '');

// ===== 公开图片图床（真实 Token 只放服务器环境，不要提交到 Git） =====
define('PICUI_TOKEN', getenv('PICUI_TOKEN') ?: '');
define('PICUI_API_URL', getenv('PICUI_API_URL') ?: 'https://picui.cn/api/v1');
define('PICUI_ENABLED', filter_var(getenv('PICUI_ENABLED') ?: 'false', FILTER_VALIDATE_BOOLEAN));
define('PICUI_PERMISSION', (int)(getenv('PICUI_PERMISSION') ?: 1));
define('PICUI_TIMEOUT', (int)(getenv('PICUI_TIMEOUT') ?: 30));
define('PICUI_FALLBACK_LOCAL', filter_var(getenv('PICUI_FALLBACK_LOCAL') ?: 'true', FILTER_VALIDATE_BOOLEAN));
define('PICUI_ALLOWED_HOSTS', getenv('PICUI_ALLOWED_HOSTS') ?: 'picui.cn,www.picui.cn');

// 数据库驱动: 'sqlite' 或 'mysql'
define('DB_DRIVER', 'sqlite');

// SQLite 配置（DB_DRIVER = sqlite 时使用）
define('DB_PATH', __DIR__ . '/data/galgame.db');

// MySQL 配置（DB_DRIVER = mysql 时使用）
define('DB_HOST', '127.0.0.1');
define('DB_NAME', 'www_test_map_vnf');
define('DB_USER', 'www_test_map_vnf');
define('DB_PASS', '');

define('SESSION_LIFETIME', 7200);
define('SESSION_SECRET', 'change-to-a-random-64-char-string');
// 访问统计匿名访客哈希密钥：生产环境请设置一个长期不变的随机值。
define('ANALYTICS_HASH_KEY', getenv('ANALYTICS_HASH_KEY') ?: SESSION_SECRET);

// ===== Makoquiz 答题游戏连携 =====
// bind_token 的 HMAC 签名密钥（与 makoquiz 服务端的 VNFEST_LINK_SECRET 一致）
define('QUIZ_LINK_SECRET', 'change-to-a-random-64-char-string');
// makoquiz 服务端回传战绩时的 Bearer 密钥（与 makoquiz 的 VNFEST_API_KEY 一致）
define('QUIZ_API_KEY', 'change-to-another-random-64-char-string');

// ===== 同好会考核（Recognition） =====
// 外部 Connector 请求的 HMAC 签名校验密钥（时间戳防重放窗口用）
define('RECOGNITION_HMAC_SECRET', 'change-to-a-random-64-char-string');
// 公开凭证编号的前缀（展示用，不参与安全）
define('RECOGNITION_CRED_PREFIX', 'VNF-CRED-');

// 邮件发送配置
// 方式一: 使用 PHP mail()（需服务器支持 sendmail/postfix）
define('MAIL_DRIVER', 'mail');       // 'mail' 或 'smtp'
define('MAIL_FROM_NAME', '地图');     // 发件人名称
define('MAIL_FROM_ADDR', 'noreply@yourdomain.com'); // 发件人地址

// 方式二: 使用 SMTP（如 QQ邮箱、阿里云邮件推送等）
// 启用 SMTP 时把 MAIL_DRIVER 改为 'smtp' 并填写以下配置
define('SMTP_HOST', '');     // SMTP 服务器 (例: smtp.qq.com)
define('SMTP_PORT', 465);    // 端口 (QQ邮箱: 465)
define('SMTP_USER', '');     // SMTP 账号 (例: your@qq.com)
define('SMTP_PASS', '');     // SMTP 密码/授权码 (QQ邮箱需开启 SMTP 并生成授权码)
define('SMTP_SECURE', 'ssl'); // ssl 或 tls

// OAuth 配置
// QQ 互联审核使用的应用 ID（公开标识，需与 QQ 互联申请保持一致）
define('QQ_APPID', '1903987938');
// App Key 仅填写在服务器私有配置中，不要提交到仓库或前端
define('QQ_APPSECRET', '');
define('QQ_REDIRECT_URI', SITE_URL . '/api/qq_callback.php');
define('DISCORD_CLIENT_ID', '');
define('DISCORD_CLIENT_SECRET', '');
define('DISCORD_REDIRECT_URI', SITE_URL . '/api/discord_callback.php');
define('BANGUMI_CLIENT_ID', getenv('BANGUMI_CLIENT_ID') ?: '');
define('BANGUMI_CLIENT_SECRET', getenv('BANGUMI_CLIENT_SECRET') ?: '');
define('BANGUMI_REDIRECT_URI', SITE_URL . '/api/bangumi_callback.php');
define('BANGUMI_TOKEN_ENCRYPTION_KEY', getenv('BANGUMI_TOKEN_ENCRYPTION_KEY') ?: '');

define('LEGACY_AUTH_ENABLED', true);

// ===== LLM API 配置（同好会运行画像生成器用，可选） =====
define('LLM_ENABLED', false);        // 是否启用 LLM 分析
define('LLM_PROVIDER', 'deepseek');  // deepseek / openai / claude
define('LLM_API_KEY', '');           // API 密钥
define('LLM_API_URL', '');           // 自定义 API 地址（空=默认）
define('LLM_PROXY', '');             // 可选代理，例如 http://127.0.0.1:7890；留空则忽略环境代理并直连
define('LLM_MODEL', 'deepseek-chat');
define('LLM_MAX_TOKENS', 2048);
define('LLM_TEMPERATURE', 0.7);

}
