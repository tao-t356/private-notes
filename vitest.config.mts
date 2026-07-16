import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

process.env.APP_PASSWORD ??= 'test-default-password-with-strong-entropy';
process.env.COOKIE_SECRET ??= 'test-cookie-secret-with-at-least-32-random-characters';

export default defineConfig(async () => {
	const rootDir = fileURLToPath(new URL('.', import.meta.url));
	const migrations = await readD1Migrations(path.join(rootDir, 'migrations'));

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						APP_PASSWORD: 'test-default-password-with-strong-entropy',
						APP_PASSWORDS: 'guest=test-guest-password-with-strong-entropy',
						COOKIE_SECRET: 'test-cookie-secret-with-at-least-32-random-characters',
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
		test: {
			include: ['test/**/*.spec.ts'],
			setupFiles: ['./test/apply-migrations.ts'],
		},
	};
});
