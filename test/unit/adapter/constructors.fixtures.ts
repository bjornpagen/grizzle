/** What the properties of constructors.test.ts read: its spaces, models and helpers. */

import * as Runtime from "@bjornpagen/grizzle/runtime"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	aimed,
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
} from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Option, String as Str } from "effect"
import { DatabaseError } from "pg"
import * as Execution from "#adapter/errors/execution.ts"
import * as Failures from "#adapter/errors/failures.ts"
import { literalBound, messageBound } from "#adapter/errors/failures.ts"
import { type FenceStep } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import type { UniqueAbort } from "#compiler/plan/change.ts"
import {
	admittedIdentifier,
	type TransientReason as EngineReason,
	type LiteralBound,
	type MessageBound
} from "#compiler/plan/common.ts"
import { CompileError, EncodingFailure, Sqlstate } from "#compiler/public/errors.ts"
import { derivedLaw } from "#compiler/runtime/law-entry.ts"
import * as Public from "#index.ts"
import { wild } from "#test/support/kernel/naming.ts"

/**
 * The failure values an application's test builds: every failure Db.open or DbLayer.make can fail with has a
 * constructor in the public barrel, and every failure the adapter classifies, which a call's
 * CallError reads, is built by its own constructor, the one the adapter builds that failure with, so a test's value is exactly grizzle's, built with no cast and no object literal standing in for a class. The
 * outcome values are the adapter's own (adapter/outcomes applyOutcome), which a write call reads as its WriteOutcome or
 * its refusal; they are built here with those constructors.
 *
 * The type tier: `Failure` is every failure reachable from the public error channels through what each carries (a
 * reason, a server's report, a nested failure), derived by the compiler from the classes themselves, so a reason added
 * to a channel joins it unasked; `constructors` must name a public value whose instances are exactly that failure for
 * each of its tags, so a failure exported as a type only, or left out, is a compile error here.
 *
 * The search: the facts each constructor that admits or converts takes (a server's report, a reason's relation and
 * constraint, an engine's transient reason and bound, an outcome's counts, read-backs, refusal and witness) are
 * drawn, built with the public constructor (an outcome with the adapter's), and the value carries each fact as given,
 * an empty report field saying nothing as an absent one does (the README's contract). Where the adapter classifies
 * the same facts from its own input (pg's DatabaseError, a SQLSTATE SERIALIZABLE or the fence refuses with, a unique
 * violation a statement lists as an abort, an engine reason or bound), its value is deeply equal to the public
 * construction, prototypes included, and an instance of the public constructor for its tag.
 *
 * Oracle: the specification, each constructor's value carrying the facts as given, and the adapter's own
 * classification of the same facts, deeply equal to it.
 *
 * Features: each constructor, each SQLSTATE grizzle branches on and any other, each report field empty or present.
 */

/** The errors a caller meets as classes: Db.open's and DbLayer.make's, and the compile's. */
type PublicChannel = Runtime.OpenError | CompileError

