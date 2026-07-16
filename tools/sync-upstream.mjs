import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';

export const UPSTREAM_REPOSITORY = 'tao-t356/private-notes';
const UPSTREAM_REMOTE = 'private-notes-upstream';
const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
const PRESERVED_TOP_LEVEL_KEYS = ['name', 'account_id', 'zone_id', 'route', 'routes', 'workers_dev'];
const SUPPORTED_TOP_LEVEL_KEYS = new Set([
	'$schema',
	'name',
	'main',
	'compatibility_date',
	'compatibility_flags',
	'preview_urls',
	'keep_vars',
	'account_id',
	'zone_id',
	'route',
	'routes',
	'workers_dev',
	'vars',
	'secrets',
	'assets',
	'd1_databases',
	'kv_namespaces',
	'r2_buckets',
	'vectorize',
	'hyperdrive',
	'observability',
	'upload_source_maps',
]);

function runGit(args, options = {}) {
	const output = execFileSync('git', args, {
		cwd: options.cwd || process.cwd(),
		encoding: 'utf8',
		stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
	});
	return typeof output === 'string' ? output.trim() : '';
}

export function parseJsonc(text, label = 'JSONC') {
	const errors = [];
	const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length) {
		const detail = errors
			.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
			.join(', ');
		throw new Error(`${label} is invalid: ${detail}`);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return value;
}

function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

function mergeBindingArray(upstreamValue, localValue, preservedKeys, resourceType) {
	const upstreamBindings = Array.isArray(upstreamValue) ? upstreamValue : [];
	const localBindings = Array.isArray(localValue) ? localValue : [];
	if (!upstreamBindings.length && !localBindings.length) return undefined;
	if (!upstreamBindings.length && localBindings.length) {
		throw new Error(`Upstream removed ${resourceType} bindings. Refusing to detach deployed resources automatically.`);
	}

	const merged = upstreamBindings.map((upstreamBinding) => {
		if (!isRecord(upstreamBinding) || typeof upstreamBinding.binding !== 'string') {
			throw new Error(`Upstream contains an invalid ${resourceType} binding.`);
		}
		const localBinding = localBindings.find(
			(candidate) => isRecord(candidate) && candidate.binding === upstreamBinding.binding
		);
		if (!isRecord(localBinding)) {
			throw new Error(
				`Upstream added ${resourceType} binding ${upstreamBinding.binding}. Provision and configure this resource before syncing.`
			);
		}
		const mergedBinding = clone(upstreamBinding);
		for (const key of preservedKeys) {
			if (Object.hasOwn(localBinding, key)) mergedBinding[key] = clone(localBinding[key]);
		}
		return mergedBinding;
	});
	for (const localBinding of localBindings) {
		if (
			isRecord(localBinding) &&
			typeof localBinding.binding === 'string' &&
			!upstreamBindings.some(
				(upstreamBinding) => isRecord(upstreamBinding) && upstreamBinding.binding === localBinding.binding
			)
		) {
			throw new Error(
				`Upstream no longer declares ${resourceType} binding ${localBinding.binding}. Refusing to detach it automatically.`
			);
		}
	}
	return merged;
}

