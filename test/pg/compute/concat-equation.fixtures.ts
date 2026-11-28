/**
 * What the properties of concat-equation.test.ts read: the SQL of a drawn equation run on PostgreSQL over its rows, and
 * pantry's reference split in small, its schema, template, space and each case's run.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Text } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { lawIdOf, namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import {
	type EquationCase,
	type EquationFeature,
	type EquationRow,
	equationDesc,
	hostValueOf,
	loweredAt,
	meaningOf,
	partColumn,
	readsNull,
	referenceValueOf,
	rowFeatures,
	shapeFeatures,
	type TermCase,
	type TermFeature,
	termFeatures,
	termHostValueOf,
	termLoweredAt,
	termMeaningOf,
	termRowFeatures
} from "#test/support/unit/compute/concat-equation.fixtures.ts"
import { plainRender, renderSql } from "#test/support/unit/compute/support.ts"

/** PostgreSQL's text of a truth value, NULL as null. */
const printed = (value: boolean | null): string | null =>
	value === null ? null : value ? "true" : "false"

/** A row's columns that hold a value, as JSON: a NULL one is left out, which jsonb_to_recordset reads as NULL. */
const presentColumns = (row: EquationRow): Readonly<Record<string, string>> =>
	Rec.fromEntries(
		Arr.flatMap(
			[["t", row.t] as const, ...Arr.map(row.parts, (p, i) => [partColumn(i), p] as const)],
			([name, value]) => (value === null ? [] : [[name, value] as const])
		)
	)

/** The most parts a drawn equation has, so the most part columns a row holds. */
const mostParts = 5

/**
 * One case on PostgreSQL, over its transaction's session `db`: the equation lowered at both sites, a query's and a
 * check's, each over every row in one statement, `jsonb_to_recordset` the rows; at each, PostgreSQL's value is the
 * host's and the plain meaning, NULL included, and the reference evaluator's where no operand is NULL.
 */
export const runEquation = (db: CaseSession, c: EquationCase, k: Case<EquationFeature>) =>
	Effect.gen(function* () {
		const label = Formatter.format({
			parts: c.parts,
			shape: c.shape,
			whole: c.whole,
			mirrored: c.mirrored,
			ne: c.ne
		})
		const lowered = Arr.map(["query", "check"] as const, (mode) => ({
			mode,
			root: succeeded(loweredAt(mode, c, equationDesc(c)), `${mode} lowers it: ${label}`).root.expr
		}))
		const columns = Arr.join(
			Array.from({ length: mostParts }, (_, i) => `${partColumn(i)} text`),
			", "
		)
		const rows = yield* db.values(
			`SELECT ${Arr.join(
				Arr.map(lowered, (l) => `(${renderSql(l.root, plainRender)})::text`),
				", "
			)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, t text, ${columns}) ORDER BY r0.ord`,
			[jsonText(Arr.map(c.rows, (row, ord) => ({ ord, ...presentColumns(row) })))]
		)
		assert.equal(rows.length, c.rows.length, "a row per input")
		for (const [i, values] of rows.entries()) {
			const row = defined(c.rows[i], "the row PostgreSQL read")
			const meaning = meaningOf(c, row)
			const where = `${Formatter.format(row)}: ${label}`
			for (const [j, { mode, root }] of lowered.entries()) {
				assert.equal(
					values[j],
					printed(meaning),
					`${mode}: PostgreSQL's is the meaning over ${where}`
				)
				assert.equal(
					hostValueOf(c, root, row),
					meaning,
					`${mode}: the host's is the meaning over ${where}`
				)
				if (!readsNull(c, row)) {
					assert.equal<unknown>(
						referenceValueOf(c, root, row),
						meaning,
						`${mode}: the reference evaluator's is the meaning over ${where}`
					)
				}
			}
			for (const feature of rowFeatures(c, row)) {
				k.note(feature)
			}
		}
		for (const feature of shapeFeatures(c)) {
			k.note(feature)
		}
	})

/**
 * One term case on PostgreSQL, over its transaction's session `db`: the concatenation lowered at both sites, a query's
 * and a check's, each over every row in one statement, `jsonb_to_recordset` the rows; at each, PostgreSQL's text is the
 * parts' texts joined in order, NULL at a NULL operand, as the host evaluates it.
 */
