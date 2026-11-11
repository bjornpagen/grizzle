/**
 * Compute.translate and Compute.lowerAscii on PostgreSQL 19, against the host.
 *
 * 1. The SQL a check holds for a drawn map, `translate(v, from, to)`, for lowerAscii, for collapse and for
 *    replaceWhitespace, over a batch of texts that mix ASCII, Latin-1, BMP and supplementary code points in one round
 *    trip: PostgreSQL's answer must be the reference evaluator's character by character, lowerAscii's must leave every
 *    character but A to Z as it was, and collapse's, its chain of replace calls, must be XML Schema's (core/text.ts
 *    collapsed) over runs of each of the four white space characters, of three or more among them, at either end and
 *    beside supplementary code points.
 * 2. An installed relation whose generated fields translate a title into xs:normalizedString's value space, fold a
 *    tag's ASCII case and collapse a title's white space, each cast into its declared text type by the inclusion of the
 *    image, and a second relation whose generated field casts a numeral to a bigint: the installer's own DDL, each
 *    drawn row inserted. Every row is admitted, and its generated fields hold the host's values. No key holds a
 *    generated field (README, "How a field is written": no fact carries its value, so such a schema is refused when
 *    it compiles), so neither relation keys one.
 *
 * Planted bug: collapse's SQL without its step that turns each tab before a space into two tabs
 * (lower/conservative/expr/ops.ts collapseText), so a run of three or more white space characters keeps more than one
 * space.
 *
 * Oracle: the reference evaluator character by character, and XML Schema's collapse (core/text.ts collapsed).
 *
 * Plants: compute-translate-collapse-tab-step (the planted bug above, as a patch).
 *
 * Features: each map and white space situation the searches name.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { codePoints, codePointsText, collapsed, translated } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
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
import { computeCore } from "#compiler/scalar/compute/builders.ts"
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

const textColumn: LeafBinding = { kind: "column", type: testPg.text.scalar }

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })
const text = (value: string): ExprDesc => ({ kind: "literal", value })

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
	| "a run of three or more folded"
	| "a tab in a run"
	| "an LF in a run"
	| "a CR in a run"
	| "a space in a run"
	| "a supplementary character beside white space"

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

/** The note of each white space character other than the space, met in a run. */
const runNotes: ReadonlyMap<number, SqlFeature> = new Map<number, SqlFeature>([
	[0x09, "a tab in a run"],
	[0x0a, "an LF in a run"],
	[0x0d, "a CR in a run"]
])

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
								"white space trimmed at an end",
								"a run of three or more folded",
								"a tab in a run",
								"an LF in a run",
								"a CR in a run",
								"a space in a run",
								"a supplementary character beside white space"
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
								for (const [i, cp] of points.entries()) {
									const before = isXmlSpace(points[i - 1] ?? 0)
									const after = isXmlSpace(points[i + 1] ?? 0)
									if (isXmlSpace(cp) && (before || after)) {
										k.note(runNotes.get(cp) ?? "a space in a run")
									}
									if (isXmlSpace(cp) && before && after) {
										k.note("a run of three or more folded")
									}
									if (cp > 0xffff && (before || after)) {
										k.note("a supplementary character beside white space")
									}
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
		| "a numeral's leading zeros dropped"

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
	const value = schema("Translated", { Named, Counted }, [])

	const installationOf = Effect.gen(function* () {
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

	const judge = (pinned: PgConnection, installation: Installation, rows: ReadonlyArray<Row>) =>
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
		"an installed translation, case fold, collapse and numeral cast store exactly the host's values",
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
								name: "the host's translation, case fold, collapse and numeral cast"
							},
							coverage: required<InstalledFeature>(
								[
									"a title normalized",
									"a title collapsed",
									"a tag folded",
									"a numeral's leading zeros dropped"
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
