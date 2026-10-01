'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { apiRouter } = require('./routes/api');
const { uiRouter } = require('./routes/ui');
const { HttpError, isDbUnavailable } = require('./lib/errors');
const { AnchorStore } = require('./anchor');

/**
 * @param {{config: object, pool: object, anchor?: AnchorStore, logger?: {error: Function}}} input
 */
function createApp(input) {
  const logger = input.logger || console;
  const deps = { ...input, logger, anchor: input.anchor || new AnchorStore(input.config.anchor, input.config.db.database) };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet());

  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'unsupported_media_type', 'request body must be application/json'));
    }
    next();
  });
  app.use('/api', express.json({ limit: deps.config.api.maxBodyBytes, strict: true }));
  app.use('/api', apiRouter(deps));

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.use(uiRouter());

  app.use((req, res) => res.status(404).json({ error: 'not_found', message: 'resource not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'malformed_json', message: 'request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: `request body exceeds ${deps.config.api.maxBodyBytes} bytes` });
    }
    if (isDbUnavailable(err)) {
      logger.error(`[ivs] database unavailable: ${err.code || err.message}`);
      return res.status(503).json({
        error: 'dependency_unavailable', dependency: 'database',
        message: 'the database is unavailable; the request was not completed and nothing was recorded',
      });
    }
    logger.error('[ivs] unhandled error', err);
    return res.status(500).json({ error: 'internal_error', message: 'the request failed; nothing was recorded' });
  });

  return app;
}

module.exports = { createApp };
