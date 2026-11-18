// Per-item failure isolation without one transaction per item.
//
// SOR uploads (up to 50,000 rows) and the AJIO SOR mirror wrote every invoice
// in its own BEGIN/COMMIT so one bad invoice could not block the rest: tens of
// thousands of commits (each a WAL flush) inside one HTTP request. Items now
// share a transaction per group, each inside a SAVEPOINT: a failing item is
// rolled back to its savepoint and reported, and the rest of the group still
// commits. Success callbacks run only after the group's COMMIT, so counts
// never include work that was rolled back.
//
// Group size: every writing savepoint gets a subtransaction id that stays
// attached to the group's transaction until it commits. PostgreSQL caches 64
// of them per backend; beyond that, visibility checks of concurrent readers
// fall back to pg_subtrans lookups (extra I/O on the ledger reads). 64 keeps a
// group inside the cache while still committing 64x less often than before.
export const ISOLATED_GROUP_SIZE = 64;

export async function forEachIsolated(client, items, work, {
  groupSize = ISOLATED_GROUP_SIZE,
  onSuccess = () => {},
  onError = () => {},
} = {}) {
  if (!Number.isSafeInteger(groupSize) || groupSize < 1) {
    throw new RangeError(`groupSize must be a positive integer, got ${groupSize}`);
  }
  for (let start = 0; start < items.length; start += groupSize) {
    const group = items.slice(start, start + groupSize);
    const succeeded = [];
    // Positions (not values) already reported, so a repeated item value still
    // gets its own callback when the group's COMMIT fails.
    const reported = new Set();
    try {
      await client.query('BEGIN');
      for (let position = 0; position < group.length; position++) {
        const item = group[position];
        await client.query('SAVEPOINT isolated_item');
        try {
          const outcome = await work(item);
          await client.query('RELEASE SAVEPOINT isolated_item');
          succeeded.push([item, outcome]);
        } catch (error) {
          // If even the rollback to the savepoint fails (connection lost), the
          // outer handler rolls back the group and reports this item too.
          await client.query('ROLLBACK TO SAVEPOINT isolated_item');
          reported.add(position);
          onError(item, error);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      group.forEach((item, position) => {
        if (!reported.has(position)) onError(item, error);
      });
      continue;
    }
    for (const [item, outcome] of succeeded) onSuccess(item, outcome);
  }
}