export const runTerm = (db: CaseSession, c: TermCase, k: Case<TermFeature>) =>
	Effect.gen(function* () {
		const label = Formatter.format({ parts: c.parts, shape: c.shape })
		const lowered = Arr.map(["query", "check"] as const, (mode) => ({
			mode,
			root: succeeded(termLoweredAt(mode, c), `${mode} lowers it: ${label}`).root.expr
		}))
		const columns = Arr.join(
			Array.from({ length: mostParts }, (_, i) => `${partColumn(i)} text`),
			", "
		)
		const rows = yield* db.values(
			`SELECT ${Arr.join(
				Arr.map(lowered, (l) => `(${renderSql(l.root, plainRender)})::text`),
				", "
			)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, ${columns}) ORDER BY r0.ord`,
			[
				jsonText(
					Arr.map(c.rows, (row, ord) => ({
						ord,
						...Rec.fromEntries(
							Arr.flatMap(row, (value, i) =>
								value === null ? [] : [[partColumn(i), value] as const]
							)
						)
					}))
				)
			]
		)
		assert.equal(rows.length, c.rows.length, "a row per input")
		for (const [i, values] of rows.entries()) {
			const row = defined(c.rows[i], "the row PostgreSQL read")
			const meaning = termMeaningOf(row)
			const where = `${Formatter.format(row)}: ${label}`
			for (const [j, { mode, root }] of lowered.entries()) {
				assert.equal(
					values[j],
					meaning,
					`${mode}: PostgreSQL's is the parts in order over ${where}`
				)
				assert.equal(
					termHostValueOf(root, row),
					meaning,
					`${mode}: the host's is the parts in order over ${where}`
				)
			}
			for (const feature of termRowFeatures(row)) {
				k.note(feature)
			}
		}
		for (const feature of termFeatures(c)) {
			k.note(feature)
		}
	})

/**
 * pantry's reference split in small: each element's attributes, keyed by the element and the attribute's name, their
 * lexical forms, and each reference an attribute holds, split into its lead, target, params and trail. Spelled is the
 * join of each reference with its attribute's lexical form, a derived relation no table stores, and "Reference split"
 * holds that the lexical form is the four in order, `lexical = lead || target || params || trail`, a check over the
 * join, which the rule judge decides in its query; Inline states the split of one row of its own, a row check, which
 * PostgreSQL decides as a CHECK. Neither builds the concatenation. Joined builds it, the four joined in its head beside
 * the lexical form, and "Joined split" holds that the two are one text. Every relation is immutable and keyed by its
 * package first, so the rule is unit-local, judged whole over the packages a transaction wrote.
 */
const Short = str.bytes(64, str.regex("^.*$", "su"))

const Attribute = relation(
	"Attribute",
	{ package: Short, element: int4, name: Short, lexical: Short },
	["package", "element", "name"]
)
const Reference = relation(
	"Reference",
	{
		package: Short,
		element: int4,
		name: Short,
		lead: Short,
		target: Short,
		params: Short,
		trail: Short
	},
	["package", "element", "name"]
)
const Inline = relation(
	"Inline",
	{
		package: Short,
		element: int4,
		lexical: Short,
		lead: Short,
		target: Short,
		params: Short,
		trail: Short
	},
	["package", "element"]
)

const Base = schema("concat_split", [Attribute, Reference, Inline], [])

/** Each reference beside its attribute's lexical form. */
const Spelled = derived(
	"Spelled",
	query(Base).rule((r) => {
		const { package: pkg, element, name, lead, target, params, trail } = v(Reference, "r")
		const { lexical } = v(Attribute, "a")
		return r
			.match(Reference, { package: pkg, element, name, lead, target, params, trail })
			.match(Attribute, { package: pkg, element, name, lexical })
			.find({ package: pkg, element, name, lead, target, params, trail, lexical })
	})
)

const referenceSplit = check("Reference_split", Spelled, (s) =>
	s.eq(s.lexical, Text.concat(Text.concat(Text.concat(s.lead, s.target), s.params), s.trail))
)

/**
 * Each reference's four parts joined in order in the head of a derived relation, beside its attribute's lexical form: a
 * concatenation a query holds, its parts' types bounding its bytes, so the judge's query builds it, text within their
 * bounds summed.
 */
