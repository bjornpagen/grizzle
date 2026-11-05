import { Array as Arr, Effect, type Schedule, type Scope, type Types } from "effect"
import {
	type ApplyError,
	type ApplyOutcome,
	ChangeSet,
	type CodecFault,
	type CommitUnknown,
	type CompileError,
	type ConstraintName,
	type CursorError,
	type Db,
	type EncodingFailure,
	type ExecutionFailure,
	type ExecutionReason,
	type KeyHost,
	type OpenError,
	type Law,
	type PutTargetConflict,
	query,
	type ReadError,
	type ReadFailure,
	type ReadStage,
	type SerializationFailure,
	type ServerError,
	type StaleSnapshot,
	type TransientFailure,
	type TransientReason,
	type TransportFailure,
	type TransportStage,
	type UnseenOccupant,
	type Uuid,
	v,
	type Witness
} from "#index.ts"

import {
	AccountCost,
	Cents,
	type Refresher,
	Task,
	Work,
	type WorkWriter
} from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * The exact error channels of every Db operation, and the exact shape of ApplyOutcome ("Writes",
 * "Errors and outcomes"). A channel is pinned by Equals, so a widened channel (unknown, a stray CompileError) and a
 * narrowed one (an ApplyError member dropped) both fail. Every `@ts-expect-error -- TSnnnn` names the diagnostic the
 * harness requires on the next line.
 */
declare const writer: Db<typeof WorkWriter, unknown>
declare const refresher: Db<typeof Refresher, unknown>

/** ApplyError is exactly six tags, and each is its class. */
export type ApplyErrorTags = Expect<
	Equals<
		ApplyError["_tag"],
		| "EncodingFailure"
		| "TransientFailure"
		| "TransportFailure"
		| "ExecutionFailure"
		| "CommitUnknown"
		| "StaleSnapshot"
	>
>

export type ApplyErrorMembers = Expect<
	Equals<
		ApplyError,
		| EncodingFailure
		| TransientFailure
		| TransportFailure
		| ExecutionFailure
		| CommitUnknown
		| StaleSnapshot
	>
>

/** A read fails with exactly three classes. */
export type ReadErrorMembers = Expect<
	Equals<ReadError, ReadFailure | TransientFailure | StaleSnapshot>
>
/**
 * Every ApplyError field classifies the failure; none holds a parameter value.
 * The one retryable error carries what refused the attempt as a tagged reason, exactly these, each a class with names
 * only, and the server's report of the refusal as its error.
 */
export type TransientFailureReason = Expect<Equals<TransientFailure["reason"], TransientReason>>
export type TransientFailureReport = Expect<Equals<TransientFailure["error"], ServerError>>
export type TransientReasonTags = Expect<
	Equals<
		Types.ReasonTags<TransientFailure>,
		| "SerializationFailure"
		| "Deadlock"
		| "PutTargetConflict"
		| "GeneratedSerialUnique"
		| "SpanKeyChange"
		| "UnseenOccupant"
		| "ConcurrentRefresh"
		| "StaleStatement"
	>
>

export type SerializationFailureReason = Expect<
	Equals<Types.ExtractReason<TransientFailure, "SerializationFailure">, SerializationFailure>
>

export type UnseenOccupantFields = Expect<
	Equals<
		Pick<
			Types.ExtractReason<TransientFailure, "UnseenOccupant">,
			"_tag" | "relation" | "constraint"
		>,
		{
			readonly _tag: "UnseenOccupant"
			readonly relation: string
			/** The installed constraint the server reported, by the brand's exported name. */
			readonly constraint: ConstraintName
		}
	>
>

export type UnseenOccupantReason = Expect<
	Equals<Types.ExtractReason<TransientFailure, "UnseenOccupant">, UnseenOccupant>
>

export type PutTargetConflictFields = Expect<
	Equals<
		Pick<Types.ExtractReason<TransientFailure, "PutTargetConflict">, "_tag" | "relation">,
		{ readonly _tag: "PutTargetConflict"; readonly relation: string }
	>
>

export type PutTargetConflictReason = Expect<
	Equals<Types.ExtractReason<TransientFailure, "PutTargetConflict">, PutTargetConflict>
>

/** A write's execution failure names its reason: the server's report, a compiler refusal, a size limit or an answer. */
export type ExecutionFailureReasonTags = Expect<
	Equals<
		Types.ReasonTags<ExecutionFailure>,
		"ServerError" | "CompileError" | "MissingCapability" | "InputTooLarge" | "UnreadableAnswer"
	>
>
export type ExecutionFailureReason = Expect<Equals<ExecutionFailure["reason"], ExecutionReason>>
export type EncodingFailureFields = Expect<
	Equals<
		Pick<EncodingFailure, "reason" | "place">,
		{
			readonly reason: { readonly _tag: CodecFault }
			readonly place: { readonly _tag: "Slot"; readonly name: string } | { readonly _tag: "Fact" }
		}
	>
