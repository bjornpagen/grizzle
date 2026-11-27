/**
 * A relation that is a member of several families is laid out and named by them in one order of what they are
 * (write/family/statements.ts memberFamilies, ir/family.ts familyOrder), never by the order the law model states its
 * families in: the sequence that nests its rows first, a relation being a member of at most one, then its counted
 * families by key. Its row layout lists their law columns in that order (statements.ts rowLayout), so the rows its
 * family statements write and the nested rows a write sends are laid out alike. The law model
 * states its families in its statements' canonical order, which moves whenever that order's definition does
 * (OPT-ENCODE's reversed sweep moved edullm's Instance, a tree's node and TestDocument.instances' member, from one
 * family to the other), so a pick by that order is a pick by no meaning.
 *
 * Box: Node, a tree's node and a member of two counted families, Doc's and Shelf's, as edullm's Instance is; a ChangeSet
 * inserting a tree alone or beside a Doc and a Shelf, its program compiled once over the law model as it states its
 * families and once over each order of them (family-pick.fixtures.ts compiledInOrder): every one of the 3! orders of
 * each of the two shapes.
 *
 * Oracle: the specification: the program the write compiles to, its statements' SQL and its binding, is the same
 * whatever order the model states the families in, the lists the host meets families and relations in read in their
 * keys' order (family-pick.fixtures.ts bindingInKeyOrder).
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { noAdvice } from "#compiler/sql/advice.ts"
import { projectWrite, servableWrite } from "#compiler/write/program/served.ts"
import {
	bindingInKeyOrder,
	compiledInOrder,
	pickCaseGen,
	type PickFeature,
	pickFeatures,
	stated
} from "#test/unit/write/family-pick.fixtures.ts"

/** A member of several families is laid out and named the same whatever order the law model states its families in. */
export const aMemberOfSeveralFamiliesIsLaidOutAndNamedTheSameWhateverOrderTheLawModelStatesItsFamiliesIn =
	property.exhaust(finite(pickCaseGen), {
		needs: {},
		situations: [
			"a tree alone",
			"a tree beside its counted owners",
			"the tree stated after a counted family",
			"the counted families in the other order"
		] satisfies ReadonlyArray<Reached<PickFeature>>,
		check: (_, c: Case<PickFeature>) => (drawn) =>
			Effect.sync(() => {
				const own = projectWrite(servableWrite(compiledInOrder(drawn.shape, stated)), noAdvice)
				const ordered = projectWrite(
					servableWrite(compiledInOrder(drawn.shape, drawn.order)),
					noAdvice
				)
				const order = Formatter.format(Arr.map(drawn.order, (f) => `${f.id.owner}.${f.id.count}`))
				assert.deepEqual(
					ordered.statements,
					own.statements,
					`${drawn.shape}: the program's statements, their SQL among them, over the families in the order ${order} are those over the law model's own order`
				)
				assert.deepEqual(
					bindingInKeyOrder(ordered.binding),
					bindingInKeyOrder(own.binding),
					`${drawn.shape}: the program's binding over the families in the order ${order} is the one over the law model's own order, the lists the host meets families in read by key`
				)
				c.noteAll(pickFeatures(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "one program whatever order the law model states its families in"
		},
		box: "Node a tree's node and a member of Doc's and Shelf's counted families; a tree inserted alone or beside a Doc and a Shelf; every order of the three families",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/family/statements.ts",
				original:
					"): ReadonlyArray<Family> => families.filter((f) => f.member.name === relation).toSorted(familyOrder)",
				replacement:
					"): ReadonlyArray<Family> => families.filter((f) => f.member.name === relation)",
				why: "A member's families in the order the law model states them: Node's row layout lists its tree's law column after Doc's and Shelf's where the model states the tree last, so the nested Node rows and the additions statement that reads them move their columns."
			},
			{
				file: "packages/engine/src/ir/family.ts",
				original: "\tmapInput(compareBooleans, (f: Family) => !isSequence(f)),",
				replacement: "\tmapInput(compareBooleans, (f: Family) => isSequence(f)),",
				why: "Counted families ranked before sequences: still one order whatever the model's, but a nested Node row is named by Doc's counted family, which never nests it."
			}
		]
	})
