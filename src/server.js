'use strict';

const config = require('./config');
const { createPool } = require('./db');
const { createApp } = require('./app');

let cfg;
try {
  cfg = config.load();
} catch (err) {
  console.error(`[ivs] configuration error: ${err.message}`);
  process.exit(1);
}

const pool = createPool(cfg.db);
const server = createApp({ config: cfg, pool }).listen(cfg.port, () => {
  console.log(`[ivs] listening on http://localhost:${cfg.port} (readiness: /api/health)`);
});

function shutdown(signal) {
  console.log(`[ivs] ${signal} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
