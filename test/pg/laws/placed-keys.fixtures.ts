/** What the property of placed-keys.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	baselineRuleChecks,
	definedRuleChecks,
	lawChecks
} from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, unit } from "#compiler/public/schema.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { foundQueryOf, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

/**
 * A package's documents, by path, of a kind; an instance of an assembly, by its start, placing a document; an element
 * of a document, by its start, of a kind; a reference an element makes to a document; an attribute of an element, the
 * base it spells; and a placed element, its base under a placement. Every relation is keyed by its package first.
 */
const Doc = relation("Doc", { pkg: int4, path: int4, kind: int4 }, ["pkg", "path"])
const Inst = relation("Inst", { pkg: int4, assembly: int4, start: int4, document: int4 }, [
	"pkg",
	"assembly",
	"start"
])
const Elem = relation("Elem", { pkg: int4, path: int4, start: int4, kind: int4 }, [
	"pkg",
	"path",
	"start"
])
const Ref = relation("Ref", { pkg: int4, path: int4, start: int4, target: int4 }, [
	"pkg",
	"path",
	"start"
])
const Attr = relation("Attr", { pkg: int4, path: int4, start: int4, base: int4 }, [
	"pkg",
	"path",
	"start"
])
const Placed = relation(
	"Placed",
	{
		pkg: int4,
		assembly: int4,
		place: int4,
		path: int4,
		start: int4,
		base: int4
	},
	["pkg", "assembly", "place", "path", "start"]
)

/**
 * Where the content sits: in its unit, Package, every relation keyed by its package first and immutable, so a rule over
 * them is judged whole over the packages a transaction wrote, and every closed import Typed's definition reads whose
 * upkeep a write bounds is a stored canonical relation (analysis/derived/storage.ts), its table read in the import's
 * place (ir/derived.ts servedDag): the spelled attributes, the standalone documents and an item's own placements; or in
 * no unit, so no borrow covers a write of its rows and every import is computed where it is read, the check reading the
 * placements at the keys the spelled attributes bind and each arm's steps at them.
 */
export type Content = "in its unit" | "in no unit"

const contents: readonly [Content, ...Array<Content>] = ["in its unit", "in no unit"]

/** The schema of `content`: every typed attribute placed, a containment of a join of unions into a stored relation. */
const placedSchema = (content: Content) => {
	const name = content === "in its unit" ? "PlacedKeys" : "LoosePlacedKeys"
	const Stored = schema(
		name,
		[Doc, Inst, Elem, Ref, Attr, Placed],
		content === "in its unit" ? [unit("Package", { pkg: int4 })] : []
	)

	/** Each attribute's base, of two spellings: the attributes the placements are read at. */
	const spelled = query(Stored)
		.rule((r) => {
			const { pkg, path, start, base } = v(Attr, "one")
			return r
				.match(Attr, { pkg, path, start, base })
				.where(r.eq(base, 1))
				.find({ pkg, path, start, base })
		})
		.rule((r) => {
			const { pkg, path, start, base } = v(Attr, "two")
			return r
				.match(Attr, { pkg, path, start, base })
				.where(r.eq(base, 2))
				.find({ pkg, path, start, base: 0 })
		})

	/** A document of kind 1 placed under its own path, in no assembly. */
	const standalone = query(Stored).rule((r) => {
		const { pkg, path } = v(Doc, "doc")
		return r.match(Doc, { pkg, path, kind: 1 }).find({ place: 0, pkg, path })
	})

	/** An item's own placements: an assembly's root instance, or a standalone document. */
	const own = query(Stored)
		.rule((r) => {
			const { pkg, assembly: path, start } = v(Inst, "root")
			return r
				.match(Inst, { pkg, assembly: path, start, document: path })
				.find({ place: start, pkg, path })
		})
		.rule((r) => {
			const { place, pkg, path } = v(standalone, "standalone")
			return r.match(standalone, { place, pkg, path }).find({ place, pkg, path })
		})

	/**
	 * The template an item locates: the document an element of kind 9 references, through the reference relation, each
	 * match a step of its navigation; or a document of kind 2 with no element at start 0, its own.
	 */
	const located = query(Stored)
		.rule((r) => {
			const { pkg, path, start, target } = v(Ref, "reference")
			const { kind } = v(Elem, "locator")
			const { kind: targetKind } = v(Doc, "template")
			return r
				.match(Elem, { pkg, path, start, kind })
				.match(Ref, { pkg, path, start, target })
				.match(Doc, { pkg, path: target, kind: targetKind })
				.where(r.eq(kind, 9))
				.find({ pkg, path, template: target })
		})
		.rule((r) => {
			const { pkg, path, kind } = v(Doc, "bare")
			return r
				.match(Doc, { pkg, path, kind })
				.where(r.eq(kind, 2))
				.where(r.not(Elem, { pkg, path, start: 0 }))
				.find({ pkg, path, template: path })
		})

	/**
	 * Each document each placement places: an instance's document, a standalone document under itself, and the template
	 * an item's own placement locates, under the item.
	 */
	const placements = query(Stored)
		.rule((r) => {
			const { pkg, assembly, start: place, document: path } = v(Inst, "instance")
			return r
				.match(Inst, { pkg, assembly, start: place, document: path })
				.find({ assembly, place, pkg, path })
		})
		.rule((r) => {
			const { place, pkg, path } = v(standalone, "standalone")
			return r.match(standalone, { place, pkg, path }).find({ assembly: path, place, pkg, path })
		})
		.rule((r) => {
			const { place, pkg, path: item } = v(own, "item")
			const { template: path } = v(located, "located")
			return r
				.match(own, { place, pkg, path: item })
				.match(located, { pkg, path: item, template: path })
				.find({ assembly: item, place, pkg, path })
		})

	/**
	 * Each spelled attribute under each placement of its document; and each located template under its locator, at place
	 * 1, its start 0 and base 0: a read of the located templates whole, beside the placements' read of them at an item's
	 * keys, so a restriction made inside the placements and read past its scope would read the item's key here, where no
	 * row of an item stands.
	 */
	const Typed = derived(
		"Typed",
		query(Stored)
			.rule((r) => {
				const { assembly, place, pkg, path } = v(placements, "placement")
				const { base, start } = v(spelled, "typed")
				return r
					.match(placements, { assembly, place, pkg, path })
					.match(spelled, { base, pkg, path, start })
					.find({ assembly, base, place, pkg, path, start })
			})
			.rule((r) => {
				const { pkg, path: assembly, template: path } = v(located, "template")
				return r
					.match(located, { pkg, path: assembly, template: path })
					.find({ assembly, base: 0, place: 1, pkg, path, start: 0 })
			})
	)

	return schema.extend(
		[Stored],
		`${name}_1`,
		[Typed],
		[
			contained(
				on(Typed, "pkg", "assembly", "place", "path", "start", "base"),
				on(Placed, "pkg", "assembly", "place", "path", "start", "base")
			)
		]
	)
}

