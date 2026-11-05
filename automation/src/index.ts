import { DurableObject } from 'cloudflare:workers';

// Retain the deployed class/namespace so historical data is not deleted during
// migration. The scheduler never instantiates or writes to these objects.
export class OutageFeed extends DurableObject<Env> {}

const WORKFLOW = 'https://api.github.com/repos/norivka/norivka.github.io/actions/workflows/update-outages.yml';

export async function dispatchUpdate(env: Env) {
    if (String(env.SCHEDULER_ENABLED) !== 'true') return { ok: true, skipped: 'disabled' };
    if (!env.GITHUB_ACTIONS_TOKEN) throw new Error('GitHub Actions token is not configured');
    const headers = {
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'norivka-outages-scheduler',
    };
    const runs = await fetch(`${WORKFLOW}/runs?branch=main&per_page=5`, {
        headers, signal: AbortSignal.timeout(20000),
    });
    if (!runs.ok) throw new Error(`GitHub workflow status HTTP ${runs.status}`);
    const data = await runs.json() as { workflow_runs?: { status: string }[] };
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid GitHub workflow status response');
    if (data.workflow_runs.some(run => run.status !== 'completed')) {
        console.log(JSON.stringify({ event: 'dispatch_skipped', reason: 'workflow_active' }));
        return { ok: true, skipped: 'workflow_active' };
    }
    const response = await fetch(`${WORKFLOW}/dispatches`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { notify: true } }),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub workflow dispatch HTTP ${response.status}`);
    await response.body?.cancel();
    console.log(JSON.stringify({ event: 'workflow_dispatched', workflow: 'update-outages.yml' }));
    return { ok: true, dispatched: true };
}

async function authorized(request: Request, token: string | undefined) {
    if (!token) return false;
    const encoder = new TextEncoder();
    const hashes = await Promise.all([request.headers.get('Authorization') ?? '', `Bearer ${token}`]
        .map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
    return crypto.subtle.timingSafeEqual(hashes[0], hashes[1]);
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
    async fetch(request, env) {
        const path = new URL(request.url).pathname;
        // Cached clients may still point at the former Worker data API.
        if (request.method === 'GET' && ['/data/outages.json', '/data/dtek-outages.json', '/data/dtek-address.json'].includes(path)) {
            const target = new URL(path, 'https://norivka.github.io');
            target.searchParams.set('t', String(Date.now()));
            return new Response(null, { status: 302, headers: {
                Location: target.href,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            } });
        }
        if (path === '/health' && request.method === 'GET') {
            return json({ ok: true, role: 'github-actions-scheduler', enabled: String(env.SCHEDULER_ENABLED) === 'true' });
        }
        if (path === '/admin/dispatch' && request.method === 'POST') {
            if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: 'Unauthorized' }, 401);
            try { return json(await dispatchUpdate(env)); }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Dispatch failed';
                console.error(JSON.stringify({ event: 'dispatch_failed', error: message }));
                return json({ error: message }, 502);
            }
        }
        return json({ error: 'Not found' }, 404);
    },
    async scheduled(_controller, env) {
        // Every cron trigger runs the same job, even after a schedule change.
        await dispatchUpdate(env);
    },
} satisfies ExportedHandler<Env>;
