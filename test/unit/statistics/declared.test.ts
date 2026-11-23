/**
 * A relation's declared statistics (physical/statistics/declared.ts) rank every statement's access path by how much of a
 * key it binds, as PostgreSQL estimates them: its independence product of each column's selectivity.
 *
 * Property: over drawn relation shapes (two to six columns, rosters among them, a unit of one or two leading columns or
 * none, keys, indexes and the bindings of keys, index prefixes and drawn sets, half of them holding a crossed pair of
 * keys and sets apart besides), a declaration gives every column one number of distinct values, its anchors relative and
 * every other column absolute; a column of few values is never relative and holds no more values than its roster's
 * handles; the unit's key's fields after its first of many values, and a roster of one handle, hold exactly one; every
 * key holding one anchor binds at most one row; every set an index's equalities stop at short of a binding, holding no
 * key, holds at most one anchor, and where it holds one binds two rows or more; and a relation refused is refused as a
 * crossing of its own keys and sets, or for a column asked beyond its values.
 *
 * Oracle: specification, PostgreSQL's estimate over the declared values (declared.fixtures.ts estimate).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { declarationOf } from "#compiler/physical/statistics/declared.ts"
import {
	boundPrefix,
	type DeclaredFeature,
	estimate,
	holdsKey,
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
			"a column beyond its values"
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
					const e = estimate(declared, key)
					if (e.kind === "rows") {
						c.note("a key bound")
						assert.ok(e.log2 <= 0, `key (${Arr.join(key, ", ")}) binds at most one row`)
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
						const e = estimate(declared, prefix)
						assert.notEqual(
							e.kind,
							"belowOne",
							`(${Arr.join(prefix, ", ")}) holds at most one anchor`
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
		kept: [],
		kills: []
	})
