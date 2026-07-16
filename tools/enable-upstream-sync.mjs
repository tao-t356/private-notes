import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runGit(args, options = {}) {
	const output = execFileSync('git', args, {
		cwd: options.cwd || process.cwd(),
		encoding: 'utf8',
		stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
	});
	return typeof output === 'string' ? output.trim() : '';
}

export function installUpstreamWorkflow(cwd = process.cwd()) {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const source = resolve(scriptDirectory, 'upstream-sync.workflow.yml');
	const target = resolve(cwd, '.github', 'workflows', 'sync-upstream.yml');
	if (!existsSync(source)) throw new Error(`Workflow template is missing: ${source}`);
	const template = readFileSync(source);
	if (existsSync(target) && Buffer.compare(readFileSync(target), template) === 0) {
		return { target, changed: false };
	}
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, template);
	return { target, changed: true };
}

function main() {
	const cwd = process.cwd();
	const push = process.argv.includes('--push');
	if (push && runGit(['status', '--porcelain'], { cwd })) {
		throw new Error('Working tree is not clean. Commit or discard changes before using --push.');
	}

	const result = installUpstreamWorkflow(cwd);
	const relativeTarget = '.github/workflows/sync-upstream.yml';
	console.log(result.changed ? `Created ${relativeTarget}.` : `${relativeTarget} is already enabled.`);

	if (!push) {
		console.log('Commit and push this file, then open GitHub Actions and run “Sync upstream Private Notes”.');
		console.log(`git add ${relativeTarget}`);
		console.log('git commit -m "chore: enable upstream updates"');
		console.log('git push');
		return;
	}

	if (!result.changed && !runGit(['status', '--porcelain'], { cwd })) {
		console.log('Nothing to commit. The update workflow is already available on this branch.');
		return;
	}
	runGit(['add', relativeTarget], { cwd });
	runGit(['commit', '-m', 'chore: enable upstream updates'], { cwd, stdio: 'inherit' });
	runGit(['push', 'origin', 'HEAD'], { cwd, stdio: 'inherit' });
	console.log('Enabled. Open the repository Actions tab and run “Sync upstream Private Notes”.');
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
	main();
}
