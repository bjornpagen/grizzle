import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { DatabaseError } from "pg"
import { admissionFailure } from "#adapter/admission/admit.ts"
import { OpenError, ReadFailure, TransientFailure } from "#adapter/errors/execution.ts"
import {
	BatchRefused,
	CommitRefused,
	type ServerError,
	StaleName,
	StartupRefused
} from "#adapter/errors/failures.ts"
import { asReadFailure } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import { type TransientTag } from "#compiler/core/errors.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"
/**
 * The failure vocabulary: every report the server can send is read once, at the wire, into exactly one class, and the
 * class carries what the server said as it said it.
 *
 * The oracle is PostgreSQL's own contract, stated here and never read from src: a SQLSTATE is five characters, each a
 * digit or an ASCII capital; 40001 is serialization_failure and 40P01 deadlock_detected, the two refusals SERIALIZABLE
 * gives any transaction; 53200 out_of_memory and 54001 statement_too_complex are resource failures; class 28 is invalid
 * authorization; FATAL and PANIC end the session. The README promise is that a server-raised failure carries its
 * SQLSTATE, its message, its DETAIL and its HINT exactly as given, and the objects it names (constraint, schema, table,
 * column, data type) as named, an empty name naming nothing.
 *
 * Admission's flight reads the same reports: 40001 and 40P01 refuse its transaction for a reason outside Db.open's
 * inputs, retryable (AdmissionTransient), and any other report is an admission with no verdict (AdmissionFailed).
 *
 * Each case is a named intention: a code grizzle branches on, any well-formed code, and the malformed ones (lowercase, a
 * fullwidth digit, too short, too long, absent); a message that is empty, quotes a value, holds a lone surrogate or is
 * long; a DETAIL and a HINT each absent, empty or present; each named object absent, empty or a name of tricky characters; every
 * severity, a lowercase spelling and none; and where the failure met the flight (a statement, COMMIT, a stale name).
 *
 * PostgreSQL's spelling of a SQLSTATE (errcodes.txt).
 */
const isSqlstateSpec = (code: string): boolean => regex("^[0-9A-Z]{5}$").test(code)

/** The conditions the contract names, by PostgreSQL's codes. */
const serialization = "40001"
const deadlock = "40P01"
const resourceStates: ReadonlySet<string> = new Set(["53200", "54001"])

type CodeKind =
	| "branched on"
	| "well-formed"
	| "lowercase"
	| "fullwidth digit"
	| "too short"
	| "too long"
	| "absent"
type MessageKind = "empty" | "quotes a value" | "lone surrogate" | "long" | "any"
type DetailKind = "absent" | "empty" | "present"
type NameKind = "absent" | "empty" | "named"
/** A severity pg reports, a lowercase spelling of one that ends the session (no severity PostgreSQL sends), or none. */
type Severity = "ERROR" | "FATAL" | "PANIC" | "WARNING" | "fatal" | "none"
type Position = "statement" | "COMMIT" | "stale name"

interface Report {
	readonly codeKind: CodeKind
	readonly code: string | undefined
	readonly messageKind: MessageKind
	readonly message: string
	readonly detailKind: DetailKind
	readonly detail: string | undefined
	readonly hintKind: DetailKind
	readonly hint: string | undefined
	readonly names: Names
	readonly severity: Severity
	readonly position: Position
}

/** The objects a report names, each with how it was drawn. */
interface Names {
	readonly constraint: Named
	readonly schema: Named
	readonly table: Named
	readonly column: Named
	readonly dataType: Named
}

interface Named {
	readonly kind: NameKind
	readonly name: string | undefined
}

const capital = element(Str.split("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", ""))
const wellFormed = string(capital, { min: 5, max: 5 })

/** Printable ASCII, up to ten characters. */
const ascii = (min: number): Gen<string> => string(codePoint(0x20, 0x7e), { min, max: 10 })

/** Up to ten graphemes of any plane: ASCII, the rest of the Basic Multilingual Plane below the surrogates, astral
 * scalars, and clusters of several scalars. */
const anyText: Gen<string> = string(
	oneOf([
		codePoint(0x20, 0x7e),
		codePoint(0xa0, 0xd7ff),
		codePoint(0x1_0000, 0x1_ffff),
		element(["e\u0301", "\u{1f44d}\u{1f3fd}", "\u{1f1eb}\u{1f1f7}"])
	]),
	{ min: 0, max: 10 }
)

