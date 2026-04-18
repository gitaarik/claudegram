import { run } from '@grammyjs/runner';
import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';

// Log unhandled rejections — prevents silent failures where the process stays
// alive but functionality is broken (e.g. fire-and-forget async calls that fail).
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS
  preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  const runner = run(bot);

  // Liveness heartbeat: periodically verify the bot can still reach the
  // Telegram API. If the runner has stopped or getMe fails repeatedly,
  // exit so PM2 can restart the process.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  const MAX_HEARTBEAT_FAILURES = 3;
  let heartbeatFailures = 0;
  const heartbeatTimer = setInterval(async () => {
    if (!runner.isRunning()) {
      console.error('[HEARTBEAT] Runner is no longer running — exiting for restart');
      process.exit(1);
    }
    try {
      await bot.api.getMe();
      heartbeatFailures = 0;
    } catch (err) {
      heartbeatFailures++;
      console.error(`[HEARTBEAT] getMe failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}):`, err);
      if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        console.error('[HEARTBEAT] Too many consecutive failures — exiting for restart');
        process.exit(1);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // Don't prevent graceful shutdown

  // Graceful shutdown (guarded against duplicate signals)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n👋 Shutting down...');
    clearInterval(heartbeatTimer);
    allowSleep();
    stopCleanup();
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