/** The errors the adapter classifies, the public ones and those a call's CallError reads (live/call-error.ts). */
type Channel = PublicChannel | Execution.ReadError | Execution.ApplyError

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
	AttestationRefused: Runtime.AttestationRefused,
	CallInputRefused: Failures.CallInputRefused,
	ClaimRefused: Runtime.ClaimRefused,
	CommitLost: Failures.CommitLost,
	CommitUnknown: Execution.CommitUnknown,
	CompileError,
	ConnectionClosed: Failures.ConnectionClosed,
	ConnectionEnvironmentRefused: Runtime.ConnectionEnvironmentRefused,
	ConnectionLost: Failures.ConnectionLost,
	CredentialError: Public.CredentialError,
	DbConfigRefused: Runtime.DbConfigRefused,
	Deadlock: Failures.Deadlock,
	DriverFailure: Failures.DriverFailure,
	DriverRefused: Failures.DriverRefused,
	EncodingFailure,
	ExecutionFailure: Execution.ExecutionFailure,
	ExpiryRefused: Runtime.ExpiryRefused,
	InputRejected: Failures.InputRejected,
	InputTooLarge: Failures.InputTooLarge,
	LawRejected: Failures.LawRejected,
	LayerReleased: Failures.LayerReleased,
	LiveSourceMissing: Runtime.LiveSourceMissing,
	Migrated: Failures.Migrated,
	Migrating: Failures.Migrating,
	NoCancelKey: Failures.NoCancelKey,
	OpenError: Runtime.OpenError,
	ParamRejected: Failures.ParamRejected,
	PutTargetConflict: Failures.PutTargetConflict,
	ReadFailure: Execution.ReadFailure,
	RoleOutsideLayers: Runtime.RoleOutsideLayers,
	SerializationFailure: Failures.SerializationFailure,
	ServedLoginRefused: Runtime.ServedLoginRefused,
	ServerError: Failures.ServerError,
	SocketFailed: Failures.SocketFailed,
	SpanKeyChange: Failures.SpanKeyChange,
	StaleSnapshot: Execution.StaleSnapshot,
	StartupRefused: Failures.StartupRefused,
	TlsRefused: Failures.TlsRefused,
	TokenMalformed: Runtime.TokenMalformed,
	TokenRefused: Runtime.TokenRefused,
	TransientFailure: Execution.TransientFailure,
	TransportFailure: Execution.TransportFailure,
	UnreadableAnswer: Failures.UnreadableAnswer,
	UnseenOccupant: Failures.UnseenOccupant,
	VerifierUnavailable: Runtime.VerifierUnavailable
}

/** Whether the adapter built `failure` with the public constructor of its tag. */
export const publiclyBuilt = (failure: Failure): boolean =>
	failure instanceof constructors[failure._tag]

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

export const reportFields = [
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
	"PutTargetConflict",
	"UnseenOccupant"
]

/** An engine reason as the engine states it, its constraint the name it names. */
export type DrawnReason =
	| Exclude<EngineReason, { readonly constraint: unknown }>
	| {
			readonly _tag: "UnseenOccupant"
			readonly relation: string
			readonly constraint: string
	  }

/** A read-back record of any shape: the outcome holds it as given. */
export type Reads = Readonly<Record<string, ReadonlyArray<number>>>

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
			readonly refused: Public.BrokenLaws
			readonly witness: Public.Witness
	  }
	| { readonly kind: "outside"; readonly relation: string }

const countGen: Gen<bigint> = oneOf([constant(0n), bigint(1n, 3n), bigint(1n << 62n, 1n << 63n)])

const lawGen: Gen<Public.OwnLaw> = oneOf<Public.OwnLaw>([
	map(
		(source) => ({ relation: source.draw(nameGen), name: source.draw(nameGen) }),
		(l): Public.OwnLaw => derivedLaw({ kind: "check", relation: l.relation, name: l.name })
	),
	map(
		(source) => ({
			relation: source.draw(nameGen),
			fields: source.draw(array(nameGen, { min: 1, max: 2 }))
		}),
		(l): Public.OwnLaw => derivedLaw({ kind: "primaryKey", relation: l.relation, fields: l.fields })
	)
])

const refusingGen: Gen<Public.RefusingObject> = oneOf<Public.RefusingObject>([
	map(
		(source) => ({ table: source.draw(nameGen), name: wild.constraint(source.draw(nameGen)) }),
		(o): Public.RefusingObject => ({ kind: "constraint", table: o.table, name: o.name })
	),
	map(
		(source) => ({ domain: source.draw(nameGen), name: wild.constraint(source.draw(nameGen)) }),
		(o): Public.RefusingObject => ({ kind: "domain", domain: o.domain, name: o.name })
	),
	constant({ kind: "statement" }),
	map(
		(source) => ({ table: source.draw(nameGen), column: source.draw(nameGen) }),
		(o): Public.RefusingObject => ({ kind: "notNull", table: o.table, column: o.column })
	)
])

const refusedLawGen: Gen<Public.RefusedLaw> = (source) => ({
	law: source.draw(lawGen),
	id: wild.lawId(source.draw(nameGen)),
	by: source.draw(refusingGen)
})

