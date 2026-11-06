import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	option,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Ref, Result, String as Str } from "effect"
import { identifierOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { assert, assertVariant, nonEmpty } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName, wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { ExpectationFailed, PgErrorFields } from "#test/support/substrate/errors.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import {
	allocatingPid,
	assertIdentifier,
	roleName,
	rolePrefix,
	uniqueSchemaName
} from "#test/support/substrate/names.ts"
import { parseVerboseError } from "#test/support/substrate/psql.ts"

/**
 * The database-free parts of the native PG test substrate, each against a model:
 *
 * - Names. A schema label and a role name are lowercase ASCII letter words joined by single underscores; an allocated
 *   schema name is `<label>_<pid>_<n>_<ten digits>`, its own conversion at the naming door, and every role and role
 *   schema minted under it starts with its prefix, so the global setup reads the allocating process off any of them
 *   and sweeps a dead one's; no name past maxIdentifierBytes is ever made, so PostgreSQL never cuts one. The oracle is
 *   the generator's own words, each drawn whole or with a fault planted, and the byte count of the name they spell.
 * - psql's verbose error report: stderr of noise lines and reports, each a severity line and its fields, is read as
 *   the last report, its message, and each field's first value that holds no line terminator; stderr with no severity
 *   line holds no report.
 * - An expectation judges its one attempt: the attempt runs once, and the expectation holds exactly for a PostgreSQL
 *   refusal of its SQLSTATE, and of its constraint where it names one.
 */
const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

/** A word of lowercase letters joined by single underscores, its letters `max` at most. */
const wordGen =
	(max: number): Gen<string> =>
	(source) =>
		Arr.join(
			source.draw(
				array(string(characterOf(lowercase), { min: 1, max: Math.max(1, Math.floor(max / 3)) }), {
					min: 1,
					max: 3
				})
			),
			"_"
		)

/** A fault that breaks the word rule. */
type WordFault =
	| "a digit"
	| "a capital"
	| "empty"
	| "a leading underscore"
	| "a trailing underscore"
	| "a double underscore"
	| "a dash"

const faultOf = (word: string, fault: WordFault): string => {
	switch (fault) {
		case "a digit":
			return `${word}2`
		case "a capital":
			return Str.capitalize(word)
		case "empty":
			return ""
		case "a leading underscore":
			return `_${word}`
		case "a trailing underscore":
			return `${word}_`
		case "a double underscore":
			return `${word}__${word}`
		case "a dash":
			return `${word}-x`
	}
}

/** A word the rule admits, or one with a fault planted. */
interface Word {
	readonly text: string
	readonly fault: Option.Option<WordFault>
}

const drawnWord = (max: number): Gen<Word> =>
	weighted<Word>([
		[4, (source) => ({ text: source.draw(wordGen(max)), fault: Option.none() })],
		[
			1,
			(source) => {
				const fault = source.draw(
					element([
						"a digit",
						"a capital",
						"empty",
						"a leading underscore",
						"a trailing underscore",
						"a double underscore",
						"a dash"
					] as const)
				)
				return { text: faultOf(source.draw(wordGen(max)), fault), fault: Option.some(fault) }
			}
		]
	])

/** Whether `make` throws. */
const refuses = (make: () => unknown): boolean => Result.isFailure(Result.try(make))

/** Every role, login and role schema name the naming door mints under an allocated schema, and a test's role. */
const mintedUnder = (schema: string): ReadonlyArray<string> => {
	const installation = identity.schema(parsedSchemaName(schema))
	const role = identity.role(installation, parsedName("Worker"))
	return [
		identifierOf(role),
		identifierOf(identity.login(installation, parsedName("web"))),
		identifierOf(identity.roleSchema(role))
	]
}

/** A schema name that is no allocation: its pid not digits, its random part short or gone, or a plain word. */
const unallocatedGen: Gen<string> = (source) => {
	const label = source.draw(wordGen(8))
	const pid = source.draw(int(1, 99_999))
	return source.draw(
		element([
			`${label}_${pid}_3`,
			`${label}_p${pid}_3_0000000005`,
			`${label}_${pid}_3_000000005`,
			label,
			`${label}__${pid}`
		])
	)
}

