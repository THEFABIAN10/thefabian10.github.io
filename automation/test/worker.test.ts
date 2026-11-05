import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { dispatchUpdate } from '../src/index';
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://worker.test${path}`, init), env, {} as ExecutionContext);
afterEach(() => vi.restoreAllMocks());

it.each(['*/6 * * * *', '*/10 * * * *', '0 * * * *'])('cron %s dispatches only the configured workflow with push enabled', async (cron) => {
    const mock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ workflow_runs: [{ status: 'completed' }] }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await worker.scheduled({ cron } as ScheduledController, env, {} as ExecutionContext);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(String(mock.mock.calls[1][0])).toBe('https://api.github.com/repos/norivka/norivka.github.io/actions/workflows/update-outages.yml/dispatches');
    const init = mock.mock.calls[1][1];
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { notify: true } });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-github');
});
it('skips a queued or active run rather than starting overlapping work', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ workflow_runs: [{ status: 'in_progress' }] }));
    expect(await dispatchUpdate(env)).toEqual({ ok: true, skipped: 'workflow_active' });
    expect(mock).toHaveBeenCalledTimes(1);
});
it('surfaces GitHub authentication failures without exposing tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private upstream details', { status: 401 }));
    await expect(dispatchUpdate(env)).rejects.toThrow('GitHub workflow status HTTP 401');
    const response = await request('/admin/dispatch', { method: 'POST', headers: { Authorization: 'Bearer test-admin' } });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/test-github|private upstream/);
});
it('manual dispatch requires authorization and old clients reach fresh public data', async () => {
    const mock = vi.spyOn(globalThis, 'fetch');
    expect((await request('/admin/dispatch', { method: 'POST' })).status).toBe(401);
    for (const file of ['outages.json', 'dtek-outages.json', 'dtek-address.json']) {
        const response = await request(`/data/${file}`);
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toMatch(new RegExp(`^https://norivka.github.io/data/${file}\\?t=\\d+$`));
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await request('/data/unknown.json')).status).toBe(404);
    expect((await request('/admin/refresh?source=dtek', { method: 'POST' })).status).toBe(404);
    expect((await request('/health')).status).toBe(200);
    expect(mock).not.toHaveBeenCalled();
});
it('disabled mode performs no network work', async () => {
    const mock = vi.spyOn(globalThis, 'fetch');
    expect(await dispatchUpdate({ ...env, SCHEDULER_ENABLED: 'false' })).toEqual({ ok: true, skipped: 'disabled' });
    expect(mock).not.toHaveBeenCalled();
});
it('dispatch errors and malformed status responses fail the cron', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ wrong: [] }));
    await expect(dispatchUpdate(env)).rejects.toThrow('Invalid GitHub');
    mock.mockResolvedValueOnce(Response.json({ workflow_runs: [] })).mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(dispatchUpdate(env)).rejects.toThrow('dispatch HTTP 403');
});
