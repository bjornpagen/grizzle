import type { ReadBackRuns } from "#adapter/apply/readback.ts"
import type { ParamCodecs } from "#adapter/reader/relations.ts"
import type { InstallationWitness } from "#adapter/witness/index.ts"
import type {
	FlightWrite,
	ParsedChangeSet,
	ServableEntry,
	ServableWrite
} from "#compiler/plan/change.ts"
import { type BindContext, type InstalledSource, nominal } from "#compiler/plan/common.ts"

declare const installedBrand: unique symbol

/**
 * Compiling a ChangeSet for a role.
 *
 * "A ChangeSet is compiled into the same kind of template: its members are queries, its parameters are theirs plus
 * one internal relation parameter per enumerated member". A ChangeSet value is a sealed Description plus the host
 * inputs of its array members; the Description alone decides the WriteProgram, compiled against the role it
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
	/** The program as an application runs it, loaded as a served one is (runtime/write/flight.ts FlightWrite). */
	readonly program: FlightWrite
	readonly witness: InstallationWitness
	/** The read-backs of the program's artifact, ready to run, built with the program. */
	readonly readBacks: ReadBackRuns
	/** The codecs of the program's declared parameters, which its read-backs read, built with the program. */
	readonly codecs: ParamCodecs
	/** What the ChangeSet's reads decoder binds under besides its layout: the role's (db/context.ts RoleContext). */
	readonly bind: BindContext
	/**
	 * Type only, with no runtime form: the program was compiled under a plan an installation stands behind
	 * (program/schema.ts InstalledSource, ParamSource `planned` or `recorded`), so every type its statements cast a
	 * parameter to is one that installation installs, and no `unserved` compile reaches a run (apply/run.ts runWrite).
	 * Two doors mint it: installedEntry, over a ChangeSet compiled over InstalledArtifacts, and served/load.ts
	 * loadedEntry, over a served file's program, in the runtime the layer loads.
	 */
	readonly [installedBrand]: true
}

/** A WriteEntry's fields but its brand: what a door mints an entry from. */
export type WriteEntryParts = Omit<WriteEntry, typeof installedBrand>

/**
 * The entry `build` makes over `compiled`, a ChangeSet compiled over InstalledArtifacts (program/workload/change.ts
 * ChangeEntry `params`), branded as an installed plan's: the door of every entry a compile makes (served/forms.ts
 * runtimeEntry).
 */
export const installedEntry = <E extends WriteEntryParts>(
	compiled: ServableEntry<InstalledSource>,
	build: (compiled: ServableEntry<InstalledSource>) => E
): E & WriteEntry => nominal<E, E & WriteEntry>()(build(compiled))

/**
 * A ChangeSet compiled for a role: its program entry, the program as it compiled, which a served file holds
 * (served/project.ts), and what applying it reads of its value besides its program, its array members' facts and its
 * bound values, and what serving it reads, the bound values its bind read with no canonical text.
 */
export interface CompiledChange extends WriteEntry {
	readonly compiled: ServableWrite
	readonly change: Pick<ParsedChangeSet, "inputs" | "values" | "opaque">
}
