/**
 * What the property of compiled.test.ts reads: its cases, a world of the NULL language (test/support/null/language.ts)
 * with rows of it, a generated field, two row checks and a selection drawn over it, and the schema that states them.
 */

import { array, type Gen } from "@bjornpagen/testing/gen"
import { Record as Rec } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { schema } from "#compiler/public/schema.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { checkBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import {
	buildPred,
	buildTerm,
	closedOf,
	itemFields,
	storedField
} from "#test/support/null/build.ts"
import {
	type Item,
	itemGen,
	type Pred,
	predGen,
	type Stored,
	storedFieldGen,
	type World,
	worldGen
} from "#test/support/null/language.ts"

/**
 * A case: its world, its rows, its generated field's sort and term, its two row checks and its selection's predicate,
 * each in the check vocabulary.
 */
export interface CompiledCase {
	readonly world: World
	readonly items: NonEmptyReadonlyArray<Item>
	readonly generated: Stored
	readonly checks: readonly [Pred, Pred]
	readonly selection: Pred
}

/** What a case reaches: each truth of a check and of the selection, a generated value and a NULL one, several rows. */
export type CompiledFeature =
	| "a check holds"
	| "a check breaks"
	| "a generated value"
	| "a NULL generated value"
	| "a row selected"
	| "a row its selection leaves"
	| "several rows"

/** A case: a world, one to five rows, a generated field, two row checks and a selection. */
export const caseGen: Gen<CompiledCase> = (s) => {
	const world = s.draw(worldGen)
	const item = itemGen(world)
	const pred = predGen(world, 2, "check")
	return {
		world,
		items: [s.draw(item), ...s.draw(array(item, { min: 0, max: 4 }))],
		generated: s.draw(storedFieldGen(world)),
		checks: [s.draw(pred), s.draw(pred)],
		selection: s.draw(pred)
	}
}

/**
 * The schema of a case: its world's closed relations, and Gen, the rows' fields with the generated field g, under the
 * two row checks Holds0 and Holds1; and the selection of Gen by the case's predicate.
 */
export const builtOf = (cc: CompiledCase) => {
	const c = closedOf(cc.world)
	const Gen = generatedRelation(
		"Gen",
		itemFields(c),
		["id"],
		(r) => ({
			g: generatedField(storedField(c, cc.generated.sort), buildTerm(c, r, cc.generated.term), [])
		}),
		[]
	)
	const holding = (pred: Pred) => (r: Readonly<Record<string, unknown>>) => buildPred(c, r, pred)
	return {
		c,
		Gen,
		selected: selectBuilder(Gen, holding(cc.selection)),
		schema: schema(
			"Compiled",
			[...Rec.values(c), Gen],
			[
				checkBuilder("Holds0", Gen, holding(cc.checks[0])),
				checkBuilder("Holds1", Gen, holding(cc.checks[1]))
			]
		)
	}
}

/** The functions whose calls are the evaluator's compile work: a table compiled, and one expression of it compiled. */
export const compileSites = Object.freeze({
	tables: { file: "packages/engine/src/scalar/compute/evaluate.ts", name: "compiledTable" },
	expressions: { file: "packages/engine/src/scalar/compute/evaluate.ts", name: "compiledNode" }
})

/**
 * The functions whose calls are the work of reading an admitted row: one of its columns read (runtime/write/witness.ts
 * RowReading), and its relation's items, its generated values and check verdicts, computed (program/evaluate.ts).
 */
export const readingSites = Object.freeze({
	columns: { file: "packages/engine/src/runtime/write/witness.ts", name: "columnValue" },
	items: { file: "packages/engine/src/program/evaluate.ts", name: "itemsOf" }
})

/** The columns of Gen a row of it is read at: the rows' fields (null/build.ts itemFields) and its generated field g. */
export const genColumns = (c: Parameters<typeof itemFields>[0]): number =>
	Rec.keys(itemFields(c)).length + 1