const aboveLawGen: Gen<Public.AboveRefusedLaw> = (source) => ({
	law: { kind: "above", level: source.draw(nameGen), law: source.draw(lawGen) },
	id: wild.lawId(source.draw(nameGen)),
	by: source.draw(refusingGen)
})

const refusedGen: Gen<Public.BrokenLaws> = (source) => {
	const first = source.draw(refusedLawGen)
	const second = source.draw(refusedLawGen)
	const rest = source.draw(array(refusedLawGen, { min: 0, max: 2 }))
	const above = source.draw(aboveLawGen)
	const moreAbove = source.draw(array(aboveLawGen, { min: 0, max: 1 }))
	return source.draw(
		element<Public.BrokenLaws>([
			{ kind: "every", laws: [first, ...rest] },
			{ kind: "first", laws: [first, ...rest] },
			{ kind: "some", laws: [first, second, ...rest] },
			{ kind: "above", own: "every", above: [above, ...moreAbove], laws: [first, ...rest] },
			{ kind: "above", own: "none", above: [above, ...moreAbove] },
			{ kind: "above", own: "unjudged", above: [above, ...moreAbove] }
		])
	)
}

/** A text's code points, in order: what pg_c_utf8 orders a text by. */
const codePoints = (text: string): ReadonlyArray<number> =>
	Arr.map(Array.from(text), (c) =>
		defined(Option.getOrUndefined(Str.codePointAt(0)(c)), "a character's code point")
	)

/** Two texts in code point order, lexicographically, a prefix first: the specification of the canonical text order. */
const byCodePoints = (a: string, b: string): -1 | 0 | 1 => {
	const [x, y] = [codePoints(a), codePoints(b)]
	for (const [i, p] of x.entries()) {
		const q = y[i]
		if (q === undefined) {
			return 1
		}
		if (p !== q) {
			return p < q ? -1 : 1
		}
	}
	return x.length < y.length ? -1 : 0
}

/** A list of a refusal's laws in canonical order: by identity, in code point order. */
const canonicalList = <L extends { readonly id: string }>(
	laws: Arr.NonEmptyReadonlyArray<L>
): Arr.NonEmptyReadonlyArray<L> => Arr.sort(laws, (a: L, b: L) => byCodePoints(a.id, b.id))

/**
 * A refusal as every refusal leaves grizzle (Bjorn's canonical-order ruling), the specification: each of its lists by its
 * laws' identities in code point order, whatever order it was assembled in.
 */
export const canonicalOf = (refused: Public.BrokenLaws): Public.BrokenLaws => {
	switch (refused.kind) {
		case "every":
		case "first":
			return { kind: refused.kind, laws: canonicalList(refused.laws) }
		case "some": {
			const [first, second, ...more] = canonicalList(refused.laws)
			return { kind: "some", laws: [first, defined(second, "a second law"), ...more] }
		}
		case "above":
			return refused.own === "every"
				? {
						kind: "above",
						own: "every",
						above: canonicalList(refused.above),
						laws: canonicalList(refused.laws)
					}
				: { kind: "above", own: refused.own, above: canonicalList(refused.above) }
	}
}