>
export type TransportFailureStage = Expect<Equals<TransportFailure["stage"], TransportStage>>
/** A read's failure names its stage, a function of its reason; the retryable one and the fence's name their reason. */
export type ReadFailureStage = Expect<Equals<ReadFailure["stage"], ReadStage>>
/** What a session's acquisition can be refused for, at Db.open, at a read and at a write alike. */
type AcquisitionTags =
	| "CredentialError"
	| "ConnectTimedOut"
	| "SocketFailed"
	| "StartupRefused"
	| "TlsRefused"
	| "ConnectionClosed"
	| "DriverRefused"
	| "NoCancelKey"
	| "LayerReleased"

/** Each reason a read fails for is one class, so Effect.catchReason reaches it by its tag. */
export type ReadFailureReasonTags = Expect<
	Equals<
		Types.ReasonTags<ReadFailure>,
		| AcquisitionTags
		| "HandleReleased"
		| "ServerError"
		| "ConnectionLost"
		| "CommitLost"
		| "DriverFailure"
		| "UnreadableAnswer"
		| "CompileError"
		| "MissingCapability"
		| "EncodingFailure"
		| "LawRejected"
		| "InputTooLarge"
		| "PageRequestRefused"
	>
>

/** Each reason Db.open fails for is one class: a stage is a function of it, never stored beside it. */
export type OpenErrorReasonTags = Expect<
	Equals<
		Types.ReasonTags<OpenError>,
		| AcquisitionTags
		| "DbConfigRefused"
		| "ConnectionEnvironmentRefused"
		| "RoleOutsideLayers"
		| "LoginNameRefused"
		| "TokenError"
		| "ClaimRefused"
		| "CompileError"
		| "AdmissionRefused"
		| "AdmissionTransient"
		| "AdmissionFailed"
		| "MissingCapability"
		| "WorkloadUngenerated"
	>
>

export type TransportFailureReasonTags = Expect<
	Equals<
		Types.ReasonTags<TransportFailure>,
		AcquisitionTags | "HandleReleased" | "ConnectionLost" | "DriverFailure"
	>
>

export type StaleSnapshotReasonTags = Expect<
	Equals<Types.ReasonTags<StaleSnapshot>, "Migrating" | "Migrated">
>

const tasks = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})

const taskId = "0193d8f2-7c1e-7000-8000-0000000000a2"
const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"

const addTask = ChangeSet.empty(Work)
	.insert(Task, [{ id: taskId, account: accountId, kind: "Manual", cost: Cents(1n) }])
	.read("added", (delta) =>
		query(Work).rule((r) => {
			const { id } = v(delta.added(Task), "addedTask")
			return r.match(delta.added(Task), { id }).find({ id })
		})
	)
type AddReads = { readonly added: ReadonlyArray<{ readonly id: Uuid }> }

/** Writes fail only with ApplyError. */
export const applied = writer.apply(addTask, {})
export type AppliedChannel = Expect<Equals<Effect.Error<typeof applied>, ApplyError>>
export type AppliedServices = Expect<Equals<Effect.Services<typeof applied>, never>>
export type AppliedOutcome = Expect<Equals<Effect.Success<typeof applied>, ApplyOutcome<AddReads>>>

/** Refresh succeeds with nothing and fails with ApplyError. */
export const refreshed = refresher.refresh(AccountCost)
export type RefreshChannel = Expect<Equals<typeof refreshed, Effect.Effect<void, ApplyError>>>

/** The caller's own retry policy: its schedule and how many times it retries. */
declare const callerSchedule: Schedule.Schedule<unknown>
declare const callerRetries: number

/**
 * The caller retries on its own Schedule while the error is the retryable one: the channel stays ApplyError, since the
 * last attempt's failure surfaces when the retries run out. One reason is handled by Effect.catchReason, and the
 * channel keeps every other ApplyError, a TransientFailure of any other reason among them.
 */
export const retried = applied.pipe(
	Effect.retry({
		while: (e) => e._tag === "TransientFailure",
		schedule: callerSchedule,
		times: callerRetries
	})
)
export type RetriedChannel = Expect<Equals<Effect.Error<typeof retried>, ApplyError>>
export const putConflicted = applied.pipe(
	Effect.catchReason("TransientFailure", "PutTargetConflict", (reason) =>
		Effect.succeed(reason.relation)
	)
)
export type CaughtReasonChannel = Expect<Equals<Effect.Error<typeof putConflicted>, ApplyError>>
export type CaughtReasonValue = Expect<
	Equals<Effect.Success<typeof putConflicted>, ApplyOutcome<AddReads> | string>
>

/** Compiling fails with the CompileError itself, scoped; a compiled change applies with ApplyError alone. */
export const compiledChange = writer.compile(addTask)
export type CompileChangeChannel = Expect<Equals<Effect.Error<typeof compiledChange>, CompileError>>
export type CompileChangeScope = Expect<Equals<Effect.Services<typeof compiledChange>, Scope.Scope>>
declare const compiled: Effect.Success<typeof compiledChange>
export const compiledApply = compiled.apply({})
export type CompiledApplyChannel = Expect<
	Equals<typeof compiledApply, Effect.Effect<ApplyOutcome<AddReads>, ApplyError>>
