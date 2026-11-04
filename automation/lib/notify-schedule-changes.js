const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { scheduleSnapshot, addressNotice } = require('./schedule-changes');
const { buildNotification, sendNotification } = require('./notification-core');
const SOURCES = { dtek: { name: 'ДТЕК', file: 'data/dtek-outages.json' } };

async function waitForPublishedData(expected, siteUrl, {
    fetchImpl = fetch, sleep = delay, log = console.log, clock = Date.now,
    timeoutMs = 4 * 60 * 1000, intervalMs = 10000
} = {}) {
    const snapshot = (data, address) => JSON.stringify({
        days: scheduleSnapshot(data), address: addressNotice(address)
    });
    const target = snapshot(expected, expected.address);
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) {
        try {
            const signal = AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - clock())));
            const [data, address] = await Promise.all(['data/dtek-outages.json', 'data/dtek-address.json'].map(async file => {
                const url = new URL(file, siteUrl);
                url.searchParams.set('t', clock());
                const response = await fetchImpl(url.href, { cache: 'no-store', signal });
                if (!response.ok) throw new Error('Published DTEK data is unavailable');
                return response.json();
            }));
            if (snapshot(data, address) === target) {
                log('Published DTEK data confirmed');
                return;
            }
        } catch {
            // A deployment or CDN refresh may temporarily return old data, 404, or HTML.
        }
        const remaining = deadline - clock();
        if (remaining <= 0) break;
        log('Waiting for updated DTEK data on the public site');
        await sleep(Math.min(intervalMs, remaining));
    }
    throw new Error('Updated DTEK data is not published; notification remains pending');
}

async function notifyScheduleChanges(source, {
    root = __dirname, apiKey = process.env.ONESIGNAL_REST_API_KEY, send = sendNotification,
    waitForPublication = waitForPublishedData, log = console.log, now = new Date()
} = {}) {
    if (!Object.hasOwn(SOURCES, source)) throw new Error('Only DTEK notifications are enabled');
    const config = JSON.parse(fs.readFileSync(`${root}/push-config.json`, 'utf8'));
    if (!apiKey || !config.appId) {
        log('::warning::Push skipped: configure ONESIGNAL_REST_API_KEY and push-config.json');
        return;
    }
    const statePath = `${root}/.github/notification-state/${source}.json`;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const data = JSON.parse(fs.readFileSync(`${root}/${SOURCES[source].file}`, 'utf8'));
    const address = source === 'dtek'
        ? JSON.parse(fs.readFileSync(`${root}/data/dtek-address.json`, 'utf8')) : null;
    const notification = buildNotification(source, state, data, config, address, now);
    if (!notification) {
        log(`No schedule changes for ${source}`);
        return;
    }
    await waitForPublication(notification.state, config.siteUrl, { log });
    const result = notification.payload ? await send(notification.payload, apiKey) : null;
    if (notification.payload && !result?.delivered) {
        throw new Error('OneSignal did not accept the notification; notification remains pending');
    }
    fs.writeFileSync(statePath, JSON.stringify(notification.state, null, 2) + '\n');
    log(result === null ? `State updated for ${source}; no notification-worthy change`
        : `Push accepted for ${source}${result.id ? `; notification ID: ${result.id}` : ''}`);
}

if (require.main === module) {
    notifyScheduleChanges(process.argv[2]).catch(error => {
        // Avoid logging request objects, headers, or credentials.
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { buildNotification, sendNotification, notifyScheduleChanges, waitForPublishedData };
