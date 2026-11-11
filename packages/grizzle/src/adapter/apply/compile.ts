import type { ReadBackRuns } from "#adapter/apply/readback.ts"
import type { ParamCodecs } from "#adapter/reader/relations.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import type { CompiledWrite, ParsedChangeSet, RunnableWrite } from "#compiler/plan/change.ts"
import type { BindContext } from "#compiler/plan/common.ts"

/**
 * Compiling a ChangeSet for a role.
 *
 * "A ChangeSet is compiled into the same kind of template: its members are queries, its parameters are theirs plus
 * one internal relation parameter per enumerated member". A ChangeSet value is a sealed Description plus the host
 * inputs of its array and Stream members; the Description alone decides the WriteProgram, compiled against the role it
 * compiles for and the contexts the Db's claims hold a fact of, which a write into a query entry fills from
 * (write/frontend/entry.ts), in the transaction evidence context. Every db.apply compiles its ChangeSet: grizzle keeps
 * no cache of programs, and a caller that applies one again keeps its compiled form itself (the workload, db.compile).
 *
 * A program carries what running it needs besides itself: the installation's witness
 * (packages/grizzle/src/adapter/witness), whose classifier decodes an integrity violation a statement or its COMMIT
 * reports into a law and its witness through the installation's key-law map, a superset of the program's own
 * (outcomes/index.ts), and whose key-law map names the object a refusal the host decides would meet (keylaw.ts
 * HostRefusal); its read-backs and its parameters' codecs. The layer builds each once, when it loads its served file (served/load.ts).
 */
export interface WriteEntry {
	/** The program as an application runs it, loaded as a served one is (write/program/bind.ts RunnableWrite). */
	readonly program: RunnableWrite
	readonly witness: InstallationWitness
	/** The read-backs of the program's artifact, ready to run, built with the program. */
	readonly readBacks: ReadBackRuns
	/** The codecs of the program's declared parameters, which its read-backs read, built with the program. */
	readonly codecs: ParamCodecs
	/** What the ChangeSet's reads decoder binds under besides its layout: the role's (db/context.ts RoleContext). */
	readonly bind: BindContext
}

/**
 * A ChangeSet compiled for a role: its program entry, the program as it compiled, which a served file holds
 * (served/project.ts), and what applying it reads of its value besides its program, its array members' facts and its
 * bound values, and what serving it reads, the bound values its bind read with no canonical text.
 */
export interface CompiledChange extends WriteEntry {
	readonly compiled: CompiledWrite
	readonly change: Pick<ParsedChangeSet, "inputs" | "values" | "opaque">
}
