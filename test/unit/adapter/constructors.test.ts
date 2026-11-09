import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { DatabaseError } from "pg"
import { admissionFailure } from "#adapter/admission/admit.ts"
import { serializationRefusal, transientReason } from "#adapter/errors/execution.ts"
import { literalBound, messageBound } from "#adapter/errors/failures.ts"
import { applyOutcome, transientFailureOf } from "#adapter/outcomes/index.ts"
import { type FenceStep, fenceReason } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import type { UniqueAbort } from "#compiler/plan/change.ts"
import {
	admittedIdentifier,
	type LiteralBound,
	type MessageBound,
	type TransientReason as EngineReason
} from "#compiler/plan/common.ts"
import { CompileError, CursorError, EncodingFailure, Sqlstate } from "#compiler/public/errors.ts"
import * as Public from "#index.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The failure and outcome values an application's test builds: every failure a Db call, Db.open, DbLayer.make, a page
 * or db.compile can fail with has a constructor in the public barrel, and it is the one the adapter builds that failure
 * with, so a test's value is exactly grizzle's, built with no cast and no object literal standing in for a class.
 *
 * The type tier: `Failure` is every failure reachable from the public error channels through what each carries (a
 * reason, a server's report, a nested failure), derived by the compiler from the classes themselves, so a reason added
 * to a channel joins it unasked; `constructors` must name a public value whose instances are exactly that failure for
 * each of its tags, so a failure exported as a type only, or left out, is a compile error here.
 *
 * The search: the facts each constructor that admits or converts takes (a server's report, a reason's relation and
 * constraint, an engine's transient reason and bound, an outcome's counts, read-backs, refusal and witness) are
 * drawn, built with the public constructor, and the value carries each fact as given, an empty report field saying
 * nothing as an absent one does (the README's contract). Where the adapter classifies the same facts from its own
 * input (pg's DatabaseError, a SQLSTATE SERIALIZABLE or the fence refuses with, a unique violation a statement lists
 * as an abort, an engine reason or bound), its value is deeply equal to the public construction, prototypes included,
 * and an instance of the public constructor for its tag.
 */

/** The errors the public channels name: Db.open's and DbLayer.make's, a read's, a write's, a page's, db.compile's. */
type Channel = Public.OpenError | Public.ReadError | Public.ApplyError | CursorError | CompileError

/** A field's value when it is a failure: an Error carrying its tag. */
type FailureIn<V> = V extends Error & { readonly _tag: string } ? V : never

/** The values inside a field's object: ConnectionLost's `ended` holds the server's report. */
type Inside<V> = V extends object ? V[keyof V] : never

/** The failures one failure carries: in a field, or in a field's object. */
type Carried<F> = F extends unknown
	? { readonly [K in keyof F]-?: FailureIn<F[K]> | FailureIn<Inside<F[K]>> }[keyof F]
	: never

/** Every failure reachable from `F` through what each carries. */
type Reachable<F, Seen = never> = [Exclude<F, Seen>] extends [never]
	? Seen
	: Reachable<Carried<Exclude<F, Seen>>, Seen | F>

type Failure = Reachable<Channel>

/**
 * Each failure's public constructor, by its tag: a value the barrel exports whose instances are exactly that failure,
 * the engine's errors read from the engine's barrel, which the public barrel re-exports whole.
 */
const constructors: {
	readonly [T in Failure["_tag"]]: abstract new (
		...args: never
	) => Extract<Failure, { readonly _tag: T }>
} = {
	AdmissionFailed: Public.AdmissionFailed,
	AdmissionRefused: Public.AdmissionRefused,
	AdmissionTransient: Public.AdmissionTransient,
	CatalogRowRefused: Public.CatalogRowRefused,
	ClaimRefused: Public.ClaimRefused,
	CommitLost: Public.CommitLost,
	CommitUnknown: Public.CommitUnknown,
	CompileError,
	ConcurrentRefresh: Public.ConcurrentRefresh,
	ConnectionClosed: Public.ConnectionClosed,
	ConnectionEnvironmentRefused: Public.ConnectionEnvironmentRefused,
	ConnectionLost: Public.ConnectionLost,
	ConnectTimedOut: Public.ConnectTimedOut,
	CredentialError: Public.CredentialError,
	CursorError,
	DbConfigRefused: Public.DbConfigRefused,
	Deadlock: Public.Deadlock,
	DriverFailure: Public.DriverFailure,
	DriverRefused: Public.DriverRefused,
	EncodingFailure,
	ExecutionFailure: Public.ExecutionFailure,
	GeneratedSerialUnique: Public.GeneratedSerialUnique,
	HandleReleased: Public.HandleReleased,
	InputTooLarge: Public.InputTooLarge,
	LawRejected: Public.LawRejected,
	LayerReleased: Public.LayerReleased,
	Migrated: Public.Migrated,
	Migrating: Public.Migrating,
	MissingCapability: Public.MissingCapability,
	NoCancelKey: Public.NoCancelKey,
	OpenError: Public.OpenError,
	PageRequestRefused: Public.PageRequestRefused,
	PutTargetConflict: Public.PutTargetConflict,
	ReadFailure: Public.ReadFailure,
	RoleOutsideLayers: Public.RoleOutsideLayers,
	SerializationFailure: Public.SerializationFailure,
	ServerError: Public.ServerError,
	SocketFailed: Public.SocketFailed,
	SpanKeyChange: Public.SpanKeyChange,
	StaleSnapshot: Public.StaleSnapshot,
	StartupRefused: Public.StartupRefused,
	TlsRefused: Public.TlsRefused,
	TokenError: Public.TokenError,
	TransientFailure: Public.TransientFailure,
	TransportFailure: Public.TransportFailure,
	UnreadableAnswer: Public.UnreadableAnswer,
	UnseenOccupant: Public.UnseenOccupant
}

/** Whether the adapter built `failure` with the public constructor of its tag. */
const publiclyBuilt = (failure: Failure): boolean => failure instanceof constructors[failure._tag]

/**
 * What PostgreSQL's ErrorResponse says, as pg reports it: a code that is a SQLSTATE, the message, and each field absent,
 * empty or given.
 */
interface Report {
	readonly code: string
	readonly message: string
	readonly constraint: string | undefined
	readonly schema: string | undefined
	readonly table: string | undefined
	readonly column: string | undefined
	readonly dataType: string | undefined
	readonly detail: string | undefined
	readonly hint: string | undefined
}

const reportFields = [
	"constraint",
	"schema",
	"table",
	"column",
	"dataType",
	"detail",
	"hint"
] as const

/** The SQLSTATEs the adapter branches on, by PostgreSQL's codes (errcodes.txt) and grizzle's fence's own. */
const serialization = "40001"
const deadlock = "40P01"
const lockNotAvailable = "55P03"
const migrating = "55Z02"
const migrated = "55Z01"
const uniqueViolation = "23505"
const exclusionViolation = "23P01"

/** A field as the server gave it: an empty one says nothing, as an absent one does. */
const said = (text: string | undefined): string | undefined => (text === "" ? undefined : text)

const capital = characterOf(Str.split("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", ""))

const codeGen: Gen<string> = oneOf([
	element([
		serialization,
		deadlock,
		lockNotAvailable,
		migrating,
		migrated,
		uniqueViolation,
		exclusionViolation
	]),
	string(capital, { min: 5, max: 5 })
])

/** A name a server or an installation gives: a few characters, tricky ones among them. */
const nameGen: Gen<string> = string(characterOf([...Str.split("ab_09|,", ""), " ", "é", '"']), {
	min: 1,
	max: 6
})

const fieldGen: Gen<string | undefined> = oneOf<string | undefined>([
	constant(undefined),
	constant(""),
	nameGen
])

const reportOf = (code: Gen<string>): Gen<Report> =>
	map(
		(source) => ({
			code: source.draw(code),
			message: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 10 })),
			constraint: source.draw(fieldGen),
			schema: source.draw(fieldGen),
			table: source.draw(fieldGen),
			column: source.draw(fieldGen),
			dataType: source.draw(fieldGen),
			detail: source.draw(fieldGen),
			hint: source.draw(fieldGen)
		}),
		(r): Report => r
	)