>

/** A direct read has no CompileError channel: a query that does not compile is ReadError stage compile. */
export const executed = writer.execute(tasks, { account: accountId })
export type ExecuteChannel = Expect<Equals<Effect.Error<typeof executed>, ReadError>>
declare const result: Effect.Success<typeof executed>
export const collected = result.collect
export type CollectChannel = Expect<
	Equals<typeof collected, Effect.Effect<ReadonlyArray<{ readonly id: Uuid }>, ReadError>>
>
export const got = writer.get(Task, { id: taskId })
export type GetChannel = Expect<Equals<Effect.Error<typeof got>, ReadError>>
export const paged = writer.page(tasks.orderBy(["id", "asc"]), { account: accountId }, { first: 2 })
export type PageChannel = Expect<Equals<Effect.Error<typeof paged>, ReadError | CursorError>>
export const explained = writer.explain(addTask, {})
export type ExplainChannel = Expect<Equals<Effect.Error<typeof explained>, ReadError>>
export const compiledQuery = writer.compile(tasks)
export type CompileChannel = Expect<Equals<Effect.Error<typeof compiledQuery>, CompileError>>

/** ApplyOutcome is exactly four variants, discriminated by kind. */
type Outcome = ApplyOutcome<AddReads>
export type OutcomeKinds = Expect<
	Equals<Outcome["kind"], "accepted" | "no-change" | "invariant-rejected" | "outside-world">
>

export type AcceptedShape = Expect<
	Equals<
		Extract<Outcome, { readonly kind: "accepted" }>,
		{
			readonly kind: "accepted"
			readonly counts: ReadonlyArray<{
				readonly relation: string
				readonly added: bigint
				readonly deleted: bigint
				readonly put: bigint
			}>
			readonly reads: AddReads
		}
	>
>

export type NoChangeShape = Expect<
	Equals<
		Extract<Outcome, { readonly kind: "no-change" }>,
		{ readonly kind: "no-change"; readonly reads: AddReads }
	>
>

export type RejectedShape = Expect<
	Equals<
		Extract<Outcome, { readonly kind: "invariant-rejected" }>,
		{
			readonly kind: "invariant-rejected"
			readonly laws: Arr.NonEmptyReadonlyArray<Law>
			readonly witness: Witness
		}
	>
>

export type OutsideWorldShape = Expect<
	Equals<
		Extract<Outcome, { readonly kind: "outside-world" }>,
		{ readonly kind: "outside-world"; readonly relation: string }
	>
>

/** The witness names the key, or says why it can't: withheld from the role, or unreported by PostgreSQL. */
export type WitnessShape = Expect<
	Equals<
		Witness,
		| {
				readonly kind: "key"
				readonly relation: string
				readonly values: Readonly<Record<string, KeyHost>>
		  }
		| { readonly kind: "withheld" }
		| { readonly kind: "unreported" }
	>
>

export const reading = (outcome: Outcome): ReadonlyArray<{ readonly id: Uuid }> => {
	switch (outcome.kind) {
		case "accepted":
		case "no-change":
			return outcome.reads.added
		case "invariant-rejected":
			// @ts-expect-error -- TS2339: an invariant-rejected outcome carries no reads
			return outcome.reads.added
		case "outside-world":
			// @ts-expect-error -- TS2339: an outside-world outcome carries no reads
			return outcome.reads.added
	}
}

export const lawOf = (outcome: Outcome): Law | undefined =>
	// @ts-expect-error -- TS2339: only a rejection names a law; narrow on kind first
	outcome.law
/** A law is matched by its kind, which narrows to that form's fields. */
export const keyFields = (law: Law): ReadonlyArray<string> =>
	law.kind === "primaryKey"
		? law.fields
		: law.kind === "key"
			? Arr.map(law.side.terms, (t) => t.field)
			: []
/** A law is one of the stated forms: no other kind, and no opaque identity, is one. */
// @ts-expect-error -- TS2322: "foreignKey" is no law's kind; a foreign key is a `contained`
export const forgedLaw: Law = { kind: "foreignKey", relation: "Task", fields: ["account"] }
/** A count is a bigint, never a JavaScript number. */
export const countOf = (outcome: Extract<Outcome, { readonly kind: "accepted" }>): number =>
	// @ts-expect-error -- TS2322: counts are bigint
	outcome.counts[0]?.added ?? 0

/** The read-back names are the ChangeSet's own: no other name is in reads. */
export const otherRead = (outcome: Extract<Outcome, { readonly kind: "no-change" }>) =>
	// @ts-expect-error -- TS2339: reads holds exactly the declared read-backs
	outcome.reads.removed
