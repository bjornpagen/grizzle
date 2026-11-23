/**
 * A compile knows an imported query by its Description's identity (check/session.ts ResolvedImports, queryIdentity), so
 * the imports of Descriptions of one identity at one key are one node (check/checker.ts importedKey), however many
 * objects spell it: a factory that builds a query anew at every place it is read, as edullm's ledger reads
 * `gradableOf(gradedSitting).bind(bySession(r))` in each argument of its grade, builds the node one object would, where
 * each object was a query of its own, a node of its own at every import, and its nested imports a node of their own
 * again (the latest-attempt fold of edullm's decideStage read-back spelled 162 times, one per argument), so no rule of
 * the lowering, keyed by node, ever saw them as one.
 *
 * The box: a reader of one rule reading 1 to 3 arguments, the `j`-th the values of at least `j` of a chain's latest
 * attempts at its own sittings, the chain the fold alone or a level above it importing it at its own sittings, each
 * argument's sittings the stages of a child: a parameter of the reader, one of two parameters, a variable of the
 * reader's rule, or one of two variables of one region, by the argument's parity. Each shape is built three ways: every
 * import of one query one object; a factory per import, every Description alike; and a factory per import whose every
 * Description is apart from the others by a filter that holds of every row, so no two of its imports are of one
 * identity, each a node of its own.
 *
 * Properties: the factory's program checks to the nodes one object's does and prints its statements byte for byte,
 * where two of its arguments bind their sittings alike the program built apart holds more; and over drawn facts and
 * parameters the factory's program reads, by the reference evaluator over its checked DAG, the rows of the program
 * built apart, its imports of one identity at different bindings never merged. Oracles: the one-object program's nodes
 * and statements; the program built apart, by the reference. Kills: a Description object a query of its own, as it
 * was; an outer value keyed by its node without its column, which merges an argument's stages at a pair's `a` with
 * another's at its `b`; every value bound to a column, a channel among them, left out of the key; a parameter keyed
 * without its name, which merges the stages at `p` with those at `q`.
 *
 * Features: one reader, several; the fold alone, a level above it; each binding.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Binding,
	checkedOf,
	type Facts,
	factsGen,
	nodesOf,
	rowsOf,
	type Shape,
	shapeGen,
	shapes,
	statementsOf,
	twoArgumentsShareABinding
} from "#test/unit/check/equal-imports.fixtures.ts"

type Situation =
	| "one reader"
	| "several readers"
	| "the fold alone"
	| "a level above the fold"
	| `bound to ${Binding}`

const situations = [
	"one reader",
	"several readers",
	"the fold alone",
	"a level above the fold",
	"bound to a parameter",
	"bound to two parameters",
	"bound to an outer value",
	"bound to two outer values"
] as const satisfies ReadonlyArray<Reached<Situation>>

/** The shape's situations, noted on `c`. */
const noteShape = (shape: Shape, c: Case<Situation>): void => {
	c.note(shape.readers === 1 ? "one reader" : "several readers")
	c.note(shape.depth === 1 ? "the fold alone" : "a level above the fold")
	c.note(`bound to ${shape.binding}`)
}

/** Imports of Descriptions of one identity are one node: the factory's program is one object's, node for node. */
export const importsOfDescriptionsOfOneIdentityAreOneNode = property.exhaust(shapeGen, {
	needs: {},
	situations,
	check: (_, c: Case<Situation>) => (shape) =>
		Effect.sync(() => {
			noteShape(shape, c)
			const factory = nodesOf(checkedOf(shape, "a factory per import"))
			assert.equal(
				factory,
				nodesOf(checkedOf(shape, "one object")),
				"a factory's imports check to the nodes one object's do"
			)
			assert.deepEqual(
				statementsOf(shape, "a factory per import"),
				statementsOf(shape, "one object"),
				"a factory's program prints one object's statements"
			)
			if (twoArgumentsShareABinding(shape)) {
				assert.ok(
					nodesOf(checkedOf(shape, "a factory per import, each apart")) > factory,
					"the program built apart holds each import as a node of its own"
				)
			}
		}),
	oracle: {
		kind: "universal",
		name: "the one-object program's checked nodes and printed statements"
	},
	box: "every shape: a chain of one level or two, 1 to 3 arguments, each binding",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/check/session.ts",
			original:
				"\tget(q: InferredQuery): ResolvedQuery | undefined {\n\t\treturn this.#resolved.get(this.#identityOf(q))\n\t}\n\n\tset(q: InferredQuery, walked: ResolvedQuery): void {\n\t\tthis.#resolved.set(this.#identityOf(q), walked)\n\t}\n",
			replacement:
				"\treadonly #byObject = new WeakMap<InferredQuery, ResolvedQuery>()\n\n\tget(q: InferredQuery): ResolvedQuery | undefined {\n\t\treturn this.#byObject.get(q)\n\t}\n\n\tset(q: InferredQuery, walked: ResolvedQuery): void {\n\t\tthis.#byObject.set(q, walked)\n\t}\n",
			why: "Each Description object is a query of its own, as it was: a factory's imports are each a place, a key and a node of their own, so its program checks to more nodes than one object's."
		}
	]
})

/** A case of the rows property: a shape, and the facts and parameters it is read over. */
interface RowsCase {
	readonly shape: Shape
	readonly facts: Facts
}

const rowsCaseGen: Gen<RowsCase> = (source) => ({
	shape: element(shapes)(source),
	facts: factsGen(source)
})

/** The interned program reads the rows of the program whose every import is a node of its own. */
export const theInternedProgramReadsTheRowsOfItsImportsBuiltApart = property.explore(rowsCaseGen, {
	needs: {},
	situations,
	check: (_, c: Case<Situation>) => (drawn) =>
		Effect.sync(() => {
			noteShape(drawn.shape, c)
			assert.deepEqual(
				rowsOf(checkedOf(drawn.shape, "a factory per import"), drawn.facts),
				rowsOf(checkedOf(drawn.shape, "a factory per import, each apart"), drawn.facts),
				"the interned program reads the rows of its imports built apart"
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the program whose every import is a node of its own, by the reference evaluator"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/check/checker.ts",
			original: `\t\t\treturn { text: \`c:\${value.node}:\${value.name}\`, closed: false }\n`,
			replacement: `\t\t\treturn { text: \`c:\${value.node}\`, closed: false }\n`,
			why: "An outer value keyed by its node alone merges the imports of one identity bound to two columns of one region: an argument's stages at a pair's b read as another's at its a."
		},
		{
			file: "packages/engine/src/check/checker.ts",
			original: `\t\t\treturn { text: \`c:\${value.node}:\${value.name}\`, closed: false }\n`,
			replacement: '\t\t\treturn { text: "c:", closed: false }\n',
			why: "A value bound to a column, an outer value or a channel a step or a probe binds to the unit's column (ir/desc.ts Channel), leaves the key: the imports of one identity bound to two columns are one node, an argument's stages at a pair's b read as another's at its a."
		},
		{
			file: "packages/engine/src/check/checker.ts",
			original: `\t\t\treturn { text: \`p:\${value.cell.name}\`, closed: true }\n`,
			replacement: '\t\t\treturn { text: "p:", closed: true }\n',
			why: "A parameter keyed without its name merges the imports of one identity bound to two parameters: an argument's stages at q read as another's at p."
		}
	]
})