const Joined = derived(
	"Joined",
	query(Base).rule((r) => {
		const { package: pkg, element, name, lead, target, params, trail } = v(Reference, "r")
		const { lexical } = v(Attribute, "a")
		return r
			.match(Reference, { package: pkg, element, name, lead, target, params, trail })
			.match(Attribute, { package: pkg, element, name, lexical })
			.find({
				package: pkg,
				element,
				name,
				lexical,
				joined: Text.concat(Text.concat(Text.concat(lead, target), params), trail)
			})
	})
)

const joinedSplit = check("Joined_split", Joined, (j) => j.eq(j.lexical, j.joined))

const inlineSplit = check("Inline_split", Inline, (s) =>
	s.eq(s.lexical, Text.concat(s.lead, Text.concat(s.target, Text.concat(s.params, s.trail))))
)

const splitSchema = schema.extend(
	[Base],
	"concat_split_1",
	[Spelled, Joined],
	[referenceSplit, joinedSplit, inlineSplit]
)

export const splitTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "concat split",
	content: { schema: splitSchema.name, logins: [] },
	versions: [{ schema: splitSchema, declarations: noDeclarations }],
	options: {
		label: "concat_split",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The characters a reference's texts are drawn of: one byte, two, and four, a pair of UTF-16 code units. */
const characters = ["a", "/", "é", "😀"] as const

/** A text of `min` to `max` characters. */
const textGen =
	(min: number, max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min, max })), "")

/** A reference split into its four parts, and the lexical form its attribute holds. */
export interface DrawnReference {
	readonly lead: string
	readonly target: string
	readonly params: string
	readonly trail: string
	readonly lexical: string
}

/**
 * A reference: its parts, each of up to three characters, the empty text among them, and a lexical form most often the
 * four in order, else the four with the target or the params replaced by another text of its length, so the lengths
 * hold, else any text.
 */
const referenceGen: Gen<DrawnReference> = (s) => {
	const lead = s.draw(textGen(0, 2))
	const target = s.draw(textGen(0, 3))
	const params = s.draw(textGen(0, 2))
	const trail = s.draw(textGen(0, 2))
	const middle = (): string => {
		const replaceTarget = s.draw(boolean)
		const was = replaceTarget ? target : params
		const other = s.draw(textGen(Array.from(was).length, Array.from(was).length))
		return replaceTarget ? `${lead}${other}${params}${trail}` : `${lead}${target}${other}${trail}`
	}
	const lexical = s.draw(
		weighted<string>([
			[5, () => `${lead}${target}${params}${trail}`],
			[3, middle],
			[1, textGen(0, 6)]
		])
	)
	return { lead, target, params, trail, lexical }
}

/** What one transaction writes: a package's references, each beside its attribute, and its inline references. */
export interface Written {
	readonly references: ReadonlyArray<DrawnReference>
	readonly inline: ReadonlyArray<DrawnReference>
}

export const writtenGen: Gen<Written> = (s) => ({
	references: s.draw(array(referenceGen, { min: 1, max: 4 })),
	inline: s.draw(array(referenceGen, { min: 0, max: 3 }))
})

export type SplitFeature =
	| "accepted"
	| "refused by a split over the join"
	| "refused by Inline split"
	| "the lengths hold and a middle part differs"
	| "a part of multibyte characters"
	| "an empty part"

/** Whether a reference's lexical form is its four parts in order. */
const split = (r: DrawnReference): boolean =>
	r.lexical === `${r.lead}${r.target}${r.params}${r.trail}`

/** The situations a reference reaches. */
const referenceFeatures = (r: DrawnReference): ReadonlyArray<SplitFeature> => {
	const parts = [r.lead, r.target, r.params, r.trail]
	const length = Arr.reduce(parts, 0, (n, p) => n + Array.from(p).length)
	return [
		...(!split(r) && Array.from(r.lexical).length === length
			? ["the lengths hold and a middle part differs" as const]
			: []),
		...(Arr.some(parts, (p) => Array.from(p).length < new TextEncoder().encode(p).length)
			? ["a part of multibyte characters" as const]
			: []),
		...(Arr.some(parts, (p) => p === "") ? ["an empty part" as const] : [])
	]
}

