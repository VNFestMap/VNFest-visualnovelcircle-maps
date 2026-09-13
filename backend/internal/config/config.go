package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config contains only runtime configuration. Secrets are deliberately not
// serialised or printed by the server, migration tool, or workers.
type Config struct {
	Root                         string
	Environment                  string
	AppAddr                      string
	SiteURL                      string
	DBDriver                     string
	DBPath                       string
	DBHost                       string
	DBPort                       int
	DBName                       string
	DBUser                       string
	DBPassword                   string
	DataDir                      string
	UploadDir                    string
	WikiUploadDir                string
	AdminToken                   string
	BotAPIKey                    string
	QuizAPIKey                   string
	QuizLinkSecret               string
	VNDBAPIURL                   string
	MakoQuizURL                  string
	LLMEnabled                   bool
	LLMProvider                  string
	LLMAPIKey                    string
	LLMAPIURL                    string
	LLMProxy                     string
	LLMModel                     string
	LLMMaxTokens                 int
	LLMTemperature               float64
	MailDriver                   string
	MailFromName                 string
	MailFromAddr                 string
	SMTPHost                     string
	SMTPPort                     int
	SMTPUser                     string
	SMTPPassword                 string
	SMTPSecure                   string
	SessionSecret                string
	AnalyticsHashKey             string
	RecognitionHMACSecret        string
	RecognitionCredPrefix        string
	ColumnWalineServerURL        string
	ColumnWalineSSOSecret        string
	ColumnWalineAllowedRedirects []string
	QQAppID                      string
	QQAppSecret                  string
	QQRedirectURI                string
	DiscordClientID              string
	DiscordClientSecret          string
	DiscordRedirectURI           string
	BangumiClientID              string
	BangumiClientSecret          string
	BangumiRedirectURI           string
	BangumiOAuthURL              string
	BangumiAPIURL                string
	BangumiTokenKey              string
	PicUIEnabled                 bool
	PicUIToken                   string
	PicUIAPIURL                  string
	PicUIAllowedHosts            []string
	PicUITimeout                 int
	PicUIPermission              int
	PicUIFallbackLocal           bool
	SessionLifetime              int
	SessionCookieDomain          string
	SessionCookieSecure          bool
	LegacyPHPUpstream            string
	LegacyAuthEnabled            bool
}

