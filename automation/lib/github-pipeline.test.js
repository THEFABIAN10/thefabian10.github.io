const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectData, waitForPublication, notifySources } = require('./github-pipeline');
const config = require('../push-config.json');
const empty = { days: [], lastUpdate: '2026-11-05T00:00:00Z' };
const address = { sub_type: '', start_date: '', end_date: '', lastUpdate: empty.lastUpdate };
const initial = { days: [], address, revision: 'initial', addressNotificationVersion: 1 };

test('failed sources retain their timestamp while successful sources update independently', async () => {
    const previous = { 'dtek-outages.json': empty, 'dtek-address.json': address };
    const result = await collectData(previous, {
        schedule: async () => { throw new Error('blocked'); },
        address: async () => ({ ...address, sub_type: 'Екстрені відключення' }),
        yasno: async () => empty,
    }, { sleep: async () => {} });
    assert.deepEqual(result.data['dtek-outages.json'], empty);
    assert.equal(result.data['dtek-address.json'].sub_type, 'Екстрені відключення');
    assert.equal(result.errors.schedule, 'blocked');
    assert.deepEqual(result.updated.sort(), ['address', 'yasno']);
});

test('publication verification rejects old fetch timestamps and retries until all files match', async () => {
    let time = 0;
    await waitForPublication({ 'outages.json': empty }, config.siteUrl, {
        fetchImpl: async () => Response.json(time === 0 ? { ...empty, lastUpdate: 'old' } : empty),
        sleep: async ms => { time += ms; }, clock: () => time, timeoutMs: 100, intervalMs: 10,
    });
    assert.equal(time, 10);
});

test('no push occurs before publication and failed sends keep their previous revision', async () => {
    const data = { 'dtek-outages.json': empty, 'dtek-address.json': { ...address, sub_type: 'Екстрені відключення' },
        'outages.json': { ...empty, today: { status: 'EmergencyShutdowns' } } };
    const states = { dtek: initial, yasno: initial };
    const accepted = [];
    let published = false;
    const options = { data, states, updated: ['address', 'yasno'], config, apiKey: 'test',
        wait: async () => { published = true; },
        send: async payload => {
            assert.equal(published, true);
            if (payload.headings.uk === 'ДТЕК') throw new Error('rejected');
            return { delivered: true, id: 'id' };
        },
        acknowledge: async (source, state) => { accepted.push(source); states[source] = state; },
    };
    const errors = await notifySources(options);
    assert.deepEqual(errors, { dtek: 'rejected' });
    assert.deepEqual(accepted, ['yasno']);
    assert.equal(states.dtek.revision, 'initial');
    assert.notEqual(states.yasno.revision, 'initial');
    await assert.rejects(notifySources({ ...options, wait: async () => { throw new Error('not published'); },
        send: async () => assert.fail('must not send') }), /not published/);
});

test('persisted acknowledgements suppress repeated runs for both providers despite new fetch timestamps', async () => {
    const states = { dtek: structuredClone(initial), yasno: structuredClone(initial) };
    const data = { 'dtek-outages.json': empty,
        'dtek-address.json': { ...address, sub_type: 'Екстрені відключення' },
        'outages.json': { ...empty, today: { status: 'EmergencyShutdowns' } } };
    const sent = [];
    const options = { data, states, updated: ['schedule', 'address', 'yasno'], config, apiKey: 'test',
        now: new Date('2026-11-05T00:00:00Z'), wait: async () => {},
        send: async payload => { sent.push(payload); return { delivered: true, id: payload.idempotency_key }; },
        acknowledge: async (source, state) => { states[source] = JSON.parse(JSON.stringify(state)); },
    };
    assert.deepEqual(await notifySources(options), {});
    assert.equal(sent.length, 1);
    const acknowledged = structuredClone(states);
    for (let run = 1; run <= 3; run++) {
        for (const value of Object.values(data)) value.lastUpdate = `2026-11-05T00:${run}5:00Z`;
        assert.deepEqual(await notifySources(options), {});
        assert.deepEqual(states, acknowledged);
    }
    assert.equal(sent.length, 1);
    data['dtek-address.json'] = address;
    data['outages.json'].today.status = 'ScheduleApplies';
    await notifySources(options);
    assert.equal(sent.length, 2); // Only DTEK sends a cancellation.
    assert.ok(sent.every(payload => payload.headings.uk === 'ДТЕК'));
    await notifySources(options);
    assert.equal(sent.length, 2);
    data['dtek-address.json'] = { ...address, sub_type: 'Екстрені відключення' };
    data['outages.json'].today.status = 'EmergencyShutdowns';
    await notifySources(options);
    assert.equal(sent.length, 3);
    assert.equal(new Set(sent.map(payload => payload.idempotency_key)).size, 3);
});

test('accepted push followed by failed state persistence retries with the same idempotency key', async () => {
    const states = { dtek: structuredClone(initial), yasno: structuredClone(initial) };
    const data = { 'dtek-outages.json': empty, 'dtek-address.json': { ...address, sub_type: 'Екстрені відключення' } };
    const keys = [];
    const options = { data, states, updated: ['address'], config, apiKey: 'test', wait: async () => {},
        send: async payload => { keys.push(payload.idempotency_key); return { delivered: true, id: 'accepted' }; },
        acknowledge: async () => { throw new Error('git push failed'); },
    };
    assert.deepEqual(await notifySources(options), { dtek: 'git push failed' });
    data['dtek-address.json'].lastUpdate = '2026-11-05T01:00:00Z';
    options.acknowledge = async (source, state) => { states[source] = state; };
    assert.deepEqual(await notifySources(options), {});
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    await notifySources(options);
    assert.equal(keys.length, 2);
});
