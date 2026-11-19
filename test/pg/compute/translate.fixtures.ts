/** What the properties of translate.test.ts read: its spaces, models and helpers. */

import { codePoints, codePointsText, collapsed } from "@bjornpagen/grizzle-text/text"
import type { Steered } from "@bjornpagen/testing/explore"
import { array, boolean, element, type Gen, int, proportional } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { defined } from "#test/support/assert.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { type LeafBinding, testPg } from "#test/unit/compute/support.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

export const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

export const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

export const text = (value: string): ExprDesc => ({ kind: "literal", value })

/** Tab, LF and CR, beside the space they become. */
const whiteSpace: Arr.NonEmptyReadonlyArray<number> = [0x09, 0x0a, 0x0d, 0x20]

/**
 * The ASCII letters and their neighbours, no-break space and line separator, which XML does not count as white space,
 * Latin-1's capital and small E acute, and BMP's last and a supplementary code point.
 */
const others: Arr.NonEmptyReadonlyArray<number> = [
	0x40, 0x41, 0x5a, 0x5b, 0x60, 0x61, 0x7a, 0x7b, 0xa0, 0x2028, 0xc9, 0xe9, 0xffff, 0x1f600
]

/** A character of the alphabet, each white space twice as often as each other one, so runs of them are common. */
const character: Gen<number> = proportional([
	[2 * whiteSpace.length, element(whiteSpace)],
	[others.length, element(others)]
])

/**
 * A case: a map Compute.translate admits, a raw pair PostgreSQL's translate takes whatever its characters, a
 * repeated one or a shorter `to` among them, which the host's translation is held to as well, and the texts.
 */
interface SqlCase {
	readonly from: ReadonlyArray<number>
	readonly to: ReadonlyArray<number>
	readonly rawFrom: string
	readonly rawTo: string
	readonly texts: ReadonlyArray<string>
}

export type SqlFeature =
	| "a character replaced"
	| "a capital lowered"
	| "a non-ASCII character kept"
	| "a repeated character read by its first"
	| "a character deleted"
	| "a run of white space folded"
	| "white space trimmed at an end"
	| "a run of three or more folded"
	| "a tab in a run"
	| "an LF in a run"
	| "a CR in a run"
	| "a space in a run"
	| "a supplementary character beside white space"

const sqlCase: Gen<SqlCase> = (source) => {
	const from = Arr.dedupe(source.draw(array(character, { min: 0, max: 4 })))
	return {
		from,
		to: Arr.map(from, () => source.draw(character)),
		rawFrom: codePointsText(source.draw(array(character, { min: 0, max: 5 }))),
		rawTo: codePointsText(source.draw(array(character, { min: 0, max: 5 }))),
		texts: source.draw(array(stringsOver(character, 10), { min: 1, max: 48 }))
	}
}

/**
 * A case whose raw pair maps `repeated` to `target` first, its drawn pairs after, and names `repeated` again after every
 * one of them, with a text of `repeated` alone: translate reads a repeated character by its first, so that text becomes
 * `target`, and a read by its last takes the target past every drawn one.
 */
const withRepeated = (c: SqlCase, repeated: number, target: number): SqlCase => ({
	...c,
	rawFrom: codePointsText([repeated, ...codePoints(c.rawFrom), repeated]),
	rawTo: codePointsText([target, ...codePoints(c.rawTo)]),
	texts: [...c.texts, codePointsText([repeated])]
})

/**
 * A case as the generator draws it: a drawn one, or, while a repeated character read by its first is pending
 * (Steered), in half its cases by a draw of its own, a drawn one with a drawn character repeated in its raw `from` and
 * met in a text (withRepeated), which a drawn case reaches too rarely for the floor and the steered phase. A rotating
 * case is drawn unaimed.
 */
export const aimedSqlCase: Steered<SqlCase, SqlFeature> = (steering) => (source) => {
	const drawnCase = source.draw(sqlCase)
	if (
		Option.exists(steering, (pending) => pending.names("a repeated character read by its first")) &&
		source.draw(boolean)
	) {
		return withRepeated(drawnCase, source.draw(character), source.draw(character))
	}
	return drawnCase
}

/** Whether a code point is one of XML's four white space characters. */
export const isXmlSpace = (c: number): boolean =>
	c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20

