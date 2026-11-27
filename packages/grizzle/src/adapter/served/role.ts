import type { InstallationWitness } from "#adapter/witness/index.ts"
import type {
	BindContext,
	ClockSource,
	CompileError,
	Engine,
	InstalledArtifacts,
	ParsedRole,
	RoleDesc
} from "#compiler/plan/common.ts"
import type { IndexResolver } from "#compiler/plan/migration.ts"
import type { CompiledTemplate, ExecutionRequest, QueryInput } from "#compiler/plan/read.ts"

/**
 * What compiling a program for one role reads: the role, its artifacts and its compilation, against which every
 * program of the login's workloads over it compiles, once, at generate and check (served/login.ts). Compile time only.
 */
export interface RoleContext {
	/**
	 * The role value, parsed once when the layer was built: every program of its Dbs is checked against it, and a
	 * program over the base runs on a full role, whose levels hold its base.
	 */
	readonly schema: ParsedRole
	/** The base's declared name, from which the PostgreSQL schema and the roles derive. */
	readonly declared: string
	/** The role's Description. */
	readonly role: RoleDesc
	/** The role's artifacts, its base's read through its views: the installation's codes and names every decoder of the
	 * role reads, and what every program of the layer's workloads compiles against. An installation stands behind them
	 * (InstalledArtifacts): every program compiled through the role is one that runs, so none casts a parameter to a type
	 * its installation lacks. */
	readonly artifacts: InstalledArtifacts
	/**
	 * How a query is compiled for one request: against the role and its artifacts (program/template.ts templateFor), with
	 * those artifacts. Every read, page and explain a Db runs that no one
	 * compiled ahead compiles through it, every call.
	 */
	readonly compile: (
		query: QueryInput,
		request: ExecutionRequest
	) => Engine.Result<ProgramTemplate, CompileError>
	/** The witness decoding of the role's artifacts (witness/index.ts), which every write of the role's reads its
	 * refusals' witnesses by. */
	readonly witness: InstallationWitness
	/**
	 * What every decoder of the role's programs binds under besides its layout, the layer's: the shell's Option
	 * vocabulary, and each roster's names in code order from the installation's codes, which a closed id's or a set's
	 * cell is read by.
	 */
	readonly bind: BindContext
	/**
	 * Where the role's programs' readings of the database's clock count from (engine ir/clock.ts ClockSource): the
	 * transaction's for every served file `grizzle generate` writes, a moved clock's for a test's
	 * (adapter/public/compile.ts compileServedMoved), which its clocked reads and its ChangeSets compile under.
	 */
	readonly clock: ClockSource
	/**
	 * The index each read of the role's programs reaches through, as the installation behind its artifacts resolved it
	 * (engine physical/indexes/ref.ts resolverOf over the snapshot's `resolved`): what every program compiled through
	 * the role is advised by (engine sql/advice.ts transactionAdvice).
	 */
	readonly resolve: IndexResolver
}

/** A query's template compiled for one request, with the artifacts it was compiled against, which its page reads. */
export interface ProgramTemplate {
	readonly compiled: CompiledTemplate
	readonly artifacts: InstalledArtifacts
}
