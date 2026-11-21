/**
 * The work of the logical analysis's closures, counted, each property's own documentation beside its search:
 *
 * - A closure's visits (logical/closure.ts closure): a round passes over the node's dependencies, visiting each once a
 *   pass, until a pass adds nothing, so a closure that names nothing visits its dependencies at most once more than the
 *   attributes it adds: its work is bounded by its dependencies times its attributes. Oracle: the closure by brute force,
 *   and that count.
 * - A key search's tests (logical/closure.ts minimalKeys): each candidate is tested against the keys found by their
 *   set-trie, so over n columns each alone a key the tests grow as the n² candidates do, never as n³. Oracle: that
 *   growth bound.
 * - Interning (logical/props.ts finish, logical/attributes.ts attributesOver, logical/closure.ts rowsOf): each node's
 *   attributes, and its dependencies over them, are interned once, where its properties are built, however many
 *   closures its own properties and its parents' read off them. Oracle: the specification, one interning a node.
 * - A relation's reading (logical/props.ts leafProps, analysis/physical/rules.ts leafProps): a Base's and a Delta's
 *   logical properties are their relation's reading's, built once for every query of the schema that reads the relation
 *   so, and their physical properties under one catalog likewise, where every Base and every Delta of each query built
 *   both again. Oracle: the specification, one build a reading however many queries read it.
 *
 * The counts are work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts), so
 * neither guard depends on the machine.
 *
 * Features: a closure that adds nothing, one of three passes or more, and a dependency that never fires; a search from
 * n = 4 and from n = 6; one relation and several joined; one query of a reading and several.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { analyzePhysical, type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import {
	attributesOver,
	type Bits,
	bitsAt,
	bitsOf,
	isEmpty,
	namesOf
} from "#compiler/logical/attributes.ts"
import { closure, minimalKeys, namesNothing, rowsOf } from "#compiler/logical/closure.ts"
import { succeeded } from "#test/support/assert.ts"
import { incrementsAtMostDouble } from "#test/support/growth.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	type ClosureFeature,
	closedMask,
	columnsIn,
	columnsOf,
	type CyclePoint,
	dependenciesOf,
	type InterningFeature,
	interning,
	keySearchSites,
	type ReadingFeature,
	readingQuery,
	readings,
	taskReading,
	sizeOfMask,
	startedGen,
	steps
} from "#test/unit/analysis/logical/closure-cost.fixtures.ts"
import { productOf } from "#test/unit/analysis/logical/join-cost.fixtures.ts"

/** A closure visits each dependency once a pass, and passes at most once more than the attributes it adds. */
export const aClosureVisitsEachDependencyOnceAPassAndPassesAtMostOnceMoreThanTheAttributesItAdds =
	property.explore(startedGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a closure that adds nothing",
			"a closure of three passes or more",
			"a dependency that never fires"
		] satisfies ReadonlyArray<Reached<ClosureFeature>>,
		check:
			(_, c: Case<ClosureFeature>) =>
			({ table, start }) =>
				Effect.gen(function* () {
					const attributes = attributesOver(columnsOf(table), [])
					const rows = rowsOf(attributes, dependenciesOf(table))
					const [reached, counts] = yield* callCounts(
						Effect.sync(() =>
							closure(rows, bitsOf(attributes, columnsIn(table, start)), namesNothing)
						),
						steps
					)
					const known = closedMask(table, start)
					assert.deepEqual(namesOf(attributes, reached.reached), [...columnsIn(table, known)])
					const dependencies = table.dependencies.length
					const added = sizeOfMask(known & ~start)
					assert.ok(
						counts.step <= dependencies * (added + 1),
						`${counts.step} visits of ${dependencies} dependencies adding ${added} attributes`
					)
					if (added === 0) {
						c.note("a closure that adds nothing")
					}
					if (dependencies > 0 && counts.step >= 3 * dependencies) {
						c.note("a closure of three passes or more")
					}
					if (Arr.some(table.dependencies, (d) => (d.from & ~known) !== 0)) {
						c.note("a dependency that never fires")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the closure by brute force, and at most one pass more than the attributes it adds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\tfor (let changed = true; changed;) {",
				replacement:
					"\t\tfor (let changed = true, pass = 0; changed || pass <= attributes.names.length; pass++) {",
				why: "A round passes over the dependencies once for each attribute whatever it adds (logical/closure.ts closure); the visits property fails."
			}
		]
	})

/**
 * A key search tests each candidate against the keys it found by their set-trie, never one by one: over n columns each
 * alone a key, every one determining the next round a cycle, the search tests n candidates for each of the n keys, and
 * its tests grow no faster than those candidates, quadratically in n, where a scan of the keys found for each grew
 * cubically.
 */
