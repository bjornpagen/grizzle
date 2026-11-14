import { Array as Arr, Effect, Record as Rec } from "effect"
import type { ApplyError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { StaleReason } from "#adapter/errors/failures.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type {
	Law,
	RefusedLaw,
	Witness as GrizzleWitness
} from "#compiler/types/changeset/changeset.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import { valueText } from "#test/support/laws/model.ts"
import { factOfKey } from "#test/support/worlds/execute/host.ts"
import type {
	Observation,
	ModelOpenStage,
	RefusedBy,
	SqlState,
	Witness
} from "#test/support/worlds/model/types.ts"

/**
 * grizzle's typed answers as the model's observations. A failure the vocabulary has no place for (a lost connection,
 * a pool that could not lease, a decode grizzle could not do) is infrastructure or a defect, never an outcome: it is
 * raised as a defect of the run, so a driver reports it as a finding.
 */
const defect = (what: string, error: unknown): Effect.Effect<never> =>
	Effect.die(
		new Error(`the real system answered ${what}, which no observation names`, { cause: error })
	)

/** The fence's refusal as the model names it. */
const staleObserved = (reason: StaleReason): Observation => ({
	kind: "stale-snapshot",
	reason: reason._tag === "Migrating" ? "migrating" : "migrated"
})

const namedStates: ReadonlySet<string> = new Set([
	"42501",
	"25000",
	"23505",
	"23503",
	"23514",
	"23000",
	"23P01",
	"40001",
	"40P01",
	"22P02",
	"22003",
	"22023",
	"428C9"
])

const isNamed = (code: string): code is Exclude<SqlState, "other"> => namedStates.has(code)

/** A SQLSTATE as the model names it: one the README names, or `other`. */
export const sqlStateOf = (code: string): SqlState => (isNamed(code) ? code : "other")

const openStages: ReadonlySet<string> = new Set(["role", "schema"])

const isOpenStage = (stage: string): stage is ModelOpenStage => openStages.has(stage)

/**
 * The stage a refused Db.open reports, as the model names it: at stage token, by its reason, its parse's TokenMalformed,
 * verify's TokenError or a ClaimRefused; none for a stage the model never predicts (config, capability).
 */
const openStageOf = (error: OpenError): ModelOpenStage | undefined => {
	if (error.stage === "token") {
		const tag = error.reason._tag
		return tag === "TokenMalformed"
			? "token:malformed"
			: tag === "TokenError"
				? "token:verify"
				: tag === "ClaimRefused"
					? "token:claims"
					: undefined
	}
	return isOpenStage(error.stage) ? error.stage : undefined
}

/** A refused Db.open at the stage grizzle reports; any other stage is a defect. */
export const openRefused = (error: OpenError, verifyCalls: 0 | 1): Effect.Effect<Observation> => {
	const stage = openStageOf(error)
	return stage === undefined
		? defect(`an open refused at ${error.stage} by ${error.reason._tag}`, error)
		: Effect.succeed({ kind: "open-refused", stage, verifyCalls })
}

/** A write's failure. */
export const applyFailed = (error: ApplyError): Effect.Effect<Observation> => {
	switch (error._tag) {
		case "EncodingFailure":
		case "CallInputRefused":
			return Effect.succeed({ kind: "encoding-refused" })
		case "TransientFailure":
			return Effect.succeed({ kind: "transient", reason: error.reason._tag })
		case "CommitUnknown":
			return Effect.succeed({ kind: "commit-unknown" })
		case "StaleSnapshot":
			return Effect.succeed(staleObserved(error.reason))
		case "TransportFailure":
			return defect("a transport failure", error)
		case "ExecutionFailure": {
			const reason = error.reason
			switch (reason._tag) {
				case "ServerError":
					return Effect.succeed({ kind: "refused", sqlstate: sqlStateOf(reason.sqlstate) })
				case "TemporaryRefused":
					return Effect.succeed({ kind: "refused", sqlstate: sqlStateOf(reason.error.sqlstate) })
				case "CompileError":
					return Effect.succeed({ kind: "compile-refused" })
				case "InputTooLarge":
					return Effect.succeed({ kind: "resource-bound" })
				case "ParamRejected":
					return Effect.succeed({ kind: "encoding-refused" })
				case "UnreadableAnswer":
					return defect("an answer grizzle could not read", error)
			}
		}
	}
}

/** A read's failure. */
export const readFailed = (error: ReadError): Effect.Effect<Observation> => {
	if (error._tag === "TransientFailure") {
		return Effect.succeed({ kind: "transient", reason: error.reason._tag })
	}
	if (error._tag === "StaleSnapshot") {
		return Effect.succeed(staleObserved(error.reason))
	}
	const reason = error.reason
	switch (reason._tag) {
		case "ServerError":
			return Effect.succeed({ kind: "refused", sqlstate: sqlStateOf(reason.sqlstate) })
		case "TemporaryRefused":
			return Effect.succeed({ kind: "refused", sqlstate: sqlStateOf(reason.error.sqlstate) })
		case "CompileError":
			return Effect.succeed({ kind: "compile-refused" })
		case "EncodingFailure":
		case "CallInputRefused":
		case "InputRejected":
		case "LawRejected":
		case "ParamRejected":
			return Effect.succeed({ kind: "encoding-refused" })
		case "InputTooLarge":
			return Effect.succeed({ kind: "resource-bound" })
		case "UnreadableAnswer":
			return defect("a read grizzle could not decode", error)
		case "CredentialError":
		case "TlsRefused":
		case "StartupRefused":
		case "ConnectTimedOut":
		case "SocketFailed":
		case "ConnectionClosed":
		case "DriverRefused":
		case "NoCancelKey":
		case "LayerReleased":
		case "ConnectionLost":
		case "CommitLost":
		case "DriverFailure":
			return defect(`a read failure at stage ${error.stage}`, error)
	}
}

