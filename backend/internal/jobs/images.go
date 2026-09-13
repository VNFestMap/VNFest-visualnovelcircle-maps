package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
	_ "golang.org/x/image/webp"
)

type ImageMigrationOptions struct {
	DryRun              bool
	Verify              bool
	Resume              bool
	Rewrite             bool
	IncludePublications bool
	Limit               int
}

type ImageMigrationReport struct {
	Discovered   int  `json:"discovered"`
	Checked      int  `json:"checked"`
	Uploaded     int  `json:"uploaded"`
	Skipped      int  `json:"skipped"`
	Failed       int  `json:"failed"`
	Verified     int  `json:"verified"`
	VerifyFailed int  `json:"verify_failed"`
	Rewritten    int  `json:"rewritten"`
	DryRun       bool `json:"dry_run"`
	VerifyMode   bool `json:"verify"`
}

type imageManifest struct {
	Version int                           `json:"version"`
	Entries map[string]imageManifestEntry `json:"entries"`
}

type imageManifestEntry struct {
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	URL          string `json:"url,omitempty"`
	RemoteKey    string `json:"remote_key,omitempty"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
	Deduplicated bool   `json:"deduplicated,omitempty"`
	VerifiedAt   string `json:"verified_at,omitempty"`
	VerifyStatus string `json:"verify_status,omitempty"`
	UpdatedAt    string `json:"updated_at"`
}

type migrationImage struct {
	Relative string
	Absolute string
	MIME     string
	Size     int64
}

// RunImageMigration ports migrate-images-to-picui.php. Local files are never
// removed: a remote upload or a rewrite failure leaves the local source and
// the manifest available for a later --resume run.
func RunImageMigration(ctx context.Context, db *sqlstore.DB, cfg config.Config, options ImageMigrationOptions) (ImageMigrationReport, error) {
	report := ImageMigrationReport{DryRun: options.DryRun, VerifyMode: options.Verify}
	runtimeDir := filepath.Join(cfg.DataDir, "image-host")
	manifestPath := filepath.Join(runtimeDir, "manifest.json")
	manifest, err := readImageManifest(manifestPath)
	if err != nil {
		return report, err
	}
	if options.Verify {
		for relative, entry := range manifest.Entries {
			if entry.Status != "uploaded" || !trustedImageURL(entry.URL, cfg.PicUIAllowedHosts) {
				continue
			}
			report.Checked++
			ok := verifyRemoteImage(ctx, entry.URL, cfg.PicUITimeout)
			entry.VerifiedAt = time.Now().Format(time.RFC3339)
			if ok {
				entry.VerifyStatus = "ok"
				report.Verified++
			} else {
				entry.VerifyStatus = "failed"
				report.VerifyFailed++
			}
			manifest.Entries[relative] = entry
		}
		if err := writeImageManifest(manifestPath, manifest); err != nil {
			return report, err
		}
		return report, nil
	}
	files, err := collectMigrationImages(ctx, db, cfg, options.IncludePublications)
	if err != nil {
		return report, err
	}
	report.Discovered = len(files)
	if options.DryRun {
		return report, nil
	}
	if !cfg.PicUIEnabled || strings.TrimSpace(cfg.PicUIToken) == "" {
		return report, errors.New("PICUI_ENABLED and PICUI_TOKEN must be configured for upload/rewrite; use --dry-run for inventory")
	}
	seen := map[string]string{}
	for relative, entry := range manifest.Entries {
		if entry.Status == "uploaded" && trustedImageURL(entry.URL, cfg.PicUIAllowedHosts) {
			seen[entry.SHA256] = entry.URL
		}
		_ = relative
	}
	uploadedThisRun := 0
	for _, file := range files {
		report.Checked++
		hash, err := hashFile(file.Absolute)
		if err != nil {
			report.Failed++
			continue
		}
		existing := manifest.Entries[file.Relative]
		if existing.SHA256 == hash && existing.Status == "uploaded" && trustedImageURL(existing.URL, cfg.PicUIAllowedHosts) {
			report.Skipped++
			continue
		}
		if existingURL := seen[hash]; existingURL != "" {
			manifest.Entries[file.Relative] = imageManifestEntry{SHA256: hash, Size: file.Size, URL: existingURL, Status: "uploaded", Deduplicated: true, UpdatedAt: time.Now().Format(time.RFC3339)}
			report.Skipped++
			if err := writeImageManifest(manifestPath, manifest); err != nil {
				return report, err
			}
			continue
		}
		remote, uploadErr := uploadImage(ctx, cfg, file)
		if uploadErr == nil {
			seen[hash] = remote.URL
			manifest.Entries[file.Relative] = imageManifestEntry{SHA256: hash, Size: file.Size, URL: remote.URL, RemoteKey: remote.Key, Status: "uploaded", UpdatedAt: time.Now().Format(time.RFC3339)}
			report.Uploaded++
			uploadedThisRun++
		} else {
			manifest.Entries[file.Relative] = imageManifestEntry{SHA256: hash, Size: file.Size, Status: "failed", Error: truncateError(uploadErr.Error()), UpdatedAt: time.Now().Format(time.RFC3339)}
			report.Failed++
		}
		if err := writeImageManifest(manifestPath, manifest); err != nil {
			return report, err
		}
		if options.Limit > 0 && uploadedThisRun >= options.Limit {
			break
		}
	}
	if options.Rewrite {
		backupRoot := filepath.Join(runtimeDir, "backups", time.Now().Format("20060102150405"))
		mapping := remoteImageMap(manifest, options.IncludePublications)
		count, err := rewriteImageReferences(ctx, cfg.Root, backupRoot, mapping)
		if err != nil {
			return report, err
		}
		databaseCount, err := rewriteDatabaseImageReferences(ctx, db, backupRoot, mapping)
		if err != nil {
			return report, err
		}
		report.Rewritten = count + databaseCount
	}
	return report, nil
}

func readImageManifest(path string) (imageManifest, error) {
	manifest := imageManifest{Version: 1, Entries: map[string]imageManifestEntry{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return manifest, nil
	}
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return imageManifest{}, fmt.Errorf("invalid image manifest: %w", err)
	}
	if manifest.Version == 0 {
		manifest.Version = 1
	}
	if manifest.Entries == nil {
		manifest.Entries = map[string]imageManifestEntry{}
	}
	return manifest, nil
}

func writeImageManifest(path string, manifest imageManifest) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".manifest-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Rename is atomic when the destination does not exist. Windows refuses to
	// replace an existing destination, so keep a recoverable copy and restore it
	// if the replacement step fails. This makes a failed checkpoint write leave
	// the previous valid manifest intact on every supported development host.
	oldData, oldErr := os.ReadFile(path)
	if oldErr != nil && !errors.Is(oldErr, os.ErrNotExist) {
		return oldErr
	}
	if err := os.Rename(tmpName, path); err == nil {
		return nil
	}
	if len(oldData) == 0 && errors.Is(oldErr, os.ErrNotExist) {
		return fmt.Errorf("replace image manifest: destination rename failed")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.WriteFile(path, oldData, 0o600)
		return err
	}
	return nil
}

func collectMigrationImages(ctx context.Context, db *sqlstore.DB, cfg config.Config, includePublications bool) ([]migrationImage, error) {
	files := map[string]migrationImage{}
	for _, relative := range []string{"data/avatars", "data/club_avatars", "data/event_images", "data/publication_images", "wiki/uploads"} {
		if err := collectImageDir(cfg.Root, relative, files); err != nil {
			return nil, err
		}
	}
	if includePublications {
		_ = collectImageDir(cfg.Root, "uploads/publication_previews", files)
	}
	if exists, err := db.TableExists(ctx, "galonly_applications"); err == nil && exists {
		rows, queryErr := db.QueryContext(ctx, `SELECT image_path,display_image,merchandise_items FROM galonly_applications WHERE status IN ('approved','confirmed','shared')`)
		if queryErr == nil {
			defer rows.Close()
			for rows.Next() {
				var imagePath, display, merchandise sql.NullString
				if err := rows.Scan(&imagePath, &display, &merchandise); err != nil {
					return nil, err
				}
				for _, value := range []sql.NullString{imagePath, display, merchandise} {
					collectImageStrings(cfg.Root, value.String, files)
				}
			}
			if err := rows.Err(); err != nil {
				return nil, err
			}
		}
	}
	result := make([]migrationImage, 0, len(files))
	for _, file := range files {
		result = append(result, file)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Relative < result[j].Relative })
	return result, nil
}

func collectImageDir(root, relative string, files map[string]migrationImage) error {
	dir := filepath.Join(root, filepath.FromSlash(relative))
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		file, ok := detectMigrationImage(path)
		if !ok {
			return nil
		}
		relativePath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		file.Relative = filepath.ToSlash(relativePath)
		files[file.Relative] = file
		return nil
	})
}

func collectImageStrings(root, value string, files map[string]migrationImage) {
	var decoded any
	if json.Unmarshal([]byte(value), &decoded) == nil {
		collectImageValue(root, decoded, files)
		return
	}
	collectImageValue(root, value, files)
}

func collectImageValue(root string, value any, files map[string]migrationImage) {
	switch typed := value.(type) {
	case string:
		parsed, err := url.Parse(typed)
		candidate := typed
		if err == nil && parsed.Path != "" {
			candidate = parsed.Path
		}
		candidate = strings.TrimLeft(filepath.ToSlash(strings.TrimSpace(candidate)), "/")
		if strings.HasPrefix(candidate, "uploads/galonly/") && !strings.Contains(candidate, "..") {
			if file, ok := detectMigrationImage(filepath.Join(root, filepath.FromSlash(candidate))); ok {
				file.Relative = candidate
				files[candidate] = file
			}
		}
	case []any:
		for _, child := range typed {
			collectImageValue(root, child, files)
		}
	case map[string]any:
		for _, child := range typed {
			collectImageValue(root, child, files)
		}
	}
}

func detectMigrationImage(path string) (migrationImage, bool) {
	fileInfo, err := os.Stat(path)
	if err != nil || !fileInfo.Mode().IsRegular() {
		return migrationImage{}, false
	}
	file, err := os.Open(path)
	if err != nil {
		return migrationImage{}, false
	}
	config, format, decodeErr := image.DecodeConfig(file)
	_ = file.Close()
	if decodeErr != nil || config.Width < 1 || config.Height < 1 {
		return migrationImage{}, false
	}
	mimeType := map[string]string{"jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}[strings.ToLower(format)]
	if mimeType == "" {
		return migrationImage{}, false
	}
	return migrationImage{Absolute: path, MIME: mimeType, Size: fileInfo.Size()}, true
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type remoteImage struct{ URL, Key string }

func uploadImage(ctx context.Context, cfg config.Config, file migrationImage) (remoteImage, error) {
	data, err := os.ReadFile(file.Absolute)
	if err != nil {
		return remoteImage{}, err
	}
	for attempt := 1; attempt <= 3; attempt++ {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", filepath.Base(file.Relative))
		if err != nil {
			return remoteImage{}, err
		}
		if _, err := part.Write(data); err != nil {
			return remoteImage{}, err
		}
		_ = writer.WriteField("permission", fmt.Sprint(cfg.PicUIPermission))
		if err := writer.Close(); err != nil {
			return remoteImage{}, err
		}
		requestCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.PicUITimeout)*time.Second)
		request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, strings.TrimRight(cfg.PicUIAPIURL, "/")+"/upload", &body)
		if err != nil {
			cancel()
			return remoteImage{}, err
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Authorization", "Bearer "+cfg.PicUIToken)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		response, err := (&http.Client{Timeout: time.Duration(cfg.PicUITimeout) * time.Second}).Do(request)
		cancel()
		if err != nil {
			if attempt < 3 {
				continue
			}
			return remoteImage{}, errors.New("picui network error")
		}
		responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		_ = response.Body.Close()
		if readErr == nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			var payload struct {
				Status  bool   `json:"status"`
				Message string `json:"message"`
				Data    struct {
					Key   string `json:"key"`
					Links struct {
						URL string `json:"url"`
					} `json:"links"`
				} `json:"data"`
			}
			if json.Unmarshal(responseBody, &payload) == nil && payload.Status && trustedImageURL(payload.Data.Links.URL, cfg.PicUIAllowedHosts) {
				return remoteImage{URL: payload.Data.Links.URL, Key: payload.Data.Key}, nil
			}
			return remoteImage{}, errors.New("picui returned no trusted image URL")
		}
		if response.StatusCode != http.StatusTooManyRequests && response.StatusCode < 500 {
			return remoteImage{}, fmt.Errorf("picui HTTP %d", response.StatusCode)
		}
	}
	return remoteImage{}, errors.New("picui upload failed")
}

func trustedImageURL(raw string, allowed []string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	for _, item := range allowed {
		item = strings.ToLower(strings.TrimSpace(item))
		if host == item || strings.HasSuffix(host, "."+strings.TrimPrefix(item, ".")) {
			return true
		}
	}
	return false
}

func verifyRemoteImage(ctx context.Context, raw string, timeout int) bool {
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodHead, raw, nil)
	if err != nil {
		return false
	}
	response, err := (&http.Client{Timeout: time.Duration(timeout) * time.Second}).Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= 200 && response.StatusCode < 400 && strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "image/")
}

func remoteImageMap(manifest imageManifest, includePublications bool) map[string]string {
	result := map[string]string{}
	for relative, entry := range manifest.Entries {
		if !includePublications && strings.HasPrefix(relative, "uploads/publication_previews/") {
			continue
		}
		if entry.Status == "uploaded" && entry.URL != "" {
			result[filepath.ToSlash(relative)] = entry.URL
		}
	}
	return result
}

func rewriteImageReferences(ctx context.Context, root, backupRoot string, mapping map[string]string) (int, error) {
	if len(mapping) == 0 {
		return 0, nil
	}
	for key := range mapping {
		mapping[key] = strings.TrimSpace(mapping[key])
	}
	files := []string{}
	for _, pattern := range []string{filepath.Join(root, "data", "*.json")} {
		matches, _ := filepath.Glob(pattern)
		files = append(files, matches...)
	}
	for _, directory := range []string{"wiki/content", "wiki/guide/seed"} {
		_ = filepath.WalkDir(filepath.Join(root, filepath.FromSlash(directory)), func(path string, entry os.DirEntry, err error) error {
			if err == nil && entry != nil && !entry.IsDir() && strings.EqualFold(filepath.Ext(path), ".json") {
				files = append(files, path)
			}
			return err
		})
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry == nil {
			return nil
		}
		if entry.IsDir() {
			relative, _ := filepath.Rel(root, path)
			if shouldSkipImageRewritePath(filepath.ToSlash(relative)) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ".html") && !shouldSkipImageRewritePath(relativeImagePath(root, path)) {
			files = append(files, path)
		}
		return nil
	})
	files = uniqueStrings(files)
	replacements := 0
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return replacements, err
		}
		text := string(data)
		next := text
		next, count := replaceImageReferenceText(next, mapping)
		if count == 0 || next == text {
			continue
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return replacements, err
		}
		backup := filepath.Join(backupRoot, relative)
		if err := os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
			return replacements, err
		}
		if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(backup, data, 0o600); err != nil {
				return replacements, err
			}
		}
		if err := writeImageFileAtomic(file, []byte(next), 0o644); err != nil {
			return replacements, err
		}
		replacements += count
	}
	return replacements, nil
}

func relativeImagePath(root, file string) string {
	relative, err := filepath.Rel(root, file)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(relative)
}

func shouldSkipImageRewritePath(relative string) bool {
	relative = filepath.ToSlash(relative)
	for strings.HasPrefix(relative, "./") {
		relative = strings.TrimPrefix(relative, "./")
	}
	relative = strings.TrimPrefix(relative, "/")
	lower := strings.ToLower(relative)
	for _, prefix := range []string{".git/", ".codex-backups/", "data/image-host/", "vendor/", "node_modules/", "_deploy_backup_", "_archify_work/", "wiki.bak-"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func replaceImageReferenceText(text string, mapping map[string]string) (string, int) {
	keys := make([]string, 0, len(mapping))
	for key := range mapping {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	count := 0
	for _, key := range keys {
		aliases := imageAliases(key)
		sort.Slice(aliases, func(i, j int) bool { return len(aliases[i]) > len(aliases[j]) })
		for _, alias := range aliases {
			if strings.Contains(text, alias) {
				text = strings.ReplaceAll(text, alias, mapping[key])
				count++
			}
		}
	}
	return text, count
}

func writeImageFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".image-rewrite-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err == nil {
		return nil
	}
	old, readErr := os.ReadFile(path)
	if readErr != nil {
		return readErr
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.WriteFile(path, old, mode)
		return err
	}
	return nil
}

type imageDBRewrite struct {
	Table       string
	Primary     string
	ID          any
	Before      map[string]any
	Assignments map[string]string
}

// rewriteDatabaseImageReferences ports the PHP migration's allowlisted
// database pass. Only columns known to contain public image references are
// touched, and every changed value is recorded before one transaction commits.
func rewriteDatabaseImageReferences(ctx context.Context, db *sqlstore.DB, backupRoot string, mapping map[string]string) (int, error) {
	if db == nil || len(mapping) == 0 {
		return 0, nil
	}
	tableNames, err := imageTableNames(ctx, db)
	if err != nil {
		return 0, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	allowed := map[string]bool{"avatar_url": true, "image_url": true, "cover_image": true, "display_image": true, "image_path": true, "merchandise_items": true, "option_images": true}
	rewrites := []imageDBRewrite{}
	count := 0
	for _, table := range tableNames {
		columns, primary, err := imageTableColumns(ctx, tx, db.Driver, table)
		if err != nil {
			return count, err
		}
		targets := []string{}
		for _, column := range columns {
			if allowed[column] {
				targets = append(targets, column)
			}
		}
		if primary == "" || len(targets) == 0 {
			continue
		}
		selectColumns := append([]string{primary}, targets...)
		quoted := make([]string, 0, len(selectColumns))
		for _, column := range selectColumns {
			quoted = append(quoted, imageQuoteIdentifier(db.Driver, column))
		}
		rows, err := tx.QueryContext(ctx, "SELECT "+strings.Join(quoted, ",")+" FROM "+imageQuoteIdentifier(db.Driver, table))
		if err != nil {
			return count, err
		}
		for rows.Next() {
			values := make([]any, len(selectColumns))
			pointers := make([]any, len(values))
			for index := range values {
				pointers[index] = &values[index]
			}
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				return count, err
			}
			assignments := map[string]string{}
			before := map[string]any{}
			for index, column := range targets {
				source, ok := imageDatabaseString(values[index+1])
				if !ok {
					continue
				}
				next, replacements := replaceImageReferenceText(source, mapping)
				if replacements > 0 && next != source {
					assignments[column] = next
					before[column] = source
					count += replacements
				}
			}
			if len(assignments) > 0 {
				rewrites = append(rewrites, imageDBRewrite{Table: table, Primary: primary, ID: imageDatabaseValue(values[0]), Before: before, Assignments: assignments})
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return count, err
		}
		if err := rows.Close(); err != nil {
			return count, err
		}
	}
	if len(rewrites) == 0 {
		return 0, nil
	}
	if err := os.MkdirAll(backupRoot, 0o755); err != nil {
		return count, err
	}
	backup := make([]map[string]any, 0, len(rewrites))
	for _, rewrite := range rewrites {
		sets := make([]string, 0, len(rewrite.Assignments))
		args := make([]any, 0, len(rewrite.Assignments)+1)
		for column, value := range rewrite.Assignments {
			sets = append(sets, imageQuoteIdentifier(db.Driver, column)+"=?")
			args = append(args, value)
		}
		args = append(args, rewrite.ID)
		query := "UPDATE " + imageQuoteIdentifier(db.Driver, rewrite.Table) + " SET " + strings.Join(sets, ",") + " WHERE " + imageQuoteIdentifier(db.Driver, rewrite.Primary) + "=?"
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return count, err
		}
		backup = append(backup, map[string]any{"table": rewrite.Table, "id_column": rewrite.Primary, "id": rewrite.ID, "values": rewrite.Before})
	}
	data, err := json.MarshalIndent(backup, "", "  ")
	if err != nil {
		return count, err
	}
	if err := writeImageFileAtomic(filepath.Join(backupRoot, "database-before-rewrite.json"), data, 0o600); err != nil {
		return count, err
	}
	if err := tx.Commit(); err != nil {
		return count, err
	}
	return count, nil
}

func imageTableNames(ctx context.Context, db *sqlstore.DB) ([]string, error) {
	query := "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
	if db.Driver == "mysql" {
		query = "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name"
	}
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func imageTableColumns(ctx context.Context, tx *sql.Tx, driver, table string) ([]string, string, error) {
	columns := []string{}
	primary := ""
	if driver == "mysql" {
		rows, err := tx.QueryContext(ctx, "SHOW COLUMNS FROM "+imageQuoteIdentifier(driver, table))
		if err != nil {
			return nil, "", err
		}
		defer rows.Close()
		for rows.Next() {
			var field, typ, nullable, key, extra string
			var defaultValue any
			if err := rows.Scan(&field, &typ, &nullable, &key, &defaultValue, &extra); err != nil {
				return nil, "", err
			}
			columns = append(columns, field)
			if key == "PRI" && primary == "" {
				primary = field
			}
		}
		return columns, primary, rows.Err()
	}
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+imageQuoteIdentifier(driver, table)+")")
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return nil, "", err
		}
		columns = append(columns, name)
		if pk == 1 && primary == "" {
			primary = name
		}
	}
	return columns, primary, rows.Err()
}

func imageQuoteIdentifier(driver, value string) string {
	if driver == "mysql" {
		return "`" + strings.ReplaceAll(value, "`", "``") + "`"
	}
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func imageDatabaseString(value any) (string, bool) {
	switch typed := value.(type) {
	case nil:
		return "", false
	case string:
		return typed, true
	case []byte:
		return string(typed), true
	default:
		return fmt.Sprint(typed), true
	}
}

func imageDatabaseValue(value any) any {
	if typed, ok := value.([]byte); ok {
		return string(typed)
	}
	return value
}

func imageAliases(relative string) []string {
	aliases := []string{relative, "./" + relative, "../" + relative}
	if strings.HasPrefix(relative, "wiki/uploads/") {
		rest := strings.TrimPrefix(relative, "wiki/uploads/")
		aliases = append(aliases, "../uploads/"+rest, "./uploads/"+rest)
	}
	if strings.HasPrefix(relative, "uploads/") || strings.HasPrefix(relative, "data/") {
		aliases = append(aliases, "../"+relative)
	}
	return uniqueStrings(aliases)
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
