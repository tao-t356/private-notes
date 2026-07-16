import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const IS_CANONICAL_GITHUB_ACTIONS =
	process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'tao-t356/private-notes';

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

test('keeps the runtime schema gate aligned with every D1 migration file', () => {
	const migrationNames = readdirSync(new URL('../migrations/', import.meta.url))
		.filter((name) => /^\d+_.+\.sql$/.test(name))
		.sort();
	const schemaSource = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
	const manifest = schemaSource.match(/const APPLIED_MIGRATIONS = \[([\s\S]*?)\] as const;/);
	assert.ok(manifest, 'src/schema.ts must declare APPLIED_MIGRATIONS');
	const runtimeNames = [...manifest[1].matchAll(/'([^']+\.sql)'/g)].map((match) => match[1]);
	assert.deepEqual(runtimeNames, migrationNames);
});

test('deploys code before applying migrations so automatic D1 provisioning can run', () => {
	const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(packageJson.scripts.deploy, 'wrangler deploy && npm run db:migrations:apply');
	assert.equal(packageJson.scripts['db:migrations:apply'], 'wrangler d1 migrations apply DB --remote');
});

test('keeps Deploy to Cloudflare self-configuring without sharing an account database', () => {
	const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(packageJson.cloudflare?.bindings?.APP_PASSWORD?.description);
	assert.ok(packageJson.cloudflare?.bindings?.DB?.description);
	const wrangler = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), 'wrangler.jsonc');
	const database = wrangler.d1_databases.find((candidate) => candidate.binding === 'DB');
	assert.equal(database.database_name, 'private-notes-db');
	if (IS_CANONICAL_GITHUB_ACTIONS) {
		assert.equal(database.database_id, undefined);
	} else if (database.database_id !== undefined) {
		assert.match(database.database_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
	}
	assert.deepEqual(wrangler.secrets?.required, ['APP_PASSWORD']);
	const exampleSecrets = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8')
		.split(/\r?\n/)
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => line.split('=', 1)[0]);
	assert.deepEqual(exampleSecrets, ['APP_PASSWORD']);
	assert.match(
		readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
		/https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/tao-t356\/private-notes/
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

test('keeps the checked-in workflow identical when the repository provider preserves workflows', () => {
	const workflow = new URL('../.github/workflows/sync-upstream.yml', import.meta.url);
	if (!existsSync(workflow)) {
		assert.equal(IS_CANONICAL_GITHUB_ACTIONS, false, 'the canonical repository must keep its update workflow');
		return;
	}
	assert.equal(
		readFileSync(workflow, 'utf8').replace(/\r\n/g, '\n'),
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