export const aKeySearchTestsACandidateAgainstTheKeysFoundByTheirTrieNeverOneByOne =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from n = 4", "from n = 6"] satisfies ReadonlyArray<Reached<CyclePoint>>,
		check: (_, c: Case<CyclePoint>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 2 ? "from n = 4" : "from n = 6")
				const counted = new Map<number, number>()
				for (const n of [2 * half, 4 * half, 6 * half]) {
					const columns = Arr.map(indices(n), (i) => `c${i}`)
					const attributes = attributesOver(columns, [])
					/** Each column determines the next, the last the first: every column alone determines all. */
					const isKey = (cs: Bits): boolean => !isEmpty(cs)
					const [keys, counts] = yield* callCounts(
						Effect.sync(() =>
							minimalKeys(
								attributes.heading,
								[attributes.heading],
								(cs) => (isKey(cs) ? true : undefined),
								Arr.map(indices(n), (i) => ({
									from: bitsAt(attributes, [i]),
									to: bitsAt(attributes, [(i + 1) % n])
								}))
							)
						),
						keySearchSites
					)
					assert.deepEqual(
						Arr.map(keys, (k) => namesOf(attributes, k.key)),
						Arr.map(columns, (column) => [column]),
						"every column alone, in heading order"
					)
					counted.set(n, counts.subsetOf + counts.keyWithin)
				}
				incrementsAtMostDouble(
					(n) => defined(counted.get(n), `the tests at n = ${n}`),
					2 * half,
					"a key search's tests of its candidates"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than quadratically increments by at most twice as much over its second equal step"
		},
		box: "n columns at 2h, 4h and 6h, h at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original:
					"\tconst contains = (set: Bits) => keyWithin(index, positions(set), 0, sizeOf(set) + 1, 0)",
				replacement: "\tconst contains = (set: Bits) => found.some((k) => subsetOf(k.key, set))",
				why: "Each candidate tested against every key found (logical/closure.ts minimalKeys); the tests property fails."
			}
		]
	})

/** Each node's attributes and dependencies are interned once, however many closures read them. */
export const eachNodesAttributesAndDependenciesAreInternedOnceHoweverManyClosuresReadThem =
	property.exhaust(finite(int(1, 6)), {
		needs: {},
		situations: ["one relation", "several relations"] satisfies ReadonlyArray<
			Reached<InterningFeature>
		>,
		check: (_, c: Case<InterningFeature>) => (k) =>
			Effect.gen(function* () {
				c.note(k === 1 ? "one relation" : "several relations")
				const [, counts] = yield* callCounts(
					Effect.sync(() => succeeded(analyzeLogical(productOf(k), checkerEvidence))),
					interning
				)
				assert.equal(
					counts.finish,
					k + 1,
					"a node's properties each of the k relations and the region"
				)
				assert.equal(counts.attributesOver, counts.finish, "one interning of a node's attributes")
				assert.equal(counts.rowsOf, counts.finish, "one interning of a node's dependencies")
				assert.ok(
					counts.closure > counts.finish,
					`${counts.closure} closures over ${counts.finish} nodes`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one interning of a node's attributes and dependencies, counted by V8's precise coverage"
		},
		box: "k relations from one to six",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"const coverOf = (props: Table, start: Bits): Closure<never> =>\n\tclosure<never>(props.stated, start, namesNothing)",
				replacement:
					"const coverOf = (props: Table, start: Bits): Closure<never> =>\n\tclosure<never>(\n\t\trowsOf(\n\t\t\tattributesOver(props.columns, props.stated.attributes.hidden),\n\t\t\tprops.stated.rows.map((row) => row.dependency)\n\t\t),\n\t\tstart,\n\t\tnamesNothing\n\t)",
				why: "Each closure interns its node's attributes and dependencies again, sets built per closure (logical/props.ts coverOf); the interning property fails."
			}
		]
	})

/**
 * A relation's reading is analyzed once however many queries read it: n queries of one schema, each its own DAG, each
 * a Base and a Delta over one relation, build the Base's and the Delta's logical properties once each, and each query's
 * own join of them once; and their physical properties under the schema's catalog once each.
 */
export const aRelationsReadingIsAnalyzedOnceHoweverManyQueriesReadIt = property.exhaust(
	finite(int(1, 6)),
	{
		needs: {},
		situations: ["one query of a reading", "several queries of a reading"] satisfies ReadonlyArray<
			Reached<ReadingFeature>
		>,
		check: (_, c: Case<ReadingFeature>) => (n) =>
			Effect.gen(function* () {
				c.note(n === 1 ? "one query of a reading" : "several queries of a reading")
				const reading = taskReading()
				/** The schema's catalog, an object of this case's own, so no other case's analysis shares its readings. */
				const env: PhysicalEnv = {
					context: "snapshot",
					catalog: { ...reading.model.fixture.catalog },
					realization: unplaced,
					roots: "result"
				}
				const [, counts] = yield* callCounts(
					Effect.sync(() => {
						for (const _ of indices(n)) {
							analyzePhysical(
								succeeded(analyzeLogical(readingQuery(reading), checkerEvidence)).dag,
								env
							)
						}
					}),
					readings
				)
				assert.equal(
					counts.finish,
					2 + n,
					"the Base's and the Delta's logical properties once, and each query's semi-join's"
				)
				assert.deepEqual(
					{ baseProps: counts.baseProps, deltaProps: counts.deltaProps },
					{ baseProps: 1, deltaProps: 1 },
					"the Base's and the Delta's physical properties once"
				)
			}),
		oracle: {
			kind: "specification",
			name: "one build of a relation's reading however many queries read it, counted by V8's precise coverage"
		},
		box: "n queries from one to six",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\tconst known = byText.get(text)\n",
				replacement: "\tconst known: Props | undefined = undefined\n",
				why: "Every Base and every Delta builds its reading's properties again (logical/props.ts leafProps), as every node of every query did; the reading property fails."
			},
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original: "\t\t\tconst known = byText.get(reading.text)\n",
				replacement: "\t\t\tconst known: PhysicalProps | undefined = undefined\n",
				why: "Every Base and every Delta builds its reading's physical properties again (analysis/physical/rules.ts leafProps); the reading property fails."
			}
		]
	}
)
