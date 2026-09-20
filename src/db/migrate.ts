import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

/**
 * Applies every .sql file in migrations/ exactly once, in filename order.
 * The directory is resolved relative to this file so it works from src (tsx) and from dist (node).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [path.join(here, 'migrations'), path.resolve('src/db/migrations'), path.resolve('dist/db/migrations')];
const dir = candidates.find((d) => fs.existsSync(d));
if (!dir) throw new Error(`No migrations directory found. Looked in: ${candidates.join(', ')}`);

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(filename text primary key, applied_at timestamptz default now())');

for (const file of files) {
  const applied = await pool.query('select 1 from schema_migrations where filename=$1', [file]);
  if (applied.rowCount) continue;
  await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  await pool.query('insert into schema_migrations(filename) values($1)', [file]);
  console.log(`applied ${file}`);
}
console.log(`migrations up to date (${files.length} total, from ${dir})`);
await pool.end();