/** A disagreement between PostgreSQL and the meaning, naming the case. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A text as an SQL literal: each quote doubled. */
const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/** Every law a refusal names, by the constraint and table PostgreSQL reports: one of the schema's tables'. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["Attribute", "Reference", "Inline"],
		(r) => installation.names.relation(r).name === table
	)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			) ?? [])
}

/**
 * One case in its one transaction, which the case's end rolls back: each inline reference inserted alone, which
 * PostgreSQL's CHECK refuses exactly where its lexical form is not its four parts in order, naming Inline split, the
 * transaction rolled back to the savepoint the substrate sets under every statement of a case (substrate.ts
 * undoneAlone), so a refused insert leaves it as it was: a savepoint the case set itself would be released with that
 * one, and a rollback to it fail (3B001);
 * then the package's attributes and references, and the judge (SET CONSTRAINTS ALL IMMEDIATE), which refuses exactly
 * where a reference's attribute's lexical form is not its four parts in order, naming Reference split.
 */
export const runWritten = (
	installed: Installed,
	connection: PgConnection,
	written: Written,
	c: Case<SplitFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const attribute = names.table(Attribute)
		const reference = names.table(Reference)
		const inline = names.table(Inline)
		const a = (f: "package" | "element" | "name" | "lexical") => names.column(Attribute, f)
		const r = (f: "package" | "element" | "name" | "lead" | "target" | "params" | "trail") =>
			names.column(Reference, f)
		const i = (f: "package" | "element" | "lexical" | "lead" | "target" | "params" | "trail") =>
			names.column(Inline, f)
		const referenceLaws = [lawIdOf(splitSchema, referenceSplit), lawIdOf(splitSchema, joinedSplit)]
		const inlineLaw = lawIdOf(splitSchema, inlineSplit)
		const where = Formatter.format(written)
		for (const drawn of [...written.references, ...written.inline]) {
			for (const feature of referenceFeatures(drawn)) {
				c.note(feature)
			}
		}
		yield* standUpJudge(connection, installed.installation)
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
		for (const [element, drawn] of written.inline.entries()) {
			const refused = yield* refusalOf(
				connection.query(
					`INSERT INTO ${inline} (${i("package")}, ${i("element")}, ${i("lexical")}, ${i("lead")}, ${i("target")}, ${i("params")}, ${i("trail")}) VALUES ('p', ${element}, ${literal(drawn.lexical)}, ${literal(drawn.lead)}, ${literal(drawn.target)}, ${literal(drawn.params)}, ${literal(drawn.trail)})`,
					[]
				)
			)
			if (Option.isNone(refused)) {
				if (!split(drawn)) {
					return yield* new Disagreed({
						message: `the CHECK accepted an inline reference whose lexical form is not its parts in order: ${Formatter.format(drawn)}`
					})
				}
				continue
			}
			if (
				split(drawn) ||
				!Arr.contains(refusedLaws(installed.installation, refused.value), inlineLaw)
			) {
				return yield* new Disagreed({
					message: `the CHECK refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} an inline reference ${split(drawn) ? "split as its lexical form is" : "naming another law"}: ${Formatter.format(drawn)}`
				})
			}
			c.note("refused by Inline split")
		}
		for (const [element, drawn] of written.references.entries()) {
			yield* connection.query(
				`INSERT INTO ${attribute} (${a("package")}, ${a("element")}, ${a("name")}, ${a("lexical")}) VALUES ('p', ${element}, 'href', ${literal(drawn.lexical)})`,
				[]
			)
			yield* connection.query(
				`INSERT INTO ${reference} (${r("package")}, ${r("element")}, ${r("name")}, ${r("lead")}, ${r("target")}, ${r("params")}, ${r("trail")}) VALUES ('p', ${element}, 'href', ${literal(drawn.lead)}, ${literal(drawn.target)}, ${literal(drawn.params)}, ${literal(drawn.trail)})`,
				[]
			)
		}
		const broken = Arr.some(written.references, (d) => !split(d))
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken) {
				return yield* new Disagreed({
					message: `the judge accepted a reference whose lexical form is not its parts in order: ${where}`
				})
			}
			c.note("accepted")
			return
		}
		if (
			!broken ||
			!Arr.some(refusedLaws(installed.installation, refused.value), (law) =>
				Arr.contains(referenceLaws, law)
			)
		) {
			return yield* new Disagreed({
				message: `the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where ${broken ? "it names another law" : "every reference is split as its lexical form is"}: ${where}`
			})
		}
		c.note("refused by a split over the join")
	})
