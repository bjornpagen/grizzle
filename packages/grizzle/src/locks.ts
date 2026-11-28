/**
 * @bjornpagen/grizzle/locks, read as gLocks: the locks one transaction of `grizzle migrate` holds installing a
 * migrations directory, at most, as its folders state them, which a test cluster's specification sizes its members'
 * max_locks_per_transaction by (the testing library's localCluster), so a cluster that installs the schema in every
 * test file holds what each install takes.
 */
export { migrationLocks } from "#adapter/public/locks.ts"
