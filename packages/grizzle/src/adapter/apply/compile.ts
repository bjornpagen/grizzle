import type { ReadBackRuns } from "#adapter/apply/readback.ts"
import type { ParamCodecs } from "#adapter/reader/relations.ts"
import type { ViolationClassifier } from "#adapter/witness/classify.ts"
import type { CompiledWrite, ParsedChangeSet } from "#compiler/plan/change.ts"
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
 * A program carries what running it needs besides itself: the installation's violation classifier
 * (packages/grizzle/src/adapter/witness), which decodes an integrity violation a statement or its COMMIT reports into a
 * law and its witness through the installation's key-law map, a superset of the program's own (outcomes/index.ts), its
 * read-backs and its parameters' codecs. The layer builds each once, when it loads its served file (served/load.ts).
 */
export interface WriteEntry {
	readonly program: CompiledWrite
	readonly violation: ViolationClassifier
	/** The read-backs of the program's artifact, ready to run, built with the program. */
	readonly readBacks: ReadBackRuns
	/** The codecs of the program's declared parameters, which its read-backs read, built with the program. */
	readonly codecs: ParamCodecs
	/** What the ChangeSet's reads decoder binds under besides its layout: the role's (db/context.ts RoleContext). */
	readonly bind: BindContext
}

/**
 * A ChangeSet compiled for a role: its program entry, and what applying it reads of its value besides its program,
 * its array members' facts and its bound values.
 */
export interface CompiledChange extends WriteEntry {
	readonly change: Pick<ParsedChangeSet, "inputs" | "values">
}
