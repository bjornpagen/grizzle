import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { storedColumn } from "#compiler/ir/expr.ts"
import { keyFactors, keyIn } from "#compiler/ir/keys.ts"
import { conservativeMeta, type Heading } from "#compiler/ir/rel.ts"
import { bitsOf } from "#compiler/logical/attributes.ts"
import { closure, namesNothing, reaches } from "#compiler/logical/closure.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import {
	admitted,
	analyzedSoundly,
	baseOf,
	closedCaseGen,
	type ClosedFeature,
	closedUnder,
	columnName,
	type Dep,
	genRelation,
	headingOf,
	holds,
	independentFactorsGen,
	int4,
	int8,
	intLiteral,
	joinCaseGen,
	joinDeps,
	joinFacts,
	type JoinFeature,
	joinRegion,
	joinSchema,
	lateralCaseGen,
	type LateralFeature,
	matchDeps,
	minimalKeysOf,
	onlyProof,
	projected,
	type ProjectionFeature,
	schemaOf,
	statedKeys,
	subsetsOf,
	Variables
} from "#test/unit/analysis/logical/gaps.fixtures.ts"

/**
 * A closed relation's columns of identical values are one class of one type, a column of distinct values is a key, and
 * every claim holds on the facts.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/gaps.test.ts:316 at 8cad5bce, its runs and its coverage's cases).
 */
export const aClosedRelationsColumnsOfIdenticalValuesAreOneClassOfOneTypeAColumnOfDistinctValuesIsAKeyAndEveryClaimHoldsOnTheFacts =
	property.explore(closedCaseGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"two columns of identical values",
			"identical values under two types",
			"a distinct column of a class of several",
			"a class of three columns"
		] satisfies ReadonlyArray<Reached<ClosedFeature>>,
		check: (_, c: Case<ClosedFeature>) => (cs) =>
			Effect.sync(() => {
				/** Each column's values: its own, or those of the column it copies. */
				const valuesOf = (i: number): ReadonlyArray<number> => {
					const col = defined(cs.columns[i], "a column")
					return col.copied ? valuesOf(col.copies) : col.values
				}
				const heading: Heading = Arr.map(cs.columns, (col, i) => ({
					name: columnName(i),
					type: col.wide ? int8 : int4
				}))
				const b = new DagBuilder(makeIdSupply())
				const closed = b.node({
					kind: "Closed",
					closed: "Facts",
					rows: Arr.map(indices(cs.facts), (r) =>
						Arr.map(indices(heading.length), (i) =>
							intLiteral(defined(valuesOf(i)[r], "a fact's value"))
						)
					),
					heading,
					loc: undefined,
					meta: conservativeMeta
				})
				const analysis = analyzedSoundly(b.build([closed]), schemaOf([]), {})
				const props = defined(analysis.props.get(closed), "the node's properties, kept")
				const proof = onlyProof(props)
				/** The oracle's class of a column: the columns of its type holding its values fact by fact. */
				const classOf = (i: number) =>
					Arr.flatMap(heading, (h, j) =>
						h.type.carrier === defined(heading[i], "a column").type.carrier &&
						deepEquals(valuesOf(j), valuesOf(i))
							? [h.name]
							: []
					)
				for (const [i, h] of heading.entries()) {
					const expected = classOf(i)
					assert.deepEqual(
						Arr.fromIterable(defined(props.classes.get(h.name), `${h.name}'s class`)),
						expected,
						`${h.name}'s class`
					)
					const values = valuesOf(i)
					if (new Set(values).size === values.length) {
						assert.ok(
							keyIn(proof, (x) => x === h.name) !== undefined,
							`${h.name}, of distinct values, is a key`
						)
						if (expected.length > 1) {
							c.note("a distinct column of a class of several")
						}
					}
					if (expected.length > 1) {
						c.note("two columns of identical values")
					}
					if (expected.length > 2) {
						c.note("a class of three columns")
					}
					if (
						cs.facts > 0 &&
						Arr.some(
							heading,
							(o, j) => o.type.carrier !== h.type.carrier && deepEquals(valuesOf(j), values)
						)
					) {
						c.note("identical values under two types")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the columns partitioned by type and by their values fact by fact, and the reference evaluator"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"\t\t\t\tconst first = firsts.find(\n\t\t\t\t\t(f) => sameScalarType(f.type, h.type) && f.values.every((v, j) => v === values[j])\n\t\t\t\t)",
				replacement: "\t\t\t\tconst first = firsts.find((f) => sameScalarType(f.type, h.type))",
				why: "Two closed columns of one type are one class whatever their values (logical/props.ts Closed); the closed columns search fails."
			}
		]
	})

/**
 * A lateral source's column fixed to a region column equals that column's variable both ways, the region's keys
 * exactly its minimal keys, every claim holding on the facts.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/gaps.test.ts:469 at 8cad5bce, its runs and its coverage's cases).
 */
