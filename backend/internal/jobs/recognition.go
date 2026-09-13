package jobs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

var ErrSchemaUnavailable = errors.New("worker schema is not installed")

type RecognitionReport struct {
	Expired         int  `json:"expired"`
	OutboxProcessed int  `json:"outbox_processed"`
	OutboxFailed    int  `json:"outbox_failed"`
	Pending         int  `json:"pending"`
	DryRun          bool `json:"dry_run"`
}

// RunRecognition ports the durable part of recognition_worker.php. Expiry is
// an idempotent status transition; notification delivery is an outbox
// transition, so a process crash leaves the task pending instead of silently
// losing it. Unknown task types are never acknowledged.
func RunRecognition(ctx context.Context, db *sqlstore.DB, dryRun bool) (RecognitionReport, error) {
	report := RecognitionReport{DryRun: dryRun}
	var err error
	for _, table := range []string{"recognition_credentials", "recognition_outbox"} {
		exists, err := db.TableExists(ctx, table)
		if err != nil {
			return report, err
		}
		if !exists {
			return report, fmt.Errorf("%w: %s", ErrSchemaUnavailable, table)
		}
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM recognition_outbox WHERE status='pending'").Scan(&report.Pending); err != nil {
		return report, err
	}
	if dryRun {
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM recognition_credentials WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP").Scan(&report.Expired); err != nil {
			return report, err
		}
		return report, nil
	}
	report.Expired, err = expireCredentials(ctx, db, 200)
	if err != nil {
		return report, err
	}
	processed, failed, err := processRecognitionOutbox(ctx, db, 100)
	report.OutboxProcessed, report.OutboxFailed = processed, failed
	return report, err
}

func expireCredentials(ctx context.Context, db *sqlstore.DB, limit int) (int, error) {
	rows, err := db.QueryContext(ctx, `SELECT id,credential_uid,holder_user_id,badge_id,program_id
		FROM recognition_credentials WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP ORDER BY id LIMIT ?`, limit)
	if err != nil {
		return 0, err
	}
	type credential struct {
		id, userID, badgeID, programID int64
		uid                            string
	}
	credentials := []credential{}
	for rows.Next() {
		var item credential
		if err := rows.Scan(&item.id, &item.uid, &item.userID, &item.badgeID, &item.programID); err != nil {
			rows.Close()
			return 0, err
		}
		credentials = append(credentials, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(credentials) == 0 {
		return 0, nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for _, item := range credentials {
		result, err := tx.ExecContext(ctx, `UPDATE recognition_credentials SET status='expired' WHERE id=? AND status='active' AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP`, item.id)
		if err != nil {
			return 0, err
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			continue
		}
		payload, _ := json.Marshal(map[string]any{"credential_id": item.id, "user_id": item.userID, "badge_id": item.badgeID, "program_id": item.programID, "credential_uid": item.uid})
		if _, err := tx.ExecContext(ctx, "INSERT INTO recognition_outbox(task_type,payload) VALUES(?,?)", "notify_credential_expired", string(payload)); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(credentials), nil
}

func processRecognitionOutbox(ctx context.Context, db *sqlstore.DB, limit int) (int, int, error) {
	rows, err := db.QueryContext(ctx, `SELECT id,task_type,COALESCE(payload,'[]'),attempts FROM recognition_outbox WHERE status='pending' ORDER BY id LIMIT ?`, limit)
	if err != nil {
		return 0, 0, err
	}
	type task struct {
		id                int64
		taskType, payload string
		attempts          int
	}
	tasks := []task{}
	for rows.Next() {
		var item task
		if err := rows.Scan(&item.id, &item.taskType, &item.payload, &item.attempts); err != nil {
			rows.Close()
			return 0, 0, err
		}
		tasks = append(tasks, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()
	processed, failed := 0, 0
	for _, item := range tasks {
		payload := map[string]any{}
		decodeErr := json.Unmarshal([]byte(item.payload), &payload)
		tx, txErr := db.BeginTx(ctx, nil)
		if txErr != nil {
			return processed, failed, txErr
		}
		handleErr := error(nil)
		if decodeErr != nil {
			handleErr = errors.New("outbox payload is invalid")
		} else {
			handleErr = handleRecognitionNotification(ctx, tx, item.taskType, payload)
		}
		if handleErr == nil {
			if _, txErr = tx.ExecContext(ctx, "UPDATE recognition_outbox SET status='done', processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'", item.id); txErr == nil {
				txErr = tx.Commit()
			}
			if txErr != nil {
				_ = tx.Rollback()
				return processed, failed, txErr
			}
			processed++
			continue
		}
		_ = tx.Rollback()
		attempts := item.attempts + 1
		status := "pending"
		if attempts >= 5 {
			status = "failed"
		}
		if _, txErr = db.ExecContext(ctx, "UPDATE recognition_outbox SET attempts=?,status=?,last_error=? WHERE id=? AND status='pending'", attempts, status, truncateError(handleErr.Error()), item.id); txErr != nil {
			return processed, failed, txErr
		}
		failed++
	}
	return processed, failed, nil
}

func handleRecognitionNotification(ctx context.Context, tx *sql.Tx, taskType string, payload map[string]any) error {
	userID := int64Value(payload["user_id"])
	credentialID := int64Value(payload["credential_id"])
	if userID <= 0 || credentialID <= 0 {
		return errors.New("notification payload is incomplete")
	}
	var title, message, link string
	switch taskType {
	case "notify_credential_issued":
		title, message = "获得新徽章："+stringValue(payload["badge_name"]), "你通过了「"+stringValue(payload["program_title"])+"」，获得来自同好会的认可。"
		link = "/verify.html?uid=" + stringValue(payload["credential_uid"])
	case "notify_credential_revoked":
		title, message, link = "凭证状态变更："+stringValue(payload["badge_name"]), "你的凭证已被签发方撤销（"+firstNonEmpty(stringValue(payload["reason"]), "未说明原因")+"）。该记录仍保留在你的履历中。", "/user.html?tab=achievements"
	case "notify_credential_expired":
		title, message, link = "凭证已过期："+stringValue(payload["badge_name"]), "你在「"+stringValue(payload["program_title"])+"」获得的凭证已过有效期，历史记录仍可在成就库查看。", "/user.html?tab=achievements"
	default:
		return fmt.Errorf("unknown recognition task type: %s", taskType)
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO notifications(user_id,type,title,message,link,related_type,related_id) VALUES(?,?,?,?,?,?,?)`, userID, strings.TrimPrefix(taskType, "notify_"), title, message, link, "recognition_credential", credentialID)
	return err
}

func int64Value(value any) int64 {
	switch item := value.(type) {
	case int64:
		return item
	case int:
		return int64(item)
	case float64:
		return int64(item)
	case json.Number:
		value, _ := item.Int64()
		return value
	case string:
		var result int64
		_, _ = fmt.Sscan(item, &result)
		return result
	default:
		return 0
	}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func firstNonEmpty(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func truncateError(value string) string {
	if len(value) > 480 {
		return value[:480]
	}
	return value
}
