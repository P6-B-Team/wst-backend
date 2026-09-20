import { pool } from './pool.js';

/** Drops and recreates the public schema. Refuses to run outside development/test. */
if (process.env.NODE_ENV === 'production') {
  console.error('db:reset is disabled in production');
  process.exit(1);
}
await pool.query('drop schema public cascade; create schema public;');
console.log('schema reset');
await pool.end();
