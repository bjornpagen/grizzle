/**
 * A relation's declared statistics (physical/statistics/declared.ts) rank every statement's access path by how much of
 * a key it binds, as PostgreSQL estimates them: its independence product of each column's selectivity.
 *
 * Property: over drawn relation shapes (two to six columns, rosters among them, a unit of one or two leading columns or
 * none, keys, indexes led by the unit or by a column of their own, the bindings of keys, index prefixes and drawn sets,
 * up to one dependency of a column on another a containment proves, half of them holding a crossed pair of keys and
 * sets apart besides), a declaration gives every column one number of distinct values, its anchors relative and every
 * other column absolute; a column of few values is never relative and holds no more values than its roster's handles;
 * the unit's key's fields after its first of many values, and a roster of one handle, hold exactly one; a declared
 * dependency ties two anchors at 2^m rows, m at least 1 and at most its determinant's exponent; every key holding one
 * anchor, or one pair, binds at most one row; every set an index's equalities stop at short of a binding, holding no
 * key, holds at most one anchor or one pair, and where it holds one binds two rows or more, as PostgreSQL prices a pair
 * under its dependency, beside whatever other columns it holds; every column the schema scopes rows by (the unit's
 * anchor, each key's first column of many values, and each column of many values a dependency proves determines one of
 * those) and, in a relation in no unit, every column of many values leading an index is an anchor, alone or in a pair,
 * but where the sets apart holding it hold two anchors besides, so an equality on it alone is priced at a number of rows
 * the table's size does not move (metis's hold gate, the first kept case, and the last); every other column of many
 * values leading a member's index is absolute, however many it leads, so an equality on it alone is priced at a share
 * of the table, which grows with the units (metis's submit and edullm's commit, the kept cases between); and a relation
 * refused is refused as a crossing of its own keys and sets, a raise grizzle did not settle over them, or for a column
 * asked beyond its values.
 *
 * Oracle: specification, PostgreSQL's estimate over the declared values (declared.fixtures.ts estimate).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { declarationOf } from "#compiler/physical/statistics/declared.ts"
import {
	boundPrefix,
	type DeclaredFeature,
	estimate,
	holdsKey,
	scopeOf,
	shapeGen,
	unitTail
} from "#test/unit/statistics/declared.fixtures.ts"

/** Declared statistics bind one row at a key and two rows or more at every set apart, as PostgreSQL estimates them. */
export const declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem =
	property.explore(shapeGen, {
		needs: {},
		situations: [
			"a unit's member",
			"a relation in no unit",
			"a key bound",
			"a set apart bound",
			"a roster column",
			"a crossing",
			"a column beyond its values",
			"a pair a dependency ties",
			"an index led by a column of many values in no unit",
			"a member's index led by a column no fact binds to its unit",
			"a column determining an anchor"
		] satisfies ReadonlyArray<Reached<DeclaredFeature>>,
		check: (_, c: Case<DeclaredFeature>) => (shape) =>
			Effect.sync(() => {
				c.note(shape.unit.length > 0 ? "a unit's member" : "a relation in no unit")
				if (Arr.some(shape.columns, (col) => col.values.kind === "few")) {
					c.note("a roster column")
				}
				const d = declarationOf(shape)
				switch (d.kind) {
					case "crossing":
						c.note("a crossing")
						for (const b of d.bounds) {
							assert.ok(
								b.kind === "key"
									? Arr.some(shape.keys, (k) => Arr.join(k, ",") === Arr.join(b.columns, ","))
									: !holdsKey(shape, b.columns),
								"a crossing names the shape's own keys and sets apart"
							)
						}
						return
					case "unsettled":
						c.note("an unsettled raise")
						for (const b of d.bounds) {
							assert.ok(
								b.kind === "key"
									? Arr.some(shape.keys, (k) => Arr.join(k, ",") === Arr.join(b.columns, ","))
									: !holdsKey(shape, b.columns),
								"an unsettled raise names the shape's own keys and sets apart"
							)
						}
						return
					case "beyondValues": {
						c.note("a column beyond its values")
						const values = Option.getOrUndefined(
							Arr.findFirst(shape.columns, (col) => col.column === d.column)
						)?.values
						assert.ok(
							values?.kind === "few" && 2 ** d.exponent > values.handles,
							"a column refused beyond its values is a roster's, asked more than its handles"
						)
						return
					}
					case "declared":
						break
				}
				assert.deepEqual(
					Arr.map(d.columns, (col) => col.column),
					Arr.map(shape.columns, (col) => col.column),
					"one declared number of distinct values per column, in column order"
				)
				const declared = new Map(Arr.map(d.columns, (col) => [col.column, col.distinct] as const))
				if (Arr.isReadonlyArrayNonEmpty(d.dependencies)) {
					c.note("a pair a dependency ties")
				}
				for (const dep of d.dependencies) {
					const y = declared.get(dep.determinant)
					assert.ok(
						y?.kind === "relative" &&
							declared.get(dep.dependent)?.kind === "relative" &&
							dep.exponent >= 0 &&
							dep.exponent <= y.exponent - 1,
						`the dependency of ${dep.dependent} on ${dep.determinant} ties two anchors at 2^m rows, m at least 1 and at most its determinant's exponent`
					)
				}
				for (const col of shape.columns) {
					const distinct = declared.get(col.column)
					if (col.values.kind === "few") {
						assert.ok(
							distinct?.kind === "absolute" &&
								2 ** distinct.exponent <= Math.max(1, col.values.handles),
							`${col.column}, of few values, holds at most its roster's handles`
						)
					}
				}
				for (const tail of unitTail(shape)) {
					const distinct = declared.get(tail)
					if (distinct?.kind === "absolute") {
						assert.equal(distinct.exponent, 0, `the unit's later field ${tail} holds one value`)
					}
				}
				for (const key of shape.keys) {
					const e = estimate(declared, d.dependencies, key)
					if (e.kind === "rows") {
						c.note("a key bound")
						assert.ok(e.log2 <= 0, `key (${Arr.join(key, ", ")}) binds at most one row`)
					}
				}
				const unitAnchor = scopeOf(shape, shape.unit)
				/** The columns the schema scopes rows by: the unit's anchor, each key's scope, and each column of many values
				 * a dependency proves determines one of those. */
				const scopes = Arr.getSomes([unitAnchor, ...Arr.map(shape.keys, (k) => scopeOf(shape, k))])
				const determinants = Arr.getSomes(
					Arr.map(shape.determined, (d) =>
						scopes.includes(d.dependent) ? scopeOf(shape, [d.determinant]) : Option.none()
					)
				)
				/** The sets an index's equalities stop at short of a binding, holding no key. */
				const aparts = Arr.flatMap(shape.bindings, (binding) => {
					const bound = new Set(binding.columns)
					return Arr.filterMap(shape.indexes, (index) => {
						const prefix = boundPrefix(index, bound)
						return prefix.length === 0 ||
							(prefix.length === bound.size && Arr.every(prefix, (col) => bound.has(col))) ||
							holdsKey(shape, prefix)
							? Result.failVoid
							: Result.succeed(prefix)
					})
				})
				/** Whether `col` is an anchor, alone or in a pair, as every column the schema scopes rows by is, but where the
				 * sets apart holding it hold two anchors besides, which no one dependency ties to it (anchorsOf). */
				const anchoredOrCrowded = (col: string): boolean =>
					declared.get(col)?.kind === "relative" ||
					new Set(
						Arr.flatMap(aparts, (p) =>
							p.includes(col)
								? Arr.filter(p, (o) => o !== col && declared.get(o)?.kind === "relative")
								: []
						)
					).size >= 2
				for (const d of determinants) {
					c.note("a column determining an anchor")
					assert.ok(
						anchoredOrCrowded(d),
						`${d}, which determines an anchor, is an anchor, alone or in a pair`
					)
				}
				for (const scope of scopes) {
					assert.ok(
						anchoredOrCrowded(scope),
						`${scope}, which scopes rows, is an anchor, alone or in a pair`
					)
				}
				for (const index of shape.indexes) {
					const [lead] = Option.toArray(scopeOf(shape, index.slice(0, 1)))
					if (lead === undefined || scopes.includes(lead) || determinants.includes(lead)) {
						continue
					}
					if (shape.unit.length === 0) {
						c.note("an index led by a column of many values in no unit")
						assert.ok(
							anchoredOrCrowded(lead),
							`${lead}, leading index (${Arr.join(index, ", ")}) of a relation in no unit, is an anchor, alone or in a pair`
						)
					} else {
						c.note("a member's index led by a column no fact binds to its unit")
						assert.equal(
							declared.get(lead)?.kind,
							"absolute",
							`${lead}, leading the member's index (${Arr.join(index, ", ")}) and scoping no rows, is a share of the table`
						)
					}
				}
				for (const binding of shape.bindings) {
					const bound = new Set(binding.columns)
					for (const index of shape.indexes) {
						const prefix = boundPrefix(index, bound)
						if (
							prefix.length === 0 ||
							(prefix.length === bound.size && Arr.every(prefix, (col) => bound.has(col))) ||
							holdsKey(shape, prefix)
						) {
							continue
						}
						const e = estimate(declared, d.dependencies, prefix)
						assert.notEqual(
							e.kind,
							"belowOne",
							`(${Arr.join(prefix, ", ")}) holds at most one anchor, or one pair a dependency ties`
						)
						if (e.kind === "rows") {
							c.note("a set apart bound")
							assert.ok(
								e.log2 >= 1,
								`(${Arr.join(prefix, ", ")}) of ${binding.by} binds two rows or more`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's independence estimate over the declared numbers of distinct values (declared.fixtures.ts estimate)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.2.0.0.0.0.1.0.0.1.0.0.0.3.1.0.1.0.1.1.0.0.0.2.1.1.0.0.1.2.0"
				),
				reason:
					"metis's assignment: unit child (c0), keyed (child, number) and (number), user (c2) leading indexes (child, user) and (user, number) and contained with child in person_user (number, person), keyed by number, so user determines child; test (c3) leading index (test). e2abf18f2 declared user 2 values, `user = $2` priced at half of 100,000 rows, and the hold gate sorted a five-arm union whole (1.9 ms at 9653f3d5c, 409 ms at 2635639dd): user is an anchor by the dependency its containment proves, and test, which no fact binds to a child, a share of the table",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.3.0.0.0.0.1.2.1.2.0.0.0.0.1.0.1.0.0.3.1.0.0"
				),
				reason:
					"metis's processed_attempt: unit child (c0), keyed (child, package, path, n) with a roster beside, its index (package, path) led by the content coordinate package (c1). Taken as an anchor for its index, package was declared 2 rows a value, and PostgreSQL read a probe binding the whole key through the prefix (package, path, n), priced at one row, filtering child after: 41,208 rows for each of 34 probes of metis's submit at 45785e7c9 (plan-23, 2.23 million buffer hits); package is a share of the table",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.3.0.0.0.0.0.1.1.0.0.0.2.0.1.0.1.0.1.2.2.2.1.1.1.4.0.0.1.0"
				),
				reason:
					"metis's test_presented: unit child (c0), keyed (child, stage, at), indexes (stage, package) and (package, path), and a statement binding (child, stage, package, path). 042c0f107 paired stage (c1) with child for leading index (stage, package, child), and a later index order made package (c3) the anchor in its place, read alone by a probe binding (child, stage, package), priced at 4 rows and read 1,432,016 (plan-22 at 45785e7c9). The 13.7 s plan-08 that motivated stage as an anchor read test_presented binding package and stage with no child, priced at 357,994 rows, a statement no declaration makes local; stage and package are shares of the table",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.2.0.0.0.0.1.0.0.0.1.0.1.1.1.1.1.1.3.0.0.0.0"
				),
				reason:
					"edullm's test_session at 6973fa8e4 (1,135 sittings): unit child (c0), keyed (child, stage), package (c2) leading index (package, path), a probe binding (child, stage, package): read through (package, path) at package alone, priced at one row, child and stage filtered after, 1,133 rows removed a probe; package is a share of the table",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.2.0.0.0.0.1.0.0.0.1.1.1.1.1.1.2.1.4.1.2.0"
				),
				reason:
					"a member of the unit c0 keyed (c0, c1), c2 determining c0 by a containment as metis's assignment.user determines child, beside the unit's anchor and the free column c3 in the set (c0, c2, c3) index (c0, c2, c3) stops at, short of a statement binding all four: c2 pairs with c0 at its own exponent (042c0f107), where 56851404d, pairing an anchor only beside columns of one value, left it a share of the table",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\tif (shape.unit.length === 0) {",
				replacement: "\tif (shape.unit.length >= 0) {",
				why: "Every index's first column of many values an anchor, a member's too, as 042c0f107 declared: a member's content coordinate leading an index is priced at a fixed count of rows a value, and a probe of the member's whole key reads through that index's prefix (the kept cases, metis's processed_attempt, test_presented and edullm's test_session)."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\tif (many.has(d.determinant) && taken.includes(d.dependent)) {",
				replacement:
					"\t\tif (many.has(d.determinant) && taken.includes(d.dependent) && shape.unit.length === 0) {",
				why: "No dependency a containment proves makes an anchor in a member: metis's assignment.user, determining child, is priced at a share of the table, and the hold gate sorts its union whole (the first kept case)."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\t\t\treturn more.length === 0",
				replacement:
					"\t\t\t\treturn more.length === 0 && p.columns.every((o) => o === c || o === only || single.has(o))",
				why: "A pair only beside columns of one value, as 56851404d paired: a column leading an index beside an anchor and another column in a set apart is left absolute, and an equality on it alone priced at a share of the table (the last kept case)."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\tif (admitted && sharers.size <= 1) {",
				replacement: "\t\tif (admitted && sharers.size === 0) {",
				why: "No two anchors paired, as e2abf18f2 declared: a column leading an index beside an anchor in a set apart is left absolute, and an equality on it alone is priced at a share of the table (the kept case, metis's hold gate)."
			}
		]
	})
