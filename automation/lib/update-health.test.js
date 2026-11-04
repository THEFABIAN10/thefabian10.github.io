const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessUpdateHealth } = require('./update-health');
const now = Date.parse('2026-11-05T00:30:00Z');
const run = { created_at: '2026-11-05T00:25:00Z', status: 'completed', conclusion: 'success' };
const files = { dtek: { lastUpdate: '2026-11-05T00:25:00Z' } };
test('health tolerates transient failures but reports three consecutive failed runs', () => {
    const failed = { ...run, conclusion: 'failure' };
    assert.deepEqual(assessUpdateHealth([run], files, now), []);
    assert.deepEqual(assessUpdateHealth([failed, failed, run], files, now), []);
    assert.equal(assessUpdateHealth([{ ...run, status: 'in_progress' }, failed, failed, failed], files, now).length, 1);
});
test('health detects stopped dispatches independently of recent public data', () => {
    assert.match(assessUpdateHealth([], files, now)[0], /No update workflow/);
    assert.match(assessUpdateHealth([{ ...run, created_at: '2026-11-05T00:00:00Z' }], files, now)[0], /Worker cron/);
});
test('health detects independently stale, absent, invalid, and future source timestamps', () => {
    for (const lastUpdate of [undefined, 'bad', '2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z']) {
        const errors = assessUpdateHealth([run], { ...files, address: { lastUpdate } }, now);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /^address:/);
    }
    assert.deepEqual(assessUpdateHealth([run], { dtek: { lastUpdate: '2026-11-05T00:10:00Z' } }, now), []);
});
