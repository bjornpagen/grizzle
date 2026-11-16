/**
 * approximateNearest in the optimized lowering: one search per execution, never one per parent, and the refusals of
 * placements that would run it more often. The indexed statements run on PostgreSQL in test/pg/vector/ann, which
 * checks their plans; here a search is counted on the AST as a query ranked by the cosine distance.
 *
 * The rule, over every placement of a search a parent and its child make (the checker builds only some of them; the
 * others are hand-built DAGs the lowering must refuse on its own): a program the lowering admits computes each search
 * node once, in one statement and outside any sublink, which runs per row of the query around it; a search whose own
 * source reads the parent variable would run once per parent, and is refused; every refusal is UnsupportedOperation,
 * by the checker or by the lowering. The placements must reach both: a search the parent delivers or only its child
 * reads is admitted, and one a statement of its own would compute again (an attachment of a child over candidates, a
 * root reading it beside the child) is refused. A search in a derived relation's definition is refused, and the lowering traces the search
 * again on the DAG it lowers, refusing a score that is no longer the cosine distance.
 *
 * Oracle: the rule as a checker over each admitted program's AST, the searches it runs counted against the DAG's
 * search nodes and none under a sublink, and over the placements whose verdict it fixes (a specification).
 *
 * Features: each placement shape paired with its outcome; a search admitted and refused by its purpose and score.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { programAsts } from "#test/support/compile.ts"
import { candidates } from "#test/support/fixtures/api/search.ts"
import {
	checked,
	checkedResult,
	literalScore,
	lowered,
	placed,
	type PlacementFeature,
	placements,
	type PlacementShape,
	searchAlsoOutside,
	searchesIn,
	searchesOf,
	searchesPerRow,
	searchUnderAttach
} from "#test/unit/lower/vector.fixtures.ts"

/** Attachments: one search per execution, never one per parent admits a placement only where one execution computes each search once, outside any per-row subquery. */
export const attachmentsOneSearchPerExecutionNeverOnePerParentAdmitsAPlacementOnlyWhereOneExecutionComputesEachSearchOnceOutsideAnyPerRowSubquery =
	property.exhaust(placements, {
		needs: {},
		situations: [
			["a search the parent delivers", "admitted"],
			["a search only the child reads", "admitted"],
			["a search the parent delivers", "refused"],
			["a search over a source that reads the parent", "refused"],
			["a search a root reads again", "refused"]
		] satisfies ReadonlyArray<Reached<PlacementFeature>>,
		check:
			(_, c: Case<PlacementFeature>) =>
			({ parent, child, again }) =>
				Effect.sync(() => {
					const perParent =
						child === "a search over a source that binds the parent" ||
						child === "a search over a source that compares the parent"
					const shapes: Array<PlacementShape> = []
					if (parent === "candidates") {
						shapes.push("a search the parent delivers")
					} else if (child === "its own candidate") {
						shapes.push("a search only the child reads")
					}
					if (perParent) {
						shapes.push("a search over a source that reads the parent")
					}
					const reached = (outcome: "admitted" | "refused") => {
						c.note(outcome)
						for (const shape of shapes) {
							c.pair(shape, outcome)
						}
					}
					const checkedPlacement = checkedResult(placed(parent, child))
					if (!checkedPlacement.ok) {
						refused(checkedPlacement, "UnsupportedOperation", `${parent}, ${child}`)
						reached("refused")
						return
					}
					const wrapped = perParent
						? searchUnderAttach(checkedPlacement.value)
						: checkedPlacement.value
					const readAgain = again && !perParent && searchesOf(wrapped) > 0
					const shaped = readAgain ? searchAlsoOutside(wrapped) : wrapped
					if (readAgain) {
						shapes.push("a search a root reads again")
					}
					const program = lowered(shaped, "query")
					if (!program.ok || perParent) {
						refused(program, "UnsupportedOperation", `${parent}, ${child}`)
						reached("refused")
						return
					}
					const asts = programAsts(program.value)
					assert.equal(
						Arr.reduce(asts, 0, (n, ast) => n + searchesIn(ast)),
						searchesOf(shaped),
						"each search computed once"
					)
					assert.equal(
						Arr.reduce(asts, 0, (n, ast) => n + searchesPerRow(ast)),
						0,
						"no search under a sublink"
					)
					reached("admitted")
				}),
		oracle: {
			kind: "specification",
			name: "an admitted program computes each search once, outside any sublink; a search reading the parent is refused"
		},
		box: "every parent with every child, the DAG's first search read by a root of its own as well or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/vector/index.ts",
				original:
					'\t\tif (outer.length > 0) {\n\t\t\trefuse("UnsupportedOperation", at, outerRefusal(outer))\n\t\t}\n\t\tconst attached = attachmentRefusal(cx.dag, node)\n\t\tif (attached !== undefined) {',
				replacement:
					'\t\tif (outer.length < 0) {\n\t\t\trefuse("UnsupportedOperation", at, outerRefusal(outer))\n\t\t}\n\t\tconst attached = attachmentRefusal(cx.dag, node)\n\t\tif (attached === null) {',
				why: "The optimized lowering lowers a search over a source that reads the parent, and one an attachment's statement would compute again, where it must refuse them; the placement search fails."
			}
		]
	})

/** Refusals in the lowering lowers a search only in a query, and only while it ranks by the cosine distance it traces. */
export const refusalsInTheLoweringLowersASearchOnlyInAQueryAndOnlyWhileItRanksByTheCosineDistanceItTraces =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<"query" | "derivedDefinition">(["query", "derivedDefinition"])),
					source.draw(
						element<"the cosine distance" | "a literal">(["the cosine distance", "a literal"])
					)
				] as const
		),
		{
			needs: {},
			situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<"admitted" | "refused">>,
			check:
				(_, c: Case<"admitted" | "refused">) =>
				([purpose, score]) =>
					Effect.sync(() => {
						const q = checked(candidates)
						const r = lowered(score === "a literal" ? literalScore(q) : q, purpose)
						if (purpose === "query" && score === "the cosine distance") {
							assert.equal(
								Arr.reduce(programAsts(succeeded(r)), 0, (n, ast) => n + searchesIn(ast)),
								1
							)
							c.note("admitted")
						} else {
							refused(r, "UnsupportedOperation", `${purpose}, ${score}`)
							c.note("refused")
						}
					}),
			oracle: {
				kind: "specification",
				name: "a search lowers only in a query and only ranked by the cosine distance it traces"
			},
			box: "a query or a derived relation's definition, ranked by the cosine distance or by a literal",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/vector/index.ts",
					original:
						"\tconst misuse = approximateMisuse(cx.dag, { derivedDefinition: facts.derivedDefinition })",
					replacement: "\tconst misuse = approximateMisuse(cx.dag, { derivedDefinition: false })",
					why: "The lowering admits a search in a derived relation's definition; the lowering-refusal search fails."
				}
			]
		}
	)
