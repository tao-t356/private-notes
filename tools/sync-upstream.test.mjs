import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	assertDeploymentIdentityPreserved,
	captureDeploymentIdentity,
	mergeWranglerConfig,
	parseJsonc,
	synchronizeUpstreamSnapshot,
} from './sync-upstream.mjs';
import { installUpstreamWorkflow } from './enable-upstream-sync.mjs';
import { getDeploymentConfigurationError } from './validate-deployment-config.mjs';

test('merges upstream behavior while preserving deployment identity and custom vars', () => {
	const upstream = {
		name: 'private-notes',
		main: 'src/index.ts',
		vars: { APP_NAME: 'Private Notes', APP_SHORT_NAME: '我的笔记', NEW_OPTION: 'new-default' },
		assets: { run_worker_first: ['/api/*', '/'] },
		d1_databases: [{ binding: 'DB', database_name: 'private-notes-db', database_id: 'upstream-id' }],
	};
	const local = {
		name: 'bj',
		vars: { APP_NAME: 'Tao Notes', CUSTOM_ONLY: 'kept' },
		routes: [{ pattern: 'notes.example.com', custom_domain: true }],
		d1_databases: [{ binding: 'DB', database_name: 'my-notes', database_id: 'local-id' }],
	};
	const merged = mergeWranglerConfig(upstream, local);
	assert.equal(merged.name, 'bj');
	assert.deepEqual(merged.assets, upstream.assets);
	assert.deepEqual(merged.vars, {
		APP_NAME: 'Tao Notes',
		APP_SHORT_NAME: '我的笔记',
		NEW_OPTION: 'new-default',
		CUSTOM_ONLY: 'kept',
	});
	assert.deepEqual(merged.routes, local.routes);
	assert.deepEqual(merged.d1_databases, [
		{ binding: 'DB', database_name: 'my-notes', database_id: 'local-id' },
	]);
	assert.doesNotThrow(() =>
		assertDeploymentIdentityPreserved(
			captureDeploymentIdentity(local, { name: 'bj' }),
			captureDeploymentIdentity(merged, { name: 'bj' })
		)
	);
});

test('stops when upstream adds an unprovisioned Cloudflare resource binding', () => {
	const upstream = {
		d1_databases: [
			{ binding: 'DB', database_name: 'notes', database_id: 'upstream-id' },
			{ binding: 'AUDIT_DB', database_name: 'audit', database_id: 'audit-upstream' },
		],
	};
	const local = {
		d1_databases: [{ binding: 'DB', database_name: 'my-notes', database_id: 'local-id' }],
	};
	assert.throws(() => mergeWranglerConfig(upstream, local), /added D1 binding AUDIT_DB/);
});

test('stops instead of deleting unsupported custom Wrangler environments or bindings', () => {
	assert.throws(
		() => mergeWranglerConfig({ main: 'src/index.ts' }, { main: 'src/index.ts', env: { production: {} } }),
		/Wrangler key env is not supported/
	);
	assert.throws(
		() => mergeWranglerConfig({ main: 'src/index.ts', services: [] }, { main: 'src/index.ts' }),
		/Wrangler key services is not supported/
	);
});

test('detects any deployment identity change', () => {
	const wrangler = {
		name: 'bj',
		vars: { APP_NAME: 'Tao Notes' },
		d1_databases: [{ binding: 'DB', database_name: 'notes', database_id: 'safe-id' }],
	};
	const before = captureDeploymentIdentity(wrangler, { name: 'bj' });
	const changed = captureDeploymentIdentity(
		{ ...wrangler, d1_databases: [{ binding: 'DB', database_name: 'notes', database_id: 'wrong-id' }] },
		{ name: 'bj' }
	);
	assert.throws(() => assertDeploymentIdentityPreserved(before, changed), /Deployment identity changed/);
});

test('parses commented Wrangler JSONC and rejects invalid input', () => {
	assert.deepEqual(parseJsonc('{ // comment\n "name": "notes",\n}', 'test'), { name: 'notes' });
	assert.throws(() => parseJsonc('{ invalid', 'test'), /test is invalid/);
});

