import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedBundled: string | null | undefined;

function isMuslLibc(): boolean {
  // On glibc systems, process.report.header includes glibcVersionRuntime.
  // On musl (Alpine etc.), that field is absent.
  const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
}

/**
 * Resolve the bundled Claude Code binary for the current Linux libc.
 *
 * The SDK's own auto-detection (sdk.mjs `N7`) tries the musl package first
 * and only falls back when require.resolve throws. Both packages are
 * installed as optional deps, so it always picks musl — which fails to
 * spawn on glibc systems with a misleading "binary not found" error.
 *
 * Returns undefined on non-Linux platforms (SDK detection works correctly
 * there) or when the matching package isn't installed.
 */
export function resolveBundledClaudeBin(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (cachedBundled !== undefined) return cachedBundled ?? undefined;

  const variant = isMuslLibc() ? `linux-${process.arch}-musl` : `linux-${process.arch}`;
  const pkg = `@anthropic-ai/claude-agent-sdk-${variant}/claude`;
  try {
    cachedBundled = require.resolve(pkg);
    return cachedBundled;
  } catch {
    cachedBundled = null;
    return undefined;
  }
}