/** The note of each white space character other than the space, met in a run. */
export const runNotes: ReadonlyMap<number, SqlFeature> = new Map<number, SqlFeature>([
	[0x09, "a tab in a run"],
	[0x0a, "an LF in a run"],
	[0x0d, "a CR in a run"]
])

/** The text PostgreSQL prints a host value as. */
export const printed = (value: unknown): string => String(value)

/** Whether a code point is an ASCII capital, the one character lowerAscii changes. */
const isCapital = (c: number): boolean => c >= 0x41 && c <= 0x5a

/** The host's ASCII case fold, character by character. */
export const asciiLower = (s: string): string =>
	codePointsText(Arr.map(codePoints(s), (c) => (isCapital(c) ? c + 0x20 : c)))

/** One row of each relation the installed case inserts. */
interface Row {
	readonly id: number
	readonly title: string
	readonly tag: string
	readonly g: number
	readonly k: string
}

export type InstalledFeature =
	| "a title normalized"
	| "a title collapsed"
	| "a tag folded"
	| "a numeral's leading zeros dropped"
	| "a conditional's image stored, the tag lower case"
	| "a conditional's literal stored, the tag not lower case"

/** Short titles over tab, LF, CR, space and letters; tags of a few letters either case; numerals with leading zeros. */
const title = stringsOver(element([0x09, 0x0a, 0x0d, 0x20, 0x61, 0xe9]), 6)

export const rowGen: Gen<ReadonlyArray<Omit<Row, "id">>> = array(
	(source) => ({
		title: source.draw(title),
		tag: codePointsText(source.draw(array(element([0x41, 0x61, 0x42, 0x62]), { min: 1, max: 3 }))),
		g: source.draw(int(0, 1)),
		k: source.draw(element(["1", "01", "001", "10", "010", "2", "02"]))
	}),
	{ min: 1, max: 16 }
)

const Title = str.regex("^.{0,40}$", "su")

const Normalized = str.regex("^[^\\t\\n\\r]{0,40}$", "su")

/** A collapsed title of at most 40 characters: no tab, LF or CR, and a space at neither end. */
const Collapsed = str.regex("^(?:[^ \\t\\n\\r](?:[^\\t\\n\\r]{0,38}[^ \\t\\n\\r])?)?$", "su")

const Tag = str.regex("^[A-Za-z]{1,8}$", "u")

const FoldedTag = str.regex("^[a-z]{1,8}$", "u")

const Numeral = str.regex("^[0-9]{1,6}$", "u")

/** Lower-case letters alone: the match the conditional fields branch on. */
const LowerCase = Compute.pattern("^[a-z]+$")

const Named = relation.generated(
	"Named",
	{ id: pg.integer, title: Title, tag: Tag },
	["id"],
	(r) => ({
		normalized: generated(
			Normalized,
			Compute.cast(Compute.translate(r.title, "\t\n\r", "   "), Normalized)
		),
		folded: generated(FoldedTag, Compute.cast(Compute.lowerAscii(r.tag), FoldedTag)),
		collapsed: generated(Collapsed, Compute.cast(Compute.collapse(r.title), Collapsed)),
		normalizedIf: generated(
			Title,
			Compute.cond(
				Compute.matches(r.tag, LowerCase),
				Compute.translate(r.title, "\t\n\r", "   "),
				""
			)
		),
		collapsedIf: generated(
			Title,
			Compute.cond(Compute.matches(r.tag, LowerCase), Compute.collapse(r.title), "")
		),
		tagIf: generated(
			Tag,
			Compute.when(Compute.matches(r.tag, LowerCase), (tag) => tag, "x")
		)
	})
)

const Counted = relation.generated(
	"Counted",
	{ id: pg.integer, g: pg.integer, k: Numeral },
	["id"],
	(r) => ({ v: generated(pg.bigint, Compute.cast(r.k, pg.bigint)) })
)

const value = schema("Translated", [Named, Counted], [])