/** A plain lowercase identifier's characters after its first: letters, digits and underscores. */
const identifierRest = nonEmpty(
	Arr.fromIterable("abcdefghijklmnopqrstuvwxyz0123456789_"),
	"identifier characters"
)

type IdentifierFault = "a capital" | "a dash" | "a leading digit" | "empty" | "a space"

/** A plain lowercase identifier of a drawn length around the byte limit, or one with a fault planted. */
interface Identifier {
	readonly text: string
	readonly fault: Option.Option<IdentifierFault>
}

const identifierGen: Gen<Identifier> = (source) => {
	const length = source.draw(
		weighted<number>([
			[3, int(maxIdentifierBytes.value - 1, maxIdentifierBytes.value + 1)],
			[1, int(1, maxIdentifierBytes.value + 8)]
		])
	)
	const text = `${source.draw(characterOf(lowercase))}${source.draw(string(characterOf(identifierRest), { min: length - 1, max: length - 1 }))}`
	const fault = source.draw(
		weighted<Option.Option<IdentifierFault>>([
			[3, () => Option.none()],
			[
				1,
				(s) =>
					Option.some(
						s.draw(element(["a capital", "a dash", "a leading digit", "empty", "a space"] as const))
					)
			]
		])
	)
	return Option.match(fault, {
		onNone: () => ({ text, fault }),
		onSome: (planted) => ({
			text:
				planted === "a capital"
					? Str.capitalize(text)
					: planted === "a dash"
						? `${text}-`
						: planted === "a leading digit"
							? `1${text}`
							: planted === "empty"
								? ""
								: `${text} `,
			fault
		})
	})
}

type NameFeature =
	| "an identifier admitted"
	| "an identifier past the limit"
	| "an identifier refused"
	| "allocated"
	| "a label refused"
	| "a label past the limit"
	| "a role named"
	| "a role refused"
	| "a role past the limit"
	| "no allocation"

describe("substrate names", () => {
	it.effect(
		"allocate exactly the names the word rule and the byte limit admit, every name under an allocation carrying its prefix and its process",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/names",
						draw: drawn((source) => ({
							label: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
							allocation: source.draw(
								weighted<number>([
									[3, int(0, 199)],
									[1, int(0, 2 ** 31 - 1)]
								])
							),
							role: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
							unallocated: source.draw(unallocatedGen),
							identifier: source.draw(identifierGen)
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the word rule on the generator's own words, and the bytes of the names they spell"
						},
						coverage: required<NameFeature>(
							[
								"an identifier admitted",
								"an identifier past the limit",
								"an identifier refused",
								"allocated",
								"a label refused",
								"a label past the limit",
								"a role named",
								"a role refused",
								"a role past the limit",
								"no allocation"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ label, allocation, role, unallocated, identifier }, c) =>
						Effect.sync(() => {
							const plain =
								Option.isNone(identifier.fault) &&
								Buffer.byteLength(identifier.text) <= maxIdentifierBytes.value
							assert.equal(
								refuses(() => assertIdentifier(identifier.text)),
								!plain,
								identifier.text
							)
							c.note(
								plain
									? "an identifier admitted"
									: Option.isSome(identifier.fault)
										? "an identifier refused"
										: "an identifier past the limit"
							)
							assert.ok(Option.isNone(allocatingPid(unallocated)), unallocated)
							assert.ok(
								refuses(() => roleName(unallocated, "worker")),
								unallocated
							)
							c.note("no allocation")
							const bytes = Buffer.byteLength(
								`${label.text}_${process.pid}_${allocation}_0000000000`
							)
							const fits = bytes <= maxIdentifierBytes.value
							const made = Result.try(() => uniqueSchemaName(label.text, allocation))
							assert.equal(Result.isSuccess(made), Option.isNone(label.fault) && fits, label.text)
							if (Result.isFailure(made)) {
								c.note(Option.isSome(label.fault) ? "a label refused" : "a label past the limit")
								return
							}
							const schema = made.success
							c.note("allocated")
							assert.equal(Buffer.byteLength(schema), bytes)
							assert.equal<string>(identifierOf(identity.schema(parsedSchemaName(schema))), schema)
							assert.deepEqual(allocatingPid(schema), Option.some(process.pid))
							const prefix = rolePrefix(schema)
							for (const name of mintedUnder(schema)) {
								if (Buffer.byteLength(name) <= maxIdentifierBytes.value) {
									assert.ok(Str.startsWith(prefix)(name), `${name} starts with ${prefix}`)
									assert.deepEqual(allocatingPid(name), Option.some(process.pid), name)
								}
							}
							const full = `${schema}__${role.text}`
							const named = Result.try(() => roleName(schema, role.text))
							const roleFits = Buffer.byteLength(full) <= maxIdentifierBytes.value
							assert.equal(Result.isSuccess(named), Option.isNone(role.fault) && roleFits, full)
							if (Result.isFailure(named)) {
								c.note(Option.isSome(role.fault) ? "a role refused" : "a role past the limit")
								return
							}
							c.note("a role named")
							assert.equal(named.success, full)
							assert.ok(Str.startsWith(prefix)(named.success))
							assert.deepEqual(allocatingPid(named.success), Option.some(process.pid))
						})
				)
			)
	)
})

