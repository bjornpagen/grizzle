/**
 * A stored relation's upkeep and a law's judge are as large as their own definitions, whatever stands beneath them: each
 * stored derivation a definition reads, at any depth, named or a query it imports, is read as its table, by its name
 * (analysis/theory/query.ts LiveReading `stored`), which its own upkeep keeps at the same COMMIT before the reader's runs
 * (physical/ddl/rules.ts stratumOf), never as its definition spelled again in place; one spelled in place is an internal
 * compiler error (query.ts inPlace). PostgreSQL plans a statement by what it holds, so its planning is bounded by its own
 * definition's relations, never by the derivations beneath them. forward_branch_rule's upkeep (qti-pie 97d0637e) spelled
 * the queries beneath it in place, a 253 KB DELETE and a 242 KB INSERT reading qti.node 228 times, which a fresh session
 * planned in 1,875 and 1,231 ms and ran in 4.6 and 21 ms; a learner's write planned 18 to 22 s cold.
 *
 * Box: D, stored over the written T joined to the top of a stack of one to four levels of stored derivations, each over
 * every derivation of the level below, one or two of them, and the written N, named or imported, the top computing a
 * declared function's value beside its fields or not, and Linked, live, reading the top across documents under a check
 * (upkeep-size.fixtures.ts).
 *
 * Oracle: specification, D's and Small's definitions, the same at every depth, fan and naming, which bound their
 * statements: D's upkeep and Small's judge hold the nodes they hold over one named derivation of a top computing the
 * same, statement by statement, and call none of the top's functions, which the top's own upkeep computes, and every
 * derivation of the stack is stored and upkept.
 *
 * Features: each depth, each fan, each naming, and a top that computes a declared function's value or nothing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Computes,
	type Naming,
	sizesOf,
	type Stack,
	stackGen
} from "#test/unit/physical/upkeep-size.fixtures.ts"

type StackFeature =
	| `depth ${1 | 2 | 3 | 4}`
	| `fan ${1 | 2}`
	| `naming ${Naming}`
	| `the top computes ${Computes}`

/** D's upkeep and Small's judge hold, statement by statement, the nodes they hold over one named derivation, at every
 * depth, fan and naming. */
