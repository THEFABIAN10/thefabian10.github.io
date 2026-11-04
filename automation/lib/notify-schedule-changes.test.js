const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildNotification: buildAtTime, sendNotification, notifyScheduleChanges } = require('./notify-schedule-changes');

const now = new Date('2026-11-01T12:00:00Z');
const buildNotification = (source, state, data, config, address = null) =>
    buildAtTime(source, state, data, config, address, now);

const config = { appId: 'e90f40ee-b1b8-4d93-93a4-a7eab7e46681', siteUrl: 'https://norivka.github.io/' };
const empty = { days: [], revision: 'initial' };
const schedule = {
    lastUpdate: '2026-11-01T10:00:00Z',
    days: [{ date: '2026-11-01T00:00:00+02:00', isToday: true, outages: [{ start: 60, end: 120 }] }]
};
const repair = { sub_type: 'Аварійні ремонтні роботи', start_date: '23:16 31.10.2026', end_date: '10:50 01.11.2026' };

test('address push uses the provider title and puts the message and Kyiv dates in its body', () => {
    for (const sub_type of [
        'Аварійне відключення', 'Планові ремонтні роботи',
        'Стабілізаційне відключення (Згідно графіку погодинних відключень)'
    ]) {
        const address = { sub_type, start_date: '10:05 10.11.2026', end_date: '09:38 11.11.2026' };
        const first = buildNotification('dtek', empty, { days: [] }, config, address);
        assert.deepEqual(first.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
        assert.deepEqual(first.payload.contents, { en: `${sub_type[0].toLowerCase()}${sub_type.slice(1)}\n10.11 10:05 - 11.11 9:38`, uk: `${sub_type[0].toLowerCase()}${sub_type.slice(1)}\n10.11 10:05 - 11.11 9:38` });
    }
});

test('address push labels a single time and handles missing times or message text', () => {
    for (const [start_date, end_date, expected] of [
        ['10:05 10.11.2026', '', 'Початок: 10.11 10:05'],
        ['', '09:38 11.11.2026', 'Завершення: 11.11 9:38'],
        ['00:05 31.12.2026', '01:00 01.01.2027', '31.12 0:05 - 01.01 1:00'],
        ['', '', ''],
        ['', 'До завершення робіт', 'Завершення: До завершення робіт']
    ]) {
        const address = { sub_type: 'Аварійне відключення', start_date, end_date };
        const notification = buildNotification('dtek', empty, { days: [] }, config, address);
        assert.deepEqual(notification.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
        assert.deepEqual(notification.payload.contents, { en: `аварійне відключення${expected ? '\n' + expected : ''}`, uk: `аварійне відключення${expected ? '\n' + expected : ''}` });
    }
    const noText = buildNotification('dtek', empty, { days: [] }, config, {
        sub_type: '', start_date: '10:05 10.11.2026', end_date: ''
    });
    assert.equal(noText.payload.headings.uk, 'ДТЕК');
    assert.equal(noText.payload.contents.uk, 'повідомлення про відключення\nПочаток: 10.11 10:05');
});

test('address updates keep the source title and show the updated interval', () => {
    const first = buildNotification('dtek', empty, { days: [] }, config, repair);
    const edited = buildNotification('dtek', first.state, { days: [] }, config, {
        ...repair, end_date: '09:38 02.11.2026'
    });
    assert.deepEqual(edited.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
    assert.deepEqual(edited.payload.contents, { en: 'аварійні ремонтні роботи\n31.10 23:16 - 02.11 9:38', uk: 'аварійні ремонтні роботи\n31.10 23:16 - 02.11 9:38' });
    assert.notEqual(edited.payload.idempotency_key, first.payload.idempotency_key);
});

test('builds web push with the correct source URL and subscriber audience', () => {
    const notification = buildNotification('dtek', empty, schedule, config);
    assert.deepEqual(notification.payload.included_segments, ['Total Subscriptions']);
    assert.equal(notification.payload.isAnyWeb, true);
    assert.equal(notification.payload.ttl, 7200);
    assert.equal(notification.payload.url, 'https://norivka.github.io/?source=dtek');
    assert.equal(notification.payload.contents.uk, 'нові графіки відключень');
    assert.deepEqual(notification.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
    assert.equal(notification.state.revision, notification.payload.idempotency_key);
    assert.match(notification.state.revision, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('schedule publication, modification, and cancellation use distinct body text and the same provider title', () => {
    const first = buildNotification('dtek', empty, schedule, config);
    const modified = buildNotification('dtek', first.state, {
        ...schedule, days: [{ ...schedule.days[0], outages: [{ start: 60, end: 180 }] }]
    }, config);
    const cancelled = buildNotification('dtek', first.state, { days: [] }, config);
    assert.equal(first.payload.contents.uk, 'нові графіки відключень');
    assert.equal(modified.payload.contents.uk, 'зміни у графіках відключень');
    assert.equal(cancelled.payload.contents.uk, 'скасовано графіки відключень');
    for (const notification of [first, modified, cancelled]) {
        assert.deepEqual(notification.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
    }
});

test('expired schedules are recorded silently, including across Kyiv midnight', () => {
    const state = { ...empty, ...schedule };
    const removed = buildAtTime('dtek', state, { days: [] }, config, null, new Date('2026-11-01T22:01:00Z'));
    assert.equal(removed.payload, null);
    assert.deepEqual(removed.state.days, []);
});

test('unchanged schedules and changed metadata never send push', () => {
    const first = buildNotification('dtek', empty, schedule, config);
    assert.equal(buildNotification('dtek', first.state, {
        ...schedule, lastUpdate: '2026-11-01T11:00:00Z',
        days: [{ ...schedule.days[0], isToday: false }]
    }, config), null);
    assert.equal(buildNotification('dtek', empty, { days: [] }, config), null);
});

test('retries share an ID but a later repeat of the same transition gets a new ID', () => {
    const first = buildNotification('dtek', empty, schedule, config);
    const retry = buildNotification('dtek', empty, { ...schedule, lastUpdate: 'later fetch' }, config);
    assert.equal(first.payload.idempotency_key, retry.payload.idempotency_key);
    const reverted = buildNotification('dtek', first.state, { days: [] }, config);
    const repeated = buildNotification('dtek', reverted.state, schedule, config);
    assert.notEqual(first.payload.idempotency_key, repeated.payload.idempotency_key);
});

test('retrying the missed 14:35 to 18:20 repair update uses a fresh key for the corrected audience', () => {
    const missed = buildNotification('dtek', {
        days: [], revision: '8804e218-16a5-4c49-89ea-a9ff7705449b',
        address: { ...repair, end_date: '14:35 01.11.2026' }
    }, { days: [] }, config, { ...repair, end_date: '18:20 01.11.2026' });
    assert.deepEqual(missed.payload.included_segments, ['Total Subscriptions']);
    assert.notEqual(missed.payload.idempotency_key, '2bcbe67b-a2b4-436a-9ddd-995bd3681aaf');
});

test('new address repair messages and restoration edits trigger push; metadata does not', () => {
    const first = buildNotification('dtek', empty, { days: [] }, config, repair);
    assert.ok(first.payload);
    assert.deepEqual(first.payload.contents, { en: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 10:50', uk: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 10:50' });
    assert.equal(buildNotification('dtek', first.state, { days: [] }, config, {
        ...repair, sub_type: '  Аварійні\nремонтні роботи  ', lastUpdate: 'later', sourceUpdate: 'updated'
    }), null);
    const edited = buildNotification('dtek', first.state, { days: [] }, config, { ...repair, end_date: '12:00 01.11.2026' });
    assert.ok(edited.payload);
    assert.equal(edited.state.address.end_date, '12:00 01.11.2026');
    assert.deepEqual(edited.payload.contents, { en: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 12:00', uk: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 12:00' });
    assert.notEqual(edited.payload.idempotency_key, first.payload.idempotency_key);
    const startOnly = buildNotification('dtek', first.state, { days: [] }, config, { ...repair, start_date: '11:00 01.11.2026' });
    assert.ok(startOnly.payload);
    assert.equal(startOnly.state.address.start_date, '11:00 01.11.2026');
    const bothTimes = buildNotification('dtek', first.state, { days: [] }, config, {
        ...repair, start_date: '11:00 01.11.2026', end_date: '18:00 01.11.2026'
    });
    assert.ok(bothTimes.payload);
});

test('emergency notice removal and reappearance trigger fresh pushes', () => {
    const data = { days: [] };
    const first = buildNotification('dtek', empty, data, config, repair);
    const removed = buildNotification('dtek', first.state, { days: [] }, config);
    assert.equal(removed.payload.contents.uk, 'скасовано аварійні відключення');
    const reappeared = buildNotification('dtek', removed.state, data, config, repair);
    assert.ok(reappeared.payload);
    assert.notEqual(reappeared.payload.idempotency_key, first.payload.idempotency_key);
});

test('eligible address notice types trigger push and identical fetches do not', () => {
    for (const sub_type of [
        'Планові ремонтні роботи', 'Нове повідомлення ДТЕК', '',
        'Увага: Стабілізаційне відключення'
    ]) {
        const address = { ...repair, sub_type };
        const first = buildNotification('dtek', empty, { days: [] }, config, address);
        assert.ok(first.payload);
        assert.equal(buildNotification('dtek', first.state, { days: [] }, config, {
            ...address, lastUpdate: 'later', sourceUpdate: 'later'
        }), null);
        const endChanged = buildNotification('dtek', first.state, { days: [] }, config, {
            ...address, end_date: '22:00 01.11.2026'
        });
        assert.ok(endChanged.payload);
        const startChanged = buildNotification('dtek', first.state, { days: [] }, config, {
            ...address, start_date: '15:00 01.11.2026'
        });
        assert.ok(startChanged.payload);
    }
});

test('stabilization notices trigger push only on appearance and reappearance', () => {
    for (const sub_type of [
        'Стабілізаційне відключення',
        'Стабілізаційне відключення (Згідно графіку погодинних відключень)',
        '  стабілізаційне\nвідключення (за графіком)  '
    ]) {
        const address = { ...repair, sub_type };
        const first = buildNotification('dtek', empty, { days: [] }, config, address);
        assert.ok(first.payload);
        assert.equal(buildNotification('dtek', first.state, { days: [] }, config, address), null);
        let latest = first.state;
        for (const changes of [
            { start_date: '15:00 01.11.2026' },
            { end_date: '22:00 01.11.2026' },
            { start_date: '15:00 01.11.2026', end_date: '22:00 01.11.2026' },
            { sub_type: 'Стабілізаційне відключення (оновлено пояснення)' }
        ]) {
            const edited = buildNotification('dtek', first.state, { days: [] }, config, { ...address, ...changes });
            assert.equal(edited.payload, null);
            latest = edited.state;
        }
        const removed = buildNotification('dtek', latest, { days: [] }, config);
        assert.equal(removed.payload, null);
        const reappeared = buildNotification('dtek', removed.state, { days: [] }, config, address);
        assert.ok(reappeared.payload);
        assert.notEqual(reappeared.payload.idempotency_key, first.payload.idempotency_key);
    }
});

test('legacy stabilization notices are not resent when unchanged or when the time changes', () => {
    for (const addressNotificationVersion of [undefined, 1]) {
        const address = { ...repair, sub_type: 'Стабілізаційне відключення (за графіком)' };
        const legacy = { ...empty, address, addressNotificationVersion };
        assert.equal(buildNotification('dtek', legacy, { days: [] }, config, address), null);
        assert.equal(buildNotification('dtek', legacy, { days: [] }, config, {
            ...address, end_date: '22:00 01.11.2026'
        }).payload, null);
    }
});

test('transition to or from stabilization produces an added notice', () => {
    const first = buildNotification('dtek', empty, { days: [] }, config, repair);
    const stabilization = buildNotification('dtek', first.state, { days: [] }, config, {
        ...repair, sub_type: 'Стабілізаційне відключення (за графіком)'
    });
    assert.ok(stabilization.payload);
    const reappeared = buildNotification('dtek', stabilization.state, { days: [] }, config, repair);
    assert.ok(reappeared.payload);
    assert.notEqual(reappeared.payload.idempotency_key, first.payload.idempotency_key);
});

test('stabilization notices do not suppress simultaneous schedule notifications', () => {
    const address = { ...repair, sub_type: 'Стабілізаційне відключення (за графіком)' };
    const first = buildNotification('dtek', empty, { days: [] }, config, address);
    const combined = buildNotification('dtek', first.state, schedule, config, { ...address, end_date: '22:00 01.11.2026' });
    assert.equal(combined.payload.contents.uk, 'нові графіки відключень');
    assert.deepEqual(combined.payload.headings, { en: 'ДТЕК', uk: 'ДТЕК' });
    assert.equal(buildNotification('dtek', combined.state, schedule, config, {
        ...combined.state.address, end_date: '23:00 01.11.2026'
    }).payload, null);
    const bothNew = buildNotification('dtek', empty, schedule, config, address);
    assert.ok(bothNew.payload);
});

test('notice type changes trigger one push even when the times stay the same', () => {
    const first = buildNotification('dtek', empty, { days: [] }, config, repair);
    const next = buildNotification('dtek', first.state, { days: [] }, config, {
        ...repair, sub_type: 'Планові ремонтні роботи'
    });
    assert.ok(next.payload);
    const removed = buildNotification('dtek', next.state, { days: [] }, config);
    assert.equal(removed.payload, null);
    const reappeared = buildNotification('dtek', removed.state, { days: [] }, config, next.state.address);
    assert.ok(reappeared.payload);
    assert.notEqual(reappeared.payload.idempotency_key, next.payload.idempotency_key);
});

test('a notice plus schedule change produces one push', () => {
    const combined = buildNotification('dtek', empty, schedule, config, repair);
    assert.ok(combined.payload);
    assert.deepEqual(combined.payload.contents, { en: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 10:50', uk: 'аварійні ремонтні роботи\n31.10 23:16 - 01.11 10:50' });
    assert.equal(combined.state.days.length, 1);
    assert.deepEqual(combined.state.address, repair);
});

test('migration delivers previously ignored current notices once without repeating emergency notices', () => {
    const address = { ...repair, sub_type: 'Планові ремонтні роботи' };
    const oldState = { ...empty, address };
    const first = buildNotification('dtek', oldState, { days: [] }, config, address);
    assert.ok(first.payload);
    assert.equal(first.state.addressNotificationVersion, 1);
    const retry = buildNotification('dtek', oldState, { days: [] }, config, address);
    assert.equal(retry.payload.idempotency_key, first.payload.idempotency_key);
    assert.equal(buildNotification('dtek', first.state, { days: [] }, config, address), null);
    assert.equal(buildNotification('dtek', { ...empty, address: repair }, { days: [] }, config, repair), null);
});

test('rejects invalid source, config, payload, and notification state', () => {
    assert.throws(() => buildNotification('invalid', empty, schedule, config));
    assert.throws(() => buildNotification('dtek', empty, schedule, { ...config, appId: 'bad' }));
    assert.throws(() => buildNotification('dtek', empty, schedule, { ...config, siteUrl: 'http://example.com' }));
    assert.throws(() => buildNotification('dtek', { days: [] }, schedule, config));
    assert.throws(() => buildNotification('dtek', empty, { days: [] }, config, { sub_type: null }));
});

test('Yasno is ignored before reading data or sending anything', async () => {
    await assert.rejects(notifyScheduleChanges('yasno', {
        root: '/does-not-exist', apiKey: 'test-key',
        send: async () => assert.fail('Yasno must never send push')
    }), /Only DTEK/);
});

test('retries network, 429, and server errors with the same request body', async () => {
    for (const first of [new Error('network failed'), new Response('', { status: 429 }), new Response('', { status: 503 })]) {
        const calls = [];
        const sleeps = [];
        const result = await sendNotification({ idempotency_key: 'stable' }, 'test-key', {
            fetchImpl: async (url, options) => {
                calls.push({ url, options });
                if (calls.length === 1) {
                    if (first instanceof Error) throw first;
                    return first;
                }
                return Response.json({ id: 'message-id' });
            }, sleep: async ms => sleeps.push(ms)
        });
        assert.equal(result.delivered, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.body, calls[1].options.body);
        assert.equal(calls[0].options.headers.Authorization, 'Key test-key');
        assert.equal(sleeps.length, 1);
    }
});

test('does not retry authentication errors or leak API keys in errors', async () => {
    let calls = 0;
    await assert.rejects(sendNotification({}, 'private-key', {
        fetchImpl: async () => { calls++; return new Response('private-key', { status: 401 }); }
    }), /^Error: OneSignal rejected notification \(HTTP 401\)$/);
    assert.equal(calls, 1);
});

test('no subscribers fails so the notification can be retried; unexpected responses fail', async () => {
    await assert.rejects(sendNotification({}, 'test-key', {
        fetchImpl: async () => Response.json({ id: '', errors: ['All included players are not subscribed'] })
    }), /no subscribed devices.*remains pending/);
    await assert.rejects(sendNotification({}, 'test-key', {
        fetchImpl: async () => Response.json({ errors: ['Invalid app'] })
    }), /did not create a notification/);
});

test('accepted notifications return the OneSignal message ID for delivery diagnostics', async () => {
    assert.deepEqual(await sendNotification({}, 'test-key', {
        fetchImpl: async () => Response.json({ id: 'notification-id' })
    }), { delivered: true, id: 'notification-id' });
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norivka-notifications-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(`${root}/.github/notification-state`, { recursive: true });
    fs.mkdirSync(`${root}/data`);
    fs.writeFileSync(`${root}/push-config.json`, JSON.stringify(config));
    fs.writeFileSync(`${root}/data/dtek-outages.json`, JSON.stringify(schedule));
    fs.writeFileSync(`${root}/data/dtek-address.json`, JSON.stringify({ sub_type: '', start_date: '', end_date: '' }));
    const statePath = `${root}/.github/notification-state/dtek.json`;
    fs.writeFileSync(statePath, JSON.stringify(empty));
    return { root, statePath, log: () => {}, now, waitForPublication: async () => {} };
}

test('persists state only after accepted delivery and skips subsequent unchanged fetches', async t => {
    const options = fixture(t);
    let calls = 0;
    options.apiKey = 'test-key';
    options.send = async () => { calls++; return { delivered: true }; };
    await notifyScheduleChanges('dtek', options);
    assert.equal(calls, 1);
    assert.notDeepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
    await notifyScheduleChanges('dtek', options);
    assert.equal(calls, 1);
});

test('failed delivery or missing credentials leaves the baseline intact for the next run', async t => {
    const options = fixture(t);
    options.send = async () => { throw new Error('delivery failed'); };
    await notifyScheduleChanges('dtek', { ...options, apiKey: '' });
    assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
    await assert.rejects(notifyScheduleChanges('dtek', { ...options, apiKey: 'test-key' }), /delivery failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
});

test('an end-time change with no eligible subscribers stays pending and is retried', async t => {
    const options = fixture(t);
    const before = { ...empty, address: repair };
    fs.writeFileSync(options.statePath, JSON.stringify(before));
    fs.writeFileSync(`${options.root}/data/dtek-outages.json`, JSON.stringify({ days: [] }));
    fs.writeFileSync(`${options.root}/data/dtek-address.json`, JSON.stringify({ ...repair, end_date: '18:20 01.11.2026' }));
    options.apiKey = 'test-key';
    const payloads = [];
    options.send = async payload => {
        payloads.push(payload);
        return sendNotification(payload, options.apiKey, {
            fetchImpl: async () => Response.json(payloads.length === 1
                ? { id: '', errors: ['All included players are not subscribed'] }
                : { id: 'accepted-id' })
        });
    };
    await assert.rejects(notifyScheduleChanges('dtek', options), /remains pending/);
    assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), before);
    await notifyScheduleChanges('dtek', options);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].idempotency_key, payloads[1].idempotency_key);
    assert.equal(payloads[1].headings.uk, 'ДТЕК');
    assert.equal(JSON.parse(fs.readFileSync(options.statePath)).address.end_date, '18:20 01.11.2026');
    await notifyScheduleChanges('dtek', options);
    assert.equal(payloads.length, 2);
});

test('an unaccepted send result never advances notification state', async t => {
    const options = fixture(t);
    await assert.rejects(notifyScheduleChanges('dtek', {
        ...options, apiKey: 'test-key', send: async () => ({ delivered: false })
    }), /remains pending/);
    assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
});

test('waits for publication before sending and acknowledging an update', async t => {
    const options = fixture(t);
    const events = [];
    await notifyScheduleChanges('dtek', {
        ...options, apiKey: 'test-key',
        waitForPublication: async (expected, siteUrl) => {
            events.push('published');
            assert.equal(siteUrl, config.siteUrl);
            assert.equal(expected.days[0].outages[0].end, 120);
            assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
        },
        send: async () => {
            assert.deepEqual(events, ['published']);
            assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
            events.push('sent');
            return { delivered: true };
        }
    });
    assert.deepEqual(events, ['published', 'sent']);
    assert.notDeepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
});

test('failed publication verification preserves the comparison state and never sends', async t => {
    const options = fixture(t);
    await assert.rejects(notifyScheduleChanges('dtek', {
        ...options, apiKey: 'test-key',
        waitForPublication: async () => { throw new Error('not published'); },
        send: async () => assert.fail('Must not send before publication')
    }), /not published/);
    assert.deepEqual(JSON.parse(fs.readFileSync(options.statePath)), empty);
});

test('unchanged data skips publication checks; silent removal waits without sending', async t => {
    const options = fixture(t);
    fs.writeFileSync(`${options.root}/data/dtek-outages.json`, JSON.stringify({ days: [] }));
    let checks = 0;
    const run = () => notifyScheduleChanges('dtek', {
        ...options, apiKey: 'test-key',
        waitForPublication: async () => { checks++; },
        send: async () => assert.fail('No notification-worthy changes')
    });
    await run();
    assert.equal(checks, 0);
    fs.writeFileSync(options.statePath, JSON.stringify({ ...empty, address: { ...repair, sub_type: 'Планові ремонтні роботи' } }));
    await run();
    assert.equal(checks, 1);
    assert.equal(JSON.parse(fs.readFileSync(options.statePath)).address.sub_type, '');
});