export function mergeWranglerConfig(upstreamConfig, localConfig) {
	if (!isRecord(upstreamConfig) || !isRecord(localConfig)) {
		throw new Error('Wrangler configurations must be objects');
	}
	for (const key of new Set([...Object.keys(upstreamConfig), ...Object.keys(localConfig)])) {
		if (!SUPPORTED_TOP_LEVEL_KEYS.has(key)) {
			throw new Error(
				`Wrangler key ${key} is not supported by the automatic updater. Review and merge this deployment configuration manually.`
			);
		}
	}
	const merged = clone(upstreamConfig);

	for (const key of PRESERVED_TOP_LEVEL_KEYS.filter((key) => key !== 'route' && key !== 'routes')) {
		if (Object.hasOwn(localConfig, key)) merged[key] = clone(localConfig[key]);
	}
	if (Object.hasOwn(localConfig, 'route')) {
		merged.route = clone(localConfig.route);
		delete merged.routes;
	} else if (Object.hasOwn(localConfig, 'routes')) {
		merged.routes = clone(localConfig.routes);
		delete merged.route;
	}

	const upstreamVars = isRecord(upstreamConfig.vars) ? upstreamConfig.vars : {};
	const localVars = isRecord(localConfig.vars) ? localConfig.vars : {};
	merged.vars = { ...clone(upstreamVars), ...clone(localVars) };

	merged.d1_databases = mergeBindingArray(
		upstreamConfig.d1_databases,
		localConfig.d1_databases,
		['database_id', 'database_name', 'preview_database_id'],
		'D1'
	);
	merged.kv_namespaces = mergeBindingArray(
		upstreamConfig.kv_namespaces,
		localConfig.kv_namespaces,
		['id', 'preview_id'],
		'KV'
	);
	merged.r2_buckets = mergeBindingArray(upstreamConfig.r2_buckets, localConfig.r2_buckets, [
		'bucket_name',
		'preview_bucket_name',
		'jurisdiction',
	], 'R2');
	merged.vectorize = mergeBindingArray(
		upstreamConfig.vectorize,
		localConfig.vectorize,
		['index_name'],
		'Vectorize'
	);
	merged.hyperdrive = mergeBindingArray(
		upstreamConfig.hyperdrive,
		localConfig.hyperdrive,
		['id'],
		'Hyperdrive'
	);

	for (const key of ['d1_databases', 'kv_namespaces', 'r2_buckets', 'vectorize', 'hyperdrive']) {
		if (merged[key] === undefined) delete merged[key];
	}
	return merged;
}

export function captureDeploymentIdentity(wranglerConfig, packageConfig) {
	const captureBindings = (value, fields) =>
		Array.isArray(value)
			? value
					.filter((binding) => isRecord(binding) && typeof binding.binding === 'string')
					.map((binding) => ({
						binding: binding.binding,
						...Object.fromEntries(fields.filter((field) => Object.hasOwn(binding, field)).map((field) => [field, binding[field]])),
					}))
			: [];

	return {
		packageName: isRecord(packageConfig) ? packageConfig.name : undefined,
		workerName: wranglerConfig.name,
		accountId: wranglerConfig.account_id,
		zoneId: wranglerConfig.zone_id,
		route: wranglerConfig.route,
		routes: wranglerConfig.routes,
		workersDev: wranglerConfig.workers_dev,
		vars: isRecord(wranglerConfig.vars) ? clone(wranglerConfig.vars) : {},
		d1: captureBindings(wranglerConfig.d1_databases, [
			'database_id',
			'database_name',
			'preview_database_id',
		]),
		kv: captureBindings(wranglerConfig.kv_namespaces, ['id', 'preview_id']),
		r2: captureBindings(wranglerConfig.r2_buckets, [
			'bucket_name',
			'preview_bucket_name',
			'jurisdiction',
		]),
		vectorize: captureBindings(wranglerConfig.vectorize, ['index_name']),
		hyperdrive: captureBindings(wranglerConfig.hyperdrive, ['id']),
	};
}

export function assertDeploymentIdentityPreserved(before, after) {
	const fail = () => {
		throw new Error('Deployment identity changed during upstream sync. The update was stopped before commit or push.');
	};
	for (const key of ['packageName', 'workerName', 'accountId', 'zoneId', 'route', 'routes', 'workersDev']) {
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail();
	}
	for (const [key, value] of Object.entries(before.vars || {})) {
		if (!Object.hasOwn(after.vars || {}, key) || JSON.stringify(after.vars[key]) !== JSON.stringify(value)) fail();
	}
	for (const group of ['d1', 'kv', 'r2', 'vectorize', 'hyperdrive']) {
		for (const binding of before[group] || []) {
			const candidate = (after[group] || []).find((item) => item.binding === binding.binding);
			if (!candidate || JSON.stringify(candidate) !== JSON.stringify(binding)) fail();
		}
	}
}

function collectFiles(root, current = root, files = new Map()) {
	if (!existsSync(current)) return files;
	for (const entry of readdirSync(current)) {
		const path = join(current, entry);
		if (statSync(path).isDirectory()) collectFiles(root, path, files);
		else files.set(relative(root, path), readFileSync(path));
	}
	return files;
}