/** The reasons a unique violation a statement lists as an abort is read as. */
type AbortReason = UniqueAbort["reason"]
const abortReasons: readonly [AbortReason, ...Array<AbortReason>] = [
	"GeneratedSerialUnique",
	"PutTargetConflict",
	"UnseenOccupant"
]

/** An engine reason as the engine states it, its constraint the name it names. */
type DrawnReason =
	| Exclude<EngineReason, { readonly constraint: unknown }>
	| {
			readonly _tag: "GeneratedSerialUnique" | "UnseenOccupant"
			readonly relation: string
			readonly constraint: string
	  }

/** A read-back record of any shape: the outcome holds it as given. */
type Reads = Readonly<Record<string, ReadonlyArray<number>>>

type CountEntry = {
	readonly relation: string
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

type Case =
	| { readonly kind: "report"; readonly report: Report; readonly snapshot: string }
	| {
			readonly kind: "abort"
			readonly report: Report
			readonly constraint: string
			readonly relation: string
			readonly reason: AbortReason
			readonly matched: boolean
	  }
	| { readonly kind: "transient"; readonly reason: DrawnReason }
	| { readonly kind: "bound"; readonly bound: MessageBound | LiteralBound }
	| {
			readonly kind: "committed"
			readonly counts: ReadonlyArray<CountEntry>
			readonly reads: Reads
	  }
	| {
			readonly kind: "rejected"
			readonly refused: Public.Refused
			readonly witness: Public.Witness
	  }
	| { readonly kind: "outside"; readonly relation: string }

const countGen: Gen<bigint> = oneOf([constant(0n), bigint(1n, 3n), bigint(1n << 62n, 1n << 63n)])

const lawGen: Gen<Public.Law> = oneOf<Public.Law>([
	map(
		(source) => ({ relation: source.draw(nameGen), name: source.draw(nameGen) }),
		(l): Public.Law => ({ kind: "check", relation: l.relation, name: l.name })
	),
	map(
		(source) => ({
			relation: source.draw(nameGen),
			fields: source.draw(array(nameGen, { min: 1, max: 2 }))
		}),
		(l): Public.Law => ({ kind: "primaryKey", relation: l.relation, fields: l.fields })
	)
])

const refusedGen: Gen<Public.Refused> = (source) => {
	const first = source.draw(lawGen)
	const second = source.draw(lawGen)
	const rest = source.draw(array(lawGen, { min: 0, max: 2 }))
	return source.draw(
		element<Public.Refused>([
			{ kind: "every", laws: [first, ...rest] },
			{ kind: "first", laws: [first, ...rest] },
			{ kind: "some", laws: [first, second, ...rest] }
		])
	)
}

const witnessGen: Gen<Public.Witness> = oneOf<Public.Witness>([
	constant({ kind: "unreported" }),
	map(
		(source) => ({
			relation: source.draw(nameGen),
			key: source.draw(nameGen),
			value: source.draw(int(-3, 3))
		}),
		(w): Public.Witness => ({ kind: "key", relation: w.relation, values: { [w.key]: w.value } })
	)
])

const transientGen: Gen<DrawnReason> = (source) => {
	const relation = source.draw(nameGen)
	const constraint = source.draw(nameGen)
	return source.draw(
		element<DrawnReason>([
			{ _tag: "SerializationFailure" },
			{ _tag: "Deadlock" },
			{ _tag: "PutTargetConflict", relation },
			{ _tag: "GeneratedSerialUnique", relation, constraint },
			{ _tag: "SpanKeyChange", relation },
			{ _tag: "UnseenOccupant", relation, constraint },
			{ _tag: "ConcurrentRefresh", relation }
		])
	)
}

const boundGen: Gen<MessageBound | LiteralBound> = (source) => {
	const input = source.draw(nameGen)
	const limit = source.draw(int(1, 1 << 30))
	return source.draw(
		oneOf<MessageBound | LiteralBound>([
			map(int(1, 1 << 30), (bytes) => ({ _tag: "MessageBound", input, bytes, limit })),
			map(
				(s) => ({
					form: s.draw(element(["text", "binary"] as const)),
					column: s.draw(nameGen)
				}),
				(b): LiteralBound => ({
					_tag: "LiteralBound",
					form: b.form,
					input,
					column: b.column,
					limit
				})
			)
		])
	)
}

const caseGen: Gen<Case> = oneOf<Case>([
	map(
		(source) => ({
			report: source.draw(reportOf(codeGen)),
			snapshot: source.draw(
				string(characterOf(Str.split("0123456789abcdef", "")), { min: 1, max: 8 })
			)
		}),
		(c): Case => ({ kind: "report", report: c.report, snapshot: c.snapshot })
	),
	map(
		(source) => ({
			report: source.draw(reportOf(element([uniqueViolation, exclusionViolation]))),
			constraint: source.draw(nameGen),
			relation: source.draw(nameGen),
			reason: source.draw(element(abortReasons)),
			matched: source.draw(boolean)
		}),
		(c): Case => ({ kind: "abort", ...c })
	),
	map(transientGen, (reason): Case => ({ kind: "transient", reason })),
	map(boundGen, (bound): Case => ({ kind: "bound", bound })),
	map(
		(source) => ({
			counts: source.draw(
				array(
					map(
						(s) => ({
							relation: s.draw(nameGen),
							added: s.draw(countGen),
							deleted: s.draw(countGen),
							put: s.draw(countGen)
						}),
						(c): CountEntry => c
					),
					{ min: 0, max: 3 }
				)
			),
			read: source.draw(nameGen),
			rows: source.draw(array(int(0, 9), { min: 0, max: 2 }))
		}),
		(c): Case => ({ kind: "committed", counts: c.counts, reads: { [c.read]: c.rows } })
	),
	map(
		(source) => ({ refused: source.draw(refusedGen), witness: source.draw(witnessGen) }),
		(c): Case => ({ kind: "rejected", refused: c.refused, witness: c.witness })
	),
	map(nameGen, (relation): Case => ({ kind: "outside", relation }))
])

/** The DatabaseError pg builds for an ErrorResponse carrying the report. */
const databaseError = (r: Report): DatabaseError => {
	const error = new DatabaseError(r.message, 0, "error")
	error.severity = "ERROR"
	error.code = r.code
	error.constraint = r.constraint
	error.schema = r.schema
	error.table = r.table
	error.column = r.column
	error.dataType = r.dataType
	error.detail = r.detail
	error.hint = r.hint
	return error
}

/** The report built with the public constructor, carrying every field as given, an empty one saying nothing. */
const publicServerError = (r: Report): Public.ServerError => {
	const built = new Public.ServerError({
		sqlstate: defined(Sqlstate.parse(r.code), `${r.code} is a SQLSTATE`),
		message: r.message,
		constraint: r.constraint,
		schema: r.schema,
		table: r.table,
		column: r.column,
		dataType: r.dataType,
		detail: r.detail,
		hint: r.hint
	})
	const sqlstate: string = built.sqlstate
	assert.equal(sqlstate, r.code)
	assert.equal(built.message, r.message)
	for (const field of reportFields) {
		assert.equal<string | undefined>(built[field], said(r[field]), field)
	}
	assert.deepEqual(
		serverFailure(databaseError(r))?.error,
		built,
		"the wire's reading is the public value"
	)
	return built
}

/** SERIALIZABLE's refusal of the report, by its SQLSTATE: 40001 or 40P01, and none for any other. */
const serializableOf = (
	error: Public.ServerError
): Public.SerializationFailure | Public.Deadlock | undefined => {
	const code: string = error.sqlstate
	return code === serialization
		? new Public.SerializationFailure()
		: code === deadlock
			? new Public.Deadlock()
			: undefined
}

/** The fence's reason for refusing its step with the report: the lock's 55P03, the guard's 55Z02 and 55Z01. */
const staleOf = (step: FenceStep, error: Public.ServerError): Public.StaleReason | undefined => {
	const code: string = error.sqlstate
	switch (step) {
		case "lock":
			return code === lockNotAvailable ? new Public.Migrating() : undefined
		case "guard":
			return code === migrating
				? new Public.Migrating()
				: code === migrated
					? new Public.Migrated()
					: undefined
	}
}

/** The public reason of an engine reason, its facts carried as drawn. */
const publicReason = (reason: DrawnReason): Public.TransientReason => {
	switch (reason._tag) {
		case "SerializationFailure":
			return new Public.SerializationFailure()
		case "Deadlock":
			return new Public.Deadlock()
		case "PutTargetConflict":
			return new Public.PutTargetConflict({ relation: reason.relation })
		case "GeneratedSerialUnique": {
			const built = new Public.GeneratedSerialUnique(reason)
			assert.equal<string>(built.constraint, reason.constraint)
			assert.equal(built.relation, reason.relation)
			return built
		}
		case "SpanKeyChange":
			return new Public.SpanKeyChange({ relation: reason.relation })
		case "UnseenOccupant": {
			const built = new Public.UnseenOccupant(reason)
			assert.equal<string>(built.constraint, reason.constraint)
			assert.equal(built.relation, reason.relation)
			return built
		}
		case "ConcurrentRefresh":
			return new Public.ConcurrentRefresh({ relation: reason.relation })
	}
}

/** The engine's reason as the engine holds it, its constraint the installed name it is. */
const engineReason = (reason: DrawnReason): EngineReason => {
	switch (reason._tag) {
		case "GeneratedSerialUnique":
		case "UnseenOccupant":
			return {
				_tag: reason._tag,
				relation: reason.relation,
				constraint: admittedIdentifier(reason.constraint)
			}
		case "SerializationFailure":
		case "Deadlock":
		case "PutTargetConflict":
		case "SpanKeyChange":
		case "ConcurrentRefresh":
			return reason
	}
}

/** The public InputTooLarge of an engine bound, its facts carried as the README states each bound's. */
const publicBound = (bound: MessageBound | LiteralBound): Public.InputTooLarge => {
	switch (bound._tag) {
		case "MessageBound":
			return new Public.InputTooLarge({
				bound: { kind: "input", input: bound.input, bytes: bound.bytes, limit: bound.limit }
			})
		case "LiteralBound":
			return new Public.InputTooLarge({
				bound: {
					kind: "literal",
					form: bound.form,
					input: bound.input,
					column: bound.column,
					limit: bound.limit
				}
			})
	}
}

const adapterBound = (bound: MessageBound | LiteralBound): Public.InputTooLarge => {
	switch (bound._tag) {
		case "MessageBound":
			return messageBound(bound)
		case "LiteralBound":
			return literalBound(bound)
	}
}

type Feature =
	| "report"
	| "report field empty"
	| "report field given"
	| "report serializable"
	| "report stale"
	| "abort matched"
	| "abort unmatched"
	| `abort ${AbortReason}`
	| `transient ${EngineReason["_tag"]}`
	| `bound ${(MessageBound | LiteralBound)["_tag"]}`
	| "outcome accepted"
	| "outcome no-change"
	| "outcome invariant-rejected"
	| "outcome outside-world"

const allFeatures: Arr.NonEmptyReadonlyArray<Feature> = [
	"report",
	"report field empty",
	"report field given",
	"report serializable",
	"report stale",
	"abort matched",
	"abort unmatched",
	"abort GeneratedSerialUnique",
	"abort PutTargetConflict",
	"abort UnseenOccupant",
	"transient SerializationFailure",
	"transient Deadlock",
	"transient PutTargetConflict",
	"transient GeneratedSerialUnique",
	"transient SpanKeyChange",
	"transient UnseenOccupant",
	"transient ConcurrentRefresh",
	"bound MessageBound",
	"bound LiteralBound",
	"outcome accepted",
	"outcome no-change",
	"outcome invariant-rejected",
	"outcome outside-world"
]

describe("the public failure and outcome constructors", () => {
	it.effect(
		"build every failure and outcome exactly as the adapter does, carrying each drawn fact, and the adapter's classifications build the same values",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each constructor carries its facts as given, and the adapter's classification of the same facts is the public value"
						},
						suite: "unit/adapter/public-constructors",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(allFeatures, { cases: 2_000, sense: notesOnly }),
						kept: [],
						runs: 1_000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase, c) =>
						Effect.sync(() => {
							switch (drawnCase.kind) {
								case "report": {
									c.note("report")
									const r = drawnCase.report
									for (const field of reportFields) {
										const value = r[field]
										if (value === "") {
											c.note("report field empty")
										} else if (value !== undefined) {
											c.note("report field given")
										}
									}
									const error = publicServerError(r)
									const serializable = serializableOf(error)
									if (serializable !== undefined) {
										c.note("report serializable")
									}
									const refused = serializationRefusal(error)
									assert.deepEqual(
										refused,
										serializable === undefined
											? undefined
											: new Public.TransientFailure({ reason: serializable, error })
									)
									const opened = admissionFailure(error)
									assert.deepEqual(
										opened,
										new Public.OpenError({
											reason:
												serializable === undefined
													? new Public.AdmissionFailed({ failure: error })
													: new Public.AdmissionTransient({ reason: serializable, error })
										})
									)
									assert.ok(publiclyBuilt(opened) && publiclyBuilt(opened.reason))
									for (const step of ["lock", "guard"] as const) {
										const stale = staleOf(step, error)
										assert.deepEqual(Option.getOrUndefined(fenceReason(step, error)), stale)
										if (stale === undefined) {
											continue
										}
										c.note("report stale")
										const snapshot = new Public.StaleSnapshot({
											reason: stale,
											snapshot: drawnCase.snapshot,
											error
										})
										assert.equal<string>(snapshot.snapshot, drawnCase.snapshot)
										assert.equal(snapshot.reason, stale)
										assert.equal(snapshot.error, error)
									}
									return
								}
								case "abort": {
									c.note(drawnCase.matched ? "abort matched" : "abort unmatched")
									c.note(`abort ${drawnCase.reason}`)
									const error = publicServerError({
										...drawnCase.report,
										constraint: drawnCase.constraint
									})
									const listed = drawnCase.matched
										? drawnCase.constraint
										: `${drawnCase.constraint}_other`
									const aborts: ReadonlyArray<UniqueAbort> = [
										{
											constraint: admittedIdentifier(listed),
											relation: drawnCase.relation,
											reason: drawnCase.reason
										}
									]
									const failure = transientFailureOf(error, aborts)
									const reason: DrawnReason =
										drawnCase.reason === "PutTargetConflict"
											? { _tag: drawnCase.reason, relation: drawnCase.relation }
											: {
													_tag: drawnCase.reason,
													relation: drawnCase.relation,
													constraint: drawnCase.constraint
												}
									assert.deepEqual(
										failure,
										drawnCase.matched
											? new Public.TransientFailure({ reason: publicReason(reason), error })
											: undefined
									)
									if (failure !== undefined) {
										assert.ok(publiclyBuilt(failure) && publiclyBuilt(failure.reason))
									}
									return
								}
								case "transient": {
									c.note(`transient ${drawnCase.reason._tag}`)
									const converted = transientReason(engineReason(drawnCase.reason))
									assert.deepEqual(converted, publicReason(drawnCase.reason))
									assert.ok(publiclyBuilt(converted))
									return
								}
								case "bound": {
									c.note(`bound ${drawnCase.bound._tag}`)
									const converted = adapterBound(drawnCase.bound)
									assert.deepEqual(converted, publicBound(drawnCase.bound))
									assert.ok(publiclyBuilt(converted))
									return
								}
								case "committed": {
									assert.equal(Public.ApplyOutcome, applyOutcome, "the adapter's constructors")
									const outcome: Public.ApplyOutcome<Reads> = Public.ApplyOutcome.committed(
										drawnCase.counts,
										drawnCase.reads
									)
									c.note(`outcome ${outcome.kind}`)
									assert.ok(Object.isFrozen(outcome))
									const changed = Arr.some(
										drawnCase.counts,
										(count) => count.added !== 0n || count.deleted !== 0n || count.put !== 0n
									)
									switch (outcome.kind) {
										case "accepted":
											assert.ok(changed, "accepted only when some count is nonzero")
											assert.deepEqual(outcome.counts, drawnCase.counts)
											assert.ok(Object.isFrozen(outcome.counts))
											assert.ok(Arr.every(outcome.counts, (count) => Object.isFrozen(count)))
											assert.equal(outcome.reads, drawnCase.reads)
											return
										case "no-change":
											assert.ok(!changed, "no-change only when every count is zero")
											assert.equal(outcome.reads, drawnCase.reads)
											return
									}
								}
								case "rejected": {
									c.note("outcome invariant-rejected")
									const outcome: Public.ApplyOutcome<Reads> = Public.ApplyOutcome.invariantRejected(
										drawnCase.refused,
										drawnCase.witness
									)
									assert.ok(Object.isFrozen(outcome))
									assert.deepEqual(outcome, {
										kind: "invariant-rejected",
										refused: drawnCase.refused,
										witness: drawnCase.witness
									})
									return
								}
								case "outside": {
									c.note("outcome outside-world")
									const outcome: Public.ApplyOutcome<Reads> = Public.ApplyOutcome.outsideWorld(
										drawnCase.relation
									)
									assert.ok(Object.isFrozen(outcome))
									assert.deepEqual(outcome, { kind: "outside-world", relation: drawnCase.relation })
									return
								}
							}
						})
				)
			)
	)
})
