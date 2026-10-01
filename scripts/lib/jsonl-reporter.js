'use strict';

// node:test reporter that emits one JSON object per finished test, prefixed so
// the verifier can pick them out reliably.

module.exports = async function* jsonlReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const err = d.details && d.details.error;
    yield `IVS-RESULT ${JSON.stringify({
      name: d.name,
      file: d.file,
      nesting: d.nesting,
      passed: event.type === 'test:pass',
      skip: Boolean(d.skip),
      todo: Boolean(d.todo),
      duration_ms: d.details ? Math.round(d.details.duration_ms) : null,
      error: err ? String((err.cause && err.cause.message) || err.message).split('\n').slice(0, 3).join(' | ') : null,
    })}\n`;
  }
};