/** A witness as the model reads it: the key grizzle names, shown; an unreported key shows none. */
const witnessOf = (witness: GrizzleWitness): Effect.Effect<Witness> =>
	witness.kind === "key"
		? Effect.map(factOfKey(witness.values, "witness key"), (fact): Witness => ({
				kind: "shown",
				keys: [fact]
			}))
		: Effect.succeed({ kind: "withheld" })

/** A table of an installation as a refusal names it: the relation it is, and each constraint and rule trigger on it,
 * by its name, with the laws its violation reports. */
interface RefusingTable {
	readonly relation: string
	readonly constraints: ReadonlyMap<string, ReadonlyArray<LawId>>
}

/**
 * What reads a Db's refusal back into the model's words, from the installation the Db was opened at: its described
 * laws, which a refused law's description is read back by (kernel/naming.ts reportedLawId), and each of its tables by
 * its installed name, with every constraint and rule trigger it installs there (physical/install
 * Installation.constraintLaws), which a refusing object is read back by.
 */
export interface RefusalReader {
	readonly described: ReadonlyMap<LawId, Law>
	readonly tables: ReadonlyMap<string, RefusingTable>
}

/** The refusal reader of an installation (`RefusalReader`), every name its compiler's. */
export const refusalReader = (
	installation: Pick<Installation, "described" | "constraintLaws" | "checked" | "names">
): RefusalReader => {
	const constraints = new Map<RelationIdent, Map<string, ReadonlyArray<LawId>>>()
	for (const c of installation.constraintLaws) {
		switch (c.kind) {
			case "constraint":
			case "trigger": {
				const named = constraints.get(c.owner) ?? new Map<string, ReadonlyArray<LawId>>()
				named.set(
					c.name,
					Arr.map(c.laws, (l) => l.law)
				)
				constraints.set(c.owner, named)
				break
			}
			case "domainConstraint":
			case "unstoredDomainConstraint":
				break
		}
	}
	return {
		described: installation.described,
		tables: new Map(
			Arr.map([...installation.checked.relations.values()], (r) => {
				const table = installation.names.relation(r.name).name
				return [
					table,
					{
						relation: r.name,
						constraints: constraints.get(table) ?? new Map<string, ReadonlyArray<LawId>>()
					}
				] as const
			})
		)
	}
}

/**
 * The object a refusal names as refusing its law, in the model's words (model/types.ts RefusedBy): a table's constraint
 * by the relation the table is, which must be a constraint or rule trigger the installation holds on that table under
 * that name and whose violation reports the refused law, or the run has a defect; any other object as `other`.
 */
const refusedByOf = (reader: RefusalReader, refused: RefusedLaw<Law>): Effect.Effect<RefusedBy> => {
	const by = refused.by
	switch (by.kind) {
		case "constraint": {
			const table = reader.tables.get(by.table)
			const laws = table?.constraints.get(by.name)
			return table !== undefined && laws !== undefined && Arr.some(laws, (l) => l === refused.id)
				? Effect.succeed({ kind: "constraint", relation: table.relation })
				: Effect.die(
						new Error(
							`a refusal of ${refused.id} names the constraint ${by.name} of the table ${by.table}, which the installation holds for none of its laws`
						)
					)
		}
		case "domain":
		case "statement":
		case "notNull":
			return Effect.succeed({ kind: "other" })
	}
}

/**
 * A write's outcome. An invariant-rejected outcome's law, the structured description grizzle reports, is read back to
 * the LawId the model names laws by, through the described laws of the installation the Db was opened at: exactly one
 * of them has the description, or the run has a defect (kernel/naming.ts reportedLawId); and the object it names as
 * refusing that law is read back by the installation's tables (refusedByOf).
 */
export const applied = (
	outcome: ApplyOutcome<unknown>,
	reader: RefusalReader
): Effect.Effect<Observation> => {
	switch (outcome.kind) {
		case "accepted":
		case "no-change":
			return Effect.succeed({ kind: "applied", outcome: outcome.kind, reads: [] })
		case "outside-world":
			return Effect.succeed({ kind: "outside-world", relation: outcome.relation })
		case "invariant-rejected":
			return Effect.gen(function* () {
				const witness = yield* witnessOf(outcome.witness)
				/**
				 * A refusal reports several laws only from a foreign key a containment merges into a family's axis
				 * (fin.md §15 rule 3), and no worlds base states a family: one law, or a defect of the executor.
				 */
				const [reported, ...more] = outcome.refused.laws
				if (more.length > 0) {
					return yield* Effect.die(
						new Error(
							`a worlds refusal reports ${outcome.refused.laws.length} laws, where no base merges one`
						)
					)
				}
				const law = yield* Effect.sync(() => reportedLawId(reader.described, reported))
				const by = yield* refusedByOf(reader, reported)
				const observation: Observation = { kind: "invariant-rejected", law, witness, by }
				return observation
			})
	}
}

/** The texts of a witness's values, for the leak scan. */
export const witnessTexts = (observation: Observation): ReadonlyArray<string> =>
	observation.kind === "invariant-rejected" || observation.kind === "law-refused"
		? observation.witness.kind === "shown"
			? Arr.flatMap(observation.witness.keys, (k) => Arr.map(Rec.values(k), valueText))
			: []
		: []
