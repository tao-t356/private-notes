type SchemaEnv = {
	DB: D1Database;
};

const APPLICATION_TABLE_NAMES = ['app_meta', 'auth_rate_limits', 'd1_migrations', 'note_shares', 'notes'] as const;
const APPLIED_MIGRATIONS = [
	'0001_init.sql',
	'0002_notes_fts.sql',
	'0003_app_meta.sql',
	'0004_auth_rate_limits.sql',
	'0005_note_vaults.sql',
	'0006_hardening.sql',
	'0007_one_time_shares.sql',
] as const;

const schemaChecks = new WeakMap<object, Promise<void>>();

async function getUserTableNames(db: D1Database) {
	const result = await db.prepare(
		`SELECT name
		 FROM sqlite_master
		 WHERE type = 'table'
		   AND name NOT GLOB 'sqlite_*'
		   AND name NOT GLOB '_cf_*'`
	).all<{ name: string }>();
	return new Set((result.results ?? []).map((row) => row.name));
}

async function hasCurrentMigrationJournal(db: D1Database) {
	const result = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
	const applied = new Set((result.results ?? []).map((row) => row.name));
	return APPLIED_MIGRATIONS.every((name) => applied.has(name));
}

async function initializeFreshDatabase(db: D1Database) {
	const userTables = await getUserTableNames(db);
	const existingTables = new Set(APPLICATION_TABLE_NAMES.filter((name) => userTables.has(name)));
	if (APPLICATION_TABLE_NAMES.every((name) => existingTables.has(name))) {
		if (await hasCurrentMigrationJournal(db)) return;
		throw new Error('database migration journal is incomplete; apply D1 migrations before deployment');
	}
	if (existingTables.size > 0) {
		throw new Error('database schema is incomplete; apply D1 migrations before deployment');
	}
	if (userTables.size > 0) {
		throw new Error('database is not empty and does not contain a private-notes schema');
	}

	const statements = [
		db.prepare(
			`CREATE TABLE IF NOT EXISTS notes (
			 id TEXT PRIMARY KEY,
			 title TEXT NOT NULL,
			 content TEXT NOT NULL,
			 created_at INTEGER NOT NULL,
			 updated_at INTEGER NOT NULL,
			 vault_id TEXT NOT NULL DEFAULT 'default'
			)`
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_notes_vault_updated_id
			 ON notes(vault_id, updated_at DESC, id DESC)`
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS app_meta (
			 key TEXT PRIMARY KEY,
			 value TEXT NOT NULL
			)`
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS auth_rate_limits (
			 key TEXT PRIMARY KEY,
			 attempts INTEGER NOT NULL,
			 first_attempt_at INTEGER NOT NULL,
			 locked_until INTEGER NOT NULL,
			 updated_at INTEGER NOT NULL
			)`
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated_at
			 ON auth_rate_limits(updated_at)`
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS note_shares (
			 token_hash TEXT PRIMARY KEY,
			 proof_hash TEXT NOT NULL,
			 vault_id TEXT NOT NULL,
			 ciphertext TEXT NOT NULL,
			 created_at INTEGER NOT NULL,
			 expires_at INTEGER NOT NULL
			)`
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_note_shares_expires_at
			 ON note_shares(expires_at)`
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS d1_migrations (
			 id INTEGER PRIMARY KEY AUTOINCREMENT,
			 name TEXT UNIQUE,
			 applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
			)`
		),
		...APPLIED_MIGRATIONS.map((name) =>
			db.prepare('INSERT INTO d1_migrations (name) VALUES (?) ON CONFLICT(name) DO NOTHING').bind(name)
		),
	];
	await db.batch(statements);

	const initializedTables = await getUserTableNames(db);
	if (!APPLICATION_TABLE_NAMES.every((name) => initializedTables.has(name))) {
		throw new Error('failed to initialize the fresh D1 database schema');
	}
	if (!(await hasCurrentMigrationJournal(db))) {
		throw new Error('failed to initialize the fresh D1 migration journal');
	}
}

/**
 * Legacy Deploy to Cloudflare installs may use the default `wrangler deploy`
 * command and skip repository migrations. Bootstrap only a completely empty
 * auto-provisioned D1 database; partial/existing schemas fail closed and must
 * use migrations.
 */
export function ensureApplicationSchema(env: SchemaEnv) {
	const cacheKey = env.DB as unknown as object;
	const existing = schemaChecks.get(cacheKey);
	if (existing) return existing;

	const pending = initializeFreshDatabase(env.DB);
	schemaChecks.set(cacheKey, pending);
	pending.catch(() => {
		if (schemaChecks.get(cacheKey) === pending) schemaChecks.delete(cacheKey);
	});
	return pending;
}
