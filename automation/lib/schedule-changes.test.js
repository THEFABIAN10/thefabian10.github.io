const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleSnapshot, changedScheduleDates, scheduleChangeKind } = require('./schedule-changes');

const day = (date = '2026-11-01', outages = [{ start: 60, end: 120 }]) => ({
    date, outages, isToday: true
});
const snapshot = days => scheduleSnapshot({ days });
const kind = (before, after, today = '2026-11-01') => scheduleChangeKind(snapshot(before), snapshot(after), today);

test('classifies first publication and publication of tomorrow independently of today', () => {
    assert.equal(kind([], [day()]), 'published');
    assert.equal(kind([day()], [day(), day('2026-11-02')]), 'published');
    assert.equal(kind([day('2026-11-01', [])], [day()]), 'published');
});

test('cancellation means no current or future planned outages remain', () => {
    assert.equal(kind([day()], []), 'cancelled');
    assert.equal(kind([day()], [day('2026-11-01', [])]), 'cancelled');
    assert.equal(kind([day(), day('2026-11-02')], [day('2026-11-02')]), 'changed');
});

test('interval edits and a mix of publication and cancellation are changes', () => {
    assert.equal(kind([day()], [day('2026-11-01', [{ start: 90, end: 180 }])]), 'changed');
    assert.equal(kind([day()], [day('2026-11-02')]), 'changed');
});

test('removing past dates and publishing empty days do not create notifications', () => {
    assert.equal(kind([day('2026-10-31')], []), null);
    assert.equal(kind([day('2026-10-31'), day()], [day()]), null);
    assert.equal(kind([], [day('2026-11-01', [])]), null);
    assert.equal(kind([day('2026-11-01', [])], []), null);
});

test('first successful fetch establishes a baseline, including an empty schedule', () => {
    assert.deepEqual(changedScheduleDates(null, snapshot([day()])), []);
    assert.deepEqual(changedScheduleDates(null, snapshot([])), []);
});

test('ignores update timestamps, isToday, and interval/day ordering', () => {
    const first = scheduleSnapshot({
        lastUpdate: '2026-11-01T12:00:00Z',
        days: [day(), day('2026-11-02', [{ start: 180, end: 240 }, { start: 60, end: 120 }])]
    });
    const next = scheduleSnapshot({
        lastUpdate: '2026-11-01T12:06:00Z',
        days: [day('2026-11-02', [{ start: 60, end: 120 }, { start: 180, end: 240 }]),
            { ...day(), isToday: false }]
    });
    assert.deepEqual(changedScheduleDates(first, next), []);
});

test('compares dates in Kyiv regardless of timestamp representation', () => {
    assert.deepEqual(changedScheduleDates(
        snapshot([day('2026-10-31T22:00:00.000Z')]), snapshot([day('2026-11-01T00:00:00+02:00')])
    ), []);
});

test('detects added, removed, and shifted intervals', () => {
    for (const outages of [[], [{ start: 60, end: 150 }],
        [{ start: 90, end: 120 }], [{ start: 60, end: 120 }, { start: 180, end: 240 }]]) {
        assert.deepEqual(changedScheduleDates(snapshot([day()]), snapshot([day('2026-11-01', outages)])), ['2026-11-01']);
    }
});

test('detects publication and removal, even for days without outages', () => {
    for (const outages of [[], [{ start: 60, end: 120 }]]) {
        const published = snapshot([day('2026-11-01', outages)]);
        assert.deepEqual(changedScheduleDates(snapshot([]), published), ['2026-11-01']);
        assert.deepEqual(changedScheduleDates(published, snapshot([])), ['2026-11-01']);
    }
});

test('reports all affected dates when the schedule rolls forward', () => {
    assert.deepEqual(changedScheduleDates(
        snapshot([day(), day('2026-11-02')]), snapshot([day('2026-11-02'), day('2026-11-03')])
    ), ['2026-11-01', '2026-11-03']);
});

test('rejects malformed payloads rather than treating them as schedule removal', () => {
    for (const data of [null, {}, { days: null }, { days: [day('invalid')] },
        { days: [{ date: '2026-11-01' }] }, { days: [day('2026-11-01', [{ start: -1, end: 120 }])] }]) {
        assert.throws(() => scheduleSnapshot(data));
    }
});