const codeGen: Gen<{ readonly kind: CodeKind; readonly code: string | undefined }> = oneOf<{
	readonly kind: CodeKind
	readonly code: string | undefined
}>([
	map(
		element([
			serialization,
			deadlock,
			"53200",
			"54001",
			"23505",
			"23P01",
			"23514",
			"26000",
			"0A000",
			"28P01"
		]),
		(code) => ({ kind: "branched on", code })
	),
	map(wellFormed, (code) => ({ kind: "well-formed", code })),
	constant({ kind: "lowercase", code: "40p01" }),
	constant({ kind: "fullwidth digit", code: "4０001" }),
	map(wellFormed, (code) => ({ kind: "too short", code: Str.slice(0, 4)(code) })),
	map(wellFormed, (code) => ({ kind: "too long", code: `${code}0` })),
	constant({ kind: "absent", code: undefined })
])

const messageGen: Gen<{ readonly kind: MessageKind; readonly message: string }> = oneOf<{
	readonly kind: MessageKind
	readonly message: string
}>([
	constant({ kind: "empty", message: "" }),
	map(ascii(0), (v) => ({
		kind: "quotes a value",
		message: `duplicate key value (${v}) violates`
	})),
	constant({ kind: "lone surrogate", message: "bad \ud800 text" }),
	constant({ kind: "long", message: Str.repeat(10_000)("x") }),
	map(anyText, (message) => ({ kind: "any", message }))
])

const detailGen: Gen<{ readonly kind: DetailKind; readonly detail: string | undefined }> = oneOf<{
	readonly kind: DetailKind
	readonly detail: string | undefined
}>([
	constant({ kind: "absent", detail: undefined }),
	constant({ kind: "empty", detail: "" }),
	map(ascii(1), (detail) => ({ kind: "present", detail }))
])

const namedGen: Gen<Named> = oneOf<Named>([
	constant({ kind: "absent", name: undefined }),
	constant({ kind: "empty", name: "" }),
	map(
		string(characterOf([...Str.split("ab_09|,", ""), " ", "é", "\u0000", '"']), { min: 1, max: 6 }),
		(name) => ({ kind: "named", name })
	)
])

const namesGen: Gen<Names> = (source) => ({
	constraint: source.draw(namedGen),
	schema: source.draw(namedGen),
	table: source.draw(namedGen),
	column: source.draw(namedGen),
	dataType: source.draw(namedGen)
})

const reportGen: Gen<Report> = map(
	(source) => ({
		code: source.draw(codeGen),
		message: source.draw(messageGen),
		detail: source.draw(detailGen),
		hint: source.draw(detailGen),
		names: source.draw(namesGen),
		severity: source.draw(
			element<Severity>(["ERROR", "FATAL", "PANIC", "WARNING", "fatal", "none"])
		),
		position: source.draw(element<Position>(["statement", "COMMIT", "stale name"]))
	}),
	(r): Report => ({
		codeKind: r.code.kind,
		code: r.code.code,
		messageKind: r.message.kind,
		message: r.message.message,
		detailKind: r.detail.kind,
		detail: r.detail.detail,
		hintKind: r.hint.kind,
		hint: r.hint.detail,
		names: r.names,
		severity: r.severity,
		position: r.position
	})
)

/** The DatabaseError pg builds for an ErrorResponse carrying the report. */
const databaseError = (r: Report): DatabaseError => {
	const error = new DatabaseError(r.message, 0, "error")
	if (r.severity !== "none") {
		error.severity = r.severity
	}
	if (r.code !== undefined) {
		error.code = r.code
	}
	if (r.detail !== undefined) {
		error.detail = r.detail
	}
	if (r.hint !== undefined) {
		error.hint = r.hint
	}
	error.constraint = r.names.constraint.name
	error.schema = r.names.schema.name
	error.table = r.names.table.name
	error.column = r.names.column.name
	error.dataType = r.names.dataType.name
	return error
}

/** A named object as the server named it: an empty name names nothing. */
const asNamed = (named: Named): string | undefined => (named.name === "" ? undefined : named.name)

const nameFields = ["constraint", "schema", "table", "column", "dataType"] as const

/** The flight failure the report is at its position. */
const flightFailure = (position: Position, failure: ServerError) => {
	switch (position) {
		case "statement":
			return new BatchRefused({ index: 0, failure })
		case "COMMIT":
			return new CommitRefused({ failure })
		case "stale name":
			return new StaleName({ index: 0, failure })
	}
}

type Feature =
	| `code ${CodeKind}`
	| `message ${MessageKind}`
	| `detail ${DetailKind}`
	| `hint ${DetailKind}`
	| `name ${NameKind}`
	| `severity ${Severity}`
	| `position ${Position}`
	| "class TransientFailure"
	| "class ReadFailure"
	| "admission transient"
	| "unparsed"