/** The text fields psql prints after a severity line, each with the key the report reads it into. */
const fieldNames = [
	["DETAIL", "detail"],
	["HINT", "hint"],
	["CONTEXT", "where"],
	["SCHEMA NAME", "schema"],
	["TABLE NAME", "table"],
	["COLUMN NAME", "column"],
	["DATATYPE NAME", "dataType"]
] as const

type FieldKey = (typeof fieldNames)[number][1]

/** Text a message or a field holds: words, spaces, quotes, parentheses, colons, and a line separator now and then. */
const textGen: Gen<string> = (source) =>
	Arr.join(
		source.draw(
			array(
				element([
					"duplicate",
					"key",
					'"fact_key"',
					"(k)=(1)",
					"x: y",
					"  ",
					"ERROR:  ",
					"\u2028"
				] as const),
				{ min: 1, max: 4 }
			)
		),
		" "
	)

/** A line psql prints that is no report's: notices, warnings, locations, client errors and statements. */
const noiseGen: Gen<string> = element([
	"NOTICE:  00000: earlier notice",
	"WARNING:  01000: a warning",
	"LOCATION:  exec_stmt_raise, pl_exec.c:3956",
	"psql:<stdin>:3: error: connection to server was lost",
	"STATEMENT:  INSERT INTO fact VALUES (1)",
	"QUERY:  SELECT 1"
] as const)

/** A field line: one of psql's text fields and its text, or the constraint's name. */
type FieldLine =
	| {
			readonly kind: "text"
			readonly key: FieldKey
			readonly name: (typeof fieldNames)[number][0]
			readonly value: string
	  }
	| { readonly kind: "constraint"; readonly value: ConstraintName }

const fieldLineGen: Gen<FieldLine> = weighted<FieldLine>([
	[
		7,
		(source) => {
			const [name, key] = source.draw(element(fieldNames))
			return { kind: "text", key, name, value: source.draw(textGen) }
		}
	],
	[1, (source) => ({ kind: "constraint", value: wild.constraint(source.draw(wordGen(8))) })]
])

/**
 * One report: its severity line's form with its SQLSTATE, which psql prints at VERBOSITY verbose as the substrate runs
 * it, its message, its fields, and LOCATION lines among them.
 */
interface Report {
	readonly prefix: string
	readonly severity: "ERROR" | "FATAL" | "PANIC"
	readonly code: string
	readonly message: string
	readonly lines: ReadonlyArray<Option.Option<FieldLine>>
}

const reportGen: Gen<Report> = (source) => ({
	prefix: source.draw(element(["", "psql:<stdin>:4: "] as const)),
	severity: source.draw(element(["ERROR", "FATAL", "PANIC"] as const)),
	code: source.draw(element(["23505", "22012", "57P01"] as const)),
	message: Str.replaceAll("\u2028", " ")(source.draw(textGen)),
	lines: source.draw(array(option(fieldLineGen), { min: 0, max: 5 }))
})

