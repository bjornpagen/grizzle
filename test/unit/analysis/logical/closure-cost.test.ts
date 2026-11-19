/**
 * The work of the logical analysis's closures, counted, each property's own documentation beside its search:
 *
 * - A closure's visits (logical/closure.ts closure): a round passes over the node's dependencies, visiting each once a
 *   pass, until a pass adds nothing, so a closure that names nothing visits its dependencies at most once more than the
 *   attributes it adds: its work is bounded by its dependencies times its attributes. Oracle: the closure by brute force,
 *   and that count.
 * - Interning (logical/props.ts finish, logical/attributes.ts attributesOver, logical/closure.ts rowsOf): each node's
 *   attributes, and its dependencies over them, are interned once, where its properties are built, however many
 *   closures its own properties and its parents' read off them. Oracle: the specification, one interning a node.
 *
 * The counts are work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts), so
 * neither guard depends on the machine.
 *
 * Features: a closure that adds nothing, one of three passes or more, and a dependency that never fires; one relation
 * and several joined.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { attributesOver, bitsOf, namesOf } from "#compiler/logical/attributes.ts"
import { closure, namesNothing, rowsOf } from "#compiler/logical/closure.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	type ClosureFeature,
	closedMask,
	columnsIn,
	columnsOf,
	dependenciesOf,
	type InterningFeature,
	interning,
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
					const node = makeIdSupply().node()
					const attributes = attributesOver(columnsOf(table), [])
					const rows = rowsOf(node, attributes, dependenciesOf(table, node))
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
					"const coverOf = (props: Table, start: Bits): Closure<never> =>\n\tclosure<never>(\n\t\trowsOf(\n\t\t\tprops.node.id,\n\t\t\tattributesOver(props.columns, props.stated.attributes.hidden),\n\t\t\tprops.stated.rows.map((row) => row.dependency)\n\t\t),\n\t\tstart,\n\t\tnamesNothing\n\t)",
				why: "Each closure interns its node's attributes and dependencies again, sets built per closure (logical/props.ts coverOf); the interning property fails."
			}
		]
	})