func Load(root string) (Config, error) {
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			return Config{}, fmt.Errorf("resolve project root: %w", err)
		}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return Config{}, fmt.Errorf("resolve project root: %w", err)
	}

	driver := strings.ToLower(envString("DB_DRIVER", "sqlite"))
	if driver != "sqlite" && driver != "mysql" {
		return Config{}, fmt.Errorf("DB_DRIVER must be sqlite or mysql, got %q", driver)
	}

	port, err := envInt("DB_PORT", 3306)
	if err != nil || port < 1 || port > 65535 {
		return Config{}, fmt.Errorf("DB_PORT must be a valid TCP port")
	}
	lifetime, err := envInt("SESSION_LIFETIME", 604800)
	if err != nil || lifetime <= 0 {
		return Config{}, fmt.Errorf("SESSION_LIFETIME must be positive")
	}
	smtpPort, err := envInt("SMTP_PORT", 465)
	if err != nil || smtpPort < 1 || smtpPort > 65535 {
		return Config{}, fmt.Errorf("SMTP_PORT must be a valid TCP port")
	}

	siteURL := envString("SITE_URL", "http://localhost:8080")
	llmProvider := strings.ToLower(envString("LLM_PROVIDER", "deepseek"))
	if llmProvider != "deepseek" && llmProvider != "openai" && llmProvider != "claude" {
		llmProvider = "deepseek"
	}
	llmAPIURL := strings.TrimSpace(os.Getenv("LLM_API_URL"))
	if llmAPIURL == "" {
		llmAPIURL = map[string]string{
			"openai":   "https://api.openai.com/v1/chat/completions",
			"claude":   "https://api.anthropic.com/v1/messages",
			"deepseek": "https://api.deepseek.com/v1/chat/completions",
		}[llmProvider]
	}
	cfg := Config{
		Root:                         root,
		Environment:                  strings.ToLower(envString("APP_ENV", "development")),
		AppAddr:                      envString("APP_ADDR", ":8080"),
		SiteURL:                      siteURL,
		DBDriver:                     driver,
		DBPath:                       envString("DB_PATH", filepath.Join(root, "data", "galgame.db")),
		DBHost:                       envString("DB_HOST", "127.0.0.1"),
		DBPort:                       port,
		DBName:                       envString("DB_NAME", "www_test_map_vnf"),
		DBUser:                       envString("DB_USER", "www_test_map_vnf"),
		DBPassword:                   os.Getenv("DB_PASS"),
		DataDir:                      envString("DATA_DIR", filepath.Join(root, "data")),
		UploadDir:                    envString("UPLOAD_DIR", filepath.Join(root, "uploads")),
		WikiUploadDir:                envString("WIKI_UPLOAD_DIR", filepath.Join(root, "wiki", "uploads")),
		AdminToken:                   os.Getenv("ADMIN_TOKEN"),
		BotAPIKey:                    os.Getenv("BOT_API_KEY"),
		QuizAPIKey:                   os.Getenv("QUIZ_API_KEY"),
		QuizLinkSecret:               os.Getenv("QUIZ_LINK_SECRET"),
		VNDBAPIURL:                   envString("VNDB_API_URL", "https://api.vndb.org/kana"),
		MakoQuizURL:                  envString("MAKOQUIZ_URL", "http://127.0.0.1:3001"),
		LLMEnabled:                   envBool("LLM_ENABLED", false),
		LLMProvider:                  llmProvider,
		LLMAPIKey:                    os.Getenv("LLM_API_KEY"),
		LLMAPIURL:                    llmAPIURL,
		LLMProxy:                     strings.TrimSpace(os.Getenv("LLM_PROXY")),
		LLMModel:                     envString("LLM_MODEL", map[string]string{"openai": "gpt-4o-mini", "claude": "claude-sonnet-4-20250514", "deepseek": "deepseek-chat"}[llmProvider]),
		LLMMaxTokens:                 envIntDefault("LLM_MAX_TOKENS", 2048, 256, 16384),
		LLMTemperature:               envFloatDefault("LLM_TEMPERATURE", 0.7, 0, 2),
		MailDriver:                   envString("MAIL_DRIVER", "mail"),
		MailFromName:                 envString("MAIL_FROM_NAME", "地图"),
		MailFromAddr:                 envString("MAIL_FROM_ADDR", "noreply@localhost"),
		SMTPHost:                     strings.TrimSpace(os.Getenv("SMTP_HOST")),
		SMTPPort:                     smtpPort,
		SMTPUser:                     strings.TrimSpace(os.Getenv("SMTP_USER")),
		SMTPPassword:                 os.Getenv("SMTP_PASS"),
		SMTPSecure:                   envString("SMTP_SECURE", "ssl"),
		SessionSecret:                os.Getenv("SESSION_SECRET"),
		AnalyticsHashKey:             envString("ANALYTICS_HASH_KEY", os.Getenv("SESSION_SECRET")),
		RecognitionHMACSecret:        os.Getenv("RECOGNITION_HMAC_SECRET"),
		RecognitionCredPrefix:        envString("RECOGNITION_CRED_PREFIX", "VNF-CRED-"),
		ColumnWalineServerURL:        strings.TrimRight(os.Getenv("COLUMN_WALINE_SERVER_URL"), "/"),
		ColumnWalineSSOSecret:        os.Getenv("COLUMN_WALINE_SSO_SECRET"),
		ColumnWalineAllowedRedirects: splitCSV(os.Getenv("COLUMN_WALINE_ALLOWED_REDIRECTS")),
		QQAppID:                      strings.TrimSpace(os.Getenv("QQ_APPID")),
		QQAppSecret:                  os.Getenv("QQ_APPSECRET"),
		QQRedirectURI:                strings.TrimSpace(os.Getenv("QQ_REDIRECT_URI")),
		DiscordClientID:              strings.TrimSpace(os.Getenv("DISCORD_CLIENT_ID")),
		DiscordClientSecret:          os.Getenv("DISCORD_CLIENT_SECRET"),
		DiscordRedirectURI:           strings.TrimSpace(os.Getenv("DISCORD_REDIRECT_URI")),
		BangumiClientID:              strings.TrimSpace(os.Getenv("BANGUMI_CLIENT_ID")),
		BangumiClientSecret:          os.Getenv("BANGUMI_CLIENT_SECRET"),
		BangumiRedirectURI:           strings.TrimSpace(os.Getenv("BANGUMI_REDIRECT_URI")),
		BangumiOAuthURL:              strings.TrimRight(envString("BANGUMI_OAUTH_URL", "https://bgm.tv"), "/"),
		BangumiAPIURL:                strings.TrimRight(envString("BANGUMI_API_URL", "https://api.bgm.tv"), "/"),
		BangumiTokenKey:              os.Getenv("BANGUMI_TOKEN_ENCRYPTION_KEY"),
		PicUIEnabled:                 envBool("PICUI_ENABLED", false),
		PicUIToken:                   os.Getenv("PICUI_TOKEN"),
		PicUIAPIURL:                  strings.TrimRight(envString("PICUI_API_URL", "https://picui.cn/api/v1"), "/"),
		PicUIAllowedHosts:            splitCSV(envString("PICUI_ALLOWED_HOSTS", "picui.cn,www.picui.cn,free.picui.cn")),
		PicUITimeout:                 envIntDefault("PICUI_TIMEOUT", 30, 5, 60),
		PicUIPermission:              envIntDefault("PICUI_PERMISSION", 1, 0, 9),
		PicUIFallbackLocal:           envBool("PICUI_FALLBACK_LOCAL", true),
		SessionLifetime:              lifetime,
		SessionCookieDomain:          os.Getenv("SESSION_COOKIE_DOMAIN"),
		SessionCookieSecure:          envBool("SESSION_COOKIE_SECURE", strings.HasPrefix(strings.ToLower(siteURL), "https://")),
		LegacyPHPUpstream:            strings.TrimRight(os.Getenv("LEGACY_PHP_UPSTREAM"), "/"),
		LegacyAuthEnabled:            envBool("LEGACY_AUTH_ENABLED", true),
	}
	return cfg, nil
}