export const translateInstallation = Effect.gen(function* () {
	const substrate = yield* Substrate
	const schemaName = yield* substrate.schema({ create: false, label: "translate" })
	const owned = owning(value)
	const real = compileInstallation(owned, {
		...installOptions(owned, substrate.owner.role),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
	if (!real.ok) {
		return yield* Effect.die(new Error(`real compile ${real.error.message}`))
	}
	return real.value
})

/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
export const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

/** The host's translation of a title into xs:normalizedString's value space: tab, LF and CR each a space. */
const normalizedOf = (s: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(s), (ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? " " : ch)),
		""
	)

export const judge = (pinned: PgConnection, installation: Installation, rows: ReadonlyArray<Row>) =>
	Effect.gen(function* () {
		const names = installationNamesOf(installation)
		const reached = new Set<InstalledFeature>()
		const problems: Array<string> = []
		for (const r of rows) {
			const named = yield* probe(
				pinned,
				`INSERT INTO ${names.table(Named)} (${names.column(Named, "id")}, ${names.column(Named, "title")}, ${names.column(Named, "tag")}) VALUES ($1, $2, $3)`,
				[r.id, r.title, r.tag]
			)
			if (named.kind === "refused") {
				problems.push(`Named ${Formatter.format(r)}: refused with ${named.code}`)
			}
			const counted = yield* probe(
				pinned,
				`INSERT INTO ${names.table(Counted)} (${names.column(Counted, "id")}, ${names.column(Counted, "g")}, ${names.column(Counted, "k")}) VALUES ($1, $2, $3)`,
				[r.id, r.g, r.k]
			)
			if (counted.kind === "refused") {
				problems.push(`Counted ${Formatter.format(r)}: refused with ${counted.code}`)
			}
		}
		const numerals = yield* pinned.queryValues(
			`SELECT ${names.column(Counted, "k")}, ${names.column(Counted, "v")} FROM ${names.table(Counted)} ORDER BY ${names.column(Counted, "id")}`,
			[]
		)
		for (const row of numerals) {
			const [k, cast] = Arr.map(row, String)
			const numeral = defined(k)
			if (BigInt(defined(cast)) !== BigInt(numeral)) {
				problems.push(`v ${Formatter.format(cast)} of ${Formatter.format(numeral)}`)
			}
			if (Str.startsWith("0")(numeral)) {
				reached.add("a numeral's leading zeros dropped")
			}
		}
		const stored = yield* pinned.queryValues(
			`SELECT ${names.column(Named, "title")}, ${names.column(Named, "normalized")}, ${names.column(Named, "tag")}, ${names.column(Named, "folded")}, ${names.column(Named, "collapsed")}, ${names.column(Named, "normalizedIf")}, ${names.column(Named, "collapsedIf")}, ${names.column(Named, "tagIf")} FROM ${names.table(Named)} ORDER BY ${names.column(Named, "id")}`,
			[]
		)
		for (const row of stored) {
			const [t, n, g, f, cl, ni, ci, ti] = Arr.map(row, String)
			const storedTitle = defined(t)
			const storedTag = defined(g)
			if (n !== normalizedOf(storedTitle)) {
				problems.push(`normalized ${Formatter.format(n)} of ${Formatter.format(storedTitle)}`)
			}
			if (f !== asciiLower(storedTag)) {
				problems.push(`folded ${Formatter.format(f)} of ${Formatter.format(storedTag)}`)
			}
			if (n !== storedTitle) {
				reached.add("a title normalized")
			}
			if (f !== storedTag) {
				reached.add("a tag folded")
			}
			if (cl !== collapsed(storedTitle)) {
				problems.push(`collapsed ${Formatter.format(cl)} of ${Formatter.format(storedTitle)}`)
			}
			if (cl !== n) {
				reached.add("a title collapsed")
			}
			const lower = asciiLower(storedTag) === storedTag
			const expected = lower
				? [normalizedOf(storedTitle), collapsed(storedTitle), storedTag]
				: ["", "", "x"]
			if (ni !== expected[0] || ci !== expected[1] || ti !== expected[2]) {
				problems.push(
					`the conditionals ${Formatter.format([ni, ci, ti])} of ${Formatter.format([storedTitle, storedTag])}, not ${Formatter.format(expected)}`
				)
			}
			reached.add(
				lower
					? "a conditional's image stored, the tag lower case"
					: "a conditional's literal stored, the tag not lower case"
			)
		}
		return { problems, reached }
	})
