/**
 * The names the workload agreement's generated program reads (test/support/agreement/workloads.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { workload } from "#compiler/public/workload.ts"
export type { Workload } from "#compiler/public/workload.ts"
export {
	Account,
	addTask,
	addTaskAbove,
	addThing,
	byName,
	Clerk,
	clerkAccount,
	clerkAccounts,
	clerkNewest,
	Kind,
	newestTasks,
	Other,
	Reader,
	Reports,
	Tally,
	Task,
	tallies,
	tasks,
	Thing,
	things,
	twins,
	Work,
	Writer,
	writerTasks
} from "#test/support/agreement/workload-schema.ts"
