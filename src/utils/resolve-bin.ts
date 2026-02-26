import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cache = new Map<string, string>();
const isWin = process.platform === 'win32';

/**
 * Check if a resolved path is a valid executable file.
 * Follows symlinks (required for Homebrew, snap, etc.).
 */
function isValidExecutable(filePath: string): boolean {
  try {
    // Resolve symlinks first, then validate the target
    const resolved = fs.realpathSync(filePath);
    const stats = fs.statSync(resolved);
    if (!stats.isFile()) return false;
    // On non-Windows, check executable bit
    if (!isWin && !(stats.mode & 0o111)) return false;
    return true;
  } catch {
    return false;
  }
}

function getSearchDirs(): string[] {
  const home = os.homedir();

  switch (process.platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',        // Apple Silicon Homebrew
        '/usr/local/bin',           // Intel Homebrew
        '/usr/bin',
        path.join(home, '.local', 'bin'),
      ];
    default: // linux, freebsd, etc.
      return [
        path.join(home, '.local', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/snap/bin',
      ];
  }
}

const SEARCH_DIRS = getSearchDirs();

/**
 * Resolve a binary name to its full path.
 * Checks platform-specific install locations so execFile works under
 * systemd, launchd, and other environments with minimal PATH.
 */
export function resolveBin(name: string): string {
  // Reject names with path separators to prevent traversal
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid binary name: path separators not allowed`);
  }

  const cached = cache.get(name);
  if (cached) {
    if (isValidExecutable(cached)) {
      return cached;
    }
    cache.delete(name);
  }

  // Try the platform's lookup command first (works when PATH is correct)
  try {
    const cmd = isWin ? 'where' : 'which';
    const result = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 }).trim();
    const resolved = result.split(/\r?\n/)[0];
    if (resolved && isValidExecutable(resolved)) {
      cache.set(name, resolved);
      return resolved;
    }
  } catch { /* lookup failed or not found */ }

  // Check platform-specific directories
  for (const dir of SEARCH_DIRS) {
    const fullPath = path.join(dir, name);
    if (isValidExecutable(fullPath)) {
      cache.set(name, fullPath);
      return fullPath;
    }
  }

  // Fall back to bare name (let execFile try PATH as last resort)
  return name;
}
