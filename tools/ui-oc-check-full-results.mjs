// Evidence-only verification; does not run tests, edit reports or weaken suites.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGETS = new Map([
  ['tests/unit/web/native-pi-port.test.ts', 8],
  ['tests/unit/web/oc-read-projection.test.ts', 12],
  ['tests/unit/web/native-composer-actions.test.tsx', 10],
  ['tests/unit/web/oc-event-projection.test.ts', 10],
  ['tests/unit/web/oc-read-transport.test.ts', 8],
  ['tests/unit/web/native-message-ordering.test.ts', 3],
  ['tests/unit/attachment-store.test.ts', 13],
  ['tests/integration/prod-smoke.test.ts', 7],
]);
function pathOf(suite) {
  const name = relative(ROOT, suite.name).split(sep).join('/');
  assert.ok(name.startsWith('tests/') && !name.includes('../'), 'Unexpected report workspace/path');
  return name;
}
function skipIdentities(report) {
  return report.testResults.flatMap(suite => suite.assertionResults
    .filter(test => test.status !== 'passed')
    .map(test => JSON.stringify([pathOf(suite), test.fullName, test.status]))).sort();
}
export function verifyFullResults(report, baseline) {
  assert.equal(report.success, true, 'Whole report not successful');
  assert.equal(report.numTotalTests, 2119, 'Unexpected total count');
  assert.equal(report.numPassedTests, 2095, 'Unexpected passed count');
  assert.equal(report.numPendingTests, 24, 'Unexpected opt-in count');
  assert.equal(report.numFailedTests, 0, 'Failed assertions');
  assert.equal(report.numFailedTestSuites, 0, 'Failed suites/setup');
  assert.equal(report.numPassedTestSuites, report.numTotalTestSuites, 'Incomplete suite execution');
  assert.equal(report.testResults.reduce((n, s) => n + s.assertionResults.length, 0), 2119, 'Assertion rows incomplete');
  assert.equal(baseline.success, true, 'Invalid baseline');
  assert.equal(baseline.numTotalTests, 2097, 'Unexpected baseline set');
  assert.equal(baseline.numPendingTests, 24, 'Unexpected baseline opt-ins');
  assert.ok(report.testResults.every(suite => suite.status === 'passed'), 'Failed/setup-only file');
  assert.deepEqual(skipIdentities(report), skipIdentities(baseline), 'Changed opt-in identities, not only count');
  for (const [name, count] of TARGETS) {
    const suites = report.testResults.filter(suite => pathOf(suite) === name);
    assert.equal(suites.length, 1, `Missing/ambiguous target: ${name}`);
    assert.equal(suites[0].assertionResults.length, count, `Target assertion count: ${name}`);
    assert.ok(suites[0].assertionResults.every(test => test.status === 'passed'), `Unexecuted/failed target: ${name}`);
  }
  return { total: 2119, passed: 2095, existingOptIns: 24, sameOptInIdentities: true, targets: Object.fromEntries(TARGETS) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node tools/ui-oc-check-full-results.mjs RESULTS_JSON BASELINE_JSON_GZ');
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const baseline = JSON.parse(gunzipSync(readFileSync(process.argv[3])).toString('utf8'));
  console.log(JSON.stringify(verifyFullResults(report, baseline), null, 2));
}