const reportText = (r: Report): ReadonlyArray<string> => [
	`${r.prefix}${r.severity}:  ${r.code}: ${r.message}`,
	...Arr.map(r.lines, (line) =>
		Option.match(line, {
			onNone: () => "LOCATION:  _bt_check_unique, nbtinsert.c:676",
			onSome: (f) => `${f.kind === "text" ? f.name : "CONSTRAINT NAME"}:  ${f.value}`
		})
	)
]

/** A field's value as the report reads it: its first line after the last severity line whose value is one line. */
const firstOf = (r: Report, key: FieldKey): Option.Option<string> =>
	Arr.findFirst(Arr.getSomes(r.lines), (f): Option.Option<string> =>
		f.kind === "text" && f.key === key && !Str.includes("\u2028")(f.value)
			? Option.some(f.value)
			: Option.none()
	)

/** The constraint the report names: the first constraint line's. */
const constraintOf = (r: Report): ConstraintName | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(Arr.getSomes(r.lines), (f): Option.Option<ConstraintName> =>
			f.kind === "constraint" ? Option.some(f.value) : Option.none()
		)
	)

type ReportFeature =
	| "no report"
	| "one report"
	| "the last of several"
	| "a field read"
	| "a field skipped"

describe("psql writer protocol", () => {
	it.effect(
		"reads psql's verbose report as its last severity line's message and each field's first one-line value",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/psql-report",
						draw: drawn((source) => ({
							before: source.draw(array(noiseGen, { min: 0, max: 2 })),
							reports: source.draw(array(reportGen, { min: 0, max: 2 })),
							after: source.draw(
								array(element(["NOTICE:  00000: later", "WARNING:  01000: later"] as const), {
									min: 0,
									max: 1
								})
							),
							sqlstate: source.draw(element(["23505", "XX000"] as const))
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the last report printed, its message and each field's first one-line value"
						},
						coverage: required<ReportFeature>(
							["no report", "one report", "the last of several", "a field read", "a field skipped"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ before, reports, after, sqlstate }, c) =>
						Effect.sync(() => {
							const stderr = Arr.join(
								Arr.map(
									[...before, ...Arr.flatMap(reports, reportText), ...after],
									(l) => `${l}\n`
								),
								""
							)
							const read = parseVerboseError(sqlstate, stderr)
							const last = Arr.last(reports)
							if (Option.isNone(last)) {
								c.note("no report")
								assert.equal(read, undefined)
								return
							}
							c.note(reports.length === 1 ? "one report" : "the last of several")
							const r = last.value
							assert.deepEqual(read, {
								code: sqlstate,
								message: r.message,
								detail: firstOf(r, "detail"),
								hint: firstOf(r, "hint"),
								where: firstOf(r, "where"),
								schema: firstOf(r, "schema"),
								table: firstOf(r, "table"),
								column: firstOf(r, "column"),
								dataType: firstOf(r, "dataType"),
								constraint: constraintOf(r)
							})
							for (const f of Arr.getSomes(r.lines)) {
								c.note(Str.includes("\u2028")(f.value) ? "a field skipped" : "a field read")
							}
						})
				)
			)
	)
})

/** How a scripted attempt ends: it succeeds, fails with no PostgreSQL error, or PostgreSQL refuses it. */
type Ending =
	| { readonly kind: "succeeds" }
	| { readonly kind: "fails"; readonly with: "text" | "a tagged error" }
	| {
			readonly kind: "refused"
			readonly code: string
			readonly constraint: Option.Option<ConstraintName>
	  }

const codes = ["23505", "23514", "40001", "40P01", "22012"] as const
const constraints: Arr.NonEmptyReadonlyArray<ConstraintName> = [
	wild.constraint("fact_key"),
	wild.constraint("fact_v_check")
]

const endingGen: Gen<Ending> = weighted<Ending>([
	[1, () => ({ kind: "succeeds" })],
	[
		1,
		(source) => ({ kind: "fails", with: source.draw(element(["text", "a tagged error"] as const)) })
	],
	[
		4,
		(source) => ({
			kind: "refused",
			code: source.draw(element(codes)),
			constraint: source.draw(option(element(constraints)))
		})
	]
])