function restoreFiles(root, files) {
	for (const [path, content] of files) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

function refuseSymlink(path, label) {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
		throw new Error(`Upstream ${label} is a symbolic link. Refusing to write through it.`);
	}
}

function ensureCleanWorkingTree(cwd) {
	if (runGit(['status', '--porcelain'], { cwd })) {
		throw new Error('Working tree is not clean. Commit or discard local changes before syncing upstream.');
	}
}

function configureUpstreamRemote(cwd, remoteName, remoteUrl, branch) {
	const remotes = runGit(['remote'], { cwd }).split(/\r?\n/).filter(Boolean);
	if (remotes.includes(remoteName)) runGit(['remote', 'set-url', remoteName, remoteUrl], { cwd });
	else runGit(['remote', 'add', remoteName, remoteUrl], { cwd });
	runGit(['fetch', '--no-tags', remoteName, branch], { cwd, stdio: 'inherit' });
}

export function synchronizeUpstreamSnapshot(cwd = process.cwd(), options = {}) {
	cwd = resolve(cwd);
	const remoteName = options.remoteName || UPSTREAM_REMOTE;
	const remoteUrl = options.remoteUrl || UPSTREAM_URL;
	const branch = options.branch || 'main';
	ensureCleanWorkingTree(cwd);
	const localWranglerText = readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8');
	const localPackageText = readFileSync(join(cwd, 'package.json'), 'utf8');
	const localWrangler = parseJsonc(localWranglerText, 'local wrangler.jsonc');
	const localPackage = JSON.parse(localPackageText);
	const identityBefore = captureDeploymentIdentity(localWrangler, localPackage);
	const preservedWorkflows = collectFiles(join(cwd, '.github', 'workflows'));

	configureUpstreamRemote(cwd, remoteName, remoteUrl, branch);
	const upstreamRef = `${remoteName}/${branch}`;
	const upstreamSha = runGit(['rev-parse', upstreamRef], { cwd });
	const upstreamWranglerText = runGit(['show', `${upstreamRef}:wrangler.jsonc`], { cwd });
	const upstreamPackageText = runGit(['show', `${upstreamRef}:package.json`], { cwd });
	const upstreamWrangler = parseJsonc(upstreamWranglerText, 'upstream wrangler.jsonc');
	const upstreamPackage = JSON.parse(upstreamPackageText);
	const mergedWrangler = mergeWranglerConfig(upstreamWrangler, localWrangler);
	upstreamPackage.name = localPackage.name;
	const identityAfter = captureDeploymentIdentity(mergedWrangler, upstreamPackage);
	assertDeploymentIdentityPreserved(identityBefore, identityAfter);

	runGit(['read-tree', '--reset', '-u', upstreamRef], { cwd });
	refuseSymlink(join(cwd, 'wrangler.jsonc'), 'wrangler.jsonc');
	refuseSymlink(join(cwd, 'package.json'), 'package.json');
	refuseSymlink(join(cwd, '.github'), '.github directory');
	const workflowsDirectory = join(cwd, '.github', 'workflows');
	refuseSymlink(workflowsDirectory, 'workflows directory');
	refuseSymlink(join(cwd, '.upstream-version'), '.upstream-version');
	writeFileSync(join(cwd, 'wrangler.jsonc'), `${JSON.stringify(mergedWrangler, null, '\t')}\n`);
	writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(upstreamPackage, null, 2)}\n`);
	rmSync(workflowsDirectory, { recursive: true, force: true });
	restoreFiles(workflowsDirectory, preservedWorkflows);
	writeFileSync(join(cwd, '.upstream-version'), `${upstreamSha}\n`);
	runGit(['add', '--all'], { cwd });

	const writtenWrangler = parseJsonc(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8'), 'written wrangler.jsonc');
	const writtenPackage = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
	assertDeploymentIdentityPreserved(identityBefore, captureDeploymentIdentity(writtenWrangler, writtenPackage));
	return { upstreamSha, identity: identityAfter };
}

function main() {
	const result = synchronizeUpstreamSnapshot();
	console.log(`Prepared upstream snapshot ${result.upstreamSha}.`);
	console.log('Deployment identity verified: Worker name, resource IDs, routes, package name, and vars are unchanged.');
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
	main();
}