// ValidateProduction is intentionally read-only. It is used by the server and
// the migration CLI before a cutover; errors contain variable names only and
// never include secret values.
func (c Config) ValidateProduction() error {
	if c.Environment != "production" {
		return nil
	}
	missing := []string{}
	if c.DBDriver != "mysql" {
		missing = append(missing, "DB_DRIVER=mysql")
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(c.SiteURL)), "https://") {
		missing = append(missing, "SITE_URL=https://...")
	}
	for name, value := range map[string]string{
		"DB_HOST": c.DBHost, "DB_NAME": c.DBName, "DB_USER": c.DBUser,
		"SESSION_SECRET": c.SessionSecret, "ADMIN_TOKEN": c.AdminToken,
		"RECOGNITION_HMAC_SECRET": c.RecognitionHMACSecret,
	} {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if c.MailDriver == "smtp" && (c.SMTPHost == "" || c.SMTPUser == "" || c.SMTPPassword == "") {
		missing = append(missing, "SMTP_HOST/SMTP_USER/SMTP_PASS")
	}
	if c.PicUIEnabled && strings.TrimSpace(c.PicUIToken) == "" {
		missing = append(missing, "PICUI_TOKEN")
	}
	if c.LLMEnabled && strings.TrimSpace(c.LLMAPIKey) == "" {
		missing = append(missing, "LLM_API_KEY")
	}
	if c.QQAppID != "" || c.QQAppSecret != "" || c.QQRedirectURI != "" {
		if c.QQAppID == "" || c.QQAppSecret == "" || c.QQRedirectURI == "" {
			missing = append(missing, "QQ_APPID/QQ_APPSECRET/QQ_REDIRECT_URI")
		}
	}
	if c.DiscordClientID != "" || c.DiscordClientSecret != "" || c.DiscordRedirectURI != "" {
		if c.DiscordClientID == "" || c.DiscordClientSecret == "" || c.DiscordRedirectURI == "" {
			missing = append(missing, "DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET/DISCORD_REDIRECT_URI")
		}
	}
	if c.BangumiClientID != "" || c.BangumiClientSecret != "" || c.BangumiRedirectURI != "" || c.BangumiTokenKey != "" {
		if c.BangumiClientID == "" || c.BangumiClientSecret == "" || c.BangumiRedirectURI == "" || c.BangumiTokenKey == "" {
			missing = append(missing, "BANGUMI_CLIENT_ID/BANGUMI_CLIENT_SECRET/BANGUMI_REDIRECT_URI/BANGUMI_TOKEN_ENCRYPTION_KEY")
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("production configuration incomplete: %s", strings.Join(missing, ", "))
	}
	return nil
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	return strconv.Atoi(value)
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envIntDefault(key string, fallback, min, max int) int {
	value, err := envInt(key, fallback)
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}

func envFloatDefault(key string, fallback, min, max float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || parsed < min || parsed > max {
		return fallback
	}
	return parsed
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}