/** Whether a refusal holds a list of three laws or more that its assembly left out of canonical order. */
export const outOfOrderOfThree = (refused: Public.BrokenLaws): boolean => {
	const canonical = canonicalOf(refused)
	const lists = (r: Public.BrokenLaws): ReadonlyArray<ReadonlyArray<{ readonly id: string }>> =>
		r.kind === "above" ? (r.own === "every" ? [r.above, r.laws] : [r.above]) : [r.laws]
	const drawn = lists(refused)
	return Arr.some(lists(canonical), (list, i) => {
		const was = defined(drawn[i], "the drawn list")
		return list.length >= 3 && Arr.some(list, (law, j) => law.id !== was[j]?.id)
	})
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
			{ _tag: "SpanKeyChange", relation },
			{ _tag: "UnseenOccupant", relation, constraint }
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

/** A report of a SQLSTATE `code` draws, and the snapshot a fence's refusal of it names. */
const reportCaseOf = (code: Gen<string>): Gen<Case> =>
	map(
		(source) => ({
			report: source.draw(reportOf(code)),
			snapshot: source.draw(
				string(characterOf(Str.split("0123456789abcdef", "")), { min: 1, max: 8 })
			)
		}),
		(c): Case => ({ kind: "report", report: c.report, snapshot: c.snapshot })
	)

const caseGen: Gen<Case> = oneOf<Case>([
	reportCaseOf(codeGen),
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
export const publicServerError = (r: Report): Failures.ServerError => {
	const built = new Failures.ServerError({
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
export const serializableOf = (
	error: Failures.ServerError
): Failures.SerializationFailure | Failures.Deadlock | undefined => {
	const code: string = error.sqlstate
	return code === serialization
		? new Failures.SerializationFailure()
		: code === deadlock
			? new Failures.Deadlock()
			: undefined
}

/** The fence's reason for refusing its step with the report: the lock's 55P03, the guard's 55Z02 and 55Z01; none for a
 * fenced write's lock. */
export const staleOf = (
	step: FenceStep,
	error: Failures.ServerError
): Failures.StaleReason | undefined => {
	const code: string = error.sqlstate
	switch (step) {
		case "lock":
			return code === lockNotAvailable ? new Failures.Migrating() : undefined
		case "exclude":
			return undefined
		case "guard":
			return code === migrating
				? new Failures.Migrating()
				: code === migrated
					? new Failures.Migrated()
					: undefined
	}
}

/** The public reason of an engine reason, its facts carried as drawn. */
export const publicReason = (reason: DrawnReason): Failures.TransientReason => {
	switch (reason._tag) {
		case "SerializationFailure":
			return new Failures.SerializationFailure()
		case "Deadlock":
			return new Failures.Deadlock()
		case "PutTargetConflict":
			return new Failures.PutTargetConflict({ relation: reason.relation })
		case "SpanKeyChange":
			return new Failures.SpanKeyChange({ relation: reason.relation })
		case "UnseenOccupant": {
			const built = new Failures.UnseenOccupant(reason)
			assert.equal<string>(built.constraint, reason.constraint)
			assert.equal(built.relation, reason.relation)
			return built
		}
	}
}

/** The engine's reason as the engine holds it, its constraint the installed name it is. */
export const engineReason = (reason: DrawnReason): EngineReason => {
	switch (reason._tag) {
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
			return reason
	}
}

/** The public InputTooLarge of an engine bound, its facts carried as the README states each bound's. */
export const publicBound = (bound: MessageBound | LiteralBound): Failures.InputTooLarge => {
	switch (bound._tag) {
		case "MessageBound":
			return new Failures.InputTooLarge({
				bound: { kind: "input", input: bound.input, bytes: bound.bytes, limit: bound.limit }
			})
		case "LiteralBound":
			return new Failures.InputTooLarge({
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

export const adapterBound = (bound: MessageBound | LiteralBound): Failures.InputTooLarge => {
	switch (bound._tag) {
		case "MessageBound":
			return messageBound(bound)
		case "LiteralBound":
			return literalBound(bound)
	}
}

export type Feature =
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
	| "outcome invariant-rejected of three laws or more out of canonical order"

export const allFeatures: Arr.NonEmptyReadonlyArray<Feature> = [
	"report",
	"report field empty",
	"report field given",
	"report serializable",
	"report stale",
	"abort matched",
	"abort unmatched",
	"abort PutTargetConflict",
	"abort UnseenOccupant",
	"transient SerializationFailure",
	"transient Deadlock",
	"transient PutTargetConflict",
	"transient SpanKeyChange",
	"transient UnseenOccupant",
	"bound MessageBound",
	"bound LiteralBound",
	"outcome accepted",
	"outcome no-change",
	"outcome invariant-rejected",
	"outcome outside-world",
	"outcome invariant-rejected of three laws or more out of canonical order"
]

/**
 * Every case, aimed at a report the fence reads as stale (the lock's 55P03, the guard's 55Z02 or 55Z01), which a report
 * of a drawn SQLSTATE seldom is.
 */
export const constructorCases = aimed<Case, Feature>(caseGen, [
	["report stale", reportCaseOf(element([lockNotAvailable, migrating, migrated]))]
])
