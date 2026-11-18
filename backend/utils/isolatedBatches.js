// Per-item failure isolation without one transaction per item.
//
// SOR uploads (up to 50,000 rows) and the AJIO SOR mirror wrote every invoice
// in its own BEGIN/COMMIT so one bad invoice could not block the rest: tens of
// thousands of commits (each a WAL flush) inside one HTTP request. Items now
// share a transaction per group, each inside a SAVEPOINT: a failing item is
// rolled back to its savepoint and reported, and the rest of the group still
// commits. Success callbacks run only after the group's COMMIT, so counts
// never include work that was rolled back.
export const ISOLATED_GROUP_SIZE = 250;

export async function forEachIsolated(client, items, work, {
  groupSize = ISOLATED_GROUP_SIZE,
  onSuccess = () => {},
  onError = () => {},
} = {}) {
  for (let start = 0; start < items.length; start += groupSize) {
    const group = items.slice(start, start + groupSize);
    const succeeded = [];
    const reported = new Set();
    try {
      await client.query('BEGIN');
      for (const item of group) {
        await client.query('SAVEPOINT isolated_item');
        try {
          const outcome = await work(item);
          await client.query('RELEASE SAVEPOINT isolated_item');
          succeeded.push([item, outcome]);
        } catch (error) {
          // If even the rollback to the savepoint fails (connection lost), the
          // outer handler rolls back the group and reports this item too.
          await client.query('ROLLBACK TO SAVEPOINT isolated_item');
          reported.add(item);
          onError(item, error);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      for (const item of group) {
        if (!reported.has(item)) onError(item, error);
      }
      continue;
    }
    for (const [item, outcome] of succeeded) onSuccess(item, outcome);
  }
}
