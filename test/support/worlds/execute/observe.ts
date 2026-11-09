import { Array as Arr, Effect, Record as Rec } from "effect"
import type { ApplyError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { StaleReason } from "#adapter/errors/failures.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { Law, Witness as GrizzleWitness } from "#compiler/types/changeset/changeset.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import { valueText } from "#test/support/laws/model.ts"
import { factOfKey } from "#test/support/worlds/execute/host.ts"
import type {
	Observation,
	ModelOpenStage,
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
 * The stage a refused Db.open reports, as the model names it: at stage token, by its reason, verify's TokenError or a
 * ClaimRefused; none for a stage the model never predicts (config, capability).
 */
const openStageOf = (error: OpenError): ModelOpenStage | undefined => {
	if (error.stage === "token") {
		const tag = error.reason._tag
		return tag === "TokenError"
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
				case "CompileError":
				case "MissingCapability":
					return Effect.succeed({ kind: "compile-refused" })
				case "InputTooLarge":
					return Effect.succeed({ kind: "resource-bound" })
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
		case "CompileError":
		case "MissingCapability":
		case "PageRequestRefused":
			return Effect.succeed({ kind: "compile-refused" })
		case "EncodingFailure":
		case "LawRejected":
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
		case "HandleReleased":
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

/**
 * A write's outcome. An invariant-rejected outcome's law, the structured description grizzle reports, is read back to
 * the LawId the model names laws by, through the described laws of the installation the Db was opened at: exactly one
 * of them has the description, or the run has a defect (kernel/naming.ts reportedLawId).
 */
export const applied = (
	outcome: ApplyOutcome<unknown>,
	described: ReadonlyMap<LawId, Law>
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
				const law = yield* Effect.sync(() => reportedLawId(described, reported))
				const observation: Observation = { kind: "invariant-rejected", law, witness }
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