/** A failure that is no PostgreSQL error. */
class NotPostgres extends Data.TaggedError("NotPostgres")<{ readonly what: string }> {}

/** A PostgreSQL error as the driver reports one: its SQLSTATE, its message, and the constraint it names or none. */
interface ServerRecord {
	readonly code: string
	readonly message: string
	readonly constraint: ConstraintName | undefined
}

/** The scripted attempt that ends as `ending`. */
const endingOf = (ending: Ending): Effect.Effect<number, string | NotPostgres | ServerRecord> => {
	switch (ending.kind) {
		case "succeeds":
			return Effect.succeed(1)
		case "fails":
			return ending.with === "text"
				? Effect.fail("plain")
				: Effect.fail(new NotPostgres({ what: "plain" }))
		case "refused":
			return Effect.fail({
				code: ending.code,
				message: "refused",
				constraint: Option.getOrUndefined(ending.constraint)
			})
	}
}

/** What an expectation names: a SQLSTATE for expectSqlstate, and a constraint besides for expectConstraint. */
type Expectation =
	| { readonly form: "sqlstate"; readonly code: (typeof codes)[number] }
	| {
			readonly form: "constraint"
			readonly code: (typeof codes)[number]
			readonly constraint: ConstraintName
	  }

const expectationGen: Gen<Expectation> = (source) => {
	const code = source.draw(element(codes))
	return source.draw(element(["sqlstate", "constraint"] as const)) === "sqlstate"
		? { form: "sqlstate", code }
		: { form: "constraint", code, constraint: source.draw(element(constraints)) }
}

type Judgment =
	| "held"
	| "failed: succeeded"
	| "failed: not PostgreSQL's"
	| "failed: another SQLSTATE"
	| "failed: another constraint"

type ExpectFeature = `${Expectation["form"]}, ${Judgment}`

describe("expectations", () => {
	it.effect(
		"run their attempt once and hold exactly for a PostgreSQL refusal of their SQLSTATE and constraint",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/expectations",
						draw: drawn((source) => ({
							ending: source.draw(endingGen),
							expected: source.draw(expectationGen)
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "an expectation holds exactly for a refusal of its SQLSTATE and, where it names one, its constraint"
						},
						coverage: required<ExpectFeature>(
							[
								"sqlstate, held",
								"sqlstate, failed: succeeded",
								"sqlstate, failed: not PostgreSQL's",
								"sqlstate, failed: another SQLSTATE",
								"constraint, held",
								"constraint, failed: succeeded",
								"constraint, failed: not PostgreSQL's",
								"constraint, failed: another SQLSTATE",
								"constraint, failed: another constraint"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ ending, expected }, c) =>
						Effect.gen(function* () {
							const runs = yield* Ref.make(0)
							const attempt: Effect.Effect<number, string | NotPostgres | ServerRecord> =
								Effect.andThen(
									Ref.update(runs, (n) => n + 1),
									endingOf(ending)
								)
							const expectation: Effect.Effect<PgErrorFields, ExpectationFailed> =
								expected.form === "sqlstate"
									? expectSqlstate(attempt, expected.code)
									: expectConstraint(attempt, expected.constraint, expected.code)
							const judged = yield* Effect.result(expectation)
							const ran = yield* Ref.get(runs)
							assert.equal(ran, 1, "the attempt runs once")
							const feature: Judgment =
								ending.kind === "succeeds"
									? "failed: succeeded"
									: ending.kind === "fails"
										? "failed: not PostgreSQL's"
										: ending.code !== expected.code
											? "failed: another SQLSTATE"
											: expected.form === "constraint" &&
												  !Option.contains(ending.constraint, expected.constraint)
												? "failed: another constraint"
												: "held"
							c.note(`${expected.form}, ${feature}`)
							if (feature !== "held") {
								assertVariant(judged, "_tag", "Failure", feature)
								assert.equal(judged.failure._tag, "ExpectationFailed")
								return
							}
							assertVariant(judged, "_tag", "Success")
							if (ending.kind === "refused") {
								assert.equal(judged.success.code, ending.code)
								assert.equal(judged.success.constraint, Option.getOrUndefined(ending.constraint))
							}
						})
				)
			)
	)
})
