package sqlstore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

type Migration struct {
	Version int
	Name    string
	Apply   func(context.Context, *sql.Tx) error
}

type Snapshot struct {
	GeneratedAt  string         `json:"generated_at"`
	Driver       string         `json:"driver"`
	SchemaSHA256 string         `json:"schema_sha256"`
	Tables       []TableSummary `json:"tables"`
}

type TableSummary struct {
	Name        string           `json:"name"`
	RowCount    int64            `json:"row_count"`
	Columns     []ColumnSummary  `json:"columns"`
	Indexes     []IndexSummary   `json:"indexes"`
	ForeignKeys []ForeignKeyInfo `json:"foreign_keys"`
}

type ColumnSummary struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Default  any    `json:"default"`
	Extra    string `json:"extra,omitempty"`
	Ordinal  int    `json:"ordinal"`
}

type IndexSummary struct {
	Name    string   `json:"name"`
	Unique  bool     `json:"unique"`
	Columns []string `json:"columns"`
}

type ForeignKeyInfo struct {
	Name      string `json:"name,omitempty"`
	Column    string `json:"column"`
	RefTable  string `json:"ref_table"`
	RefColumn string `json:"ref_column"`
	OnUpdate  string `json:"on_update,omitempty"`
	OnDelete  string `json:"on_delete,omitempty"`
}

