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
 * anchor, or one pair, binds at most one row, or is carried by its own unique index, which PostgreSQL prices at one
 * tuple whatever the statistics: each column of it past its anchors that its type would let halve its rows again lies in
 * a set apart over those anchors binding exactly two rows, a largest, or, for an anchor of a pair of the unit's anchor
 * and a spanning lead, in a set apart over the pair whose columns but the other anchor's bind four rows over it, so no
 * number of values its columns' types hold brings it to one row (Rel0x0 keyed (Bool, field0), the kept case); every
 * set an index's equalities stop at short of a binding, holding no
 * key, holds at most one anchor or one pair, and where it holds one binds two rows or more, as PostgreSQL prices a pair
 * under its dependency, beside whatever other columns it holds; every column the schema scopes rows by (the unit's
 * anchor, each key's first column of many values, and each column of many values a dependency proves determines one of
 * those) and, in a relation in no unit, every column of many values leading an index is an anchor, alone or in a pair,
 * but where the sets apart holding it hold two anchors besides, so an equality on it alone is priced at a number of rows
 * the table's size does not move (metis's hold gate, the first kept case, and the last); in a unit's member, the lead of
 * each index a binding spanning its units binds whole (one holding none of the columns that scope its rows) is an
 * anchor paired with the unit's, the two binding two rows or more together and fewer than either alone, but where a set
 * apart holding it holds another anchor besides the unit's, so a staff read spanning the units reads its index at any
 * size (edullm's Q05) and a read binding the unit still prefers the unit's index (metis's submit and edullm's commit,
 * the kept cases between); every other column of many values leading a member's index is absolute, so an equality on
 * it alone is priced at a share of the table, which grows with the units; and a relation
 * refused is refused as a crossing of its own keys and sets, or a raise grizzle did not settle over them: never for a
 * column asked beyond its values, which no declaration does.
 *
 * Oracle: specification, PostgreSQL's estimate over the declared values (declared.fixtures.ts estimate).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Result } from "effect"
import { declarationOf } from "#compiler/physical/statistics/declared.ts"
import {
	boundPrefix,
	type DeclaredFeature,
	estimate,
	holdsKey,
	type LessonFeature,
	priced,
	scopeOf,
	scopingColumns,
	shapeGen,
	spanningLeadsOf,
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
			"a key carried by its index",
			"a pair a dependency ties",
			"an index led by a column of many values in no unit",
			"a member's index led by a column no fact binds to its unit",
			"a member's index led by a spanning binding's column",
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
				const unitAnchorOf = Option.getOrUndefined(unitAnchor)
				/** The leads of indexes a binding spanning the units binds whole (spanningLeadsOf), and of them those the
				 * declaration pairs with the unit's anchor: each that scopes no rows of itself. */
				const spanning = spanningLeadsOf(shape)
				const spanningPaired = new Set(
					Arr.filter([...spanning], (l) => !scopes.includes(l) && !determinants.includes(l))
				)
				/** Whether a column, declared `distinct` and holding `values`, could halve a set's rows again within its type:
				 * one of many values, or of few below the most values its handles hold. */
				const belowCap = (col: string): boolean => {
					const distinct = declared.get(col)
					const values = Option.getOrUndefined(
						Arr.findFirst(shape.columns, (x) => x.column === col)
					)?.values
					return (
						distinct?.kind === "absolute" &&
						distinct.exponent >= 1 &&
						(values?.kind === "many" ||
							(values?.kind === "few" && 2 ** (distinct.exponent + 1) <= values.handles))
					)
				}
				const anchorsIn = (set: ReadonlyArray<string>): ReadonlyArray<string> =>
					Arr.sort(
						Arr.filter(set, (col) => declared.get(col)?.kind === "relative"),
						Order.String
					)
				for (const key of shape.keys) {
					const e = estimate(declared, d.dependencies, key)
					if (e.kind !== "rows") {
						continue
					}
					c.note("a key bound")
					if (e.log2 <= 0) {
						continue
					}
					c.note("a key carried by its index")
					const held = anchorsIn(key)
					const over = Arr.join(held, ",")
					/** The sets apart that set its anchor's exponent: those over its anchors binding two rows, and, for an
					 * anchor of a pair of the unit's anchor and a spanning lead, those over the pair, whose columns but the
					 * other anchor's bind four rows over the anchor (exponents.ts `least`). */
					const [only, ...others] = held
					const partners =
						only === undefined || others.length > 0
							? []
							: Arr.flatMap(d.dependencies, (dep) =>
									dep.determinant === unitAnchorOf && spanningPaired.has(dep.dependent)
										? dep.determinant === only
											? [dep.dependent]
											: dep.dependent === only
												? [dep.determinant]
												: []
										: []
								)
					const tops = Arr.filter(aparts, (p) => {
						const at = estimate(declared, d.dependencies, p)
						if (Arr.join(anchorsIn(p), ",") === over) {
							return at.kind === "rows" && at.log2 === 1
						}
						return Arr.some(partners, (other) => {
							const pair = Arr.join(anchorsIn([...held, other]), ",")
							const alone = estimate(
								declared,
								d.dependencies,
								Arr.filter(p, (col) => col !== other)
							)
							return (
								Arr.join(anchorsIn(p), ",") === pair && alone.kind === "rows" && alone.log2 === 2
							)
						})
					})
					assert.ok(
						Arr.every(key, (col) => !belowCap(col) || Arr.some(tops, (p) => p.includes(col))),
						`key (${Arr.join(key, ", ")}), binding 2^${e.log2} rows, is carried by its own index: each column of it its type would let halve its rows again lies in a set apart over its anchors that binds two rows`
					)
				}
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
				for (const lead of spanningPaired) {
					c.note("a member's index led by a spanning binding's column")
					const u = unitAnchorOf
					/** Whether a set apart holding the lead holds an anchor beside it other than the unit's, which no one
					 * dependency on the unit's anchor ties to it (anchorsOf). */
					const crowded = Arr.some(
						aparts,
						(p) =>
							p.includes(lead) &&
							Arr.some(p, (o) => o !== lead && o !== u && declared.get(o)?.kind === "relative")
					)
					if (crowded) {
						c.note("a spanning lead beside another anchor")
						continue
					}
					const y = declared.get(lead)
					assert.ok(
						y?.kind === "relative",
						`${lead}, leading an index a binding spanning the units binds whole, is an anchor, so PostgreSQL reads the binding through its index at any size`
					)
					if (u === undefined || holdsKey(shape, [u, lead])) {
						continue
					}
					const yu = declared.get(u)
					const together = estimate(declared, d.dependencies, [u, lead])
					assert.ok(
						yu?.kind === "relative" &&
							together.kind === "rows" &&
							together.log2 >= 1 &&
							together.log2 < y.exponent &&
							together.log2 < yu.exponent,
						`the unit's anchor ${u} and the spanning lead ${lead} bind two rows or more together, fewer than either alone, by a declared dependency`
					)
				}
				for (const index of shape.indexes) {
					const [lead] = Option.toArray(scopeOf(shape, index.slice(0, 1)))
					if (
						lead === undefined ||
						scopes.includes(lead) ||
						determinants.includes(lead) ||
						spanning.has(lead)
					) {
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
							`${lead}, leading the member's index (${Arr.join(index, ", ")}), scoping no rows and serving no spanning binding, is a share of the table`
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
					"metis's assignment: unit child (c0), keyed (child, number) and (number), user (c2) leading indexes (child, user) and (user, number) and contained with child in person_user (number, person), keyed by number, so user determines child; test (c3) leading index (test). e2abf18f2 declared user 2 values, `user = $2` priced at half of 100,000 rows, and the hold gate sorted a five-arm union whole (1.9 ms at 9653f3d5c, 409 ms at 2635639dd): user is an anchor by the dependency its containment proves; test, which no fact binds to a child, leads the index of a binding spanning the children, (test), and is an anchor paired with child, four rows a test where the pair binds two",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.3.0.0.0.0.1.2.1.2.0.0.0.0.1.0.1.0.0.3.1.0.0"
				),
				reason:
					"metis's processed_attempt: unit child (c0), keyed (child, package, path, n) with a roster beside, its index (package, path) led by the content coordinate package (c1). Taken as an anchor for its index, package was declared 2 rows a value, and PostgreSQL read a probe binding the whole key through the prefix (package, path, n), priced at one row, filtering child after: 41,208 rows for each of 34 probes of metis's submit at 45785e7c9 (plan-23, 2.23 million buffer hits); package, leading the index of the binding (package, path), which spans the children, is an anchor paired with child, and the probe's set apart (package, path) binds two rows, above the key's one",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.3.0.0.0.0.0.1.1.0.0.0.2.0.1.0.1.0.1.2.2.2.1.1.1.4.0.0.1.0"
				),
				reason:
					"metis's test_presented: unit child (c0), keyed (child, stage, at), indexes (stage, package) and (package, path), and a statement binding (child, stage, package, path). 042c0f107 paired stage (c1) with child for leading index (stage, package, child), and a later index order made package (c3) the anchor in its place, read alone by a probe binding (child, stage, package), priced at 4 rows and read 1,432,016 (plan-22 at 45785e7c9). The 13.7 s plan-08 that motivated stage as an anchor read test_presented binding package and stage with no child, priced at 357,994 rows, a statement no declaration makes local; stage, leading the index of the binding (stage, package), which spans the children, is an anchor paired with child, and package, beside stage in the set apart (stage, package) of the statement binding (child, stage, package, path), a share of the table",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#declaredStatisticsBindOneRowAtAKeyAndTwoOrMoreAtEverySetApartAsPostgresqlEstimatesThem:-:0.2.0.0.0.0.1.0.0.0.1.0.1.1.1.1.1.1.3.0.0.0.0"
				),
				reason:
					"edullm's test_session at 6973fa8e4 (1,135 sittings): unit child (c0), keyed (child, stage), package (c2) leading index (package, path), a probe binding (child, stage, package): read through (package, path) at package alone, priced at one row, child and stage filtered after, 1,133 rows removed a probe; package, leading the index of the binding (package, path), which spans the children, is an anchor paired with child at four rows a package, above the key's one",
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
				why: "Every index's first column of many values an anchor, a member's too, as 042c0f107 declared, where no binding spanning the units asks the index: a column a binding beside the unit leads an index with is priced at a fixed count of rows a value alone, unpaired with the unit, where it is a share of the table, as test_presented's package took stage's place as an anchor (the third kept case)."
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
			},
			{
				file: "packages/engine/src/physical/statistics/exponents.ts",
				original: '\t\tdefined(caps[c], "a column\'s cap") - defined(x[c], "a column\'s exponent")',
				replacement: '\t\tNumber.POSITIVE_INFINITY - defined(x[c], "a column\'s exponent")',
				why: "Every column raised past its type's values, as e637d8a3d's raise asked: a boolean in a key beside a set apart is declared 4 values, which a refusal named, more than its type holds."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\tfor (const c of spanningLeads(shape, firstOf)) {",
				replacement: "\tfor (const c of spanningLeads(shape, firstOf).slice(0, 0)) {",
				why: "No spanning binding's lead an anchor, as before: a read that binds a member's column without its unit, test_moment's stage without its child, is priced at a share of the table, and PostgreSQL scans the table for it (edullm's Q05, 34 scans and 367,166 pages a submit)."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original:
					"\t\tadmit(c, unitAnchor === undefined || isKey([unitAnchor, c]) ? undefined : unitAnchor)",
				replacement: "\t\tadmit(c, undefined)",
				why: "A spanning lead taken as an anchor of its own, no pair with the unit's: a read binding the unit and the lead is priced below one row, as two independent anchors, whatever rows it binds."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\t\t\t\t\t\t{ over: pair.determinant, least: 2 },",
				replacement: "\t\t\t\t\t\t\t{ over: pair.determinant, least: 1 },",
				why: "The unit's anchor bound at a spanning pair's rows, not twice them: a unit and its pair with a spanning lead may bind as many rows, and a read binding both ties an index the unit leads that stops at the unit alone, every row of the unit for its few."
			}
		]
	})

