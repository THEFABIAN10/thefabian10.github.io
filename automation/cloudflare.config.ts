import { bindings, defineConfig, exports, triggers } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
    worker: {
        name: 'norivka-outages',
        entrypoint,
        compatibilityDate: '2026-11-04',
        compatibilityFlags: ['nodejs_compat'],
        workersDev: true,
        env: {
            ADMIN_TOKEN: bindings.secret(),
            GITHUB_ACTIONS_TOKEN: bindings.secret(),
            SCHEDULER_ENABLED: bindings.text(mode === 'live' ? 'true' : 'false'),
        },
        exports: { OutageFeed: exports.durableObject({ storage: 'sqlite' }) },
        triggers: [triggers.scheduled({ schedule: '*/6 * * * *' })],
        observability: {
            enabled: true,
            logs: { enabled: true, headSamplingRate: 1 },
            traces: { enabled: true, headSamplingRate: 1 },
        },
    },
}));