func Migrations(db *DB) []Migration {
	return []Migration{
		{
			Version: 1,
			Name:    "backend migration metadata",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS vnfest_schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    applied_at DATETIME NOT NULL
                )`
				_, err := tx.ExecContext(ctx, query)
				return err
			},
		},
		{
			Version: 2,
			Name:    "PHP session bridge",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS vnfest_session_bridge (
                    session_id VARCHAR(128) PRIMARY KEY,
                    user_id INT NULL,
                    payload_json TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    is_valid TINYINT NOT NULL DEFAULT 1,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    INDEX idx_vnfest_session_bridge_user (user_id),
                    INDEX idx_vnfest_session_bridge_expiry (expires_at),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                )`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS vnfest_session_bridge (
                        session_id TEXT PRIMARY KEY,
                        user_id INTEGER NULL,
                        payload_json TEXT NOT NULL,
                        expires_at DATETIME NOT NULL,
                        is_valid INTEGER NOT NULL DEFAULT 1,
                        created_at DATETIME NOT NULL,
                        updated_at DATETIME NOT NULL,
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                    )`
				}
				if _, err := tx.ExecContext(ctx, query); err != nil {
					return err
				}
				for _, indexQuery := range []string{
					"CREATE INDEX IF NOT EXISTS idx_vnfest_session_bridge_user ON vnfest_session_bridge(user_id)",
					"CREATE INDEX IF NOT EXISTS idx_vnfest_session_bridge_expiry ON vnfest_session_bridge(expires_at)",
				} {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && db.Driver == "mysql" && !strings.Contains(strings.ToLower(err.Error()), "duplicate") {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 3,
			Name:    "posts, follows, and direct-message compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				statements := []string{
					`CREATE TABLE IF NOT EXISTS posts (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        author_id INT NOT NULL,
                        club_id INT NULL,
                        club_country VARCHAR(20) NULL,
                        content TEXT NOT NULL,
                        images_json TEXT NOT NULL,
                        reply_to_id INT NULL,
                        quoted_post_id INT NULL,
                        status VARCHAR(20) NOT NULL DEFAULT 'published',
                        like_count INT NOT NULL DEFAULT 0,
                        reply_count INT NOT NULL DEFAULT 0,
                        repost_count INT NOT NULL DEFAULT 0,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        deleted_at DATETIME NULL,
                        INDEX idx_posts_listing (status, id),
                        INDEX idx_posts_author (author_id, status, id),
                        INDEX idx_posts_reply (reply_to_id, status, id),
                        INDEX idx_posts_quoted (quoted_post_id),
                        CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES users(id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS post_likes (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        post_id INT NOT NULL,
                        user_id INT NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE KEY uk_post_like (post_id, user_id),
                        CONSTRAINT fk_post_like_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
                        CONSTRAINT fk_post_like_user FOREIGN KEY (user_id) REFERENCES users(id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS post_attachments (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        uploader_id INT NOT NULL,
                        post_id INT NULL,
                        upload_token VARCHAR(64) NOT NULL,
                        relative_path VARCHAR(500) NOT NULL,
                        mime_type VARCHAR(80) NOT NULL,
                        width INT NOT NULL DEFAULT 0,
                        height INT NOT NULL DEFAULT 0,
                        file_size INT NOT NULL DEFAULT 0,
                        original_name VARCHAR(255) NOT NULL DEFAULT '',
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        INDEX idx_post_attachment_upload (uploader_id, upload_token, post_id),
                        INDEX idx_post_attachment_post (post_id),
                        CONSTRAINT fk_post_attachment_uploader FOREIGN KEY (uploader_id) REFERENCES users(id),
                        CONSTRAINT fk_post_attachment_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS user_follows (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        follower_id INT NOT NULL,
                        following_id INT NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE KEY uk_user_follow (follower_id, following_id),
                        INDEX idx_user_follow_following (following_id),
                        CONSTRAINT fk_user_follow_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
                        CONSTRAINT fk_user_follow_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS dm_conversations (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        user_a_id INT NOT NULL,
                        user_b_id INT NOT NULL,
                        last_message_id INT NULL,
                        last_message_at DATETIME NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE KEY uk_dm_conversation_pair (user_a_id, user_b_id),
                        INDEX idx_dm_conversation_a (user_a_id, last_message_at),
                        INDEX idx_dm_conversation_b (user_b_id, last_message_at),
                        CONSTRAINT fk_dm_conv_a FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
                        CONSTRAINT fk_dm_conv_b FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS dm_messages (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        conversation_id INT NOT NULL,
                        sender_id INT NOT NULL,
                        content TEXT NOT NULL,
                        images_json TEXT NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        read_at DATETIME NULL,
                        INDEX idx_dm_message_thread (conversation_id, id),
                        INDEX idx_dm_message_unread (conversation_id, read_at),
                        CONSTRAINT fk_dm_message_conversation FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
                        CONSTRAINT fk_dm_message_sender FOREIGN KEY (sender_id) REFERENCES users(id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS posts (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            author_id INTEGER NOT NULL REFERENCES users(id),
                            club_id INTEGER NULL,
                            club_country TEXT NULL,
                            content TEXT NOT NULL,
                            images_json TEXT NOT NULL DEFAULT '[]',
                            reply_to_id INTEGER NULL REFERENCES posts(id),
                            quoted_post_id INTEGER NULL REFERENCES posts(id),
                            status TEXT NOT NULL DEFAULT 'published',
                            like_count INTEGER NOT NULL DEFAULT 0,
                            reply_count INTEGER NOT NULL DEFAULT 0,
                            repost_count INTEGER NOT NULL DEFAULT 0,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            deleted_at TEXT NULL
                        )`,
						`CREATE TABLE IF NOT EXISTS post_likes (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                            user_id INTEGER NOT NULL REFERENCES users(id),
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )`,
						`CREATE TABLE IF NOT EXISTS post_attachments (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            uploader_id INTEGER NOT NULL REFERENCES users(id),
                            post_id INTEGER NULL REFERENCES posts(id) ON DELETE SET NULL,
                            upload_token TEXT NOT NULL,
                            relative_path TEXT NOT NULL,
                            mime_type TEXT NOT NULL,
                            width INTEGER NOT NULL DEFAULT 0,
                            height INTEGER NOT NULL DEFAULT 0,
                            file_size INTEGER NOT NULL DEFAULT 0,
                            original_name TEXT NOT NULL DEFAULT '',
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )`,
						`CREATE TABLE IF NOT EXISTS user_follows (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )`,
						`CREATE TABLE IF NOT EXISTS dm_conversations (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            last_message_id INTEGER NULL,
                            last_message_at TEXT NULL,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )`,
						`CREATE TABLE IF NOT EXISTS dm_messages (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
                            sender_id INTEGER NOT NULL REFERENCES users(id),
                            content TEXT NOT NULL,
                            images_json TEXT NOT NULL DEFAULT '[]',
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            read_at TEXT NULL
                        )`,
						`CREATE INDEX IF NOT EXISTS idx_posts_listing ON posts(status, id)`,
						`CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, status, id)`,
						`CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts(reply_to_id, status, id)`,
						`CREATE INDEX IF NOT EXISTS idx_posts_quoted ON posts(quoted_post_id)`,
						`CREATE UNIQUE INDEX IF NOT EXISTS idx_post_like_unique ON post_likes(post_id, user_id)`,
						`CREATE INDEX IF NOT EXISTS idx_post_attachment_upload ON post_attachments(uploader_id, upload_token, post_id)`,
						`CREATE INDEX IF NOT EXISTS idx_post_attachment_post ON post_attachments(post_id)`,
						`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follow_unique ON user_follows(follower_id, following_id)`,
						`CREATE INDEX IF NOT EXISTS idx_user_follow_following ON user_follows(following_id)`,
						`CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_conversation_pair ON dm_conversations(user_a_id, user_b_id)`,
						`CREATE INDEX IF NOT EXISTS idx_dm_message_thread ON dm_messages(conversation_id, id)`,
						`CREATE INDEX IF NOT EXISTS idx_dm_message_unread ON dm_messages(conversation_id, read_at)`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				// These two columns were added after the original PHP posts schema
				// shipped. CREATE TABLE IF NOT EXISTS cannot repair an existing
				// production table, so make the additive repair explicit and
				// idempotent. No existing value is rewritten.
				for _, column := range []struct {
					table, name, mysql, sqlite string
				}{
					{"dm_messages", "images_json", "ALTER TABLE dm_messages ADD COLUMN images_json TEXT NOT NULL", "ALTER TABLE dm_messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'"},
					{"users", "banner_url", "ALTER TABLE users ADD COLUMN banner_url VARCHAR(500) NOT NULL DEFAULT ''", "ALTER TABLE users ADD COLUMN banner_url TEXT NOT NULL DEFAULT ''"},
				} {
					exists, err := columnExistsTx(ctx, tx, db.Driver, column.table, column.name)
					if err != nil {
						return err
					}
					if exists {
						continue
					}
					query := column.sqlite
					if db.Driver == "mysql" {
						query = column.mysql
					}
					if _, err := tx.ExecContext(ctx, query); err != nil {
						return fmt.Errorf("add %s.%s: %w", column.table, column.name, err)
					}
				}
				return nil
			},
		},
		{
			Version: 4,
			Name:    "Bangumi OAuth binding compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS bangumi_bindings (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    vnfmap_user_id INT NOT NULL,
                    bangumi_user_id BIGINT NOT NULL,
                    bangumi_username VARCHAR(255) NOT NULL,
                    bangumi_nickname VARCHAR(255) NOT NULL DEFAULT '',
                    access_token_ciphertext TEXT NOT NULL,
                    refresh_token_ciphertext TEXT NOT NULL,
                    token_expires_at DATETIME NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_bangumi_vnfmap_user (vnfmap_user_id),
                    UNIQUE KEY uq_bangumi_user (bangumi_user_id),
                    CONSTRAINT fk_bangumi_vnfmap_user FOREIGN KEY (vnfmap_user_id) REFERENCES users(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS bangumi_bindings (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        vnfmap_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                        bangumi_user_id INTEGER NOT NULL UNIQUE,
                        bangumi_username TEXT NOT NULL,
                        bangumi_nickname TEXT NOT NULL DEFAULT '',
                        access_token_ciphertext TEXT NOT NULL,
                        refresh_token_ciphertext TEXT NOT NULL,
                        token_expires_at TEXT,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )`
				}
				_, err := tx.ExecContext(ctx, query)
				return err
			},
		},
		{
			Version: 5,
			Name:    "club verification code compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS club_verification_codes (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    club_id INT NOT NULL,
                    code VARCHAR(255) NOT NULL,
                    created_by INT NOT NULL,
                    max_uses INT NOT NULL DEFAULT 50,
                    use_count INT NOT NULL DEFAULT 0,
                    expires_at DATETIME NULL,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    country VARCHAR(20) NOT NULL DEFAULT 'china',
                    INDEX idx_verify_codes_club (club_id),
                    INDEX idx_verify_codes_code (code),
                    CONSTRAINT fk_verify_codes_creator FOREIGN KEY (created_by) REFERENCES users(id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS club_verification_codes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        club_id INTEGER NOT NULL,
                        code TEXT NOT NULL,
                        created_by INTEGER NOT NULL REFERENCES users(id),
                        max_uses INTEGER NOT NULL DEFAULT 50,
                        use_count INTEGER NOT NULL DEFAULT 0,
                        expires_at TEXT,
                        is_active INTEGER NOT NULL DEFAULT 1,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        country TEXT NOT NULL DEFAULT 'china'
                    )`
				}
				if _, err := tx.ExecContext(ctx, query); err != nil {
					return err
				}
				indexes := []string{
					"CREATE INDEX IF NOT EXISTS idx_verify_codes_club ON club_verification_codes(club_id)",
					"CREATE INDEX IF NOT EXISTS idx_verify_codes_code ON club_verification_codes(code)",
				}
				for _, indexQuery := range indexes {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 6,
			Name:    "club comments and recommendations compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				statements := []string{
					`CREATE TABLE IF NOT EXISTS club_recommendations (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        club_id INT NOT NULL,
                        country VARCHAR(20) NOT NULL DEFAULT 'china',
                        bangumi_id INT NOT NULL,
                        title VARCHAR(255) NOT NULL,
                        image_url VARCHAR(500) NOT NULL DEFAULT '',
                        rating DECIMAL(3,1) NOT NULL DEFAULT 0,
                        summary TEXT,
                        sort_order INT NOT NULL DEFAULT 0,
                        created_by INT NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        INDEX idx_recommendations_club (club_id, sort_order),
                        CONSTRAINT fk_recommendations_creator FOREIGN KEY (created_by) REFERENCES users(id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS club_comments (
                        id INT PRIMARY KEY AUTO_INCREMENT,
                        club_id INT NOT NULL,
                        country VARCHAR(20) NOT NULL DEFAULT 'china',
                        user_id INT NOT NULL,
                        content TEXT NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME NULL,
                        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
                        INDEX idx_comments_club (club_id, created_at),
                        CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS club_recommendations (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            club_id INTEGER NOT NULL,
                            country TEXT NOT NULL DEFAULT 'china',
                            bangumi_id INTEGER NOT NULL,
                            title TEXT NOT NULL,
                            image_url TEXT NOT NULL DEFAULT '',
                            rating REAL NOT NULL DEFAULT 0,
                            summary TEXT NOT NULL DEFAULT '',
                            sort_order INTEGER NOT NULL DEFAULT 0,
                            created_by INTEGER NOT NULL REFERENCES users(id),
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )`,
						`CREATE TABLE IF NOT EXISTS club_comments (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            club_id INTEGER NOT NULL,
                            country TEXT NOT NULL DEFAULT 'china',
                            user_id INTEGER NOT NULL REFERENCES users(id),
                            content TEXT NOT NULL,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            updated_at TEXT,
                            is_deleted INTEGER NOT NULL DEFAULT 0
                        )`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				for _, indexQuery := range []string{
					"CREATE INDEX IF NOT EXISTS idx_recommendations_club ON club_recommendations(club_id, sort_order)",
					"CREATE INDEX IF NOT EXISTS idx_comments_club ON club_comments(club_id, created_at)",
				} {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 7,
			Name:    "club moe king compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS club_moe_kings (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    club_id INT NOT NULL,
                    country VARCHAR(20) NOT NULL DEFAULT 'china',
                    character_id INT NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    name_cn VARCHAR(255) NOT NULL DEFAULT '',
                    image_url VARCHAR(500) NOT NULL DEFAULT '',
                    summary TEXT,
                    updated_by INT NOT NULL,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_moe_king_club (club_id, country),
                    INDEX idx_moe_kings_club (club_id, country),
                    CONSTRAINT fk_moe_king_updater FOREIGN KEY (updated_by) REFERENCES users(id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS club_moe_kings (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        club_id INTEGER NOT NULL,
                        country TEXT NOT NULL DEFAULT 'china',
                        character_id INTEGER NOT NULL,
                        name TEXT NOT NULL,
                        name_cn TEXT NOT NULL DEFAULT '',
                        image_url TEXT NOT NULL DEFAULT '',
                        summary TEXT NOT NULL DEFAULT '',
                        updated_by INTEGER NOT NULL REFERENCES users(id),
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(club_id, country)
                    )`
				}
				if _, err := tx.ExecContext(ctx, query); err != nil {
					return err
				}
				indexQuery := "CREATE INDEX IF NOT EXISTS idx_moe_kings_club ON club_moe_kings(club_id, country)"
				if db.Driver == "mysql" {
					indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
				}
				if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
					return err
				}
				return nil
			},
		},
		{
			Version: 8,
			Name:    "privacy preserving analytics compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				statements := []string{
					`CREATE TABLE IF NOT EXISTS analytics_pageviews (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        event_id CHAR(36) NOT NULL UNIQUE,
                        visitor_hash CHAR(64) NOT NULL,
                        page_path VARCHAR(512) NOT NULL,
                        page_title VARCHAR(255) NOT NULL DEFAULT '',
                        source_category VARCHAR(32) NOT NULL DEFAULT 'external',
                        referrer_host VARCHAR(255) NOT NULL DEFAULT '',
                        device_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
                        browser_name VARCHAR(32) NOT NULL DEFAULT 'other',
                        is_authenticated TINYINT(1) NOT NULL DEFAULT 0,
                        day_key DATE NOT NULL,
                        created_at DATETIME NOT NULL,
                        INDEX idx_analytics_day (day_key),
                        INDEX idx_analytics_created (created_at),
                        INDEX idx_analytics_visitor_day (visitor_hash, day_key),
                        INDEX idx_analytics_page_day (page_path(191), day_key)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS analytics_historical_pv (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        day_key DATE NOT NULL,
                        page_path VARCHAR(512) NOT NULL,
                        page_title VARCHAR(255) NOT NULL DEFAULT '',
                        source_category VARCHAR(32) NOT NULL DEFAULT 'external',
                        referrer_host VARCHAR(255) NOT NULL DEFAULT '',
                        device_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
                        browser_name VARCHAR(32) NOT NULL DEFAULT 'other',
                        pv_count INT UNSIGNED NOT NULL DEFAULT 0,
                        imported_at DATETIME NOT NULL,
                        UNIQUE KEY uq_analytics_historical_dimension (day_key, page_path(191), source_category, referrer_host(191), device_type, browser_name),
                        INDEX idx_analytics_historical_day (day_key),
                        INDEX idx_analytics_historical_page_day (page_path(191), day_key)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS analytics_pageviews (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            event_id TEXT NOT NULL UNIQUE,
                            visitor_hash TEXT NOT NULL,
                            page_path TEXT NOT NULL,
                            page_title TEXT NOT NULL DEFAULT '',
                            source_category TEXT NOT NULL DEFAULT 'external',
                            referrer_host TEXT NOT NULL DEFAULT '',
                            device_type TEXT NOT NULL DEFAULT 'unknown',
                            browser_name TEXT NOT NULL DEFAULT 'other',
                            is_authenticated INTEGER NOT NULL DEFAULT 0,
                            day_key TEXT NOT NULL,
                            created_at TEXT NOT NULL
                        )`,
						`CREATE TABLE IF NOT EXISTS analytics_historical_pv (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            day_key TEXT NOT NULL,
                            page_path TEXT NOT NULL,
                            page_title TEXT NOT NULL DEFAULT '',
                            source_category TEXT NOT NULL DEFAULT 'external',
                            referrer_host TEXT NOT NULL DEFAULT '',
                            device_type TEXT NOT NULL DEFAULT 'unknown',
                            browser_name TEXT NOT NULL DEFAULT 'other',
                            pv_count INTEGER NOT NULL DEFAULT 0,
                            imported_at TEXT NOT NULL
                        )`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				indexes := []string{
					"CREATE INDEX IF NOT EXISTS idx_analytics_day ON analytics_pageviews(day_key)",
					"CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_pageviews(created_at)",
					"CREATE INDEX IF NOT EXISTS idx_analytics_visitor_day ON analytics_pageviews(visitor_hash, day_key)",
					"CREATE INDEX IF NOT EXISTS idx_analytics_page_day ON analytics_pageviews(page_path, day_key)",
					"CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_historical_dimension ON analytics_historical_pv(day_key, page_path, source_category, referrer_host, device_type, browser_name)",
					"CREATE INDEX IF NOT EXISTS idx_analytics_historical_day ON analytics_historical_pv(day_key)",
					"CREATE INDEX IF NOT EXISTS idx_analytics_historical_page_day ON analytics_historical_pv(page_path, day_key)",
				}
				for _, indexQuery := range indexes {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
						if strings.Contains(indexQuery, "analytics_pageviews(page_path,") {
							indexQuery = strings.Replace(indexQuery, "page_path,", "page_path(191),", 1)
						}
						if strings.Contains(indexQuery, "analytics_historical_pv(day_key, page_path,") {
							indexQuery = strings.Replace(indexQuery, "day_key, page_path,", "day_key, page_path(191),", 1)
						}
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 9,
			Name:    "recognition core compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				mysql := []string{
					`CREATE TABLE IF NOT EXISTS recognition_programs (id INT PRIMARY KEY AUTO_INCREMENT, club_id INT NOT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', type VARCHAR(30) NOT NULL DEFAULT 'assessment', title VARCHAR(255) NOT NULL, intro TEXT, participant_difficulty VARCHAR(20) NOT NULL DEFAULT 'normal', visibility VARCHAR(20) NOT NULL DEFAULT 'public', status VARCHAR(20) NOT NULL DEFAULT 'draft', capabilities TEXT NOT NULL, participation_rules TEXT, max_attempts INT NOT NULL DEFAULT 0, cooldown_minutes INT NOT NULL DEFAULT 0, open_at DATETIME NULL, close_at DATETIME NULL, max_issuance INT NOT NULL DEFAULT 0, credential_ttl_days INT NOT NULL DEFAULT 0, security_level VARCHAR(20) NOT NULL DEFAULT 'normal', created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_program_versions (id INT PRIMARY KEY AUTO_INCREMENT, program_id INT NOT NULL, version_no VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', content_snapshot MEDIUMTEXT NOT NULL, published_by INT NULL, published_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_ver (program_id, version_no), FOREIGN KEY (program_id) REFERENCES recognition_programs(id), FOREIGN KEY (published_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_badges (id INT PRIMARY KEY AUTO_INCREMENT, club_id INT NOT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', name VARCHAR(255) NOT NULL, category VARCHAR(30) NOT NULL DEFAULT 'participation', description TEXT, image_url VARCHAR(500) NOT NULL DEFAULT '', version INT NOT NULL DEFAULT 1, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_connectors (id INT PRIMARY KEY AUTO_INCREMENT, club_id INT NOT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', name VARCHAR(128) NOT NULL, type VARCHAR(40) NOT NULL DEFAULT 'webhook', token_prefix VARCHAR(16) NOT NULL, token_hash VARCHAR(128) NOT NULL, hmac_secret VARCHAR(255) NOT NULL DEFAULT '', scope TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL, revoked_at DATETIME NULL, FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_events (id INT PRIMARY KEY AUTO_INCREMENT, event_id VARCHAR(64) NOT NULL, idempotency_key VARCHAR(128) NOT NULL DEFAULT '', schema_version VARCHAR(10) NOT NULL DEFAULT '1.0', type VARCHAR(128) NOT NULL, club_id INT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', user_id INT NULL, program_id INT NULL, program_version_id INT NULL, badge_id INT NULL, connector_id INT NULL, occurred_at DATETIME NOT NULL, data TEXT, evidence_refs TEXT, source_verified TINYINT(1) NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'processed', error_message VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_evt_event (event_id), UNIQUE KEY uq_recog_evt_idem (idempotency_key), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id), FOREIGN KEY (connector_id) REFERENCES recognition_connectors(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_attempts (id INT PRIMARY KEY AUTO_INCREMENT, program_version_id INT NOT NULL, user_id INT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'created', score INT NULL, answers MEDIUMTEXT, attempt_no INT NOT NULL DEFAULT 1, started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at DATETIME NULL, UNIQUE KEY uq_recog_att_sess (program_version_id, user_id, attempt_no), FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_submissions (id INT PRIMARY KEY AUTO_INCREMENT, program_version_id INT NOT NULL, user_id INT NOT NULL, content TEXT, file_path VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(20) NOT NULL DEFAULT 'pending', reviewed_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_reviews (id INT PRIMARY KEY AUTO_INCREMENT, submission_id INT NOT NULL, reviewer_id INT NOT NULL, decision VARCHAR(20) NOT NULL, comment TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_rev (submission_id, reviewer_id), FOREIGN KEY (submission_id) REFERENCES recognition_submissions(id), FOREIGN KEY (reviewer_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_credentials (id INT PRIMARY KEY AUTO_INCREMENT, credential_uid VARCHAR(64) NOT NULL, holder_user_id INT NOT NULL, badge_id INT NOT NULL, badge_version INT NOT NULL DEFAULT 1, issuer_club_id INT NOT NULL, issuer_country VARCHAR(50) NOT NULL DEFAULT 'china', program_id INT NOT NULL, program_version_id INT NOT NULL, credential_type VARCHAR(30) NOT NULL DEFAULT 'participation', verification_level VARCHAR(30) NOT NULL DEFAULT 'auto', status VARCHAR(20) NOT NULL DEFAULT 'active', condition_snapshot TEXT, evidence_refs TEXT, public_visibility TINYINT(1) NOT NULL DEFAULT 1, issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NULL, revocation_reason VARCHAR(255) NULL, revoked_at DATETIME NULL, revoked_by INT NULL, superseded_by INT NULL, active_key VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN status='active' THEN CONCAT(program_version_id, ':', holder_user_id, ':', badge_id) ELSE NULL END) STORED, UNIQUE KEY uq_recog_cred_uid (credential_uid), UNIQUE KEY uq_recog_cred_active (active_key), FOREIGN KEY (holder_user_id) REFERENCES users(id), FOREIGN KEY (badge_id) REFERENCES recognition_badges(id), FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_outbox (id INT PRIMARY KEY AUTO_INCREMENT, task_type VARCHAR(40) NOT NULL, payload TEXT, status VARCHAR(20) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, last_error VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_identity_links (id INT PRIMARY KEY AUTO_INCREMENT, external_provider VARCHAR(40) NOT NULL, external_subject_id VARCHAR(191) NOT NULL, vnfmap_user_id INT NULL, verification_status VARCHAR(20) NOT NULL DEFAULT 'pending', linked_at DATETIME NULL, revoked_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_idl_active (external_provider, external_subject_id), FOREIGN KEY (vnfmap_user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_claim_codes (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(32) NOT NULL, program_id INT NOT NULL, program_version_id INT NOT NULL, badge_id INT NOT NULL, redeemed_by INT NULL, redeemed_at DATETIME NULL, expires_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_claim_code (code), FOREIGN KEY (program_version_id) REFERENCES recognition_program_versions(id), FOREIGN KEY (redeemed_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS recognition_club_roles (id INT PRIMARY KEY AUTO_INCREMENT, club_id INT NOT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', user_id INT NOT NULL, role VARCHAR(30) NOT NULL, granted_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_recog_role (club_id, country, user_id, role), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (granted_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				sqlite := []string{
					`CREATE TABLE IF NOT EXISTS recognition_programs (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', type TEXT NOT NULL DEFAULT 'assessment', title TEXT NOT NULL, intro TEXT, participant_difficulty TEXT NOT NULL DEFAULT 'normal', visibility TEXT NOT NULL DEFAULT 'public', status TEXT NOT NULL DEFAULT 'draft', capabilities TEXT NOT NULL, participation_rules TEXT, max_attempts INTEGER NOT NULL DEFAULT 0, cooldown_minutes INTEGER NOT NULL DEFAULT 0, open_at TEXT, close_at TEXT, max_issuance INTEGER NOT NULL DEFAULT 0, credential_ttl_days INTEGER NOT NULL DEFAULT 0, security_level TEXT NOT NULL DEFAULT 'normal', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_program_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id INTEGER NOT NULL REFERENCES recognition_programs(id), version_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', content_snapshot TEXT NOT NULL, published_by INTEGER REFERENCES users(id), published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(program_id, version_no))`,
					`CREATE TABLE IF NOT EXISTS recognition_badges (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'participation', description TEXT, image_url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_connectors (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'webhook', token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL, hmac_secret TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, revoked_at TEXT)`,
					`CREATE TABLE IF NOT EXISTS recognition_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL DEFAULT '' UNIQUE, schema_version TEXT NOT NULL DEFAULT '1.0', type TEXT NOT NULL, club_id INTEGER, country TEXT NOT NULL DEFAULT 'china', user_id INTEGER REFERENCES users(id), program_id INTEGER, program_version_id INTEGER REFERENCES recognition_program_versions(id), badge_id INTEGER, connector_id INTEGER REFERENCES recognition_connectors(id), occurred_at TEXT NOT NULL, data TEXT, evidence_refs TEXT, source_verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'processed', error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id), user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'created', score INTEGER, answers TEXT, attempt_no INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, UNIQUE(program_version_id, user_id, attempt_no))`,
					`CREATE TABLE IF NOT EXISTS recognition_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id), user_id INTEGER NOT NULL REFERENCES users(id), content TEXT, file_path TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL REFERENCES recognition_submissions(id), reviewer_id INTEGER NOT NULL REFERENCES users(id), decision TEXT NOT NULL, comment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(submission_id, reviewer_id))`,
					`CREATE TABLE IF NOT EXISTS recognition_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, credential_uid TEXT NOT NULL UNIQUE, holder_user_id INTEGER NOT NULL REFERENCES users(id), badge_id INTEGER NOT NULL REFERENCES recognition_badges(id), badge_version INTEGER NOT NULL DEFAULT 1, issuer_club_id INTEGER NOT NULL, issuer_country TEXT NOT NULL DEFAULT 'china', program_id INTEGER NOT NULL, program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id), credential_type TEXT NOT NULL DEFAULT 'participation', verification_level TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'active', condition_snapshot TEXT, evidence_refs TEXT, public_visibility INTEGER NOT NULL DEFAULT 1, issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, revocation_reason TEXT, revoked_at TEXT, revoked_by INTEGER, superseded_by INTEGER)`,
					`CREATE TABLE IF NOT EXISTS recognition_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, task_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT)`,
					`CREATE TABLE IF NOT EXISTS recognition_identity_links (id INTEGER PRIMARY KEY AUTOINCREMENT, external_provider TEXT NOT NULL, external_subject_id TEXT NOT NULL, vnfmap_user_id INTEGER REFERENCES users(id), verification_status TEXT NOT NULL DEFAULT 'pending', linked_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_claim_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, program_id INTEGER NOT NULL, program_version_id INTEGER NOT NULL REFERENCES recognition_program_versions(id), badge_id INTEGER NOT NULL, redeemed_by INTEGER REFERENCES users(id), redeemed_at TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS recognition_club_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, granted_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(club_id, country, user_id, role))`,
				}
				if db.Driver == "sqlite" {
					mysql = sqlite
				}
				for _, statement := range mysql {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				indexes := []string{
					"CREATE INDEX IF NOT EXISTS idx_recog_prog_club ON recognition_programs(club_id, country, status)", "CREATE INDEX IF NOT EXISTS idx_recog_prog_status ON recognition_programs(status)", "CREATE INDEX IF NOT EXISTS idx_recog_ver_prog ON recognition_program_versions(program_id, status)", "CREATE INDEX IF NOT EXISTS idx_recog_badge_club ON recognition_badges(club_id, country)", "CREATE INDEX IF NOT EXISTS idx_recog_conn_club ON recognition_connectors(club_id, country)", "CREATE INDEX IF NOT EXISTS idx_recog_conn_prefix ON recognition_connectors(token_prefix)", "CREATE INDEX IF NOT EXISTS idx_recog_evt_user ON recognition_events(user_id)", "CREATE INDEX IF NOT EXISTS idx_recog_evt_prog ON recognition_events(program_version_id)", "CREATE INDEX IF NOT EXISTS idx_recog_evt_type ON recognition_events(type)", "CREATE INDEX IF NOT EXISTS idx_recog_att_user ON recognition_attempts(user_id)", "CREATE INDEX IF NOT EXISTS idx_recog_att_status ON recognition_attempts(program_version_id, status)", "CREATE INDEX IF NOT EXISTS idx_recog_sub_prog_user ON recognition_submissions(program_version_id, user_id)", "CREATE INDEX IF NOT EXISTS idx_recog_sub_status ON recognition_submissions(status)", "CREATE INDEX IF NOT EXISTS idx_recog_rev_sub ON recognition_reviews(submission_id)", "CREATE INDEX IF NOT EXISTS idx_recog_cred_holder ON recognition_credentials(holder_user_id, status)", "CREATE INDEX IF NOT EXISTS idx_recog_cred_club ON recognition_credentials(issuer_club_id, issuer_country)", "CREATE INDEX IF NOT EXISTS idx_recog_cred_expires ON recognition_credentials(status, expires_at)", "CREATE INDEX IF NOT EXISTS idx_recog_outbox_status ON recognition_outbox(status)", "CREATE INDEX IF NOT EXISTS idx_recog_idl_user ON recognition_identity_links(vnfmap_user_id)", "CREATE INDEX IF NOT EXISTS idx_recog_claim_prog ON recognition_claim_codes(program_version_id)", "CREATE INDEX IF NOT EXISTS idx_recog_role_user ON recognition_club_roles(user_id)",
				}
				if db.Driver == "mysql" {
					for index := range indexes {
						indexes[index] = strings.Replace(indexes[index], " IF NOT EXISTS", "", 1)
					}
				}
				for _, indexQuery := range indexes {
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				if db.Driver == "sqlite" {
					if _, err := tx.ExecContext(ctx, "CREATE UNIQUE INDEX IF NOT EXISTS uq_recog_cred_active ON recognition_credentials(program_version_id, holder_user_id, badge_id) WHERE status='active'"); err != nil {
						return err
					}
					if _, err := tx.ExecContext(ctx, "CREATE UNIQUE INDEX IF NOT EXISTS uq_recog_idl_active ON recognition_identity_links(external_provider, external_subject_id) WHERE revoked_at IS NULL"); err != nil {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 10,
			Name:    "voting compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				statements := []string{
					`CREATE TABLE IF NOT EXISTS vote_projects (id INT PRIMARY KEY AUTO_INCREMENT, project_type VARCHAR(20) NOT NULL, club_id INT NOT NULL, country VARCHAR(20) NOT NULL DEFAULT 'china', title VARCHAR(255) NOT NULL, year_label VARCHAR(20) NOT NULL DEFAULT '', description TEXT, cover_url VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'draft', visibility VARCHAR(30) NOT NULL DEFAULT 'public', eligibility_mode VARCHAR(30) NOT NULL DEFAULT 'club_member', result_visibility VARCHAR(30) NOT NULL DEFAULT 'live_rank_only', config_json TEXT, share_token VARCHAR(40) NOT NULL DEFAULT '', guest_vote TINYINT(1) NOT NULL DEFAULT 0, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at DATETIME NULL, ended_at DATETIME NULL, FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_stages (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_type VARCHAR(30) NOT NULL, title VARCHAR(255) NOT NULL, sort_order INT NOT NULL DEFAULT 0, status VARCHAR(30) NOT NULL DEFAULT 'pending', starts_at DATETIME NULL, ends_at DATETIME NULL, vote_mode VARCHAR(30) NOT NULL DEFAULT 'multi_select', max_select INT NOT NULL DEFAULT 1, advance_count INT NOT NULL DEFAULT 0, group_count INT NOT NULL DEFAULT 1, score_min INT NOT NULL DEFAULT 1, score_max INT NOT NULL DEFAULT 10, allow_vote_change TINYINT(1) NOT NULL DEFAULT 0, result_visibility VARCHAR(30) NOT NULL DEFAULT 'live_rank_only', config_json TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES vote_projects(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_entries (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, source_type VARCHAR(40) NOT NULL DEFAULT 'manual', source_id VARCHAR(80) NOT NULL DEFAULT '', title VARCHAR(255) NOT NULL, title_cn VARCHAR(255) NOT NULL DEFAULT '', subtitle VARCHAR(255) NOT NULL DEFAULT '', image_url VARCHAR(500) NOT NULL DEFAULT '', summary TEXT, external_url VARCHAR(500) NOT NULL DEFAULT '', identity_key VARCHAR(500) NOT NULL, entry_status VARCHAR(30) NOT NULL DEFAULT 'pending', created_by INT NOT NULL, reviewed_by INT NULL, reviewed_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_entry_identity (project_id, identity_key), FOREIGN KEY (project_id) REFERENCES vote_projects(id), FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_nominations (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_id INT NULL, entry_id INT NOT NULL, user_id INT NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_nomination_user (project_id, entry_id, user_id), FOREIGN KEY (project_id) REFERENCES vote_projects(id), FOREIGN KEY (entry_id) REFERENCES vote_entries(id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_votes (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_id INT NOT NULL, entry_id INT NOT NULL, match_id INT NULL, user_id INT NULL, guest_key VARCHAR(64) NOT NULL DEFAULT '', vote_value INT NOT NULL DEFAULT 1, score_value INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES vote_projects(id), FOREIGN KEY (stage_id) REFERENCES vote_stages(id), FOREIGN KEY (entry_id) REFERENCES vote_entries(id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_stage_entries (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_id INT NOT NULL, entry_id INT NOT NULL, group_key VARCHAR(80) NOT NULL DEFAULT '', seed_no INT NOT NULL DEFAULT 0, source_stage_id INT NULL, source_result_rank INT NULL, status VARCHAR(30) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_stage_entry (stage_id, entry_id), FOREIGN KEY (project_id) REFERENCES vote_projects(id), FOREIGN KEY (stage_id) REFERENCES vote_stages(id), FOREIGN KEY (entry_id) REFERENCES vote_entries(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_matches (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_id INT NOT NULL, round_no INT NOT NULL DEFAULT 1, match_no INT NOT NULL DEFAULT 1, slot_a_entry_id INT NULL, slot_b_entry_id INT NULL, winner_entry_id INT NULL, status VARCHAR(30) NOT NULL DEFAULT 'pending', next_match_id INT NULL, next_slot VARCHAR(1) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (project_id) REFERENCES vote_projects(id), FOREIGN KEY (stage_id) REFERENCES vote_stages(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_results (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, stage_id INT NOT NULL, entry_id INT NOT NULL, rank_no INT NOT NULL DEFAULT 0, votes INT NOT NULL DEFAULT 0, score_avg DECIMAL(8,3) NULL, advanced TINYINT(1) NOT NULL DEFAULT 0, snapshot_json TEXT, settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_result (stage_id, entry_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS vote_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, project_type TEXT NOT NULL, club_id INTEGER NOT NULL, country TEXT NOT NULL DEFAULT 'china', title TEXT NOT NULL, year_label TEXT NOT NULL DEFAULT '', description TEXT, cover_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'public', eligibility_mode TEXT NOT NULL DEFAULT 'club_member', result_visibility TEXT NOT NULL DEFAULT 'live_rank_only', config_json TEXT, share_token TEXT NOT NULL DEFAULT '', guest_vote INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT, ended_at TEXT)`,
						`CREATE TABLE IF NOT EXISTS vote_stages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), stage_type TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', starts_at TEXT, ends_at TEXT, vote_mode TEXT NOT NULL DEFAULT 'multi_select', max_select INTEGER NOT NULL DEFAULT 1, advance_count INTEGER NOT NULL DEFAULT 0, group_count INTEGER NOT NULL DEFAULT 1, score_min INTEGER NOT NULL DEFAULT 1, score_max INTEGER NOT NULL DEFAULT 10, allow_vote_change INTEGER NOT NULL DEFAULT 0, result_visibility TEXT NOT NULL DEFAULT 'live_rank_only', config_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS vote_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), source_type TEXT NOT NULL DEFAULT 'manual', source_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, title_cn TEXT NOT NULL DEFAULT '', subtitle TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', summary TEXT, external_url TEXT NOT NULL DEFAULT '', identity_key TEXT NOT NULL, entry_status TEXT NOT NULL DEFAULT 'pending', created_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, identity_key))`,
						`CREATE TABLE IF NOT EXISTS vote_nominations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), stage_id INTEGER, entry_id INTEGER NOT NULL REFERENCES vote_entries(id), user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, entry_id, user_id))`,
						`CREATE TABLE IF NOT EXISTS vote_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), stage_id INTEGER NOT NULL REFERENCES vote_stages(id), entry_id INTEGER NOT NULL REFERENCES vote_entries(id), match_id INTEGER, user_id INTEGER REFERENCES users(id), guest_key TEXT NOT NULL DEFAULT '', vote_value INTEGER NOT NULL DEFAULT 1, score_value INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS vote_stage_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), stage_id INTEGER NOT NULL REFERENCES vote_stages(id), entry_id INTEGER NOT NULL REFERENCES vote_entries(id), group_key TEXT NOT NULL DEFAULT '', seed_no INTEGER NOT NULL DEFAULT 0, source_stage_id INTEGER, source_result_rank INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(stage_id, entry_id))`,
						`CREATE TABLE IF NOT EXISTS vote_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES vote_projects(id), stage_id INTEGER NOT NULL REFERENCES vote_stages(id), round_no INTEGER NOT NULL DEFAULT 1, match_no INTEGER NOT NULL DEFAULT 1, slot_a_entry_id INTEGER, slot_b_entry_id INTEGER, winner_entry_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', next_match_id INTEGER, next_slot TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS vote_results (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, rank_no INTEGER NOT NULL DEFAULT 0, votes INTEGER NOT NULL DEFAULT 0, score_avg REAL, advanced INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT, settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(stage_id, entry_id))`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				indexes := []string{"CREATE INDEX IF NOT EXISTS idx_vote_projects_public ON vote_projects(visibility,status,updated_at)", "CREATE INDEX IF NOT EXISTS idx_vote_projects_club ON vote_projects(club_id,country,project_type)", "CREATE INDEX IF NOT EXISTS idx_vote_stages_project ON vote_stages(project_id,sort_order)", "CREATE INDEX IF NOT EXISTS idx_vote_entries_project ON vote_entries(project_id,entry_status)", "CREATE INDEX IF NOT EXISTS idx_vote_votes_stage_user ON vote_votes(stage_id,user_id)", "CREATE INDEX IF NOT EXISTS idx_vote_votes_entry ON vote_votes(stage_id,entry_id)", "CREATE INDEX IF NOT EXISTS idx_vote_stage_entries_project ON vote_stage_entries(project_id,stage_id,status)", "CREATE INDEX IF NOT EXISTS idx_vote_matches_stage ON vote_matches(stage_id,round_no,match_no)"}
				for _, indexQuery := range indexes {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 11,
			Name:    "voting flow engine compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				// Existing deployments may have created the basic voting tables
				// through PHP with an older column set. Add only missing nullable or
				// defaulted columns; never rebuild or drop a business table.
				type repair struct{ table, column, definition string }
				repairs := []repair{
					{"vote_projects", "share_token", "VARCHAR(40) NOT NULL DEFAULT ''"},
					{"vote_projects", "guest_vote", "TINYINT NOT NULL DEFAULT 0"},
					{"vote_votes", "guest_key", "VARCHAR(64) NOT NULL DEFAULT ''"},
					{"vote_stage_entries", "group_key", "VARCHAR(80) NOT NULL DEFAULT ''"},
					{"vote_stage_entries", "seed_no", "INT NOT NULL DEFAULT 0"},
					{"vote_stage_entries", "source_stage_id", "INT NULL"},
					{"vote_stage_entries", "source_result_rank", "INT NULL"},
					{"vote_matches", "next_match_id", "INT NULL"},
					{"vote_matches", "next_slot", "VARCHAR(1) NOT NULL DEFAULT ''"},
				}
				if db.Driver == "sqlite" {
					for index := range repairs {
						repairs[index].definition = strings.ReplaceAll(repairs[index].definition, "VARCHAR", "TEXT")
						if strings.HasPrefix(repairs[index].definition, "TINYINT") {
							repairs[index].definition = strings.Replace(repairs[index].definition, "TINYINT", "INTEGER", 1)
						} else if strings.HasPrefix(repairs[index].definition, "INT") {
							repairs[index].definition = strings.Replace(repairs[index].definition, "INT", "INTEGER", 1)
						}
					}
				}
				for _, item := range repairs {
					exists, err := columnExistsTx(ctx, tx, db.Driver, item.table, item.column)
					if err != nil {
						return err
					}
					if !exists {
						if _, err := tx.ExecContext(ctx, "ALTER TABLE "+item.table+" ADD COLUMN "+item.column+" "+item.definition); err != nil {
							return fmt.Errorf("add %s.%s: %w", item.table, item.column, err)
						}
					}
				}
				statements := []string{
					`CREATE TABLE IF NOT EXISTS vote_flow_runs (id INT PRIMARY KEY AUTO_INCREMENT, project_id INT NOT NULL, version_no INT NOT NULL DEFAULT 1, status VARCHAR(30) NOT NULL DEFAULT 'active', created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at DATETIME NULL, snapshot_json TEXT, UNIQUE KEY uq_vote_flow_run_version (project_id,version_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_flow_pools (id INT PRIMARY KEY AUTO_INCREMENT, run_id INT NOT NULL, project_id INT NOT NULL, stage_id INT NOT NULL, stage_type VARCHAR(40) NOT NULL, title VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'draft', vote_mode VARCHAR(40) NOT NULL DEFAULT 'multi_select', group_count INT NOT NULL DEFAULT 1, max_select INT NOT NULL DEFAULT 1, advance_count INT NOT NULL DEFAULT 0, config_json TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, opened_at DATETIME NULL, settled_at DATETIME NULL, UNIQUE KEY uq_vote_flow_pool_stage (run_id,stage_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_flow_pool_entries (id INT PRIMARY KEY AUTO_INCREMENT, run_id INT NOT NULL, pool_id INT NOT NULL, project_id INT NOT NULL, entry_id INT NOT NULL, group_key VARCHAR(80) NOT NULL DEFAULT '', seed_no INT NOT NULL DEFAULT 0, source_pool_id INT NULL, source_rank INT NULL, status VARCHAR(30) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_flow_pool_entry (pool_id,entry_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_flow_results (id INT PRIMARY KEY AUTO_INCREMENT, run_id INT NOT NULL, pool_id INT NOT NULL, project_id INT NOT NULL, entry_id INT NOT NULL, rank_no INT NOT NULL DEFAULT 0, votes INT NOT NULL DEFAULT 0, score_total INT NOT NULL DEFAULT 0, rating_count INT NOT NULL DEFAULT 0, score_avg DECIMAL(8,3) NULL, advanced TINYINT NOT NULL DEFAULT 0, snapshot_json TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_vote_flow_result (pool_id,entry_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_flow_matches (id INT PRIMARY KEY AUTO_INCREMENT, run_id INT NOT NULL, pool_id INT NOT NULL, project_id INT NOT NULL, stage_id INT NOT NULL, round_no INT NOT NULL DEFAULT 1, match_no INT NOT NULL DEFAULT 1, slot_a_entry_id INT NULL, slot_b_entry_id INT NULL, winner_entry_id INT NULL, status VARCHAR(30) NOT NULL DEFAULT 'pending', next_match_id INT NULL, next_slot VARCHAR(1) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS vote_flow_events (id INT PRIMARY KEY AUTO_INCREMENT, run_id INT NULL, pool_id INT NULL, project_id INT NOT NULL, event_type VARCHAR(80) NOT NULL, payload_json TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS vote_flow_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, version_no INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT, snapshot_json TEXT, UNIQUE(project_id,version_no))`,
						`CREATE TABLE IF NOT EXISTS vote_flow_pools (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, project_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, stage_type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', vote_mode TEXT NOT NULL DEFAULT 'multi_select', group_count INTEGER NOT NULL DEFAULT 1, max_select INTEGER NOT NULL DEFAULT 1, advance_count INTEGER NOT NULL DEFAULT 0, config_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, opened_at TEXT, settled_at TEXT, UNIQUE(run_id,stage_id))`,
						`CREATE TABLE IF NOT EXISTS vote_flow_pool_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, pool_id INTEGER NOT NULL, project_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, group_key TEXT NOT NULL DEFAULT '', seed_no INTEGER NOT NULL DEFAULT 0, source_pool_id INTEGER, source_rank INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(pool_id,entry_id))`,
						`CREATE TABLE IF NOT EXISTS vote_flow_results (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, pool_id INTEGER NOT NULL, project_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, rank_no INTEGER NOT NULL DEFAULT 0, votes INTEGER NOT NULL DEFAULT 0, score_total INTEGER NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0, score_avg REAL, advanced INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(pool_id,entry_id))`,
						`CREATE TABLE IF NOT EXISTS vote_flow_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, pool_id INTEGER NOT NULL, project_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, round_no INTEGER NOT NULL DEFAULT 1, match_no INTEGER NOT NULL DEFAULT 1, slot_a_entry_id INTEGER, slot_b_entry_id INTEGER, winner_entry_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', next_match_id INTEGER, next_slot TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS vote_flow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, pool_id INTEGER, project_id INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				indexes := []string{
					"CREATE INDEX IF NOT EXISTS idx_vote_flow_runs_project ON vote_flow_runs(project_id,status)",
					"CREATE INDEX IF NOT EXISTS idx_vote_flow_pools_project ON vote_flow_pools(project_id,status,stage_type)",
					"CREATE INDEX IF NOT EXISTS idx_vote_flow_pool_entries_pool ON vote_flow_pool_entries(pool_id,status,group_key)",
					"CREATE INDEX IF NOT EXISTS idx_vote_flow_results_pool ON vote_flow_results(pool_id,advanced,rank_no)",
					"CREATE INDEX IF NOT EXISTS idx_vote_flow_matches_pool ON vote_flow_matches(pool_id,round_no,match_no)",
					"CREATE INDEX IF NOT EXISTS idx_vote_projects_share ON vote_projects(share_token)",
					"CREATE INDEX IF NOT EXISTS idx_vote_votes_guest ON vote_votes(guest_key)",
				}
				for _, indexQuery := range indexes {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 12,
			Name:    "GalOnly application and review compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				statements := []string{
					`CREATE TABLE IF NOT EXISTS galonly_events (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL, location VARCHAR(255) NOT NULL DEFAULT '', date DATE NOT NULL, registration_open TINYINT NOT NULL DEFAULT 1, staff_only TINYINT NOT NULL DEFAULT 0, event_code VARCHAR(32) NOT NULL DEFAULT '', description TEXT, staff_deadline DATETIME NULL, staff_max_applicants INT NULL, staff_required_count INT NOT NULL DEFAULT 0, staff_registration_open TINYINT NOT NULL DEFAULT 1, staff_roster_finalized TINYINT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_applications (id INT PRIMARY KEY AUTO_INCREMENT, event_id INT NOT NULL, event_number INT NULL, user_id INT NOT NULL, is_joint TINYINT NOT NULL DEFAULT 0, joint_name VARCHAR(255) NOT NULL DEFAULT '', wants_upgrade TINYINT NOT NULL DEFAULT 0, contact VARCHAR(255) NOT NULL DEFAULT '', qq_number VARCHAR(32) NOT NULL DEFAULT '', phone_number VARCHAR(32) NOT NULL DEFAULT '', exhibition_experience TEXT, notes TEXT, image_path TEXT NOT NULL, display_image VARCHAR(500) NULL, booth_name VARCHAR(255) NOT NULL DEFAULT '', booth_type VARCHAR(30) NOT NULL DEFAULT '', expected_members INT NOT NULL DEFAULT 0, layout_notes TEXT, needs_power VARCHAR(20) NOT NULL DEFAULT 'unsure', attachment_paths TEXT, merchandise_items TEXT, merchandise_attachments TEXT, merchandise_version INT NOT NULL DEFAULT 0, merchandise_updated_at DATETIME NULL, phase2_approved_status VARCHAR(30) NULL, status VARCHAR(30) NOT NULL DEFAULT 'pending', phase INT NOT NULL DEFAULT 1, rejected_at DATETIME NULL, revision_at DATETIME NULL, resubmitted TINYINT NOT NULL DEFAULT 0, has_update TINYINT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (event_id) REFERENCES galonly_events(id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_application_clubs (id INT PRIMARY KEY AUTO_INCREMENT, application_id INT NOT NULL, club_id INT NOT NULL, club_country VARCHAR(50) NOT NULL DEFAULT '', UNIQUE KEY uq_galonly_application_club (application_id,club_id), FOREIGN KEY (application_id) REFERENCES galonly_applications(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_votes (id INT PRIMARY KEY AUTO_INCREMENT, application_id INT NOT NULL, auditer_id INT NOT NULL, vote VARCHAR(10) NOT NULL, comment TEXT NULL, phase INT NOT NULL DEFAULT 1, merchandise_version INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_galonly_vote (application_id,auditer_id,phase,merchandise_version), FOREIGN KEY (application_id) REFERENCES galonly_applications(id), FOREIGN KEY (auditer_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_public_votes (id INT PRIMARY KEY AUTO_INCREMENT, event_id INT NOT NULL, application_id INT NOT NULL, ip_address VARCHAR(45) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_galonly_public_vote (event_id,ip_address,application_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_reviewers (id INT PRIMARY KEY AUTO_INCREMENT, event_id INT NOT NULL DEFAULT 0, user_id INT NOT NULL, role VARCHAR(20) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_galonly_reviewer (event_id,user_id), FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS galonly_staff_applications (id INT PRIMARY KEY AUTO_INCREMENT, event_id INT NOT NULL, user_id INT NOT NULL, cn_name VARCHAR(255) NOT NULL DEFAULT '', qq_number VARCHAR(32) NOT NULL DEFAULT '', phone_number VARCHAR(32) NOT NULL DEFAULT '', email VARCHAR(255) NOT NULL DEFAULT '', club_id INT NOT NULL DEFAULT 0, club_country VARCHAR(50) NOT NULL DEFAULT 'china', positions TEXT, confirm_schedule TINYINT NOT NULL DEFAULT 0, is_cosplay TINYINT NOT NULL DEFAULT 0, three_day_available TINYINT NOT NULL DEFAULT 0, self_intro TEXT, gender VARCHAR(20) NOT NULL DEFAULT '', staff_experience TINYINT NOT NULL DEFAULT 0, skills TEXT, status VARCHAR(20) NOT NULL DEFAULT 'pending', voted_by INT NULL, vote VARCHAR(20) NULL, resubmitted TINYINT NOT NULL DEFAULT 0, has_update TINYINT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					statements = []string{
						`CREATE TABLE IF NOT EXISTS galonly_events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, registration_open INTEGER NOT NULL DEFAULT 1, staff_only INTEGER NOT NULL DEFAULT 0, event_code TEXT NOT NULL DEFAULT '', description TEXT, staff_deadline TEXT, staff_max_applicants INTEGER, staff_required_count INTEGER NOT NULL DEFAULT 0, staff_registration_open INTEGER NOT NULL DEFAULT 1, staff_roster_finalized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS galonly_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES galonly_events(id), event_number INTEGER, user_id INTEGER NOT NULL REFERENCES users(id), is_joint INTEGER NOT NULL DEFAULT 0, joint_name TEXT NOT NULL DEFAULT '', wants_upgrade INTEGER NOT NULL DEFAULT 0, contact TEXT NOT NULL DEFAULT '', qq_number TEXT NOT NULL DEFAULT '', phone_number TEXT NOT NULL DEFAULT '', exhibition_experience TEXT NOT NULL DEFAULT '', notes TEXT, image_path TEXT NOT NULL DEFAULT '[]', display_image TEXT, booth_name TEXT NOT NULL DEFAULT '', booth_type TEXT NOT NULL DEFAULT '', expected_members INTEGER NOT NULL DEFAULT 0, layout_notes TEXT, needs_power TEXT NOT NULL DEFAULT 'unsure', attachment_paths TEXT NOT NULL DEFAULT '[]', merchandise_items TEXT NOT NULL DEFAULT '[]', merchandise_attachments TEXT NOT NULL DEFAULT '[]', merchandise_version INTEGER NOT NULL DEFAULT 0, merchandise_updated_at TEXT, phase2_approved_status TEXT, status TEXT NOT NULL DEFAULT 'pending', phase INTEGER NOT NULL DEFAULT 1, rejected_at TEXT, revision_at TEXT, resubmitted INTEGER NOT NULL DEFAULT 0, has_update INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
						`CREATE TABLE IF NOT EXISTS galonly_application_clubs (id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES galonly_applications(id), club_id INTEGER NOT NULL, club_country TEXT NOT NULL DEFAULT '', UNIQUE(application_id,club_id))`,
						`CREATE TABLE IF NOT EXISTS galonly_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES galonly_applications(id), auditer_id INTEGER NOT NULL REFERENCES users(id), vote TEXT NOT NULL, comment TEXT, phase INTEGER NOT NULL DEFAULT 1, merchandise_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(application_id,auditer_id,phase,merchandise_version))`,
						`CREATE TABLE IF NOT EXISTS galonly_public_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, application_id INTEGER NOT NULL, ip_address TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id,ip_address,application_id))`,
						`CREATE TABLE IF NOT EXISTS galonly_reviewers (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id,user_id))`,
						`CREATE TABLE IF NOT EXISTS galonly_staff_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, cn_name TEXT NOT NULL DEFAULT '', qq_number TEXT NOT NULL DEFAULT '', phone_number TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', club_id INTEGER NOT NULL DEFAULT 0, club_country TEXT NOT NULL DEFAULT 'china', positions TEXT NOT NULL DEFAULT '[]', confirm_schedule INTEGER NOT NULL DEFAULT 0, is_cosplay INTEGER NOT NULL DEFAULT 0, three_day_available INTEGER NOT NULL DEFAULT 0, self_intro TEXT, gender TEXT NOT NULL DEFAULT '', staff_experience INTEGER NOT NULL DEFAULT 0, skills TEXT, status TEXT NOT NULL DEFAULT 'pending', voted_by INTEGER, vote TEXT, resubmitted INTEGER NOT NULL DEFAULT 0, has_update INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					}
				}
				for _, statement := range statements {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				indexes := []string{"CREATE INDEX IF NOT EXISTS idx_galonly_app_event ON galonly_applications(event_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_app_user ON galonly_applications(user_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_app_status ON galonly_applications(status)", "CREATE INDEX IF NOT EXISTS idx_galonly_app_clubs_app ON galonly_application_clubs(application_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_votes_app ON galonly_votes(application_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_public_votes_event ON galonly_public_votes(event_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_public_votes_app ON galonly_public_votes(application_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_staff_event ON galonly_staff_applications(event_id)", "CREATE INDEX IF NOT EXISTS idx_galonly_staff_status ON galonly_staff_applications(status)", "CREATE INDEX IF NOT EXISTS idx_galonly_reviewers_role ON galonly_reviewers(role)"}
				for _, indexQuery := range indexes {
					if db.Driver == "mysql" {
						indexQuery = strings.Replace(indexQuery, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, indexQuery); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 13,
			Name:    "Spy game compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				mysql := []string{
					`CREATE TABLE IF NOT EXISTS spy_rooms (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(16) NOT NULL, name VARCHAR(80) NOT NULL DEFAULT '', host_user_id INT NOT NULL, club_id INT NULL, country VARCHAR(50) NOT NULL DEFAULT 'china', cap INT NOT NULL DEFAULT 8, joined INT NOT NULL DEFAULT 0, dist_civilian INT NOT NULL DEFAULT 0, dist_spy INT NOT NULL DEFAULT 0, dist_blank INT NOT NULL DEFAULT 0, phase VARCHAR(16) NOT NULL DEFAULT 'lobby', round INT NOT NULL DEFAULT 1, timer_profile VARCHAR(16) NOT NULL DEFAULT 'standard', deadline_at BIGINT NOT NULL DEFAULT 0, speaker_seat INT NOT NULL DEFAULT 0, vote_sealed_at BIGINT NOT NULL DEFAULT 0, revote_used TINYINT NOT NULL DEFAULT 0, spectate TINYINT NOT NULL DEFAULT 1, spectate_delay INT NOT NULL DEFAULT 60, need_code TINYINT NOT NULL DEFAULT 0, join_code VARCHAR(16) NOT NULL DEFAULT '', word_a VARCHAR(64) NOT NULL DEFAULT '', word_b VARCHAR(64) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'waiting', winner VARCHAR(16) NOT NULL DEFAULT '', host_last_seen_at BIGINT NOT NULL DEFAULT 0, rev BIGINT NOT NULL DEFAULT 1, last_activity_at BIGINT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_spy_room_code (code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_seats (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, seat INT NOT NULL, user_id INT NULL, nick VARCHAR(64) NOT NULL DEFAULT '', avatar VARCHAR(255) NOT NULL DEFAULT '', role VARCHAR(16) NOT NULL DEFAULT '', role_preset VARCHAR(16) NOT NULL DEFAULT '', ready_at BIGINT NOT NULL DEFAULT 0, viewed_at BIGINT NOT NULL DEFAULT 0, out_round INT NULL, out_by VARCHAR(16) NOT NULL DEFAULT '', last_seen_at BIGINT NOT NULL DEFAULT 0, joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_spy_seat (room_id,seat), UNIQUE KEY uq_spy_seat_user (room_id,user_id), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_words (room_id INT NOT NULL PRIMARY KEY, pair_id INT NOT NULL DEFAULT 0, civilian_word VARCHAR(64) NOT NULL DEFAULT '', spy_word VARCHAR(64) NOT NULL DEFAULT '', difficulty VARCHAR(16) NOT NULL DEFAULT 'mid', similarity VARCHAR(16) NOT NULL DEFAULT 'near', dealt_at BIGINT NOT NULL DEFAULT 0, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_word_pairs (id INT PRIMARY KEY AUTO_INCREMENT, a VARCHAR(64) NOT NULL, b VARCHAR(64) NOT NULL, level VARCHAR(16) NOT NULL DEFAULT 'mid', similarity VARCHAR(16) NOT NULL DEFAULT 'near', used_count INT NOT NULL DEFAULT 0, enabled TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_spy_pair (a,b)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_sentences (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, round INT NOT NULL, seat INT NOT NULL, body VARCHAR(160) NOT NULL, skipped TINYINT NOT NULL DEFAULT 0, submitted_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_sentence (room_id,round,seat), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_votes (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, round INT NOT NULL, from_seat INT NOT NULL, to_seat INT NULL, sealed TINYINT NOT NULL DEFAULT 0, submitted_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_vote (room_id,round,from_seat), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_night_actions (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, round INT NOT NULL, from_seat INT NOT NULL, target_seat INT NULL, submitted_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_night (room_id,round,from_seat), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_blank_guesses (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, round INT NOT NULL, seat INT NOT NULL, guess_a VARCHAR(64) NOT NULL DEFAULT '', guess_b VARCHAR(64) NOT NULL DEFAULT '', hit_a TINYINT NOT NULL DEFAULT 0, hit_b TINYINT NOT NULL DEFAULT 0, result VARCHAR(16) NOT NULL DEFAULT '', host_confirmed TINYINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_blank_guess (room_id,seat), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_round_outcomes (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, round INT NOT NULL, stage VARCHAR(16) NOT NULL, eliminated_seat INT NULL, eliminated_role VARCHAR(16) NOT NULL DEFAULT '', out_by VARCHAR(16) NOT NULL DEFAULT '', tie TINYINT NOT NULL DEFAULT 0, host_ruling VARCHAR(64) NOT NULL DEFAULT '', tally TEXT NULL, created_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_round_outcome (room_id,round,stage), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_events (id INT PRIMARY KEY AUTO_INCREMENT, room_id INT NOT NULL, rev BIGINT NOT NULL, kind VARCHAR(32) NOT NULL, payload TEXT NULL, created_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_event_rev (room_id,rev), FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_results (room_id INT NOT NULL PRIMARY KEY, winner VARCHAR(16) NOT NULL DEFAULT '', reason VARCHAR(255) NOT NULL DEFAULT '', rounds INT NOT NULL DEFAULT 0, awards TEXT NULL, reveal TEXT NULL, settled_at BIGINT NOT NULL DEFAULT 0, FOREIGN KEY (room_id) REFERENCES spy_rooms(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
					`CREATE TABLE IF NOT EXISTS spy_idempotency (id INT PRIMARY KEY AUTO_INCREMENT, idem_key VARCHAR(64) NOT NULL, room_id INT NOT NULL DEFAULT 0, response TEXT NULL, created_at BIGINT NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL DEFAULT 0, UNIQUE KEY uq_spy_idem (idem_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				sqlite := []string{
					`CREATE TABLE IF NOT EXISTS spy_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', host_user_id INTEGER NOT NULL, club_id INTEGER, country TEXT NOT NULL DEFAULT 'china', cap INTEGER NOT NULL DEFAULT 8, joined INTEGER NOT NULL DEFAULT 0, dist_civilian INTEGER NOT NULL DEFAULT 0, dist_spy INTEGER NOT NULL DEFAULT 0, dist_blank INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'lobby', round INTEGER NOT NULL DEFAULT 1, timer_profile TEXT NOT NULL DEFAULT 'standard', deadline_at INTEGER NOT NULL DEFAULT 0, speaker_seat INTEGER NOT NULL DEFAULT 0, vote_sealed_at INTEGER NOT NULL DEFAULT 0, revote_used INTEGER NOT NULL DEFAULT 0, spectate INTEGER NOT NULL DEFAULT 1, spectate_delay INTEGER NOT NULL DEFAULT 60, need_code INTEGER NOT NULL DEFAULT 0, join_code TEXT NOT NULL DEFAULT '', word_a TEXT NOT NULL DEFAULT '', word_b TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'waiting', winner TEXT NOT NULL DEFAULT '', host_last_seen_at INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1, last_activity_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
					`CREATE TABLE IF NOT EXISTS spy_seats (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, seat INTEGER NOT NULL, user_id INTEGER, nick TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', role_preset TEXT NOT NULL DEFAULT '', ready_at INTEGER NOT NULL DEFAULT 0, viewed_at INTEGER NOT NULL DEFAULT 0, out_round INTEGER, out_by TEXT NOT NULL DEFAULT '', last_seen_at INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id,seat), UNIQUE(room_id,user_id))`,
					`CREATE TABLE IF NOT EXISTS spy_words (room_id INTEGER NOT NULL PRIMARY KEY REFERENCES spy_rooms(id) ON DELETE CASCADE, pair_id INTEGER NOT NULL DEFAULT 0, civilian_word TEXT NOT NULL DEFAULT '', spy_word TEXT NOT NULL DEFAULT '', difficulty TEXT NOT NULL DEFAULT 'mid', similarity TEXT NOT NULL DEFAULT 'near', dealt_at INTEGER NOT NULL DEFAULT 0)`,
					`CREATE TABLE IF NOT EXISTS spy_word_pairs (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'mid', similarity TEXT NOT NULL DEFAULT 'near', used_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(a,b))`,
					`CREATE TABLE IF NOT EXISTS spy_sentences (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, round INTEGER NOT NULL, seat INTEGER NOT NULL, body TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,round,seat))`,
					`CREATE TABLE IF NOT EXISTS spy_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, round INTEGER NOT NULL, from_seat INTEGER NOT NULL, to_seat INTEGER, sealed INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,round,from_seat))`,
					`CREATE TABLE IF NOT EXISTS spy_night_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, round INTEGER NOT NULL, from_seat INTEGER NOT NULL, target_seat INTEGER, submitted_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,round,from_seat))`,
					`CREATE TABLE IF NOT EXISTS spy_blank_guesses (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, round INTEGER NOT NULL, seat INTEGER NOT NULL, guess_a TEXT NOT NULL DEFAULT '', guess_b TEXT NOT NULL DEFAULT '', hit_a INTEGER NOT NULL DEFAULT 0, hit_b INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', host_confirmed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,seat))`,
					`CREATE TABLE IF NOT EXISTS spy_round_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, round INTEGER NOT NULL, stage TEXT NOT NULL, eliminated_seat INTEGER, eliminated_role TEXT NOT NULL DEFAULT '', out_by TEXT NOT NULL DEFAULT '', tie INTEGER NOT NULL DEFAULT 0, host_ruling TEXT NOT NULL DEFAULT '', tally TEXT, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,round,stage))`,
					`CREATE TABLE IF NOT EXISTS spy_events (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES spy_rooms(id) ON DELETE CASCADE, rev INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,rev))`,
					`CREATE TABLE IF NOT EXISTS spy_results (room_id INTEGER NOT NULL PRIMARY KEY REFERENCES spy_rooms(id) ON DELETE CASCADE, winner TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', rounds INTEGER NOT NULL DEFAULT 0, awards TEXT, reveal TEXT, settled_at INTEGER NOT NULL DEFAULT 0)`,
					`CREATE TABLE IF NOT EXISTS spy_idempotency (id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT NOT NULL UNIQUE, room_id INTEGER NOT NULL DEFAULT 0, response TEXT, created_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0)`,
				}
				if db.Driver == "sqlite" {
					mysql = sqlite
				}
				for _, statement := range mysql {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				// Older PHP deployments may already have the core tables with a
				// smaller column set. Add only defaulted columns; no table rebuild.
				type repair struct{ table, column, definition string }
				repairs := []repair{
					{"spy_rooms", "word_a", "VARCHAR(64) NOT NULL DEFAULT ''"}, {"spy_rooms", "word_b", "VARCHAR(64) NOT NULL DEFAULT ''"},
					{"spy_seats", "role_preset", "VARCHAR(16) NOT NULL DEFAULT ''"},
				}
				if db.Driver == "sqlite" {
					for i := range repairs {
						repairs[i].definition = strings.ReplaceAll(repairs[i].definition, "VARCHAR", "TEXT")
					}
				}
				for _, item := range repairs {
					exists, err := columnExistsTx(ctx, tx, db.Driver, item.table, item.column)
					if err != nil {
						return err
					}
					if !exists {
						if _, err := tx.ExecContext(ctx, "ALTER TABLE "+item.table+" ADD COLUMN "+item.column+" "+item.definition); err != nil {
							return fmt.Errorf("add %s.%s: %w", item.table, item.column, err)
						}
					}
				}
				indexes := []string{
					"CREATE INDEX IF NOT EXISTS idx_spy_rooms_status ON spy_rooms(status,last_activity_at)", "CREATE INDEX IF NOT EXISTS idx_spy_rooms_host ON spy_rooms(host_user_id)", "CREATE INDEX IF NOT EXISTS idx_spy_rooms_deadline ON spy_rooms(deadline_at,status)", "CREATE INDEX IF NOT EXISTS idx_spy_seats_room ON spy_seats(room_id)", "CREATE INDEX IF NOT EXISTS idx_spy_seats_user ON spy_seats(user_id)", "CREATE INDEX IF NOT EXISTS idx_spy_votes_round ON spy_votes(room_id,round)", "CREATE INDEX IF NOT EXISTS idx_spy_sentences_round ON spy_sentences(room_id,round)", "CREATE INDEX IF NOT EXISTS idx_spy_events_room ON spy_events(room_id,rev)", "CREATE INDEX IF NOT EXISTS idx_spy_idem_expiry ON spy_idempotency(expires_at)",
				}
				for _, query := range indexes {
					if db.Driver == "mysql" {
						query = strings.Replace(query, " IF NOT EXISTS", "", 1)
					}
					if _, err := tx.ExecContext(ctx, query); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 14,
			Name:    "GalOnly merchandise history and legacy column repairs",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				definition := func(mysql, sqlite string) string {
					if db.Driver == "sqlite" {
						return sqlite
					}
					return mysql
				}
				// PHP versions created these columns lazily. This migration is
				// additive and deliberately does not rewrite any existing row.
				type repair struct{ table, column, mysql, sqlite string }
				repairs := []repair{
					{"galonly_events", "staff_deadline", "DATETIME NULL", "TEXT NULL"}, {"galonly_events", "staff_max_applicants", "INT NULL", "INTEGER NULL"}, {"galonly_events", "staff_required_count", "INT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_events", "staff_registration_open", "TINYINT NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"}, {"galonly_events", "staff_roster_finalized", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_events", "staff_only", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_events", "event_code", "VARCHAR(32) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"},
					{"galonly_applications", "event_number", "INT NULL", "INTEGER NULL"}, {"galonly_applications", "qq_number", "VARCHAR(32) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_applications", "phone_number", "VARCHAR(32) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_applications", "exhibition_experience", "TEXT NULL", "TEXT NULL"}, {"galonly_applications", "display_image", "VARCHAR(500) NULL", "TEXT NULL"}, {"galonly_applications", "booth_name", "VARCHAR(255) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_applications", "booth_type", "VARCHAR(30) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_applications", "expected_members", "INT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_applications", "layout_notes", "TEXT NULL", "TEXT NULL"}, {"galonly_applications", "needs_power", "VARCHAR(20) NOT NULL DEFAULT 'unsure'", "TEXT NOT NULL DEFAULT 'unsure'"}, {"galonly_applications", "attachment_paths", "TEXT NULL", "TEXT NULL"}, {"galonly_applications", "merchandise_items", "TEXT NULL", "TEXT NULL"}, {"galonly_applications", "merchandise_attachments", "TEXT NULL", "TEXT NULL"}, {"galonly_applications", "merchandise_version", "INT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_applications", "merchandise_updated_at", "DATETIME NULL", "TEXT NULL"}, {"galonly_applications", "phase2_approved_status", "VARCHAR(30) NULL", "TEXT NULL"}, {"galonly_applications", "phase", "INT NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"}, {"galonly_applications", "rejected_at", "DATETIME NULL", "TEXT NULL"}, {"galonly_applications", "revision_at", "DATETIME NULL", "TEXT NULL"}, {"galonly_applications", "resubmitted", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_applications", "has_update", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"},
					{"galonly_votes", "comment", "TEXT NULL", "TEXT NULL"}, {"galonly_votes", "phase", "INT NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"}, {"galonly_votes", "merchandise_version", "INT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"},
					{"galonly_staff_applications", "cn_name", "VARCHAR(255) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_staff_applications", "qq_number", "VARCHAR(32) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_staff_applications", "phone_number", "VARCHAR(32) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_staff_applications", "email", "VARCHAR(255) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_staff_applications", "club_id", "INT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "club_country", "VARCHAR(50) NOT NULL DEFAULT 'china'", "TEXT NOT NULL DEFAULT 'china'"}, {"galonly_staff_applications", "positions", "TEXT NULL", "TEXT NULL"}, {"galonly_staff_applications", "confirm_schedule", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "is_cosplay", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "three_day_available", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "self_intro", "TEXT NULL", "TEXT NULL"}, {"galonly_staff_applications", "gender", "VARCHAR(20) NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"}, {"galonly_staff_applications", "staff_experience", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "skills", "TEXT NULL", "TEXT NULL"}, {"galonly_staff_applications", "status", "VARCHAR(20) NOT NULL DEFAULT 'pending'", "TEXT NOT NULL DEFAULT 'pending'"}, {"galonly_staff_applications", "voted_by", "INT NULL", "INTEGER NULL"}, {"galonly_staff_applications", "vote", "VARCHAR(20) NULL", "TEXT NULL"}, {"galonly_staff_applications", "resubmitted", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"}, {"galonly_staff_applications", "has_update", "TINYINT NOT NULL DEFAULT 0", "INTEGER NOT NULL DEFAULT 0"},
				}
				for _, item := range repairs {
					exists, err := columnExistsTx(ctx, tx, db.Driver, item.table, item.column)
					if err != nil {
						return err
					}
					if !exists {
						if _, err := tx.ExecContext(ctx, "ALTER TABLE "+item.table+" ADD COLUMN "+item.column+" "+definition(item.mysql, item.sqlite)); err != nil {
							return fmt.Errorf("add %s.%s: %w", item.table, item.column, err)
						}
					}
				}
				tables := []string{
					`CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (id INT PRIMARY KEY AUTO_INCREMENT, application_id INT NOT NULL, material_version INT NOT NULL, submitted_by INT NULL, submitted_at DATETIME NOT NULL, source_status VARCHAR(40) NOT NULL DEFAULT 'phase2_pending', review_status VARCHAR(20) NOT NULL DEFAULT 'pending', reviewed_at DATETIME NULL, reviewed_by INT NULL, review_feedback TEXT NULL, merchandise_items TEXT NOT NULL, merchandise_attachments TEXT NULL, display_image VARCHAR(500) NULL, UNIQUE KEY uk_galonly_merch_revision (application_id,material_version)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
				}
				if db.Driver == "sqlite" {
					tables = []string{`CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL, material_version INTEGER NOT NULL, submitted_by INTEGER NULL, submitted_at TEXT NOT NULL, source_status TEXT NOT NULL DEFAULT 'phase2_pending', review_status TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT NULL, reviewed_by INTEGER NULL, review_feedback TEXT NULL, merchandise_items TEXT NOT NULL, merchandise_attachments TEXT NULL, display_image TEXT NULL, UNIQUE(application_id,material_version))`}
				}
				for _, statement := range tables {
					if _, err := tx.ExecContext(ctx, statement); err != nil {
						return err
					}
				}
				index := "CREATE INDEX idx_galonly_merch_revision_app ON galonly_merchandise_revisions(application_id,submitted_at)"
				if db.Driver == "sqlite" {
					index = "CREATE INDEX IF NOT EXISTS idx_galonly_merch_revision_app ON galonly_merchandise_revisions(application_id,submitted_at)"
				}
				if _, err := tx.ExecContext(ctx, index); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
					return err
				}
				return nil
			},
		},
		{
			Version: 15,
			Name:    "quiz hub shared question bank compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS quiz_shares (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    title VARCHAR(200) NOT NULL,
                    description VARCHAR(500) NOT NULL DEFAULT '',
                    uploader_id INT NOT NULL,
                    uploader_name VARCHAR(100) NOT NULL DEFAULT '',
                    question_count INT NOT NULL DEFAULT 0,
                    type_counts VARCHAR(500) NOT NULL DEFAULT '{}',
                    content MEDIUMTEXT NOT NULL,
                    upload_token VARCHAR(64) NOT NULL DEFAULT '',
                    downloads INT NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_quiz_share_token (upload_token),
                    INDEX idx_quiz_share_uploader (uploader_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS quiz_shares (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title TEXT NOT NULL,
                        description TEXT NOT NULL DEFAULT '',
                        uploader_id INTEGER NOT NULL,
                        uploader_name TEXT NOT NULL DEFAULT '',
                        question_count INTEGER NOT NULL DEFAULT 0,
                        type_counts TEXT NOT NULL DEFAULT '{}',
                        content TEXT NOT NULL,
                        upload_token TEXT NOT NULL DEFAULT '',
                        downloads INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(upload_token)
                    )`
				}
				if _, err := tx.ExecContext(ctx, query); err != nil {
					return err
				}
				if db.Driver == "sqlite" {
					_, _ = tx.ExecContext(ctx, "CREATE INDEX IF NOT EXISTS idx_quiz_share_uploader ON quiz_shares(uploader_id)")
				} else {
					if _, err := tx.ExecContext(ctx, "CREATE INDEX idx_quiz_share_uploader ON quiz_shares(uploader_id)"); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate") {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 16,
			Name:    "bot token compatibility schema",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				query := `CREATE TABLE IF NOT EXISTS club_bot_tokens (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    club_id INT NOT NULL,
                    country VARCHAR(20) NOT NULL DEFAULT 'china',
                    name VARCHAR(120) NOT NULL DEFAULT '',
                    token_prefix VARCHAR(64) NOT NULL,
                    token_hash VARCHAR(255) NOT NULL,
                    permissions TEXT NOT NULL,
                    created_by INT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_used_at DATETIME NULL,
                    revoked_at DATETIME NULL,
                    INDEX idx_club_bot_tokens_club (club_id,country),
                    INDEX idx_club_bot_tokens_prefix (token_prefix)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
				if db.Driver == "sqlite" {
					query = `CREATE TABLE IF NOT EXISTS club_bot_tokens (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        club_id INTEGER NOT NULL,
                        country TEXT NOT NULL DEFAULT 'china',
                        name TEXT NOT NULL DEFAULT '',
                        token_prefix TEXT NOT NULL,
                        token_hash TEXT NOT NULL,
                        permissions TEXT NOT NULL,
                        created_by INTEGER NOT NULL,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        last_used_at TEXT,
                        revoked_at TEXT
                    )`
				}
				if _, err := tx.ExecContext(ctx, query); err != nil {
					return err
				}
				indexes := []string{
					"CREATE INDEX idx_club_bot_tokens_club ON club_bot_tokens(club_id,country)",
					"CREATE INDEX idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix)",
				}
				if db.Driver == "sqlite" {
					indexes = []string{
						"CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_club ON club_bot_tokens(club_id,country)",
						"CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix)",
					}
				}
				for _, index := range indexes {
					if _, err := tx.ExecContext(ctx, index); err != nil && (db.Driver != "mysql" || !strings.Contains(strings.ToLower(err.Error()), "duplicate")) {
						return err
					}
				}
				return nil
			},
		},
		{
			Version: 17,
			Name:    "GalOnly phase two review feedback compatibility",
			Apply: func(ctx context.Context, tx *sql.Tx) error {
				definition := "TEXT NULL"
				if db.Driver == "mysql" {
					definition = "TEXT NULL"
				}
				for _, column := range []string{"phase1_feedback", "phase2_feedback"} {
					exists, err := columnExistsTx(ctx, tx, db.Driver, "galonly_applications", column)
					if err != nil {
						return err
					}
					if !exists {
						if _, err := tx.ExecContext(ctx, "ALTER TABLE galonly_applications ADD COLUMN "+column+" "+definition); err != nil {
							return fmt.Errorf("add galonly_applications.%s: %w", column, err)
						}
					}
				}
				return nil
			},
		},
	}
}

func columnExistsTx(ctx context.Context, tx *sql.Tx, driver, table, column string) (bool, error) {
	if driver == "mysql" {
		var count int
		err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, table, column).Scan(&count)
		return count > 0, err
	}
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+quoteSQLiteIdentifier(table)+")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func quoteSQLiteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func Apply(ctx context.Context, db *DB, writer io.Writer) error {
	// The metadata table is the only table created without an existing
	// application baseline. This keeps a failed migration non-destructive.
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS vnfest_schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL
    )`); err != nil {
		return fmt.Errorf("create migration metadata: %w", err)
	}
	rows, err := db.QueryContext(ctx, "SELECT version FROM vnfest_schema_migrations")
	if err != nil {
		return fmt.Errorf("read migration metadata: %w", err)
	}
	applied := map[int]bool{}
	for rows.Next() {
		var version int
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}

	for _, migration := range Migrations(db) {
		if applied[migration.Version] {
			continue
		}
		if migration.Version == 2 {
			exists, err := db.TableExists(ctx, "users")
			if err != nil {
				return fmt.Errorf("check application baseline: %w", err)
			}
			if !exists {
				return fmt.Errorf("users table is missing; run the existing baseline schema before applying the Go session bridge")
			}
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %04d: %w", migration.Version, err)
		}
		if err := migration.Apply(ctx, tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply migration %04d (%s): %w", migration.Version, migration.Name, err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO vnfest_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)", migration.Version, migration.Name, time.Now().UTC()); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %04d: %w", migration.Version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %04d: %w", migration.Version, err)
		}
		if writer != nil {
			fmt.Fprintf(writer, "applied %04d %s\n", migration.Version, migration.Name)
		}
	}
	return nil
}

func Pending(ctx context.Context, db *DB) ([]Migration, error) {
	exists, err := db.TableExists(ctx, "vnfest_schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("check migration metadata: %w", err)
	}
	applied := map[int]bool{}
	if exists {
		rows, err := db.QueryContext(ctx, "SELECT version FROM vnfest_schema_migrations")
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var version int
			if err := rows.Scan(&version); err != nil {
				rows.Close()
				return nil, err
			}
			applied[version] = true
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	pending := make([]Migration, 0)
	for _, migration := range Migrations(db) {
		if !applied[migration.Version] {
			pending = append(pending, migration)
		}
	}
	return pending, nil
}

func Verify(ctx context.Context, db *DB) error {
	for _, table := range []string{"users", "sessions", "vnfest_schema_migrations", "vnfest_session_bridge", "bangumi_bindings", "club_verification_codes", "club_recommendations", "club_comments", "club_moe_kings", "analytics_pageviews", "analytics_historical_pv", "recognition_programs", "recognition_program_versions", "recognition_badges", "recognition_connectors", "recognition_events", "recognition_attempts", "recognition_submissions", "recognition_reviews", "recognition_credentials", "recognition_outbox", "recognition_identity_links", "recognition_claim_codes", "recognition_club_roles", "vote_projects", "vote_stages", "vote_entries", "vote_nominations", "vote_votes", "vote_stage_entries", "vote_matches", "vote_results", "vote_flow_runs", "vote_flow_pools", "vote_flow_pool_entries", "vote_flow_results", "vote_flow_matches", "vote_flow_events", "galonly_events", "galonly_applications", "galonly_application_clubs", "galonly_votes", "galonly_public_votes", "galonly_reviewers", "galonly_staff_applications", "galonly_merchandise_revisions", "spy_rooms", "spy_seats", "spy_words", "spy_word_pairs", "spy_sentences", "spy_votes", "spy_night_actions", "spy_blank_guesses", "spy_round_outcomes", "spy_events", "spy_results", "spy_idempotency", "quiz_shares", "club_bot_tokens"} {
		exists, err := db.TableExists(ctx, table)
		if err != nil {
			return fmt.Errorf("verify table %s: %w", table, err)
		}
		if !exists {
			return fmt.Errorf("required table %s is missing", table)
		}
	}
	var version int
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM vnfest_schema_migrations").Scan(&version); err != nil {
		return fmt.Errorf("verify migration version: %w", err)
	}
	if version < 17 {
		return fmt.Errorf("compatibility schema migration is not applied; current version is %d", version)
	}
	return nil
}

func WriteSnapshot(ctx context.Context, db *DB, writer io.Writer) error {
	var query string
	if db.Driver == "mysql" {
		query = "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
	} else {
		query = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
	}
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		names = append(names, name)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	sort.Strings(names)
	snapshot := Snapshot{GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Driver: db.Driver}
	for _, name := range names {
		// Table names originate from the database metadata, not request input.
		quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
		if db.Driver == "mysql" {
			quoted = "`" + strings.ReplaceAll(name, "`", "``") + "`"
		}
		var count int64
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quoted).Scan(&count); err != nil {
			return fmt.Errorf("count table %s: %w", name, err)
		}
		table := TableSummary{Name: name, RowCount: count}
		if err := appendColumns(ctx, db, name, &table); err != nil {
			return fmt.Errorf("columns table %s: %w", name, err)
		}
		if err := appendIndexes(ctx, db, name, &table); err != nil {
			return fmt.Errorf("indexes table %s: %w", name, err)
		}
		if err := appendForeignKeys(ctx, db, name, &table); err != nil {
			return fmt.Errorf("foreign keys table %s: %w", name, err)
		}
		snapshot.Tables = append(snapshot.Tables, table)
	}
	canonical, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(canonical)
	snapshot.SchemaSHA256 = hex.EncodeToString(digest[:])
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(snapshot)
}

func appendColumns(ctx context.Context, db *DB, tableName string, table *TableSummary) error {
	if db.Driver == "mysql" {
		rows, err := db.QueryContext(ctx, `SELECT column_name, column_type, is_nullable, column_default, extra, ordinal_position FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, tableName)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name, typ, nullable, extra string
			var defaultValue sql.NullString
			var ordinal int
			if err := rows.Scan(&name, &typ, &nullable, &defaultValue, &extra, &ordinal); err != nil {
				return err
			}
			var value any
			if defaultValue.Valid {
				value = defaultValue.String
			}
			table.Columns = append(table.Columns, ColumnSummary{Name: name, Type: typ, Nullable: nullable == "YES", Default: value, Extra: extra, Ordinal: ordinal})
		}
		return rows.Err()
	}
	quoted := sqlitePragmaName(tableName)
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+quoted+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue sql.NullString
		var primary int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primary); err != nil {
			return err
		}
		var value any
		if defaultValue.Valid {
			value = defaultValue.String
		}
		table.Columns = append(table.Columns, ColumnSummary{Name: name, Type: typ, Nullable: notNull == 0, Default: value, Ordinal: cid + 1})
	}
	return rows.Err()
}

func appendIndexes(ctx context.Context, db *DB, tableName string, table *TableSummary) error {
	if db.Driver == "mysql" {
		rows, err := db.QueryContext(ctx, `SELECT index_name, non_unique, seq_in_index, column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index`, tableName)
		if err != nil {
			return err
		}
		defer rows.Close()
		byName := map[string]int{}
		for rows.Next() {
			var name, column string
			var nonUnique, sequence int
			if err := rows.Scan(&name, &nonUnique, &sequence, &column); err != nil {
				return err
			}
			idx, ok := byName[name]
			if !ok {
				table.Indexes = append(table.Indexes, IndexSummary{Name: name, Unique: nonUnique == 0})
				idx = len(table.Indexes) - 1
				byName[name] = idx
			}
			if column != "" {
				table.Indexes[idx].Columns = append(table.Indexes[idx].Columns, column)
			}
		}
		return rows.Err()
	}
	rows, err := db.QueryContext(ctx, "PRAGMA index_list("+sqlitePragmaName(tableName)+")")
	if err != nil {
		return err
	}
	type sqliteIndex struct {
		name   string
		unique bool
	}
	indexes := []sqliteIndex{}
	for rows.Next() {
		var sequence int
		var name string
		var unique int
		var origin string
		var partial int
		if err := rows.Scan(&sequence, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return err
		}
		indexes = append(indexes, sqliteIndex{name: name, unique: unique != 0})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, sqliteIndex := range indexes {
		index := IndexSummary{Name: sqliteIndex.name, Unique: sqliteIndex.unique}
		info, err := db.QueryContext(ctx, "PRAGMA index_info("+sqlitePragmaName(sqliteIndex.name)+")")
		if err != nil {
			return err
		}
		for info.Next() {
			var seq, cid int
			var column sql.NullString
			if err := info.Scan(&seq, &cid, &column); err != nil {
				info.Close()
				return err
			}
			if column.Valid {
				index.Columns = append(index.Columns, column.String)
			}
		}
		if err := info.Close(); err != nil {
			return err
		}
		table.Indexes = append(table.Indexes, index)
	}
	return rows.Err()
}

func appendForeignKeys(ctx context.Context, db *DB, tableName string, table *TableSummary) error {
	if db.Driver == "mysql" {
		rows, err := db.QueryContext(ctx, `SELECT k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r USING (constraint_schema, constraint_name) WHERE k.constraint_schema = DATABASE() AND k.table_name = ? AND k.referenced_table_name IS NOT NULL ORDER BY k.constraint_name, k.ordinal_position`, tableName)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var fk ForeignKeyInfo
			if err := rows.Scan(&fk.Name, &fk.Column, &fk.RefTable, &fk.RefColumn, &fk.OnUpdate, &fk.OnDelete); err != nil {
				return err
			}
			table.ForeignKeys = append(table.ForeignKeys, fk)
		}
		return rows.Err()
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_list("+sqlitePragmaName(tableName)+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, seq int
		var refTable, from, to, onUpdate, onDelete, match string
		if err := rows.Scan(&id, &seq, &refTable, &from, &to, &onUpdate, &onDelete, &match); err != nil {
			return err
		}
		table.ForeignKeys = append(table.ForeignKeys, ForeignKeyInfo{Column: from, RefTable: refTable, RefColumn: to, OnUpdate: onUpdate, OnDelete: onDelete})
	}
	return rows.Err()
}

func sqlitePragmaName(name string) string { return "'" + strings.ReplaceAll(name, "'", "''") + "'" }
