const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitForPublishedData } = require('./notify-schedule-changes');

const siteUrl = 'https://norivka.github.io/';
const address = { sub_type: 'Аварійні ремонтні роботи', start_date: '23:16 31.10.2026', end_date: '20:00 01.11.2026' };
const expected = {
    days: [{ date: '2026-11-01', outages: [{ start: 60, end: 120 }] }], address
};

function pollingOptions(fetchImpl) {
    let time = 0;
    const sleeps = [];
    return {
        fetchImpl, log: () => {}, timeoutMs: 40, intervalMs: 10,
        clock: () => time,
        sleep: async ms => { sleeps.push(ms); time += ms; },
        sleeps
    };
}

test('waits until both the public schedule and repair notice match the update', async () => {
    const requests = [];
    const options = pollingOptions(async (url, init) => {
        const attempt = Math.floor(requests.length / 2);
        requests.push({ url: new URL(url), init });
        if (url.includes('dtek-outages')) return Response.json(attempt === 0 ? { days: [] } : expected);
        return Response.json(attempt < 2 ? { ...address, end_date: '18:20 01.11.2026' } : address);
    });
    await waitForPublishedData(expected, siteUrl, options);
    assert.deepEqual(options.sleeps, [10, 10]);
    assert.equal(requests.length, 6);
    for (const { url, init } of requests) {
        assert.equal(url.origin, 'https://norivka.github.io');
        assert.equal(init.cache, 'no-store');
        assert.equal(url.searchParams.has('t'), true);
        assert.equal(init.signal instanceof AbortSignal, true);
    }
    assert.notEqual(requests[0].url.search, requests[2].url.search);
});

test('publication checks ignore timestamps, isToday, and notice whitespace', async () => {
    const options = pollingOptions(async url => Response.json(url.includes('dtek-outages') ? {
        ...expected, lastUpdate: 'different fetch',
        days: [{ ...expected.days[0], isToday: true, date: '2026-11-01T00:00:00+02:00' }]
    } : { ...address, sub_type: '  Аварійні\nремонтні роботи ', sourceUpdate: 'different source update' }));
    await waitForPublishedData(expected, siteUrl, options);
    assert.deepEqual(options.sleeps, []);
});

test('temporary network, HTTP, invalid JSON, and malformed data failures are retried', async () => {
    for (const failure of [
        () => { throw new Error('network'); },
        () => new Response('', { status: 404 }),
        () => new Response('<html>Deploying</html>'),
        () => Response.json({ invalid: true })
    ]) {
        let requests = 0;
        const options = pollingOptions(async url => {
            if (requests++ < 2) return failure();
            return Response.json(url.includes('dtek-outages') ? expected : address);
        });
        await waitForPublishedData(expected, siteUrl, options);
        assert.deepEqual(options.sleeps, [10]);
    }
});

test('an unpublished update times out rather than allowing an early push', async () => {
    const options = pollingOptions(async url => Response.json(url.includes('dtek-outages')
        ? expected : { ...address, end_date: '18:20 01.11.2026' }));
    await assert.rejects(waitForPublishedData(expected, siteUrl, options), /not published.*remains pending/);
    assert.deepEqual(options.sleeps, [10, 10, 10, 10]);
});
