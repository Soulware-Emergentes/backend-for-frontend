import { serveStatic } from 'hono/bun';
import { createApp } from './app';
import { configFrom } from './config';
import { Sessions } from './sessions';
import { staffAt } from './staff';

const SWEEP_EVERY_MS = 60_000;

const config = configFrom(process.env);
const sessions = new Sessions();
const app = createApp({ config, staff: staffAt(config), sessions });

// Where this deployment serves the SPA too: its files, and index.html for any route of its own.
if (config.staticDir) {
  app.use('/*', serveStatic({ root: config.staticDir }));
  app.get('/*', serveStatic({ path: `${config.staticDir}/index.html` }));
}

setInterval(() => sessions.sweep(), SWEEP_EVERY_MS);

console.log(`sgt-bff listening on ${config.port}, as ${config.publicUrl}`);

export default { port: config.port, fetch: app.fetch };