export const aLateralSourcesColumnFixedToARegionColumnEqualsThatColumnsVariableBothWaysTheRegionsKeysExactlyItsMinimalKeysEveryClaimHoldingOnTheFacts =
	property.explore(lateralCaseGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"the region's column",
			"the earlier occurrence's column",
			"through a projection",
			"a key of the source holding its fixed column",
			"a key holding the fixed column's variable",
			"a take of one row"
		] satisfies ReadonlyArray<Reached<LateralFeature>>,
		check: (_2, c: Case<LateralFeature>) => (lc) =>
			Effect.sync(() => {
				c.note(lc.target)
				const R = genRelation("R", lc.r)
				const S = genRelation("S", lc.s)
				const b = new DagBuilder(makeIdSupply())
				const vars = new Variables(b)
				const rBase = baseOf(b, R)
				const region = b.reserve()
				const t = defined(lc.r.bindings[lc.to], "R's fixed-to variable")
				const w = defined(lc.s.bindings[lc.fixed], "S's fixed variable")
				const sBase = baseOf(b, S)
				const outer = b.expr({
					kind: "column",
					column:
						lc.target === "the region's column"
							? { node: region, name: t }
							: { node: rBase.id, name: columnName(lc.to) },
					args: [],
					type: int4,
					nonNull: "storage"
				})
				const filtered = b.node({
					kind: "Take",
					input: sBase,
					orders: [
						{
							keys: Arr.map(sBase.heading, (h) => ({ column: h.name, dir: "asc" as const }))
						}
					],
					bound: { kind: "literal", k: BigInt(lc.take) },
					correlation: [{ column: columnName(lc.fixed), expr: outer }],
					heading: sBase.heading,
					loc: undefined,
					meta: conservativeMeta
				})
				const lateral = lc.projected
					? b.node({
							kind: "ProjectSet",
							input: filtered,
							out: Arr.map(filtered.heading, (h) => ({
								name: h.name,
								expr: b.expr(storedColumn(filtered.id, h.name, h.type))
							})),
							heading: filtered.heading,
							loc: undefined,
							meta: conservativeMeta
						})
					: filtered
				if (lc.projected) {
					c.note("through a projection")
				}
				const occurrences = [
					{
						id: b.ids.occurrence(),
						source: rBase,
						bindings: Arr.map(lc.r.bindings, (v, i) => ({
							column: columnName(i),
							var: vars.of(v)
						})),
						constants: []
					},
					{
						id: b.ids.occurrence(),
						source: lateral,
						bindings: Arr.map(lc.s.bindings, (v, i) => ({
							column: columnName(i),
							var: vars.of(v)
						})),
						constants: []
					}
				]
				const root = b.define(region, {
					kind: "MatchRegion",
					scope: b.ids.scope(),
					vars: vars.all,
					occurrences,
					equalities: [],
					correlated: [],
					heading: headingOf(vars.all),
					loc: undefined,
					meta: conservativeMeta
				})
				const analysis = analyzedSoundly(
					b.build([root]),
					schemaOf([R, S]),
					canonicalFacts({
						R: admitted(lc.r, lc.rows[0]),
						S: admitted(lc.s, lc.rows[1])
					})
				)
				const props = defined(analysis.props.get(root), "the node's properties, kept")
				assert.ok(
					defined(props.classes.get(w), "the fixed column's variable's class").includes(t),
					`${w} and ${t} are one class`
				)
				const deps: ReadonlyArray<Dep> = [
					...matchDeps(lc.r, []),
					{ from: [t], to: [w] },
					{ from: [w], to: [t] },
					...Arr.map(lc.s.keys, (key) => ({
						from: [t, ...Arr.filter(lc.s.bindings, (_, i) => i !== lc.fixed && holds(key, i))],
						to: lc.s.bindings
					})),
					...(lc.take === 1 ? [{ from: [t], to: lc.s.bindings }] : [])
				]
				const expected = minimalKeysOf(
					Arr.map(vars.all, (v) => v.name),
					deps
				)
				assert.deepEqual(statedKeys(onlyProof(props)), expected)
				if (lc.take === 1) {
					c.note("a take of one row")
				}
				if (Arr.some(lc.s.keys, (key) => holds(key, lc.fixed))) {
					c.note("a key of the source holding its fixed column")
				}
				if (Arr.some(expected, (k) => Arr.contains(Str.split(k, ","), w))) {
					c.note("a key holding the fixed column's variable")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "every subset of the region's variables closed under its matches and the fixed column's equality, and the reference evaluator"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"\t\t\t\t})\n\t\t\t\tdeps.push(stated.there, stated.back)\n\t\t\t\tequal.push(stated)",
				replacement: "\t\t\t\t})\n\t\t\t\tdeps.push(stated.there)",
				why: "A lateral source's fixed column determines the region's variable but not back (logical/props.ts); the lateral source search fails."
			}
		]
	})

/**
 * Keys of joined relations are one proof over independent factors whose choices are exactly the join's minimal keys,
 * each holding on the facts.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/gaps.test.ts:742 at 8cad5bce, its runs and its coverage's cases).
 */