const allFeatures: Arr.NonEmptyReadonlyArray<Feature> = [
	"code branched on",
	"code well-formed",
	"code lowercase",
	"code fullwidth digit",
	"code too short",
	"code too long",
	"code absent",
	"message empty",
	"message quotes a value",
	"message lone surrogate",
	"message long",
	"message any",
	"detail absent",
	"detail empty",
	"detail present",
	"hint absent",
	"hint empty",
	"hint present",
	"name absent",
	"name empty",
	"name named",
	"severity ERROR",
	"severity FATAL",
	"severity PANIC",
	"severity WARNING",
	"severity fatal",
	"severity none",
	"position statement",
	"position COMMIT",
	"position stale name",
	"class TransientFailure",
	"class ReadFailure",
	"admission transient",
	"unparsed"
]

describe("the failure vocabulary", () => {
	it.effect(
		"reads every server report into exactly one class that carries its SQLSTATE, message, DETAIL, HINT and named objects as given",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/failure-vocabulary",
						draw: drawn(reportGen),
						literal: Formatter.format,
						coverage: required<Feature>(allFeatures, { cases: 2_000, sense: notesOnly }),
						kept: [],
						runs: 2_000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(r, c) =>
						Effect.sync(() => {
							c.note(`code ${r.codeKind}`)
							c.note(`message ${r.messageKind}`)
							c.note(`detail ${r.detailKind}`)
							c.note(`hint ${r.hintKind}`)
							for (const field of nameFields) {
								c.note(`name ${r.names[field].kind}`)
							}
							c.note(`severity ${r.severity}`)
							c.note(`position ${r.position}`)
							const answer = serverFailure(databaseError(r))
							const parses = r.code !== undefined && isSqlstateSpec(r.code)
							assert.equal(
								answer !== undefined,
								parses,
								"a report is read exactly when its code is a SQLSTATE"
							)
							if (answer === undefined || r.code === undefined) {
								c.note("unparsed")
								return
							}
							const error = answer.error
							/** What the server said, as it said it. */
							const sqlstate: string = error.sqlstate
							assert.equal(sqlstate, r.code)
							assert.equal(error.message, r.message)
							assert.equal(error.detail, r.detail === "" ? undefined : r.detail)
							assert.equal(error.hint, r.hint === "" ? undefined : r.hint)
							for (const field of nameFields) {
								assert.equal<string | undefined>(error[field], asNamed(r.names[field]), field)
							}
							assert.equal(
								answer._tag,
								r.severity === "FATAL" || r.severity === "PANIC" ? "terminated" : "refused"
							)
							assert.equal(
								new OpenError({ reason: new StartupRefused({ error }) }).stage,
								Str.startsWith("28")(r.code) ? "authentication" : "connect"
							)
							/**
							 * Admission's failure: SERIALIZABLE's refusal of its transaction is retryable, carrying the report; any
							 * other report is an admission with no verdict, carrying it; both at stage `admission`.
							 */
							const opened = admissionFailure(error)
							assert.equal(opened.stage, "admission")
							const refusedBySerializable: TransientTag | undefined =
								r.code === serialization
									? "SerializationFailure"
									: r.code === deadlock
										? "Deadlock"
										: undefined
							if (opened.reason._tag === "AdmissionTransient") {
								c.note("admission transient")
								assert.equal<TransientTag | undefined>(
									opened.reason.reason._tag,
									refusedBySerializable
								)
								assert.equal(opened.reason.error, error)
							} else {
								assert.equal(
									refusedBySerializable,
									undefined,
									"SERIALIZABLE's refusal is retryable"
								)
								assert.ok(
									opened.reason._tag === "AdmissionFailed" && opened.reason.failure === error,
									`an admission with no verdict carrying the report, not ${opened.reason._tag}`
								)
							}
							/** A read's failure: exactly one class, carrying the same report. */
							const read = asReadFailure(flightFailure(r.position, error))
							assert.equal(
								read instanceof TransientFailure,
								!(read instanceof ReadFailure),
								"exactly one class"
							)
							const transient: TransientTag | undefined =
								r.position === "stale name"
									? "StaleStatement"
									: r.code === serialization
										? "SerializationFailure"
										: r.code === deadlock
											? "Deadlock"
											: undefined
							if (read instanceof TransientFailure) {
								c.note("class TransientFailure")
								assert.ok(
									read.reason._tag === transient,
									`reason ${read.reason._tag}, the contract's ${transient}`
								)
								assert.equal(read.error, error)
								assert.equal(read.error.message, r.message)
								return
							}
							c.note("class ReadFailure")
							assert.equal(
								transient,
								undefined,
								"SERIALIZABLE's refusal and a stale name are transient"
							)
							assert.ok(
								read instanceof ReadFailure,
								"a statement's or COMMIT's refusal is never the fence's"
							)
							assert.equal(read.reason, error)
							assert.equal(read.stage, resourceStates.has(r.code) ? "resource" : "execute")
						})
				)
			)
	)
})
