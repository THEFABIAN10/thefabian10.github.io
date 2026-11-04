import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [cloudflareTest({
        config: './cloudflare.config.ts',
        miniflare: { bindings: { ADMIN_TOKEN: 'test-admin', GITHUB_ACTIONS_TOKEN: 'test-github', SCHEDULER_ENABLED: 'true' } },
    })],
    test: { include: ['test/**/*.test.ts'] },
});