/** The schema of `content` installed by its first migration, which runs the rule's check over every row, no login. */
const placedTemplate = (content: Content) => {
	const value = placedSchema(content)
	return migratedTemplate({
		declaredIn: import.meta,
		name: `placed keys ${content}`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, declarations: noDeclarations }],
		options: {
			label: content === "in its unit" ? "placed_keys" : "loose_placed_keys",
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/** Each content's template. */
export const placedKeysTemplates = {
	"in its unit": placedTemplate("in its unit"),
	"in no unit": placedTemplate("in no unit")
} as const satisfies Record<Content, ReturnType<typeof placedTemplate>>

/** A case: where its content sits, and the rows one transaction writes, each table's of two packages' small places. */
export interface PlacedCase {
	readonly content: Content
	readonly docs: ReadonlyArray<{
		readonly pkg: number
		readonly path: number
		readonly kind: number
	}>
	readonly insts: ReadonlyArray<{
		readonly pkg: number
		readonly assembly: number
		readonly start: number
		readonly document: number
	}>
	readonly elems: ReadonlyArray<{
		readonly pkg: number
		readonly path: number
		readonly start: number
		readonly kind: number
	}>
	readonly refs: ReadonlyArray<{
		readonly pkg: number
		readonly path: number
		readonly start: number
		readonly target: number
	}>
	readonly attrs: ReadonlyArray<{
		readonly pkg: number
		readonly path: number
		readonly start: number
		readonly base: number
	}>
	readonly placed: ReadonlyArray<{
		readonly pkg: number
		readonly assembly: number
		readonly place: number
		readonly path: number
		readonly start: number
		readonly base: number
	}>
}

const packages = [1, 2] as const
const paths = [1, 2, 3] as const
const starts = [0, 1] as const
const places = Arr.flatMap(packages, (pkg) => Arr.map(paths, (path) => ({ pkg, path })))
const elementPlaces = Arr.flatMap(places, (p) => Arr.map(starts, (start) => ({ ...p, start })))

/**
 * A drawn schema, its content in its unit or in none, and a drawn state of two packages, three documents each: some
 * documents, of kind 1 or 2; some instances, each of an assembly path placing a document at a start; some elements,
 * of kind 0 or 9; some references, each to a document path; some attributes, spelling base 1 or 2; and some placed
 * rows, each an element's under a placement, its base 0, 1 or 2.
 */
export const placedCaseGen: Gen<PlacedCase> = (s) => ({
	content: s.draw(element(contents)),
	docs: Arr.map(s.draw(subset(places, { min: 0, max: 6 })), (p) => ({
		...p,
		kind: s.draw(element([1, 2] as const))
	})),
	insts: Arr.map(s.draw(subset(places, { min: 0, max: 3 })), (p) => ({
		pkg: p.pkg,
		assembly: p.path,
		start: s.draw(element(starts)),
		document: s.draw(element(paths))
	})),
	elems: Arr.map(s.draw(subset(elementPlaces, { min: 0, max: 6 })), (p) => ({
		...p,
		kind: s.draw(element([0, 9] as const))
	})),
	refs: Arr.map(s.draw(subset(elementPlaces, { min: 0, max: 4 })), (p) => ({
		...p,
		target: s.draw(element(paths))
	})),
	attrs: Arr.map(s.draw(subset(elementPlaces, { min: 0, max: 6 })), (p) => ({
		...p,
		base: s.draw(element([1, 2] as const))
	})),
	placed: Arr.map(s.draw(subset(elementPlaces, { min: 0, max: 6 })), (p) => ({
		...p,
		assembly: s.draw(element(paths)),
		place: s.draw(element(starts)),
		base: s.draw(element([0, 1, 2] as const))
	}))
})

export type PlacedFeature = "refused by the judge" | "accepted by the judge" | Content

/** The INSERT of `rows` into `table`'s columns `fields`, none where there are none. */
const insertOf = <F extends string>(
	installed: Installed,
	table: Parameters<ReturnType<typeof namesOf>["table"]>[0],
	fields: ReadonlyArray<F>,
	rows: ReadonlyArray<Readonly<Record<F, number>>>
): ReadonlyArray<string> => {
	if (!Arr.isReadonlyArrayNonEmpty(rows)) {
		return []
	}
	const names = namesOf(installed)
	const columns = Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.columnIdent(table, f))),
		", "
	)
	const values = Arr.join(
		Arr.map(
			rows,
			(row) =>
				`(${Arr.join(
					Arr.map(fields, (f) => String(row[f])),
					", "
				)})`
		),
		", "
	)
	return [`INSERT INTO ${names.table(table)} (${columns}) VALUES ${values}`]
}

