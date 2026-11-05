// Check the owning account immediately before each SQLite operation, including
// writes that resume after execution or extraction. Rollback must still unwind.
export function guardedDatabase(database, assertCurrent) {
  if (!assertCurrent) return database;
  return {
    exec(sql) { if (sql !== 'ROLLBACK') assertCurrent(); return database.exec(sql); },
    prepare(sql) {
      assertCurrent();
      const statement = database.prepare(sql);
      return Object.fromEntries(['run', 'get', 'all'].map(method => [method, (...args) => {
        assertCurrent();
        return statement[method](...args);
      }]));
    },
    close() { database.close(); },
  };
}