/**
 * The lesson of metis's processed_attempt and test_presented, as a property: under its declared statistics an index
 * whose equalities stop at a set holding none of the columns that scope a member's rows (its unit's fields, its keys'
 * scopes, and the columns its containments prove determine one) never wins a read that binds the unit. Each read the
 * installation makes leads an index exactly (README "Keys and indexes"), or binds a key, whose unique index serves it;
 * so over drawn relation shapes, every binding of a unit's member that holds the unit's anchor and that some index
 * binds whole, or whose every column of a key's index it binds, is priced through the cheapest such index strictly below every index stopping at a
 * spanning set, as PostgreSQL prices them (declared.fixtures.ts priced): a unique index bound whole at one tuple, any
 * other at its estimate of the set its equalities stop at, clamped at one row. A spanning set holds a spanning lead,
 * paired with the unit's anchor, which binds more rows than the two together, or no anchor, a share of the table.
 *
 * Oracle: specification, PostgreSQL's estimate over the declared values (declared.fixtures.ts estimate, priced).
 */
export const noIndexASpanningColumnLeadsWinsAReadThatBindsTheUnitUnderDeclaredStatistics =
	property.explore(shapeGen, {
		needs: {},
		situations: [
			"a read binding the unit beside a spanning index",
			"a spanning index binding a pair's lead",
			"a spanning index binding no anchor",
			"a read binding the unit through a key"
		] satisfies ReadonlyArray<Reached<LessonFeature>>,
		check: (_, c: Case<LessonFeature>) => (shape) =>
			Effect.sync(() => {
				const d = declarationOf(shape)
				const [u] = Option.toArray(scopeOf(shape, shape.unit))
				if (d.kind !== "declared" || u === undefined) {
					return
				}
				const declared = new Map(Arr.map(d.columns, (col) => [col.column, col.distinct] as const))
				const scoping = new Set([
					...scopingColumns(shape),
					...Arr.flatMap(shape.determined, (dep) => [dep.determinant])
				])
				for (const binding of shape.bindings) {
					const bound = new Set(binding.columns)
					if (!bound.has(u)) {
						continue
					}
					const runs = Arr.map(shape.indexes, (index) => ({
						index,
						run: boundPrefix(index, bound)
					}))
					const keyed = Arr.some(shape.keys, (k) =>
						Arr.some(
							runs,
							({ index, run }) =>
								k.length === index.length &&
								Arr.every(k, (col, at) => index[at] === col && run.includes(col))
						)
					)
					if (!keyed && !Arr.some(runs, ({ run }) => run.length === bound.size)) {
						continue
					}
					const own = Arr.reduce(
						Arr.filter(runs, ({ run }) => run.includes(u)),
						Number.POSITIVE_INFINITY,
						(least, { index, run }) =>
							Math.min(least, priced(shape, declared, d.dependencies, index, run))
					)
					for (const { index, run } of runs) {
						if (
							run.length === 0 ||
							Arr.some(run, (col) => scoping.has(col)) ||
							holdsKey(shape, run)
						) {
							continue
						}
						c.note("a read binding the unit beside a spanning index")
						if (keyed) {
							c.note("a read binding the unit through a key")
						}
						c.note(
							Arr.some(run, (col) => declared.get(col)?.kind === "relative")
								? "a spanning index binding a pair's lead"
								: "a spanning index binding no anchor"
						)
						const spanning = priced(shape, declared, d.dependencies, index, run)
						assert.ok(
							spanning > own,
							`${binding.by}, binding (${Arr.join(binding.columns, ", ")}) with the unit's anchor ${u}, is priced at 2^${spanning} rows through index (${Arr.join(index, ", ")}), which stops at (${Arr.join(run, ", ")}), spanning the units, where an index binding the unit reads 2^${own}`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's estimate of each index's rows over the declared values, its unique index's one tuple (declared.fixtures.ts priced)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/statistics/declared.test.ts#noIndexASpanningColumnLeadsWinsAReadThatBindsTheUnitUnderDeclaredStatistics:-:0.1.0.0.0.1.1.0.0.1.0.0.0.1.0.0"
				),
				reason:
					"key-reach's M0 at its smallest: unit c0, keyed (c0, c1, c2), the index (c1) a read of c1 alone asks (test/pg/contracts/key-reach, edullm's Q05), and a read binding (c0, c1), as the stored derivation's upkeep reads M0: c1 leads the spanning index, an anchor paired with c0, and the read is priced through the key's (c0, c1) at the pair's rows, below c1's own, where an index the engine appended c0 to, (c1, c0), bound it as wholly and tied the key",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\t\t\t\t\t\t{ over: pair.dependent, least: 2 }",
				replacement: "\t\t\t\t\t\t\t{ over: pair.dependent, least: 1 }",
				why: "A spanning lead bound at its pair's rows, not twice them: the lead alone and the unit's anchor beside it tie, and an index the lead leads, which leaves the unit out, ties the unit's own index for a read binding both, as (k0) tied M0's key for its upkeep's (doc, k0)."
			}
		]
	})
