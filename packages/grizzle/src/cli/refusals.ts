import type { MigrateStage } from "#adapter/migrate/errors.ts"
import type { CliStage } from "#cli/errors.ts"

interface Refusal {
	readonly problem: string
	readonly fix: string
}

/**
 * Every refusal the command line prints, with its fix.
 *
 * `grizzle check` and `grizzle migrate` print each finding as `<where>: <problem>; <fix>`, and every refusal of a
 * command names its fix on its own line. The texts live here, in one table, because the skill file
 * (skills/grizzle/SKILL.md) documents each of them and a test checks that it does: a refusal added here without its
 * documentation fails that test. Each stage of the apply runner (packages/grizzle/src/adapter/migrate/errors.ts) and of the command line
 * (errors.ts) has its fix here too, typed by the stage, so a new stage cannot go undocumented.
 *
 * A roster's handles out of their codes' order are refused, by `grizzle check` and by `grizzle generate`, with one fix:
 * a stored code never changes meaning, so a roster's order, its comparison order, is its codes' order, and a new
 * handle goes after every handle declared before it.
 */
const appendHandles = "append new handles; a roster's order is its codes' order"

/** The findings of `grizzle check`, which `grizzle migrate` runs first. */
export const refusalText = {
	ungenerated: {
		problem: "the schemas or their logins differ from snapshot.json (an ungenerated change)",
		fix: "run grizzle generate"
	},
	workloadAccess: {
		problem: "a workload program's access differs from snapshot.json (an ungenerated change)",
		fix: "run grizzle generate"
	},
	derivedFacts: {
		problem:
			"the derived facts snapshot.json records differ from the ones the schemas compile to, or are missing (an ungenerated change)",
		fix: "run grizzle generate, which writes snapshot.json again and drafts no migration"
	},
	servedStale: {
		problem:
			"the login's served file differs from what its workload compiles to under snapshot.json (an ungenerated change)",
		fix: "run grizzle generate, which writes the served file again"
	},
	servedMissing: {
		problem: "the login has no served file beside snapshot.json (an ungenerated change)",
		fix: "run grizzle generate, which writes the served file"
	},
	servedExtra: {
		problem: "the served file is of a login the configuration does not list over the schema",
		fix: "run grizzle generate, which removes the served file"
	},
	compile: {
		problem: "the schema or a login's workload does not compile",
		fix: "fix the schema or workload it names, then run grizzle generate"
	},
	undeclaredDrop: {
		problem:
			"the schema no longer holds a name snapshot.json holds, and no --drop or --rename declares what became of it",
		fix: "run grizzle generate <config> --drop <name>, or --rename <old>=<new> where it was renamed"
	},
	rosterReordered: {
		problem: "a roster declares a handle before one that holds a lower code in snapshot.json",
		fix: appendHandles
	},
	placeholder: {
		problem: "unresolved placeholder",
		fix: "write the value or the UPDATE, then delete the marker line"
	},
	confirm: {
		problem: "unconfirmed group",
		fix: "keep every statement below the marker as drafted, then delete the two marker lines"
	},
	literalPack: {
		problem:
			"a closed constant's literal pack was edited after it was drafted: its literal, its comment and its function's name no longer agree",
		fix: "restore the file from git, or regenerate; never hand-edit a literal pack"
	},
	unresolvedLoss: {
		problem:
			"unresolved data loss: a schema's first migration starts it empty beside a schema the configuration no longer lists, and the statement that loses that schema's rows is still commented",
		fix: "to start the new schema empty, uncomment the statement below its -- grizzle: data loss line; to keep the rows, keep the old schema's name and delete the folder"
	},
	unreadableSnapshot: {
		problem:
			"snapshot.json and manifest.json do not decode as a snapshot, or are the snapshot of another schema",
		fix: "restore them from git"
	},
	unreadableMeta: {
		problem: "meta.json does not decode as a migration's meta.json, or names another schema",
		fix: "restore it from git"
	},
	brokenChain: {
		problem: "broken chain: this migration does not start where the previous one ends",
		fix: "regenerate; never hand-edit meta.json"
	},
	chainEnd: {
		problem: "broken chain: the newest migration does not reach snapshot.json",
		fix: "regenerate; never hand-edit meta.json"
	},
	folderName: {
		problem: "a migration folder is named <YYYYMMDDHHMMSS>_<name>",
		fix: "fix the file: rename the folder, or move it out of the migrations directory"
	},
	fileName: {
		problem: "a migration file is named NN-<words>.sql, one per NN",
		fix: "fix the file: rename it to NN-<words>.sql with an NN of its own"
	},
	transactionControl: {
		problem:
			"a migration file runs as one transaction, or each statement alone with -- grizzle: no-transaction, and never controls the transaction itself",
		fix: "fix the file: delete the transaction control; SAVEPOINT and ROLLBACK TO are allowed"
	},
	misplacedNoTransaction: {
		problem: "-- grizzle: no-transaction counts only as a file's first line",
		fix: "fix the file: move the marker to the first line, or delete it"
	},
	strayEntry: {
		problem: "the migrations directory holds what grizzle generate never writes",
		fix: "fix the file: remove it, or move it out of the migrations directory"
	}
} as const satisfies Readonly<Record<string, Refusal>>

/** The fix of each stage at which `grizzle migrate` stops (packages/grizzle/src/adapter/migrate/errors.ts). */
export const migrateStageFix: Readonly<Record<MigrateStage, string>> = {
	connect: "check the configuration's connection: its host, port, database, role, password and CA",
	server: "have a superuser raise the server's max_stack_depth to at least 2MB, its default",
	owner: "connect as the role that owns the schema",
	input: "run grizzle check and fix what it reports",
	busy: "wait for the other grizzle migrate to finish, then run it again",
	ledger: "the ledger was changed by hand; restore it from a backup",
	edited: "restore the applied files from git; put new steps in a new migration",
	order: "restore the migrations directory from git, then run grizzle check",
	marker: "resolve the markers, delete the marker lines, then run grizzle check",
	decision: "decide each data loss as its -- grizzle: data loss line says, then run grizzle check",
	statement:
		"fix the failing file (an applied file stays as it is), then run grizzle migrate again",
	record: "run grizzle migrate again: the failed file rolled back with its ledger row",
	commit: "run grizzle migrate again: the ledger tells whether the file committed",
	drift:
		"undo the change made outside a migration, or reach the snapshot with a new migration (grizzle generate <config> --custom --name <name>)",
	unchecked:
		"the check changed nothing: run grizzle drift again, and report it with this output if it is refused the same way",
	uninstall:
		"nothing was dropped: revoke or drop what the DETAIL names in the database it names, a grant to a role of the installation made outside it, then run grizzle uninstall again"
}

/** The fix of each stage at which the command line itself refuses (errors.ts). */
export const cliStageFix: Readonly<Record<CliStage, string>> = {
	usage: "run grizzle --help for the commands",
	config:
		'fix the configuration file: export default defineConfig({ schemas: [...], logins: [...], migrations: "...", connection: () => ({ ... }) })',
	environment:
		"unset the variable it names in the environment grizzle runs in, then run the command again",
	filesystem: "fix the migrations directory, then run grizzle check",
	snapshot: "restore snapshot.json, manifest.json and the migration folders from git",
	codes: appendHandles,
	generate: "fix the schema or workload it names, then run grizzle generate again"
}
