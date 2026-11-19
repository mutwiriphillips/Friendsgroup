import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { startScheduler } from './services/scheduler.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Savings system listening on :${config.port} (${config.isProd ? 'production' : 'development'})`);
});
startScheduler();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
