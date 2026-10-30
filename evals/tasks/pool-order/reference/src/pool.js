/**
 * runPool(tasks, limit): runs async task functions with at most `limit` of them running at once.
 * Resolves with the results in the same order as `tasks`.
 * If a task rejects (or throws), the returned promise rejects with that error and no further tasks are started;
 * tasks already running are left to finish and their results are ignored.
 * `limit` must be a positive integer, otherwise the promise rejects with a RangeError.
 */
export async function runPool(tasks, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const results = new Array(tasks.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < tasks.length) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
