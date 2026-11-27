/**
 * Advice printing (sql/advice.ts printAdvice): a plan's advice holds exactly the atoms the plan states, each read back
 * by PostgreSQL's advice parser as the plan names it. The advice is what pg_plan_advice holds the planner to, every plan
 * and replan of a statement (CARRY-THE-PLAN §04), so an atom too few leaves a choice to the planner, the tie that read
 * 1,887 buffers for a 4-buffer key read; an atom too many disables a plan PostgreSQL then cannot take, a scan kind the
 * index cannot run among them; and an identifier the parser reads otherwise names a relation or an index the plan never
 * meant, a tag's name read as the tag.
 *
 * A case draws a plan of one to three levels, each the statement's top or one a scope's alias names, each its first item
 * and up to three joined after it by a nested loop or a hash join, each item read whole, through an index, at tuple ids
 * or as rows of no stored relation; an index of several access methods, whether it returns what it stores, the columns
 * it stores and the ones its read needs drawn from one small pool, and its name and schema plain, capitalized, quoted,
 * or a tag's name.
 *
 * Properties, for every plan: the advice parses (pg_plan_advice's grammar, a second implementation of its reading of
 * identifiers, targets and indexes), and its atoms are the plan's (CARRY-CONTRACT.md §5) as a multiset: a join order per
 * level of two items or more, a method per joined item, a scan per stored relation, index-only exactly where its index
 * returns and stores every column the read needs, and no Gather per item.
 *
 * Oracle: a specification, the contract's atoms of the plan, and an independent reading of the printed text.
 *
 * Features: a join order, a hash join, an index-only scan, an index scan of a covering index that returns nothing, a
 * sequential scan, a tid scan, a named level, a quoted name, a tag's name.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { printAdvice } from "#compiler/sql/advice.ts"
import {
	type AdviceFeature,
	type Atom,
	adviceFeatures,
	atomText,
	parsedAtoms,
	planGen,
	readsBare,
	statedAtoms
} from "#test/unit/sql/advice.fixtures.ts"

/** A plan's advice parses as pg_plan_advice reads it, and holds exactly the atoms the plan states. */
export const aPlansAdviceParsesAsPgPlanAdviceReadsItAndHoldsExactlyTheAtomsThePlanStates =
	property.explore(planGen, {
		needs: {},
		situations: adviceFeatures,
		check: (_, c: Case<AdviceFeature>) => (plan) =>
			Effect.sync(() => {
				const advice = printAdvice(plan)
				if (advice === undefined) {
					assert.fail("a plan of a level, which names an item, has advice")
				}
				const sorted = (atoms: ReadonlyArray<Atom>) =>
					Arr.sort(Arr.map(atoms, atomText), Order.String)
				assert.deepEqual(sorted(parsedAtoms(advice)), sorted(statedAtoms(plan)))
				for (const level of plan.levels) {
					const items = [level.first, ...Arr.map(level.joined, (j) => j.item)]
					if (items.length > 1) {
						c.note("join order")
					}
					if (Arr.some(level.joined, (j) => j.join === "hash")) {
						c.note("hash join")
					}
					if (level.name.kind === "named") {
						c.note("named level")
					}
					for (const { scan } of items) {
						switch (scan.kind) {
							case "seq":
								c.note("sequential scan")
								break
							case "tid":
								c.note("tid scan")
								break
							case "rows":
								break
							case "index": {
								const covered = Arr.every(scan.needs, (col) => Arr.contains(scan.index.stores, col))
								if (covered && scan.index.returns) {
									c.note("index-only scan")
								}
								if (covered && !scan.index.returns) {
									c.note("index scan of a covering index that returns nothing")
								}
								const { schema, name } = scan.index.name
								if (Arr.some([schema, name], (n) => !readsBare(n))) {
									c.note("quoted name")
								}
								if (Arr.some([schema, name], (n) => n === "seq_scan" || n === "no_gather")) {
									c.note("a tag's name")
								}
								break
							}
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the contract's atoms of the plan, and pg_plan_advice's reading of the printed text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/advice.ts",
				original: "\t\t...items.map((item) => noGather(at(item)))",
				replacement: "\t\t...[level.first].map((item) => noGather(at(item)))",
				why: "A joined item may run under a Gather; its NO_GATHER atom is missing."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original: "\tindex.returns && needs.every((c) => index.stores.includes(c))",
				replacement: "\tneeds.every((c) => index.stores.includes(c))",
				why: "An index that returns nothing is advised an index-only scan, which PostgreSQL cannot run."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original:
					"const ident = (name: string): string => (isBare(name) && !tags.has(name) ? name : quoted(name))",
				replacement: "const ident = (name: string): string => (isBare(name) ? name : quoted(name))",
				why: "An index named as a tag prints bare, and the parser reads the tag."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original: '\tlevel.kind === "top" ? ident(item.alias) : within(item.alias, level.name)',
				replacement: "\tident(item.alias)",
				why: "A read inside a named level is targeted at the top, a relation of no level the plan named."
			}
		]
	})
