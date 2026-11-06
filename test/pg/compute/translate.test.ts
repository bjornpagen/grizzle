import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { translated } from "#compiler/scalar/regex/translate.ts"
import { collapsed } from "#compiler/scalar/regex/whitespace.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

/**
 * Compute.translate and Compute.lowerAscii on PostgreSQL 19, against the host.
 *
 * 1. The SQL a check holds for a drawn map and for lowerAscii, `translate(v, from, to)`, over a batch of texts that mix
 *    ASCII, Latin-1, BMP and supplementary code points in one round trip: PostgreSQL's answer must be the reference
 *    evaluator's character by character, and lowerAscii's must leave every character but A to Z as it was.
 * 2. An installed relation whose generated fields translate a title into xs:normalizedString's value space and fold a
 *    tag's ASCII case, each cast into its declared text type by the inclusion of the image, and whose second relation
 *    keys a selected side by a field generated from a text: the installer's own DDL, each drawn row inserted under a
 *    savepoint. A row is admitted exactly when the host model admits it, a refusal is 23505 naming the key the model
 *    names, and every admitted row's generated fields hold the host's translation.
 */

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value, type: undefined })

/**
 * Tab, LF and CR beside the space they become, twice, so runs of them are common, the ASCII letters and their
 * neighbours, no-break space and line separator, which XML does not count as white space, Latin-1's capital and small E
 * acute, and BMP's last and a supplementary code point.
 */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [
	0x09, 0x0a, 0x0d, 0x20, 0x09, 0x0a, 0x0d, 0x20, 0x40, 0x41, 0x5a, 0x5b, 0x60, 0x61, 0x7a, 0x7b,
	0xa0, 0x2028, 0xc9, 0xe9, 0xffff, 0x1f600
]

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

type SqlFeature =
	| "a character replaced"
	| "a capital lowered"
	| "a non-ASCII character kept"
	| "a repeated character read by its first"
	| "a character deleted"
	| "a run of white space folded"
	| "white space trimmed at an end"

const sqlCase: Gen<SqlCase> = (source) => {
	const from = Arr.dedupe(source.draw(array(element(alphabet), { min: 0, max: 4 })))
	return {
		from,
		to: Arr.map(from, () => source.draw(element(alphabet))),
		rawFrom: codePointsText(source.draw(array(element(alphabet), { min: 0, max: 5 }))),
		rawTo: codePointsText(source.draw(array(element(alphabet), { min: 0, max: 5 }))),
		texts: source.draw(array(stringsOver(alphabet, 10), { min: 1, max: 48 }))
	}
}

/** Whether a code point is one of XML's four white space characters. */
const isXmlSpace = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20

/** The text PostgreSQL prints a host value as. */
const printed = (value: unknown): string => String(value)

/** Whether a code point is an ASCII capital, the one character lowerAscii changes. */
const isCapital = (c: number): boolean => c >= 0x41 && c <= 0x5a

/** The host's ASCII case fold, character by character. */
const asciiLower = (s: string): string =>
	codePointsText(Arr.map(codePoints(s), (c) => (isCapital(c) ? c + 0x20 : c)))