export const aStoredRelationsUpkeepAndALawsJudgeAreAsLargeAsTheirOwnDefinitionsWhateverStoredDerivationsStandBeneathThem =
	property.exhaust(finite(stackGen), {
		needs: {},
		situations: [
			"depth 1",
			"depth 2",
			"depth 3",
			"depth 4",
			"fan 1",
			"fan 2",
			"naming named",
			"naming imported",
			"the top computes nothing",
			"the top computes a call"
		] satisfies ReadonlyArray<Reached<StackFeature>>,
		check: (_, c: Case<StackFeature>) => (stack: Stack) =>
			Effect.sync(() => {
				c.note(`depth ${stack.depth === 1 ? 1 : stack.depth === 2 ? 2 : stack.depth === 3 ? 3 : 4}`)
				c.note(`fan ${stack.fan === 1 ? 1 : 2}`)
				c.note(`naming ${stack.naming}`)
				c.note(`the top computes ${stack.computes}`)
				const one = sizesOf({ depth: 1, fan: 1, naming: "named", computes: stack.computes })
				const at = sizesOf(stack)
				const beneath = stack.fan * (stack.depth - 1) + 1
				assert.equal(
					at.upkept,
					one.upkept + beneath - 1,
					`every one of the ${beneath} derivations beneath D is stored and upkept`
				)
				assert.deepEqual(
					at.upkeep,
					one.upkeep,
					`D's upkeep over ${stack.depth} ${stack.naming} derivations of fan ${stack.fan} holds ${Arr.join(Arr.map(at.upkeep, String), ", ")} nodes, over one ${Arr.join(Arr.map(one.upkeep, String), ", ")}: each derivation beneath it is read as its table`
				)
				assert.deepEqual(
					at.judge,
					one.judge,
					`Small's judge over ${stack.depth} ${stack.naming} derivations of fan ${stack.fan} holds ${Arr.join(Arr.map(at.judge, String), ", ")} nodes, over one ${Arr.join(Arr.map(one.judge, String), ", ")}: each derivation beneath Linked is read as its table`
				)
				assert.deepEqual(
					[at.calls.upkeep, at.calls.judge],
					[0, 0],
					"D's upkeep and Small's judge call none of the top's functions: they read the top's computed column from its table"
				)
				assert.equal(
					at.calls.top > 0,
					stack.computes === "a call",
					"the top's own upkeep computes its call, where it holds one"
				)
			}),
		oracle: {
			kind: "specification",
			name: "D's and Small's definitions, the same at every depth, fan and naming, whose statements read each stored derivation beneath them as its table"
		},
		box: "D and Linked over a stack of one to four levels of stored derivations, each over every derivation of the level below, one or two of them, named or imported, its top computing a call or not",
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/upkeep-size.test.ts#aStoredRelationsUpkeepAndALawsJudgeAreAsLargeAsTheirOwnDefinitionsWhateverStoredDerivationsStandBeneathThem:-:3.1.1.0"
				),
				reason:
					"forward_branch_rule's shape: four levels of imported stored queries, each read by both of the level above, as qti-pie's ForwardBranchRule reads targetedBranchRuleRows, commonSectionRows and fixedBackwardRows over the queries beneath them (qti-pie 97d0637e, edullm-bd's slow-query profile): its upkeep spelled them in place, a 253 KB DELETE and a 242 KB INSERT reading qti.node 228 times, 1,875 and 1,231 ms to plan on a fresh session; here D's INSERT held 7,335 nodes where over one named derivation it holds 143, and Small's judge 7,292 where 78",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/physical/upkeep-size.test.ts#aStoredRelationsUpkeepAndALawsJudgeAreAsLargeAsTheirOwnDefinitionsWhateverStoredDerivationsStandBeneathThem:-:1.0.1.1"
				),
				reason:
					"test/pg/derived/stored's Programmed as it stood, edullm's WalkPattern: each linked place joined back to an imported query of its document's values' compiles, which admission stores; its upkeep spelled that query in place and called compile beside the join, once per value of every document it kept, where it reads the compiles' table and calls compile never, the stored query's own upkeep calling it once per value new to its document",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\treturn c !== undefined && this.#tables(c.subject.name) ? c.subject.name : undefined",
				replacement: "\t\treturn undefined",
				why: "No import is a stored relation to any reading, as before: an upkeep and the judge spell every stored derivation beneath them in place, so D's upkeep over four imported levels of fan two holds 676, 586 and 7,335 nodes where over one named derivation it holds 161, 107 and 143, and Small's judge 486 and 7,292 where 71 and 78; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\ts.kind === "query" && Object.keys(s.bind).length === 0 ? stored(s.query) : undefined',
				replacement: "\tundefined",
				why: "No reading reads a stored import by its name: each reads it in place, which inPlace refuses, an internal compiler error, so every imported stack fails to compile."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\tif (bound.some((f) => computedOfVars(defined(derived[f], f)))) {\n\t\treturn undefined\n\t}\n",
				replacement: "",
				why: "A lost rule whose fact computes a field from a variable keeps its definition checked: a top computing its program reads the level below it by the key its head binds, so it takes the checked form, whose lost check negates the definition at a program computed from the region's value, which no negation binds, and no stack whose top computes a call compiles (test/unit/derived/storage's kept case, NamedDeclaration's cast value, refused alike)."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tconst stored = storedSource(source, this.env.live.stored)",
				replacement: "\t\tconst stored = undefined",
				why: "A law's arms read a stored import's definition in place (Flattener), which inPlace refuses, an internal compiler error, so Small fails to compile over every imported stack."
			}
		]
	})