export const keysOfJoinedRelationsAreOneProofOverIndependentFactorsWhoseChoicesAreExactlyTheJoinsMinimalKeysEachHoldingOnTheFacts =
	property.explore(
		aimed(joinCaseGen(3), [["two factors of two minimal keys each", independentFactorsGen(3)]]),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				"a factor of two minimal keys",
				"two factors of two minimal keys each",
				"relations joined on a variable",
				"a minimal key of several columns"
			] satisfies ReadonlyArray<Reached<JoinFeature>>,
			check: (_, c: Case<JoinFeature>) => (j) =>
				Effect.sync(() => {
					const b = new DagBuilder(makeIdSupply())
					const region = joinRegion(b, j)
					const analysis = analyzedSoundly(b.build([region]), joinSchema(j), joinFacts(j))
					const proof = onlyProof(
						defined(analysis.props.get(region), "the node's properties, kept")
					)
					const expected = minimalKeysOf(
						Arr.map(region.heading, (h) => h.name),
						joinDeps(j)
					)
					assert.deepEqual(statedKeys(proof), expected)
					const factors = Arr.map(keyFactors(proof), (f) => f.length)
					if (Arr.some(factors, (n) => n > 1)) {
						c.note("a factor of two minimal keys")
					}
					if (Arr.filter(factors, (n) => n > 1).length > 1) {
						c.note("two factors of two minimal keys each")
					}
					if (
						new Set(Arr.flatMap(j.matched, (m) => m.bindings)).size <
						Arr.reduce(j.matched, 0, (n, m) => n + m.width)
					) {
						c.note("relations joined on a variable")
					}
					if (Arr.some(expected, Str.includes(","))) {
						c.note("a minimal key of several columns")
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "every subset of the region's variables closed under each relation's keys, and the reference evaluator"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/logical/props.ts",
					original: "\t\t\t\t\t\tothers.map((other) => alternativeOf(other, factor, before))",
					replacement: "\t\t\t\t\t\t[]",
					why: "A key factor states no alternative of its chosen key (logical/props.ts finish); the joined keys search fails."
				}
			]
		}
	)

/**
 * Projections of a join determine exactly what the join determines among their columns, a dependency through a dropped
 * column included.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/gaps.test.ts:810 at 8cad5bce, its runs and its coverage's cases).
 */
export const projectionsOfAJoinDetermineExactlyWhatTheJoinDeterminesAmongTheirColumnsADependencyThroughADroppedColumnIncluded =
	property.explore(joinCaseGen(3), {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a dependency only a dropped column carries, from no key",
			"two stacked projections dropping columns",
			"a key of the projection narrower than its heading"
		] satisfies ReadonlyArray<Reached<ProjectionFeature>>,
		check: (_, c: Case<ProjectionFeature>) => (j) =>
			Effect.sync(() => {
				const b = new DagBuilder(makeIdSupply())
				const region = joinRegion(b, j)
				const first = projected(b, region, j.keep[0])
				const second = projected(b, first, j.keep[1])
				const analysis = analyzedSoundly(b.build([second]), joinSchema(j), joinFacts(j))
				const deps = joinDeps(j)
				const all = Arr.map(region.heading, (h) => h.name)
				for (const node of [first, second]) {
					const props = defined(analysis.props.get(node), "the node's properties, kept")
					const heading = Arr.map(node.heading, (h) => h.name)
					/** Only the dependencies whose determinants the node delivers: what a projection that drops would keep. */
					const delivered = Arr.filter(deps, (d) => Arr.every(d.from, (x) => heading.includes(x)))
					for (const set of subsetsOf(heading)) {
						const reached = closure(
							props.stated,
							bitsOf(props.stated.attributes, set),
							namesNothing
						)
						const got = Arr.filter(heading, (h) => reaches(reached, h))
						const known = closedUnder(deps, set)
						assert.deepEqual(
							got,
							Arr.filter(heading, (h) => known.has(h)),
							`[${Arr.join(set, ", ")}] at ${node.id}`
						)
						const without = closedUnder(delivered, set)
						if (
							!Arr.every(all, (v) => known.has(v)) &&
							Arr.some(heading, (h) => known.has(h) && !without.has(h))
						) {
							c.note("a dependency only a dropped column carries, from no key")
						}
					}
					if (
						Arr.some(
							defined(analysis.props.get(node), "the node's properties, kept").keys,
							(k) => k.key.length < heading.length
						)
					) {
						c.note("a key of the projection narrower than its heading")
					}
				}
				if (second.heading.length < first.heading.length && first.heading.length < all.length) {
					c.note("two stacked projections dropping columns")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the closure in the join of every subset of the projection's columns, and the reference evaluator"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\tconst attributes = attributesOver(all, [...hiddenFrom.keys()])",
				replacement: "\tconst attributes = attributesOver(all, [])",
				why: "A projection keeps no hidden attribute of its input (logical/props.ts projectProps); the projections search fails."
			}
		]
	})