test('requires a real D1 database ID before production migrations or deploy', () => {
	assert.match(
		getDeploymentConfigurationError({ d1_databases: [{ binding: 'DB', database_name: 'private-notes-db' }] }),
		/database_id/
	);
	assert.equal(
		getDeploymentConfigurationError({
			d1_databases: [
				{
					binding: 'DB',
					database_name: 'private-notes-db',
					database_id: '123e4567-e89b-42d3-a456-426614174000',
				},
			],
		}),
		null
	);
});

test('installs the workflow template idempotently', () => {
	const directory = mkdtempSync(join(tmpdir(), 'private-notes-updater-'));
	try {
		const first = installUpstreamWorkflow(directory);
		const second = installUpstreamWorkflow(directory);
		assert.equal(first.changed, true);
		assert.equal(second.changed, false);
		assert.match(readFileSync(first.target, 'utf8'), /workflow_dispatch/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('keeps the Fork workflow identical to the legacy-clone template', () => {
	assert.equal(
		readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
		readFileSync(new URL('./upstream-sync.workflow.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
	);
});

test('replaces an unrelated deployment snapshot while preserving local Cloudflare identity', () => {
	const directory = mkdtempSync(join(tmpdir(), 'private-notes-sync-integration-'));
	const upstream = join(directory, 'upstream');
	const local = join(directory, 'local');
	const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
	const initialize = (cwd, files) => {
		mkdirSync(cwd, { recursive: true });
		git(cwd, ['init', '-b', 'main']);
		git(cwd, ['config', 'user.name', 'Updater Test']);
		git(cwd, ['config', 'user.email', 'updater@example.invalid']);
		for (const [path, content] of Object.entries(files)) {
			const target = join(cwd, path);
			mkdirSync(join(target, '..'), { recursive: true });
			writeFileSync(target, content);
		}
		git(cwd, ['add', '--all']);
		git(cwd, ['commit', '-m', 'fixture']);
	};

	try {
		initialize(upstream, {
			'wrangler.jsonc': `${JSON.stringify({
				name: 'private-notes',
				main: 'src/index.ts',
				vars: { APP_NAME: 'Private Notes', APP_SHORT_NAME: '我的笔记' },
				d1_databases: [{ binding: 'DB', database_name: 'upstream-db', database_id: 'upstream-id' }],
			}, null, 2)}\n`,
			'package.json': '{"name":"private-notes","private":true}\n',
			'.github/workflows/upstream-ci.yml': 'name: must not be imported\n',
			'src/version.txt': 'new upstream code\n',
		});
		initialize(local, {
			'wrangler.jsonc': `${JSON.stringify({
				name: 'bj',
				main: 'src/index.ts',
				vars: { APP_NAME: 'Tao Notes' },
				d1_databases: [{ binding: 'DB', database_name: 'my-live-db', database_id: 'local-live-id' }],
			}, null, 2)}\n`,
			'package.json': '{"name":"bj","private":true}\n',
			'.github/workflows/sync-upstream.yml': 'name: local updater\n',
			'src/version.txt': 'old deployment code\n',
		});

		const result = synchronizeUpstreamSnapshot(local, {
			remoteName: 'fixture-upstream',
			remoteUrl: upstream,
		});
		const writtenWrangler = JSON.parse(readFileSync(join(local, 'wrangler.jsonc'), 'utf8'));
		assert.equal(writtenWrangler.name, 'bj');
		assert.deepEqual(writtenWrangler.vars, { APP_NAME: 'Tao Notes', APP_SHORT_NAME: '我的笔记' });
		assert.deepEqual(writtenWrangler.d1_databases, [
			{ binding: 'DB', database_name: 'my-live-db', database_id: 'local-live-id' },
		]);
		assert.equal(JSON.parse(readFileSync(join(local, 'package.json'), 'utf8')).name, 'bj');
		assert.equal(readFileSync(join(local, 'src/version.txt'), 'utf8').replace(/\r\n/g, '\n'), 'new upstream code\n');
		assert.equal(readFileSync(join(local, '.github/workflows/sync-upstream.yml'), 'utf8'), 'name: local updater\n');
		assert.equal(existsSync(join(local, '.github/workflows/upstream-ci.yml')), false);
		assert.equal(readFileSync(join(local, '.upstream-version'), 'utf8').trim(), result.upstreamSha);
		assert.notEqual(execFileSync('git', ['status', '--porcelain'], { cwd: local, encoding: 'utf8' }).trim(), '');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
