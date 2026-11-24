/** What the property of placed-keys.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { foundQueryOf, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

/**
 * A package's documents, by path, of a kind; an instance of an assembly, by its start, placing a document; an element of
 * a document, by its start, of a kind; a reference an element makes to a document; an attribute of an element, the base
 * it spells; and a placed element, its base under a placement. Every relation is keyed by its package first, the unit,
 * and immutable, so a rule over them is judged whole over the packages a transaction wrote.
 */
const Doc = relation("Doc", { pkg: pg.integer, path: pg.integer, kind: pg.integer }, [
	"pkg",
	"path"
])
const Inst = relation(
	"Inst",
	{ pkg: pg.integer, assembly: pg.integer, start: pg.integer, document: pg.integer },
	["pkg", "assembly", "start"]
)
const Elem = relation(
	"Elem",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, kind: pg.integer },
	["pkg", "path", "start"]
)
const Ref = relation(
	"Ref",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, target: pg.integer },
	["pkg", "path", "start"]
)
const Attr = relation(
	"Attr",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, base: pg.integer },
	["pkg", "path", "start"]
)
const Placed = relation(
	"Placed",
	{
		pkg: pg.integer,
		assembly: pg.integer,
		place: pg.integer,
		path: pg.integer,
		start: pg.integer,
		base: pg.integer
	},
	["pkg", "assembly", "place", "path", "start"]
)
const Stored = schema(
	"PlacedKeys",
	[Doc, Inst, Elem, Ref, Attr, Placed],
	[unit("Package", { pkg: pg.integer })]
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

/** Each spelled attribute under each placement of its document. */
const Typed = derived(
	"Typed",
	query(Stored).rule((r) => {
		const { assembly, place, pkg, path } = v(placements, "placement")
		const { base, start } = v(spelled, "typed")
		return r
			.match(placements, { assembly, place, pkg, path })
			.match(spelled, { base, pkg, path, start })
			.find({ assembly, base, place, pkg, path, start })
	})
)

/** The schema: every typed attribute placed, a containment of a join of unions into a stored relation. */
const PlacedKeys = schema.extend(
	[Stored],
	"PlacedKeys_1",
	[Typed],
	[
		contained(
			on(Typed, "pkg", "assembly", "place", "path", "start", "base"),
			on(Placed, "pkg", "assembly", "place", "path", "start", "base")
		)
	]
)

/** The schema installed by its first migration, which runs the rule's check over every row, with no login. */
export const placedKeysTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "placed keys",
	content: { schema: PlacedKeys.name, logins: [] },
	versions: [{ schema: PlacedKeys, logins: [], declarations: noDeclarations }],
	options: {
		label: "placed_keys",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A case: the rows one transaction writes, each table's of the two packages' small places. */
export interface PlacedCase {
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
 * A drawn state of two packages, three documents each: some documents, of kind 1 or 2; some instances, each of an
 * assembly path placing a document at a start; some elements, of kind 0 or 9; some references, each to a document
 * path; some attributes, spelling base 1 or 2; and some placed rows, each an element's under a placement, its base
 * 0, 1 or 2.
 */
export const placedCaseGen: Gen<PlacedCase> = (s) => ({
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

export type PlacedFeature = "refused by the judge" | "accepted by the judge"

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
 * judged. The containment's violation query lowered by the oracle baseline finds the state broken or not; the rule's
 * check over every row, the one the migration that installs it runs, which reads the placements at the keys the
 * spelled attributes bind and each placement's arms at them inside their steps, must find a row exactly then, and the
 * judge (SET CONSTRAINTS ALL IMMEDIATE) must refuse exactly then, under an integrity SQLSTATE.
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
		const [baseline, ...more] = baselineRuleChecks(installation)
		assert.ok(
			baseline !== undefined && more.length === 0,
			"the schema states one rule, the containment"
		)
		const broken =
			(yield* connection.queryValues(
				`SELECT EXISTS (${printStatement(baseline.query)})`,
				[]
			))[0]?.[0] === true
		for (const check of lawChecks(installation).rules) {
			const found = (yield* connection.queryValues(foundQueryOf(check.query), []))[0]?.[0] === true
			assert.equal(
				found,
				broken,
				`${Formatter.format(drawn)}: the check over every row agrees with the violation query`
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
	})