/** The state's rows, each table's INSERT. */
const written = (installed: Installed, drawn: PlacedCase): ReadonlyArray<string> => [
	...insertOf(installed, Doc, ["pkg", "path", "kind"], drawn.docs),
	...insertOf(installed, Inst, ["pkg", "assembly", "start", "document"], drawn.insts),
	...insertOf(installed, Elem, ["pkg", "path", "start", "kind"], drawn.elems),
	...insertOf(installed, Ref, ["pkg", "path", "start", "target"], drawn.refs),
	...insertOf(installed, Attr, ["pkg", "path", "start", "base"], drawn.attrs),
	...insertOf(
		installed,
		Placed,
		["pkg", "assembly", "place", "path", "start", "base"],
		drawn.placed
	)
]

/**
 * One case in its one transaction, which the case's end rolls back: the drawn state written through the captures, then
 * judged. The containment's violation query lowered by the oracle baseline, every derived relation it reads read
 * through its definition (deploy/snapshot/violation.ts definedRuleChecks), finds the state broken or not, the state the
 * judge judges once its upkeep made each stored relation's table current, and the judge (SET CONSTRAINTS ALL IMMEDIATE)
 * must refuse exactly then, under an integrity SQLSTATE. The rule's check over every row, the one the migration that
 * installs it runs over tables its fill made current, reads each stored relation's table as the last COMMIT left it,
 * the canonical relations of Typed's imports a stored one among them, so it must find a row exactly where the violation
 * query as installed (baselineRuleChecks), which reads the same tables, finds one.
 */
export const runPlaced = (
	installed: Installed,
	connection: PgConnection,
	drawn: PlacedCase,
	c: Case<PlacedFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		for (const sql of written(installed, drawn)) {
			yield* connection.query(sql, [])
		}
		const installation = installed.installation
		const [defined, ...moreDefined] = definedRuleChecks(installation)
		const [baseline, ...more] = baselineRuleChecks(installation)
		assert.ok(
			defined !== undefined &&
				moreDefined.length === 0 &&
				baseline !== undefined &&
				more.length === 0,
			"the schema states one rule, the containment"
		)
		const finds = (statement: Select) =>
			Effect.map(
				connection.queryValues(`SELECT EXISTS (${printStatement(statement)})`, []),
				(found) => found[0]?.[0] === true
			)
		const broken = yield* finds(defined.query)
		const installedBroken = yield* finds(baseline.query)
		for (const check of lawChecks(installation).rules) {
			const found = (yield* connection.queryValues(foundQueryOf(check.query), []))[0]?.[0] === true
			assert.equal(
				found,
				installedBroken,
				`${Formatter.format(drawn)}: the check over every row agrees with the violation query as installed`
			)
		}
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		assert.equal(
			Option.isSome(refused),
			broken,
			`${Formatter.format(drawn)}: the judge ${Option.isSome(refused) ? "refused" : "accepted"} a state the violation query finds ${broken ? "broken" : "lawful"}`
		)
		if (Option.isSome(refused)) {
			assert.ok(
				Arr.contains(["23503", "23505", "23514"], refused.value.code),
				`${Formatter.format(drawn)}: the judge refused under ${refused.value.code}, an integrity SQLSTATE`
			)
		}
		c.note(broken ? "refused by the judge" : "accepted by the judge")
		c.note(drawn.content)
	})
