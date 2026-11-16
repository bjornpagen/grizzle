/** What the properties of substrate.test.ts read: its spaces, models and helpers. */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Option, Result, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName, wild } from "#test/support/kernel/naming.ts"

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

export const drawnWord = (max: number): Gen<Word> =>
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
export const refuses = (make: () => unknown): boolean => Result.isFailure(Result.try(make))

/** Every role, login and role schema name the naming door mints under an allocated schema, and a test's role. */
export const mintedUnder = (schema: string): ReadonlyArray<string> => {
	const installation = identity.schema(parsedSchemaName(schema))
	const role = identity.role(installation, parsedName("Worker"))
	return [
		identifierOf(role),
		identifierOf(identity.login(installation, parsedName("web"))),
		identifierOf(identity.roleSchema(role))
	]
}

/** A schema name that is no allocation: its pid not digits, its random part short or gone, or a plain word. */
export const unallocatedGen: Gen<string> = (source) => {
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

export const identifierGen: Gen<Identifier> = (source) => {
	const length = source.draw(
		weighted<number>([
			[3, int(maxIdentifierBytes - 1, maxIdentifierBytes + 1)],
			[1, int(1, maxIdentifierBytes + 8)]
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

export type NameFeature =
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
					" "
				] as const),
				{ min: 1, max: 4 }
			)
		),
		" "
	)

/** A line psql prints that is no report's: notices, warnings, locations, client errors and statements. */
export const noiseGen: Gen<string> = element([
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

export const reportGen: Gen<Report> = (source) => ({
	prefix: source.draw(element(["", "psql:<stdin>:4: "] as const)),
	severity: source.draw(element(["ERROR", "FATAL", "PANIC"] as const)),
	code: source.draw(element(["23505", "22012", "57P01"] as const)),
	message: Str.replaceAll(" ", " ")(source.draw(textGen)),
	lines: source.draw(array(option(fieldLineGen), { min: 0, max: 5 }))
})

export const reportText = (r: Report): ReadonlyArray<string> => [
	`${r.prefix}${r.severity}:  ${r.code}: ${r.message}`,
	...Arr.map(r.lines, (line) =>
		Option.match(line, {
			onNone: () => "LOCATION:  _bt_check_unique, nbtinsert.c:676",
			onSome: (f) => `${f.kind === "text" ? f.name : "CONSTRAINT NAME"}:  ${f.value}`
		})
	)
]

/** A field's value as the report reads it: its first line after the last severity line whose value is one line. */
export const firstOf = (r: Report, key: FieldKey): Option.Option<string> =>
	Arr.findFirst(Arr.getSomes(r.lines), (f): Option.Option<string> =>
		f.kind === "text" && f.key === key && !Str.includes(" ")(f.value)
			? Option.some(f.value)
			: Option.none()
	)

/** The constraint the report names: the first constraint line's. */
export const constraintOf = (r: Report): ConstraintName | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(Arr.getSomes(r.lines), (f): Option.Option<ConstraintName> =>
			f.kind === "constraint" ? Option.some(f.value) : Option.none()
		)
	)

export type ReportFeature =
	| "no report"
	| "one report"
	| "the last of several"
	| "a field read"
	| "a field skipped"

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

export const endingGen: Gen<Ending> = weighted<Ending>([
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
export class NotPostgres extends Data.TaggedError("NotPostgres")<{ readonly what: string }> {}

/** A PostgreSQL error as the driver reports one: its SQLSTATE, its message, and the constraint it names or none. */
export interface ServerRecord {
	readonly code: string
	readonly message: string
	readonly constraint: ConstraintName | undefined
}

/** The scripted attempt that ends as `ending`. */
export const endingOf = (
	ending: Ending
): Effect.Effect<number, string | NotPostgres | ServerRecord> => {
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

export const expectationGen: Gen<Expectation> = (source) => {
	const code = source.draw(element(codes))
	return source.draw(element(["sqlstate", "constraint"] as const)) === "sqlstate"
		? { form: "sqlstate", code }
		: { form: "constraint", code, constraint: source.draw(element(constraints)) }
}

export type Judgment =
	| "held"
	| "failed: succeeded"
	| "failed: not PostgreSQL's"
	| "failed: another SQLSTATE"
	| "failed: another constraint"

export type ExpectFeature = `${Expectation["form"]}, ${Judgment}`
