'use strict';

const { STATUS } = require('./outcome');

/**
 * Folds rule results into a record verdict.
 *   failed     - at least one rule failed
 *   incomplete - nothing failed, but the record was not fully checked:
 *                a rule returned unknown, or no rule reached a decision at all
 *   clean      - every rule that applied was evaluated, and all of them passed
 * `fully_evaluated` is reported independently, so a failed record still says
 * whether some of its rules could not run.
 */
function aggregate(results) {
  const counts = { total: results.length, pass: 0, fail: 0, unknown: 0, skipped: 0 };
  for (const r of results) counts[r.status] += 1;

  const notes = [];
  if (counts.total === 0) notes.push('no active rules: nothing was checked');
  else if (counts.pass + counts.fail === 0 && counts.unknown === 0) notes.push('every rule was skipped: nothing was checked');
  if (counts.unknown > 0) notes.push(`${counts.unknown} rule(s) could not be evaluated`);

  const decided = counts.pass + counts.fail;
  const fully_evaluated = counts.unknown === 0 && decided > 0;
  let verdict;
  if (counts.fail > 0) verdict = 'failed';
  else if (!fully_evaluated) verdict = 'incomplete';
  else verdict = 'clean';

  if (verdict === 'clean' && counts[STATUS.PASS] !== decided) throw new Error('invariant violated: clean verdict with non-pass decisions');
  return { verdict, fully_evaluated, summary: { ...counts, notes } };
}

module.exports = { aggregate };
