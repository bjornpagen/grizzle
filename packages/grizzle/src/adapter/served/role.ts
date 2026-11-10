import type { InstallationWitness } from "#adapter/witness/index.ts"
import type {
	BindContext,
	CompileError,
	Engine,
	ParsedRole,
	ProgramDesc,
	RoleDesc,
	SchemaArtifacts
} from "#compiler/plan/common.ts"
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
	/** The role's artifacts over the layer's slice: the installation's codes and names every decoder of the role reads,
	 * and what every program of the layer's workloads compiles against. */
	readonly artifacts: SchemaArtifacts
	/**
	 * How a query is compiled for one request: against the role and its artifacts for the query (programArtifacts,
	 * program/template.ts templateFor), with those artifacts. Every read, page and explain a Db runs that no one
	 * compiled ahead compiles through it, every call.
	 */
	readonly compile: (
		query: QueryInput,
		request: ExecutionRequest
	) => Engine.Result<ProgramTemplate, CompileError>
	/**
	 * The artifacts a program of the role compiles against, with their witness decoding (witness/index.ts): the layer's,
	 * when the slice the layer's law model serves holds the program's own (schema/reach.ts within), else the artifacts
	 * of the program's own slice, compiled at the call (pool/registry.ts). Either reads, of each relation the program
	 * names, exactly what the installation's law model states.
	 */
	readonly programArtifacts: (program: ProgramDesc) => Engine.Result<SliceArtifacts, CompileError>
	/**
	 * What every decoder of the role's programs binds under besides its layout, the layer's: the shell's Option
	 * vocabulary, and each roster's names in code order from the installation's codes, which a closed id's or a set's
	 * cell is read by.
	 */
	readonly bind: BindContext
}

/** A query's template compiled for one request, with the artifacts it was compiled against, which its page reads. */
export interface ProgramTemplate {
	readonly compiled: CompiledTemplate
	readonly artifacts: SchemaArtifacts
}

/** What one program of a role compiles against: the role's artifacts over a slice holding the program's, and their
 * witness decoding. */
export interface SliceArtifacts {
	readonly artifacts: SchemaArtifacts
	readonly witness: InstallationWitness
}
