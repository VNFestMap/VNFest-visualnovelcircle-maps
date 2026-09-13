package jobs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var ErrAlreadyRunning = errors.New("job is already running")

type Lock struct {
	path string
	file *os.File
}

func Acquire(dir, name string) (*Lock, error) {
	if name == "" || filepath.Base(name) != name {
		return nil, fmt.Errorf("invalid job name")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, ".vnfest-"+name+".lock")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return nil, ErrAlreadyRunning
		}
		return nil, err
	}
	if _, err := fmt.Fprintf(file, "pid=%d\nstarted_at=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		file.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return &Lock{path: path, file: file}, nil
}

func (l *Lock) Close() error {
	if l == nil {
		return nil
	}
	if err := l.file.Close(); err != nil {
		_ = os.Remove(l.path)
		return err
	}
	return os.Remove(l.path)
}
