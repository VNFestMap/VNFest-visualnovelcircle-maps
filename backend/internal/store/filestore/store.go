package filestore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Store struct {
	DataRoot   string
	UploadRoot string
	locks      sync.Map
}

func New(dataRoot, uploadRoot string) *Store {
	return &Store{DataRoot: filepath.Clean(dataRoot), UploadRoot: filepath.Clean(uploadRoot)}
}

func (s *Store) ReadJSON(ctx context.Context, name string, dst any) error {
	path, err := s.safePath(s.DataRoot, name)
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}
	return nil
}

func (s *Store) WriteJSONAtomic(ctx context.Context, name string, value any) error {
	path, err := s.safePath(s.DataRoot, name)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(value, "", "    ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", name, err)
	}
	return s.atomicWrite(ctx, path, encoded, 0o644)
}

func (s *Store) SaveUpload(ctx context.Context, relativePath string, r io.Reader) error {
	path, err := s.safePath(s.UploadRoot, relativePath)
	if err != nil {
		return err
	}
	return s.atomicCopy(ctx, path, r, 0o644)
}

// SaveData is the data-volume counterpart of SaveUpload. It is used for
// files whose public URL intentionally lives under data/, while retaining the
// same path validation and atomic-write protections.
func (s *Store) SaveData(ctx context.Context, relativePath string, r io.Reader) error {
	path, err := s.safePath(s.DataRoot, relativePath)
	if err != nil {
		return err
	}
	return s.atomicCopy(ctx, path, r, 0o644)
}

func (s *Store) OpenUpload(ctx context.Context, relativePath string) (io.ReadCloser, error) {
	path, err := s.safePath(s.UploadRoot, relativePath)
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return os.Open(path)
}

// OpenData is the read counterpart of SaveData. It is kept separate from
// OpenUpload because data/ and uploads/ are independent mounted volumes in
// production. Public-image promotion uses it for legacy GalOnly files that
// were written by older Go/PHP code under data/.
func (s *Store) OpenData(ctx context.Context, relativePath string) (io.ReadCloser, error) {
	path, err := s.safePath(s.DataRoot, relativePath)
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return os.Open(path)
}

// DeleteUpload removes one explicitly requested upload after its owner has
// been checked by the HTTP layer. It is intentionally not used by migration
// or cleanup jobs; those paths must preserve historical files. The same lock
// used by atomic writes prevents a delete from racing with an upload replace.
func (s *Store) DeleteUpload(ctx context.Context, relativePath string) error {
	path, err := s.safePath(s.UploadRoot, relativePath)
	if err != nil {
		return err
	}
	return s.withLock(ctx, path, func() error {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return os.ErrNotExist
		}
		return err
	})
}

func (s *Store) atomicCopy(ctx context.Context, path string, r io.Reader, mode os.FileMode) error {
	return s.withLock(ctx, path, func() error {
		if existing, err := os.Stat(path); err == nil {
			mode = existing.Mode().Perm()
		}
		tmp, err := s.tempPath(path)
		if err != nil {
			return err
		}
		defer os.Remove(tmp)
		file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		copyErr := copyWithContext(ctx, file, r)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		return s.replace(path, tmp)
	})
}

func (s *Store) atomicWrite(ctx context.Context, path string, data []byte, mode os.FileMode) error {
	return s.atomicCopy(ctx, path, strings.NewReader(string(data)), mode)
}

func (s *Store) replace(path, tmp string) error {
	if err := os.Rename(tmp, path); err == nil {
		return nil
	}
	// Windows cannot rename over an existing file. The lock keeps this
	// fallback safe within this process; failure still leaves the original.
	if _, err := os.Stat(path); err == nil {
		backup := path + ".vnfest-replace-" + fmt.Sprint(time.Now().UnixNano())
		if err := os.Rename(path, backup); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Rename(backup, path)
			return err
		}
		return os.Remove(backup)
	}
	return os.Rename(tmp, path)
}

func (s *Store) tempPath(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s.tmp-%d-%d", path, os.Getpid(), rand.Int63()), nil
}

func (s *Store) withLock(ctx context.Context, path string, fn func() error) error {
	value, _ := s.locks.LoadOrStore(path, &sync.Mutex{})
	mutex := value.(*sync.Mutex)
	mutex.Lock()
	defer mutex.Unlock()

	lockPath := path + ".lock"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var lockFile *os.File
	deadline := time.Now().Add(10 * time.Second)
	for lockFile == nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		file, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			lockFile = file
			break
		}
		if !os.IsExist(err) {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for file lock %s", filepath.Base(lockPath))
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()
	return fn()
}

func (s *Store) safePath(root, name string) (string, error) {
	// Normalize both separator styles before validating. filepath.Clean only
	// understands the host OS separator, so validating a Windows-shaped path
	// on Linux would otherwise treat "..\\outside" as a literal filename.
	normalized := strings.ReplaceAll(name, "\\", "/")
	if name == "" || filepath.IsAbs(name) || path.IsAbs(normalized) ||
		strings.HasPrefix(normalized, "/") ||
		(len(normalized) >= 2 && normalized[1] == ':') {
		return "", errors.New("file path must be relative")
	}
	cleanSlash := path.Clean(normalized)
	if cleanSlash == "." || cleanSlash == ".." || strings.HasPrefix(cleanSlash, "../") {
		return "", errors.New("file path escapes storage root")
	}
	clean := filepath.FromSlash(cleanSlash)
	path := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("file path escapes storage root")
	}
	return path, nil
}

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) error {
	buffer := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			if _, err := dst.Write(buffer[:n]); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}
