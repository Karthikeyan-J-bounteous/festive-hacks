import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'varisai.db');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * Run `fn` in a write transaction. `DatabaseSync` is synchronous, so nothing
 * interleaves between the reads and writes inside `fn` (no quota/seq races).
 * Call only at the top level of a route handler: never nest.
 */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
