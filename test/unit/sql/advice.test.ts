/**
 * Advice printing (sql/advice.ts printAdvice): a plan's advice holds exactly the atoms the plan states, each read back
 * by PostgreSQL's advice parser as the plan names it. The advice is what pg_plan_advice holds the planner to, every plan
 * and replan of a statement (CARRY-THE-PLAN §04), so an atom too few leaves a choice to the planner, the tie that read
 * 1,887 buffers for a 4-buffer key read; an atom too many disables a plan PostgreSQL then cannot take, a scan kind the
 * index cannot run among them; and an identifier the parser reads otherwise names a relation or an index the plan never
 * meant, a tag's name read as the tag.
 *
 * A case draws a plan of one to three levels, each the statement's top or one a scope's alias names, each a join problem
 * of one item or a tree of them, a join's members joined by a nested loop or a hash join, a member a tree of its own to
 * two levels deep, its first a problem planned apart or a joined one a group on the join's inner side, its items'
 * range-table order drawn apart from their join order; or a UNION ALL's append level; each item read whole, through
 * an index, at tuple ids or as rows of no stored relation; an index of several access methods, whether it returns what it stores, the columns
 * it stores and the ones its read needs drawn from one small pool, and its name and schema plain, capitalized, quoted,
 * or a tag's name.
 *
 * Properties, for every plan: the advice parses (pg_plan_advice's grammar, a second implementation of its reading of
 * identifiers, targets and indexes), and its atoms are the plan's (CARRY-CONTRACT.md §5) as a multiset: a join order per
 * level of two items or more, nested as its tree nests, a method per joined member, a tree named as the set of its items
 * in their range-table order, a scan per stored relation, index-only exactly where its index
 * returns and stores every column the read needs, and no Gather per item.
 *
 * Oracle: a specification, the contract's atoms of the plan, and an independent reading of the printed text.
 *
 * Features: a join order, a hash join, an index-only scan, an index scan of a covering index that returns nothing, a
 * sequential scan, a tid scan, a named level, a quoted name, a tag's name, a member joining several items nested, and
 * one on a join's inner side named as its set.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { printAdvice } from "#compiler/sql/advice.ts"
import { type JoinedMember, type JoinMember, levelItems } from "#compiler/sql/plan.ts"
import {
	type AdviceFeature,
	type Atom,
	adviceFeatures,
	atomText,
	parsedAtoms,
	planGen,
	readsBare,
	statedAtoms
} from "#test/support/unit/sql/advice.fixtures.ts"

/** Every member a join tree joins after a join's first, a member's own joins after it. */
const joinsOf = (member: JoinMember<unknown>): ReadonlyArray<JoinedMember<unknown>> =>
	member.kind === "item"
		? []
		: [
				...joinsOf(member.tree.first),
				...Arr.flatMap(member.tree.joined, (j) => [j, ...joinsOf(j.member)])
			]

/** A plan's advice parses as pg_plan_advice reads it, and holds exactly the atoms the plan states. */
export const aPlansAdviceParsesAsPgPlanAdviceReadsItAndHoldsExactlyTheAtomsThePlanStates =
	property.explore(planGen, {
		needs: {},
		situations: adviceFeatures,
		check: (_, c: Case<AdviceFeature>) => (plan) =>
			Effect.sync(() => {
				const advice = printAdvice(plan)
				const sorted = (atoms: ReadonlyArray<Atom>) =>
					Arr.sort(Arr.map(atoms, atomText), Order.String)
				assert.deepEqual(sorted(parsedAtoms(advice)), sorted(statedAtoms(plan)))
				for (const level of plan.levels) {
					const items = levelItems(level)
					if (items.length > 1) {
						c.note("join order")
					}
					const joins = level.kind === "joins" ? joinsOf(level.problem) : []
					if (Arr.some(joins, (j) => j.join === "hash")) {
						c.note("hash join")
					}
					if (
						level.kind === "joins" &&
						level.problem.kind === "tree" &&
						level.problem.tree.first.kind === "tree"
					) {
						c.note("a member joining several items, nested")
					}
					if (Arr.some(joins, (j) => j.member.kind === "tree")) {
						c.note("a nested member on a join's inner side, named as its set")
					}
					if (level.name.kind === "named") {
						c.note("named level")
					}
					if (level.kind === "append") {
						c.note("a UNION ALL's append level")
					} else if (level.appended.length > 0) {
						c.note("an append member")
					}
					for (const { scan } of items) {
						switch (scan.kind) {
							case "seq":
								c.note("sequential scan")
								break
							case "tid":
								c.note("tid scan")
								break
							case "bitmap":
								c.note("bitmap heap scan")
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
				original: `): string => (member.kind === "item" ? at(member.item) : \`(\${treeOrder(member.tree, at)})\`)\n`,
				replacement:
					'): string => (member.kind === "item" ? at(member.item) : treeOrder(member.tree, at))\n',
				why: "A member joining several items is advised flat in its join's order: a problem PostgreSQL plans apart, or a group it builds on a join's inner side, reads as items of the one join, an order PostgreSQL builds no join of."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original: `(\${j.member.range.map(named).join(" ")})`,
				replacement: `(\${treeOrder(j.member.tree, at)})`,
				why: "A group on a join's inner side is named in its join order, not its items' range-table order, the set pg_plan_advice prints of the join (NESTED_LOOP_PLAIN((r19@r16 v4@r16)) where v4 is a whole view's table it pulls up after r19)."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original: '\t\tcase "bitmap":\n\t\t\treturn [`BITMAP_HEAP_SCAN(',
				replacement: '\t\tcase "bitmap":\n\t\t\treturn [`SEQ_SCAN(',
				why: "A read through an index's bitmap is advised as a sequential scan: the relation is read whole, and the parsed atoms hold a SEQ_SCAN the plan states no read of."
			},
			{
				file: "packages/engine/src/sql/advice.ts",
				original: "\t\t...scanned.map((item) => noGather(at(item)))",
				replacement: "\t\t...scanned.slice(0, 1).map((item) => noGather(at(item)))",
				why: "A joined item or an append member may run under a Gather; its NO_GATHER atom is missing."
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
				original: '\t\tlevel.name.kind === "top" ? ident(alias) : within(alias, level.name.name)',
				replacement: "\t\tident(alias)",
				why: "A read inside a named level is targeted at the top, a relation of no level the plan named."
			}
		]
	})
