import { run } from '@grammyjs/runner';
import { isMainThread, parentPort } from 'worker_threads';
import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';

// When running as a worker thread (multi-instance mode), prefix all console
// output with the instance name so logs from different bots are distinguishable.
const instanceName = process.env.CLAUDEGRAM_INSTANCE_NAME;
if (instanceName) {
  const prefix = `[${instanceName}]`;
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args: unknown[]) => origLog(prefix, ...args);
  console.error = (...args: unknown[]) => origError(prefix, ...args);
  console.warn = (...args: unknown[]) => origWarn(prefix, ...args);
}

// ---------------------------------------------------------------------------
// Multi-instance restart helpers (used by command handler)
// ---------------------------------------------------------------------------

/** Ask the launcher to restart this worker. Returns false if not in worker mode. */
export function requestRestart(): boolean {
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ type: 'restart' });
    return true;
  }
  return false;
}

/** Ask the launcher to restart a sibling worker by name. */
export function requestSiblingRestart(name: string): Promise<{ success: boolean; name?: string; reason?: string }> {
  return new Promise((resolve) => {
    if (isMainThread || !parentPort) {
      return resolve({ success: false, reason: 'not in multi-instance mode' });
    }
    const pp = parentPort;
    const handler = (msg: { type?: string; success?: boolean; name?: string; reason?: string }) => {
      if (msg?.type === 'restart_sibling_result') {
        pp.off('message', handler);
        clearTimeout(timer);
        resolve({ success: !!msg.success, name: msg.name, reason: msg.reason });
      }
    };
    pp.on('message', handler);
    pp.postMessage({ type: 'restart_sibling', name });
    // Timeout in case the launcher never responds
    const timer = setTimeout(() => {
      pp.off('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 5000);
  });
}

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS (only when running standalone, not as worker)
  if (isMainThread) preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  const runner = run(bot);

  // Graceful shutdown (guarded against duplicate signals)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n👋 Shutting down...');
    allowSleep();
    stopCleanup();
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // When running as a worker thread, communicate with the launcher
  if (!isMainThread && parentPort) {
    parentPort.on('message', (msg: { type?: string }) => {
      if (msg?.type === 'shutdown') shutdown();
    });

    // Send periodic heartbeat so the launcher can detect stuck workers
    const pp = parentPort;
    const workerHeartbeat = setInterval(() => pp.postMessage({ type: 'heartbeat' }), 30_000);
    workerHeartbeat.unref();
  }

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
