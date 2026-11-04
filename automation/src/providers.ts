import dtek from '../lib/process-dtek-data.js';
import address from '../lib/process-dtek-address.js';
import { scheduleSnapshot } from '../lib/schedule-changes.js';

// Keep the same browser identity for the session page and its AJAX request.
const DTEK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const DTEK_PAGE = 'https://www.dtek-dnem.com.ua/ua/shutdowns/';
const YASNO = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/301/planned-outages';

// Bound decoded bodies, including chunked/compressed responses.
export async function readBody(response: Response, limit = 2 * 1024 * 1024): Promise<string> {
    if (!response.body) throw new Error('Empty upstream response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('Upstream response exceeds size limit');
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        await reader.cancel();
    }
}

type HttpTrace = Record<string, unknown>[];

async function request(url: string, init: RequestInit = {}, trace?: HttpTrace): Promise<Response> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    if (trace) {
        const text = await readBody(response.clone());
        const headers = Object.fromEntries(new Headers(init.headers));
        for (const name of ['cookie', 'x-csrf-token']) {
            if (headers[name]) headers[name] = '[present, redacted]';
        }
        trace.push({
            url, method: init.method ?? 'GET', headers,
            form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null,
            status: response.status, finalUrl: response.url, redirected: response.redirected,
            contentType: response.headers.get('content-type'),
            server: response.headers.get('server'),
            cookieNames: response.headers.getSetCookie().map(value => value.split('=', 1)[0]),
            bytes: new TextEncoder().encode(text).byteLength,
            hasSchedule: /DisconSchedule\.fact\s*=/.test(text),
            hasCsrf: /name=["']csrf-token["']/.test(text),
            hasProtectionScript: /_Incapsula_Resource|challenge-platform/i.test(text),
        });
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Upstream HTTP ${response.status}`);
    }
    return response;
}

export async function fetchSchedule(now = new Date(), trace?: HttpTrace) {
    const html = await readBody(await request(DTEK_PAGE, { headers: { 'User-Agent': DTEK_USER_AGENT } }, trace));
    const data = dtek.processData(html, now);
    scheduleSnapshot(data);
    return data;
}

export async function fetchAddress(now = new Date(), trace?: HttpTrace) {
    // A fresh cookie jar belongs to this refresh only, just as in the shell fetcher.
    const session = await request(DTEK_PAGE, { headers: { 'User-Agent': DTEK_USER_AGENT } }, trace);
    const cookies = session.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    const html = await readBody(session);
    const csrf = address.extractCsrfHeader(html).slice('X-CSRF-Token: '.length);
    const body = new URLSearchParams({
        method: 'getHomeNum',
        'data[0][name]': 'city', 'data[0][value]': 'с. Любимівка',
        'data[1][name]': 'street', 'data[1][value]': 'вул. Центральна',
        'data[2][name]': 'updateFact', 'data[2][value]': address.formatUpdateFact(now),
    });
    const response = await request('https://www.dtek-dnem.com.ua/ua/ajax', {
        method: 'POST', body,
        headers: {
            'User-Agent': DTEK_USER_AGENT,
            Cookie: cookies, 'X-CSRF-Token': csrf,
            Referer: DTEK_PAGE, Origin: 'https://www.dtek-dnem.com.ua',
            'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json',
        },
    }, trace);
    return address.processAddressData(JSON.parse(await readBody(response)), now);
}

interface YasnoDay {
    date: string;
    status: string;
    slots: { type: string; start: number; end: number }[];
}

export async function fetchYasno(now = new Date()) {
    const response = await request(YASNO, { headers: { Accept: 'application/json' } });
    const text = await readBody(response);
    if (!text.trimStart().startsWith('{')) throw new Error('Yasno returned non-JSON data (possible protection page)');
    const group = JSON.parse(text)?.['1.1'] as { today?: YasnoDay; tomorrow?: YasnoDay } | undefined;
    if (!group || (!group.today && !group.tomorrow)) throw new Error('Missing Yasno group 1.1 days');
    const days = [group.today && { ...group.today, isToday: true },
        group.tomorrow && { ...group.tomorrow, isToday: false }]
        .filter(day => day && day.status === 'ScheduleApplies')
        .map(day => {
            if (!day) throw new Error('Invalid Yasno day');
            return {
                date: day.date, isToday: day.isToday,
                outages: (day.slots || []).filter(slot => slot.type === 'Definite')
                    .map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start),
            };
        });
    const data = { lastUpdate: now.toISOString(), days,
        today: group.today ? { date: group.today.date, status: group.today.status } : null,
    };
    scheduleSnapshot(data);
    return data;
}

// Runs the production HTTP providers without storage, notifications or browser fallback.
// The same module is imported directly by Node on the GitHub runner.
export async function diagnoseDtek(now = new Date()) {
    const steps = [];
    for (const [name, load] of [['schedule', fetchSchedule], ['address', fetchAddress]] as const) {
        const requests: HttpTrace = [];
        try {
            const data = await load(now, requests);
            steps.push({ name, ok: true, requests, data });
        } catch (error) {
            steps.push({ name, ok: false, requests,
                error: error instanceof Error ? error.message : 'Request failed' });
        }
    }
    return { checkedAt: now.toISOString(), steps };
}
