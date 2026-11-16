/**
 * A read's routes never miss a change that alters its answer: every committed change of a stored relation's row that
 * changes what a read answers under its binding is one the read's footprint routes to it. Over-approximation is the
 * routes' licence (a wake-up that changes nothing re-runs to an empty diff and sends nothing); a change they miss is a
 * subscriber left on a stale answer.
 *
 * A row's change is its removal or its addition: an update of a row is its old row's removal and its new row's
 * addition, which touches both rows' values, so a read whose answer an update changes changes by one of the two. So
 * over generated public cases (test/support/oracle/public), each read of a query compiled as a workload's program over
 * the case's schema, as generate plans it (program/workload/compile.ts compileWorkload), its footprint read off the
 * plan, and every fact of the case: when the reference's answer to the read over the case's facts (meaning.ts
 * expectedQuery) and over them without the fact differ (answer.ts answerEquivalence), the fact's relation is in the
 * footprint, and it routes table-wide or some routed field of the fact holds the value the read binds the field's
 * parameter to. That covers the fact's removal from the case and its addition to the case without it.
 *
 * A read the plan compiles over the case's schema runs on full roles, whose relations are the schema's, whole, so its
 * answer on every role it runs on is the reference's here; a role's own filters only narrow what it reads, and routes
 * over-approximating the full read over-approximate the narrowed one.
 *
 * The population must reach a fact whose removal changes a read past a take: a read of an earlier read's rows that take
 * the first k of their order, filtered by a parameter. A take's rows each depend on every row it ranks, so its routes
 * read its input whole whatever its consumers bind. A witness whose turn aims at it draws a sketch whose case is
 * constructed to reach it (takeCaseGen: the take leaves out one fact, of its field's least value, and the read past it
 * binds that value, so removing a fact of a greater value lets the left-out fact in).
 *
 * A read through a query entry is held to the same property, constructed in every case: a role whose query entry
 * `Seen` holds each fact of one of the case's relations that holds facts, and its read of `Seen`'s facts whose drawn
 * field is a parameter, bound to that field of one of the relation's facts, or of their count, a fold whose match binds
 * the relation's primary key and the drawn field alone, the key `Seen`'s analysis proves, which the role admits
 * (FoldOverProjection names no key bound) and so its plan must. Its routes are its plan's, which reads the entry's
 * definition inlined (program/workload/compile.ts workloadQueryRead), and its answer the reference's over that same
 * inlined IR (reference/evaluate.ts Reference, deliver.ts expectedStatements), the case's facts with and without each
 * fact: every fact whose removal changes the answer is one the routes reach.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	caseOf,
	type Feature,
	routedChange,
	type SeenRead,
	sketchGen,
	sound,
	takeChange,
	type WorldFeature,
	worldSound
} from "#test/unit/served/routes-sound.fixtures.ts"

/** A read's routes reach every change of a row that alters the read's answer. */
export const aReadsRoutesReachEveryChangeOfARowThatAltersTheReadsAnswer = property.explore(
	aimed(sketchGen("drawn"), [
		[routedChange, sketchGen("routed")],
		[takeChange, sketchGen("past a take")]
	]),
	{
		needs: {},
		situations: [
			"a fact a routed read's answer changes by",
			"a fact a table-wide read's answer changes by",
			"a fact of a routed table no answer changes by",
			"a fact a read past a take changes by"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, reads]) =>
				Effect.sync(() =>
					sound(caseOf(notes.draw(resolveCase(sketch)), reads, notes.draw), notes.note)
				),
		oracle: {
			kind: "specification",
			name: "the reference's answer over the case's facts with and without each fact (meaning.ts expectedQuery)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/routes.ts",
				original:
					"\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareText(a, b))))",
				replacement:
					"\t\tconst [firstColumn] = (occurrences[0]?.heading ?? []).filter((c) => routable[c.type.carrier])\n\t\tconst [firstParam] = named.values()\n\t\tif (routes.length === 0 && firstColumn !== undefined && firstParam !== undefined) {\n\t\t\troutes.push([firstColumn.name, firstParam])\n\t\t}\n\t\ttables.set(relation, new Map(routes.toSorted(([a], [b]) => compareText(a, b))))",
				why: "logical/routes.ts footprintOf routes a table its program reads table-wide by its first column, under the program's first parameter; the property fails."
			},
			{
				file: "packages/engine/src/logical/routes.ts",
				original: '\t\tcase "Take":',
				replacement:
					'\t\tcase "Take":\n\t\t\treturn [[node.input, onHeading(r, node.input.heading)]]',
				why: "A take passes what its consumers read to its input, so a filter above a take routes the rows it ranks; the property fails at a case takeCaseGen constructs."
			},
			{
				file: "packages/engine/src/logical/routes.ts",
				original: "\t\t\t\t\treturn name === undefined ? [] : [name]",
				replacement: `\t\t\t\t\treturn name === undefined ? [] : [\`\${name}_\`]`,
				why: "A route names its parameter otherwise than the program declares it (a trailing underscore), so a fact whose removal changes the answer is routed under a parameter the read never binds; the property fails."
			}
		]
	}
)

/** A read's routes reach every change of a row that alters a read through a query entry. */
export const aReadsRoutesReachEveryChangeOfARowThatAltersAReadThroughAQueryEntry = property.explore(
	caseSketchGen,
	{
		needs: {},
		situations: [
			"a fact a read through a query entry changes by",
			"a fact a read through a query entry does not change by",
			"a fold through a query entry bound by its key"
		] satisfies ReadonlyArray<Reached<WorldFeature>>,
		check: (_, notes: Case<WorldFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = notes.draw(resolveCase(sketch))
				const holding = Arr.filter(
					c.schema.relations,
					(r) => (c.facts.get(r.name) ?? []).length > 0
				)
				if (!Arr.isReadonlyArrayNonEmpty(holding)) {
					return
				}
				const stored = notes.draw(element(holding))
				const at = notes.draw(element(Arr.map(stored.fields, (field, i) => ({ field, i }))))
				const facts = c.facts.get(stored.name) ?? []
				if (!Arr.isReadonlyArrayNonEmpty(facts)) {
					return
				}
				const bound = notes.draw(element(facts))[at.i]
				const shape = notes.draw(element<SeenRead>(["facts", "count"]))
				if (bound !== undefined) {
					worldSound(c, stored, at.field, bound.literal, shape, notes.note)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the reference's answer over the read's inlined IR, the case's facts with and without each fact"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/world.ts",
				original: "\t\t\tObject.hasOwn(m.bindings, field)",
				replacement: "\t\t\tObject.hasOwn(m.bindings, field) || world.fields.length > 0",
				why: "A world match is inlined under its own bindings alone (program/workload/world.ts), so the plan refuses the count through Seen that the role admits; the query entry's property fails."
			}
		]
	}
)
