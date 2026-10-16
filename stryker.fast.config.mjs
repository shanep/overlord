// Fast mutation runs for day to day work and CI pushes. Same 90% bar, but no
// TypeScript checker (npm run typecheck already covers that) and its own
// incremental file so unchanged code and tests are skipped.
import base from './stryker.config.mjs';

export default {
  ...base,
  checkers: [],
  incrementalFile: 'reports/stryker-incremental-fast.json',
  reporters: ['clear-text', 'progress'],
};
