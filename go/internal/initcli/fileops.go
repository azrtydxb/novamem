package initcli

// Filesystem helpers — small wrappers that consolidate the edge cases we
// need across installers (missing files, writes that create their parent
// directories, recursive copy of the bundled skill assets).

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Exists reports whether a path exists (any kind of entry). Like the
// TypeScript `fs.access` probe it follows symlinks, so a dangling link
// counts as absent.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ReadFileMaybe reads a file as UTF-8 text, returning ok=false when the
// file does not exist. Any other error (permissions, a directory in the
// way) is returned — a missing file is the only outcome that is not an
// error.
func ReadFileMaybe(path string) (content string, ok bool, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(b), true, nil
}

// WriteFileEnsureDir writes a file, creating parent directories as
// needed.
func WriteFileEnsureDir(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// CopyDir recursively copies a directory tree; idempotent (overwrites).
// Only directories and regular files are copied — symlinks, sockets and
// devices in the bundled assets are skipped, matching the TypeScript
// original's isDirectory()/isFile() filter. The executable bit is
// preserved so shipped hook scripts stay runnable.
func CopyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, ent := range entries {
		from := filepath.Join(src, ent.Name())
		to := filepath.Join(dst, ent.Name())
		switch {
		case ent.IsDir():
			if err := CopyDir(from, to); err != nil {
				return err
			}
		case ent.Type().IsRegular():
			if err := copyFile(from, to); err != nil {
				return err
			}
		}
	}
	return nil
}

// copyFile copies one regular file, overwriting the destination and
// giving it the source's permission bits.
func copyFile(from, to string) error {
	info, err := os.Stat(from)
	if err != nil {
		return err
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }() // read side: a failed close cannot lose data
	// Truncate rather than append: copy is idempotent, and the mode is
	// re-applied below because O_CREATE only honours it for a new file.
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(to, info.Mode().Perm())
}

// trimTrailingSlash normalises a base URL before it is stored in a
// config or joined with a path — the TypeScript installer did the same,
// so "https://x/" and "https://x" produce identical config bytes.
func trimTrailingSlash(s string) string {
	return strings.TrimSuffix(s, "/")
}
