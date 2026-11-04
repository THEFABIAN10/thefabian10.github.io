const { setTimeout: delay } = require('node:timers/promises');
const { buildNotification, sendNotification } = require('./notification-core');

const FILES = { schedule: 'dtek-outages.json', address: 'dtek-address.json', yasno: 'outages.json' };

async function collectData(previous, loaders, { sleep = delay } = {}) {
    const data = { ...previous };
    const errors = {};
    const updated = [];
    await Promise.all(Object.entries(loaders).map(async ([key, load]) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                data[FILES[key]] = await load();
                updated.push(key);
                return;
            } catch (error) {
                if (attempt === 2) errors[key] = error instanceof Error ? error.message : 'Source fetch failed';
                else await sleep(2000 * (attempt + 1));
            }
        }
    }));
    return { data, errors, updated };
}

async function waitForPublication(data, siteUrl, {
    // deploy-pages itself may wait ten minutes; allow setup/propagation as well.
    fetchImpl = fetch, sleep = delay, clock = Date.now, timeoutMs = 11 * 60 * 1000, intervalMs = 10000,
} = {}) {
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) {
        try {
            const matches = await Promise.all(Object.entries(data).map(async ([file, expected]) => {
                const url = new URL(`data/${file}`, siteUrl);
                url.searchParams.set('t', String(clock()));
                const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
                // Include lastUpdate: the user must see this specific published fetch.
                return response.ok && JSON.stringify(await response.json()) === JSON.stringify(expected);
            }));
            if (matches.every(Boolean)) return;
        } catch { /* A Pages rollout can temporarily serve old or missing files. */ }
        const remaining = deadline - clock();
        if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
    }
    throw new Error('GitHub Pages has not published the fetched data; push remains pending');
}

async function notifySources({ data, updated, states, config, apiKey, acknowledge,
    send = sendNotification, wait = waitForPublication, now = new Date() }) {
    const errors = {};
    await wait(data, config.siteUrl);
    for (const source of ['dtek', 'yasno']) {
        if (!(source === 'dtek' ? updated.some(key => key === 'schedule' || key === 'address') : updated.includes('yasno'))) continue;
        try {
            if (!states[source]?.revision) throw new Error(`Missing migrated ${source} notification state`);
            const schedule = data[source === 'dtek' ? FILES.schedule : FILES.yasno];
            const address = source === 'dtek' ? data[FILES.address] : null;
            if (!schedule || (source === 'dtek' && !address)) throw new Error('Source data incomplete');
            const notification = buildNotification(source, states[source], schedule, config, address, now);
            if (!notification) {
                console.log(`No notification for ${source}: state unchanged`);
                continue;
            }
            if (notification.payload) {
                if (!apiKey) throw new Error('OneSignal secret is missing');
                const result = await send(notification.payload, apiKey);
                if (!result?.delivered) throw new Error('OneSignal did not accept notification');
                console.log(`Push accepted for ${source}; id=${result.id}`);
            }
            // Persist after each source. Failed acceptance never advances its revision.
            await acknowledge(source, notification.state);
        } catch (error) { errors[source] = error instanceof Error ? error.message : 'Notification failed'; }
    }
    return errors;
}

module.exports = { FILES, collectData, waitForPublication, notifySources };
