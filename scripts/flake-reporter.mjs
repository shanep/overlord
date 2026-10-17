// A vitest reporter that adds each run to the test run log behind npm run
// flakes. It only records: a failure here never fails the run, and CI, which
// starts fresh every time, skips it.
import path from 'node:path';
import process from 'node:process';

import {
  appendLog,
  defaultLogPath,
  failedAt,
  fingerprint,
  readLog,
  runEntry,
} from './flake-log.mjs';

function resultsOf(testModules, cwd) {
  return testModules.flatMap((module) => {
    const file = path.relative(cwd, module.moduleId);
    return [...module.children.allTests()].map((test) => {
      const result = test.result();
      return {
        id: `${file} > ${test.fullName}`,
        file,
        state: result.state,
        message: result.errors?.[0]?.message ?? '',
      };
    });
  });
}

// Vitest loads a reporter named by path from its default export.
// eslint-disable-next-line import-x/no-default-export
export default class FlakeReporter {
  onTestRunEnd(testModules) {
    if (process.env.CI) {
      return;
    }
    try {
      const cwd = process.cwd();
      const file = process.env.OVERLORD_TEST_LOG || defaultLogPath();
      const print = fingerprint(cwd);
      const entry = runEntry({
        at: Date.now(),
        cwd,
        fingerprint: print,
        results: resultsOf(testModules, cwd),
        priorFailed: failedAt(readLog(file), print),
      });
      appendLog(file, entry);
    } catch {
      // The log is a convenience. A run never fails because of it.
    }
  }
}