layer(Substrate.layer)("Compute's translate and lowerAscii on PostgreSQL", (it) => {
	it.effect("translate and lowerAscii agree with the host over mixed texts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session(ownerSession())
				return yield* explore(
					{
						suite: "pg/compute/translate-sql",
						draw: drawn(sqlCase),
						literal: Formatter.format,
						oracle: { kind: "second-implementation", name: "the reference evaluator" },
						coverage: required<SqlFeature>(
							[
								"a character replaced",
								"a capital lowered",
								"a non-ASCII character kept",
								"a repeated character read by its first",
								"a character deleted",
								"a run of white space folded",
								"white space trimmed at an end"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						/** Each case one round trip of up to 48 rows and two expressions. */
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const lower = (desc: ExprDesc) => {
								const lowered = lowerWith("check", desc, { v: textColumn }, false, baseParams)
								if (!lowered.ok) {
									return assert.fail(`lowers: ${lowered.error.message}`)
								}
								return lowered.value.root.expr
							}
							const translation = lower({
								kind: "compute",
								fn: "translate",
								args: [variable("v"), text(codePointsText(c.from)), text(codePointsText(c.to))]
							})
							const folded = lower(spelledExpr(computeCore.lowerAscii(v("v", testPg.text)).expr))
							const collapse = lower(spelledExpr(computeCore.collapse(v("v", testPg.text)).expr))
							const replace = lower(
								spelledExpr(computeCore.replaceWhitespace(v("v", testPg.text)).expr)
							)
							const probes = [translation, folded, collapse, replace]
							const select = Arr.join(
								Arr.map(probes, (p) => `(${renderSql(p, plainRender)})::text`),
								", "
							)
							const rows = yield* db.values(
								`SELECT ${select}, pg_catalog.translate(r0.v, $2::text, $3::text) FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
								[
									jsonText(Arr.map(c.texts, (value, ord) => ({ ord, v: value }))),
									c.rawFrom,
									c.rawTo
								]
							)
							const rawSources = codePoints(c.rawFrom)
							const rawTargets = codePoints(c.rawTo)
							assert.equal(rows.length, c.texts.length, "a row per input")
							for (const [i, row] of rows.entries()) {
								const input = defined(c.texts[i])
								for (const [j, p] of probes.entries()) {
									const host = evaluate(p, {
										kind: "row",
										column: () => input,
										param: () => undefined,
										regexMember: patternMember
									})
									if (host._tag !== "Success") {
										return assert.fail("the reference evaluates it")
									}
									assert.equal(
										row[j],
										printed(host.success),
										`${defined(["translate", "lowerAscii", "collapse", "replaceWhitespace"][j])} over ${Formatter.format(input)}: PostgreSQL against the host`
									)
								}
								assert.equal(
									row[1],
									asciiLower(input),
									`lowerAscii over ${Formatter.format(input)}`
								)
								if (row[0] !== input) {
									k.note("a character replaced")
								}
								if (row[1] !== input) {
									k.note("a capital lowered")
								}
								if (Arr.some(codePoints(input), (c) => c > 0x7f)) {
									k.note("a non-ASCII character kept")
								}
								assert.equal(row[2], collapsed(input), `collapse over ${Formatter.format(input)}`)
								const points = codePoints(input)
								if (Arr.some(points, (cp, i) => isXmlSpace(cp) && isXmlSpace(points[i + 1] ?? 0))) {
									k.note("a run of white space folded")
								}
								if (isXmlSpace(points[0] ?? 0) || isXmlSpace(points.at(-1) ?? 0)) {
									k.note("white space trimmed at an end")
								}
								assert.equal(
									row[4],
									translated(input, c.rawFrom, c.rawTo),
									`translate(${Formatter.format(input)}, ${Formatter.format(c.rawFrom)}, ${Formatter.format(c.rawTo)}): PostgreSQL against the host`
								)
								for (const cp of codePoints(input)) {
									const first = rawSources.indexOf(cp)
									if (first >= 0 && rawSources.lastIndexOf(cp) !== first) {
										k.note("a repeated character read by its first")
									}
									if (first >= rawTargets.length) {
										k.note("a character deleted")
									}
								}
							}
						})
				)
			})
		)
	)

	/** One row of each relation the installed case inserts. */
	interface Row {
		readonly id: number
		readonly title: string
		readonly tag: string
		readonly g: number
		readonly k: string
	}

	type InstalledFeature =
		| "a title normalized"
		| "a title collapsed"
		| "a tag folded"
		| "a tag refused by its folded key"
		| "a selected row refused by its generated key"
		| "an unselected row admitted beside its twin"

	/** Short titles over tab, LF, CR, space and letters; tags of a few letters either case; numerals with leading zeros. */
	const title = stringsOver([0x09, 0x0a, 0x0d, 0x20, 0x61, 0xe9], 6)
	const rowGen: Gen<ReadonlyArray<Omit<Row, "id">>> = array(
		(source) => ({
			title: source.draw(title),
			tag: codePointsText(
				source.draw(array(element([0x41, 0x61, 0x42, 0x62]), { min: 1, max: 3 }))
			),
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
			collapsed: generated(Collapsed, Compute.cast(Compute.collapse(r.title), Collapsed))
		})
	)
	const Counted = relation.generated(
		"Counted",
		{ id: pg.integer, g: pg.integer, k: Numeral },
		["id"],
		(r) => ({ v: generated(pg.bigint, Compute.cast(r.k, pg.bigint)) })
	)
	/** The rows whose numeral is a one after any zeros: "1", "01" and "001" are one value of v, which the key holds apart. */
	const ones = select(Counted, (c) => Compute.matches(c.k, "^0*1"))
	const foldedKey = key(on(Named, "folded"))
	const onesKey = key(on(ones, "g", "v"))
	const value = schema("Translated", { Named, Counted }, [foldedKey, onesKey])

	const installationOf = Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaName = yield* substrate.schema({ create: false, label: "translate" })
		const owned = owning(value)
		const real = compileInstallation(owned, {
			...installOptions(owned, substrate.owner.role),
			installation: identity.schema(parsedSchemaName(schemaName))
		})
		if (!real.ok) {
			return yield* Effect.die(new Error(`real compile ${real.error.message}`))
		}
		return real.value
	})

	/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
	const inInstallation = <A>(
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

	/** Whether a numeral is a one after any zeros, as `^0*1` matches it. */
	const isOne = (numeral: string): boolean => {
		const digits = Arr.fromIterable(numeral)
		return Option.match(
			Arr.findFirstIndex(digits, (d) => d !== "0"),
			{ onNone: () => false, onSome: (first) => digits[first] === "1" }
		)
	}

	const judge = (pinned: PgConnection, installation: Installation, rows: ReadonlyArray<Row>) =>
		Effect.gen(function* () {
			const names = installationNamesOf(installation)
			const foldedConstraint = names.constraintOf(names.lawOf(foldedKey), "Unique")
			const onesConstraint = names.constraintOf(names.lawOf(onesKey), "Unique")
			const reached = new Set<InstalledFeature>()
			const problems: Array<string> = []
			const folded = new Set<string>()
			const held = new Set<string>()
			const verdictProblem = (
				what: string,
				expected: Option.Option<string>,
				verdict:
					| { readonly kind: "admitted" }
					| {
							readonly kind: "refused"
							readonly code: string
							readonly constraint: Option.Option<string>
					  }
			): ReadonlyArray<string> => {
				if (verdict.kind === "admitted") {
					return Option.isNone(expected)
						? []
						: [`${what}: the model refuses it, the server admitted it`]
				}
				return Option.isSome(expected) &&
					verdict.code === "23505" &&
					Option.contains(verdict.constraint, expected.value)
					? []
					: [
							`${what}: refused with ${verdict.code}, the model ${Option.isSome(expected) ? `names ${expected.value}` : "admits it"}`
						]
			}
			for (const r of rows) {
				const tag = asciiLower(r.tag)
				const tagTaken = folded.has(tag)
				const named = yield* probe(
					pinned,
					`INSERT INTO ${names.table(Named)} (${names.column(Named, "id")}, ${names.column(Named, "title")}, ${names.column(Named, "tag")}) VALUES ($1, $2, $3)`,
					[r.id, r.title, r.tag]
				)
				appendAll(
					problems,
					verdictProblem(
						`Named ${Formatter.format(r)}`,
						tagTaken ? Option.some(foldedConstraint) : Option.none(),
						named
					)
				)
				if (tagTaken) {
					reached.add("a tag refused by its folded key")
				} else {
					folded.add(tag)
				}
				const selected = isOne(r.k)
				const held_ = `${r.g}:${BigInt(r.k)}`
				const clash = selected && held.has(held_)
				const counted = yield* probe(
					pinned,
					`INSERT INTO ${names.table(Counted)} (${names.column(Counted, "id")}, ${names.column(Counted, "g")}, ${names.column(Counted, "k")}) VALUES ($1, $2, $3)`,
					[r.id, r.g, r.k]
				)
				appendAll(
					problems,
					verdictProblem(
						`Counted ${Formatter.format(r)}`,
						clash ? Option.some(onesConstraint) : Option.none(),
						counted
					)
				)
				if (clash) {
					reached.add("a selected row refused by its generated key")
				} else if (selected) {
					held.add(held_)
				} else if (
					Arr.some(rows, (o) => o.id < r.id && o.g === r.g && BigInt(o.k) === BigInt(r.k))
				) {
					reached.add("an unselected row admitted beside its twin")
				}
			}
			const stored = yield* pinned.queryValues(
				`SELECT ${names.column(Named, "title")}, ${names.column(Named, "normalized")}, ${names.column(Named, "tag")}, ${names.column(Named, "folded")}, ${names.column(Named, "collapsed")} FROM ${names.table(Named)} ORDER BY ${names.column(Named, "id")}`,
				[]
			)
			for (const row of stored) {
				const [t, n, g, f, cl] = Arr.map(row, String)
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
			}
			return { problems, reached }
		})

	it.effect(
		"an installed translation, case fold and generated selected key admit exactly the host model's rows",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							suite: "pg/compute/translate-installed",
							draw: drawn(rowGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the host model of the keys and the host's translation"
							},
							coverage: required<InstalledFeature>(
								[
									"a title normalized",
									"a title collapsed",
									"a tag folded",
									"a tag refused by its folded key",
									"a selected row refused by its generated key",
									"an unselected row admitted beside its twin"
								],
								{ cases: 30, sense: notesOnly }
							),
							kept: [],
							runs: 30,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnRows, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const rows = Arr.map(drawnRows, (r, id) => ({ ...r, id }))
									const installation = yield* installationOf
									const pinned = yield* substrate.admin.pin
									const { problems, reached } = yield* inInstallation(
										pinned,
										installationSql(installation),
										judge(pinned, installation, rows)
									)
									c.noteAll(reached)
									assert.deepEqual(problems, [])
								})
							)
					)
				})
			)
	)
})
