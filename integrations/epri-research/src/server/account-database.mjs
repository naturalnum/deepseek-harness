import { DatabaseSync } from 'node:sqlite';

/** Open one native SQLite handle whose actual reads and commits require its original account lease. */
export function openAccountDatabase(path, {assertCurrent, maxDatabaseBytes}) {
  assertCurrent();
  if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 65536) throw new RangeError('Research database capacity must be explicit.');
  const database = new DatabaseSync(path);
  try {
    const pageSize = Number(database.prepare('PRAGMA page_size').get().page_size);
    const pages = Math.floor(maxDatabaseBytes / pageSize);
    const existing = Number(database.prepare('PRAGMA page_count').get().page_count);
    if (existing > pages) throw new Error('The research database exceeds its selected capacity.');
    database.exec('PRAGMA max_page_count=' + pages);
  } catch (error) { database.close(); throw error; }
  return {
    exec(sql) { if (sql.trim() !== 'ROLLBACK') assertCurrent(); return database.exec(sql); },
    prepare(sql) {
      assertCurrent();
      const statement = database.prepare(sql);
      return {
        get(...args) { assertCurrent(); return statement.get(...args); },
        all(...args) { assertCurrent(); return statement.all(...args); },
        run(...args) { assertCurrent(); return statement.run(...args); },
      };
    },
    close() { database.close(); },
  };
}
