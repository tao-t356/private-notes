import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './sync-upstream.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getDeploymentConfigurationError(config) {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return 'wrangler.jsonc must contain an object';
	}
	const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
	const database = databases.find(
		(candidate) => candidate && typeof candidate === 'object' && candidate.binding === 'DB'
	);
	if (!database) return 'D1 binding DB is missing';
	if (typeof database.database_id !== 'string' || !UUID_PATTERN.test(database.database_id)) {
		return 'D1 binding DB does not contain your Cloudflare database_id';
	}
	return null;
}

export function validateDeploymentConfigFile(path = 'wrangler.jsonc') {
	const config = parseJsonc(readFileSync(path, 'utf8'), path);
	const error = getDeploymentConfigurationError(config);
	if (error) {
		throw new Error(
			`${error}. Create a D1 database in your account and update wrangler.jsonc before production deployment.`
		);
	}
	return config;
}

function main() {
	try {
		validateDeploymentConfigFile();
		console.log('Deployment configuration verified.');
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
	main();
}
