const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { scheduleSnapshot, changedScheduleDates, scheduleChangeKind, addressNotice, isNotifiableAddressNotice, isStabilizationNotice, addressChangeKind } = require('./schedule-changes');

const SOURCES = {
    dtek: { name: 'ДТЕК', file: 'data/dtek-outages.json' },
    yasno: { name: 'ЯСНО', file: 'data/outages.json' }
};
const PUSH_SEGMENTS = ['Total Subscriptions'];

function formatAddressTime(value) {
    // DTEK already supplies Kyiv wall time; do not reinterpret it as a UTC date.
    const match = /^(\d{1,2}):(\d{2}) (\d{1,2})\.(\d{1,2})\.\d{4}$/u.exec(value);
    if (!match) return value;
    const [, hour, minute, day, month] = match;
    return `${day.padStart(2, '0')}.${month.padStart(2, '0')} ${Number(hour)}:${minute}`;
}

function addressNotificationBody(notice) {
    const start = formatAddressTime(notice.start_date);
    const end = formatAddressTime(notice.end_date);
    if (start && end) return `${start} - ${end}`;
    if (start) return `Початок: ${start}`;
    if (end) return `Завершення: ${end}`;
    return '';
}

/** @param {{sub_type: string, start_date: string, end_date: string} | null} addressData */
function buildNotification(source, previousState, data, config, addressData = null, now = new Date()) {
    if (!Object.hasOwn(SOURCES, source)) throw new Error('Unknown schedule source');
    const previous = scheduleSnapshot(previousState);
    const next = scheduleSnapshot(data);
    const dates = changedScheduleDates(previous, next);
    const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    const scheduleKind = source === 'dtek' ? scheduleChangeKind(previous, next, today) : null;
    const beforeNotice = addressNotice(previousState.address);
    const nextNotice = addressNotice(source === 'dtek' ? addressData :
        data.today?.status === 'EmergencyShutdowns'
            ? { sub_type: 'Екстрені відключення', start_date: '', end_date: '' } : null);
    const isRepair = /^аварійні ремонтні роботи$/iu.test(nextNotice.sub_type);
    // Older states silently acknowledged non-emergency notices. Deliver a current
    // notice once under the expanded policy, keeping failed sends pending.
    const pendingNotice = previousState.addressNotificationVersion !== 1 &&
        isNotifiableAddressNotice(nextNotice) && !isRepair && !isStabilizationNotice(nextNotice);
    const emergencyRemoved = /аварійн|екстрен/iu.test(beforeNotice.sub_type) &&
        !isNotifiableAddressNotice(nextNotice);
    const noticeKind = emergencyRemoved ? 'removed' :
        pendingNotice ? 'appeared' : addressChangeKind(beforeNotice, nextNotice);
    if (dates.length === 0 && JSON.stringify(beforeNotice) === JSON.stringify(nextNotice) && !pendingNotice) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.appId)) {
        throw new Error('Invalid OneSignal App ID');
    }
    if (!previousState.revision) throw new Error('Missing notification state revision');

    // A stable UUID deduplicates retries even after a failed acknowledgement commit.
    // Chaining the previous revision lets a later A → B change get its own message.
    // Include the audience so correcting a target does not reuse a failed send's key.
    const bytes = createHash('sha256').update(JSON.stringify([source, previousState.revision, next, nextNotice, PUSH_SEGMENTS])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const title = noticeKind
        ? (emergencyRemoved
            ? (/екстрен/iu.test(beforeNotice.sub_type) ? 'Скасовано екстрені відключення' : 'Скасовано аварійні відключення')
            : nextNotice.sub_type || 'Повідомлення про відключення')
        : {
            published: 'нові графіки відключень',
            changed: 'зміни у графіках відключень',
            cancelled: 'скасовано графіки відключень'
        }[scheduleKind];
    const heading = SOURCES[source].name;
    const message = (title ?? '').replace(/\p{L}/u, letter => letter.toLocaleLowerCase('uk-UA'));
    const times = noticeKind ? addressNotificationBody(nextNotice) : '';
    const body = [message, times].filter(Boolean).join('\n');
    const url = new URL(config.siteUrl);
    if (url.protocol !== 'https:') throw new Error('Notification URL must use HTTPS');
    url.searchParams.set('source', source);
    return {
        state: { days: next, address: nextNotice, addressNotificationVersion: 1, revision: id },
        // Acknowledge every change so reappearance can trigger a new notification.
        payload: !scheduleKind && !noticeKind ? null : {
            app_id: config.appId,
            included_segments: PUSH_SEGMENTS,
            target_channel: 'push',
            isAnyWeb: true,
            headings: { en: heading, uk: heading },
            contents: { en: body, uk: body },
            url: url.href,
            ttl: 2 * 60 * 60,
            idempotency_key: id
        }
    };
}

async function sendNotification(payload, apiKey, { fetchImpl = fetch, sleep = delay } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try {
            response = await fetchImpl('https://api.onesignal.com/notifications?c=push', {
                method: 'POST',
                headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000)
            });
        } catch {
            if (attempt === 2) throw new Error('OneSignal network request failed after 3 attempts');
        }
        if (response?.ok) {
            const result = await response.json();
            if (result.id) return { delivered: true, id: result.id };
            // With no eligible subscribers OneSignal creates no notification.
            if (Array.isArray(result.errors) && result.errors.length > 0 &&
                result.errors.every(error => typeof error === 'string' && /not subscribed|no subscribers/i.test(error))) {
                throw new Error('OneSignal found no subscribed devices in the target audience; notification remains pending');
            }
            throw new Error('OneSignal did not create a notification; check the app configuration');
        }
        if (response && response.status !== 429 && response.status < 500) {
            throw new Error(`OneSignal rejected notification (HTTP ${response.status})`);
        }
        if (attempt === 2) throw new Error(`OneSignal unavailable (HTTP ${response.status})`);
        const retryAfter = Number(response?.headers?.get('retry-after'));
        await sleep(Math.min(Math.max(2 ** attempt * 1000, retryAfter * 1000 || 0), 60000));
    }
}

module.exports = { buildNotification, sendNotification };
