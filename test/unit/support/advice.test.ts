/**
 * The plan laws read PostgreSQL's plans as PostgreSQL 19 prints them (test/support/advice.ts): its generated advice and
 * its feedback on the supplied, each scan's index condition, filter and join conditions by column, and every node it
 * disabled, so a law finds exactly the failures each measured mutant of a carried plan makes, and none in a plan that
 * holds.
 *
 * - **Property:** over a box of plans PostgreSQL 19.0 made for grizzle's statement shapes under their scope's advice
 *   (advice.fixtures.ts), Laws 1 to 3 find, for each, the problems the specification states: none for a probe under its
 *   whole advice, nor with its key's equality by an extension's operator, nor for a scope of two statements, a
 *   FROM-less EXISTS over a probe or a write target read by the tuple id a probe found; for the probe's index item
 *   dropped, the tie's index (Laws 1 and 2); none for a sibling index named, f2, which it does not store, a residual
 *   filter Law 2 admits (INDEXES' rule: the budget holds the rows it reads); for the probe printed as a plain join, doc in a join's condition (Law 2), the Join Filter's
 *   equality told even where its plan claims the read bound without doc; for a correlated EXISTS PostgreSQL flattens, a
 *   join grizzle never named (Laws 1 and 2); for an alias two statements share, its items conflicting and matched twice
 *   (Laws 1 and 3); for an index advised for a read no index condition serves, its seq scan disabled (Law 1); none for a
 *   whole view read at two levels, its body's one alias at each, each read judged by its own scan's range table entry
 *   (Laws 2 and 3); none for a read of a system catalog, which grizzle carries nothing for; and for a flight whose
 *   advice reached no transaction, a plan under no advice (Law 1).
 * - **Oracle:** the specification: each plan's problems, stated, from the measurements of e1 to e3 and lanes LAWS and
 *   LAWS2.
 * - **Box, exhausted:** the fifteen cases, the plain join's plan under two claims.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type AdviceCase,
	adviceBox,
	adviceCases,
	problemsOf
} from "#test/unit/support/advice.fixtures.ts"

/** The problems the laws find with each case, by the specification. */
const expected: { readonly [C in AdviceCase]: ReadonlyArray<string> } = {
	probe: [],
	dropped: [
		"the flight, the probe: PostgreSQL planned INDEX_SCAN(n@s public.node_doc_f1), which grizzle does not carry",
		"the flight: n@s.f2 is bound, read outside its index condition and in its filter of its Index Scan of n using node_doc_f1"
	],
	sibling: [],
	plain: [
		"the flight: its Nested Loop filters d.doc = n.doc after joining, a binding of a stored read no index condition holds",
		"the flight: n.doc is bound, read outside its index condition and in a join's condition of its Index Scan of n using node_pkey"
	],
	unclaimed: [
		"the flight: its Nested Loop filters d.doc = n.doc after joining, a binding of a stored read no index condition holds"
	],
	flattened: [
		"the flight, the EXISTS: PostgreSQL planned JOIN_ORDER(d n), which grizzle does not carry",
		"the flight, the EXISTS: PostgreSQL planned NESTED_LOOP_PLAIN(n), which grizzle does not carry",
		"the flight, the EXISTS: PostgreSQL planned INDEX_SCAN(n public.node_doc_f1), which grizzle does not carry",
		"the flight, the EXISTS: PostgreSQL planned NO_GATHER(n), which grizzle does not carry",
		"the flight: its Nested Loop filters d.doc = n.doc after joining, a binding of a stored read no index condition holds",
		"the flight: the read n@exists_1 is scanned 0 times",
		"the flight: INDEX_SCAN(n@exists_1 public.node_pkey) is matched in 0 of its statements",
		"the flight: NO_GATHER(n@exists_1) is matched in 0 of its statements"
	],
	qualified: [],
	reused: [
		"the flight, the doc read: INDEX_SCAN(r1 public.doc_pkey) matched, conflicting, failed",
		"the flight, the doc read: INDEX_SCAN(r1 public.node_pkey) matched, conflicting, failed",
		"the flight, the doc read: PostgreSQL planned SEQ_SCAN(r1), which grizzle does not carry",
		"the flight, the doc read: grizzle carries INDEX_SCAN(r1 public.doc_pkey), which PostgreSQL did not plan",
		"the flight, the doc read: grizzle carries INDEX_SCAN(r1 public.node_pkey), which PostgreSQL did not plan",
		"the flight, the node read: INDEX_SCAN(r1 public.doc_pkey) matched, conflicting, failed",
		"the flight, the node read: INDEX_SCAN(r1 public.node_pkey) matched, conflicting, failed",
		"the flight, the node read: PostgreSQL planned INDEX_SCAN(r1 public.node_doc_f1), which grizzle does not carry",
		"the flight, the node read: grizzle carries INDEX_SCAN(r1 public.doc_pkey), which PostgreSQL did not plan",
		"the flight, the node read: grizzle carries INDEX_SCAN(r1 public.node_pkey), which PostgreSQL did not plan",
		"the flight: the read r1 is scanned 2 times",
		"the flight: 2 items are r1",
		"the flight: INDEX_SCAN(r1 public.doc_pkey) is matched in 2 of its statements (the doc read, the node read)",
		"the flight: NO_GATHER(r1) is matched in 2 of its statements (the doc read, the node read)",
		"the flight: INDEX_SCAN(r1 public.node_pkey) is matched in 2 of its statements (the doc read, the node read)"
	],
	scope: [],
	result: [],
	tid: [],
	disabled: [
		"the flight, the read by v: INDEX_SCAN(n public.node_doc_f1) matched, failed",
		"the flight, the read by v: PostgreSQL planned SEQ_SCAN(n), which grizzle does not carry",
		"the flight, the read by v: grizzle carries INDEX_SCAN(n public.node_doc_f1), which PostgreSQL did not plan",
		"the flight, the read by v: its Seq Scan of n is disabled"
	],
	views: [],
	catalog: [],
	unadvised: [
		"the flight: its vehicle holds no INDEX_SCAN(r1 public.doc_pkey)",
		"the flight: its vehicle holds no NO_GATHER(r1)",
		"the flight, the doc read: planned under no advice",
		"the flight, the doc read: PostgreSQL planned SEQ_SCAN(r1), which grizzle does not carry",
		"the flight, the doc read: PostgreSQL planned NO_GATHER(r1), which grizzle does not carry",
		"the flight: r1.doc is bound, read outside its index condition and in its filter of its Seq Scan of r1",
		"the flight: INDEX_SCAN(r1 public.doc_pkey) is matched in 0 of its statements",
		"the flight: NO_GATHER(r1) is matched in 0 of its statements"
	]
}

/** Each plan's problems are the ones the specification states. */
export const theLawsFindExactlyTheFailuresOfEachMeasuredPlan = property.exhaust(finite(adviceBox), {
	needs: {},
	situations: adviceCases satisfies ReadonlyArray<Reached<AdviceCase>>,
	check: (_, k: Case<AdviceCase>) => (c) =>
		Effect.sync(() => {
			assert.deepEqual(problemsOf(c), expected[c], `the laws over ${c}`)
			k.note(c)
		}),
	oracle: {
		kind: "specification",
		name: "each measured plan's problems under Laws 1 to 3, stated"
	},
	box: "the plans PostgreSQL 19.0 made for a probe, its mutants, a scope of two statements, a FROM-less EXISTS, a tuple-id target, a disabled scan, a whole view read at two levels, a catalog read and a flight under no advice",
	kept: [],
	kills: [
		{
			file: "test/support/advice.ts",
			original: '(x.feedback.match === "matched" && x.feedback.flags.length === 0)',
			replacement: 'x.feedback.match === "matched"',
			why: "An atom PostgreSQL matched but flagged is taken as applied: an alias two statements share, whose items are conflicting and failed, passes Law 1 (e3 P7, G10)."
		},
		{
			file: "test/support/advice.ts",
			original: "onSome: (p) => minted.has(p)",
			replacement: "onSome: () => true",
			why: "A target at a level PostgreSQL named is read as grizzle's: the NO_GATHER of a probe at its sublink's level, which no carried advice can name, fails Law 1 for a sound EXISTS over a probe."
		},
		{
			file: "test/support/advice.ts",
			original: 'indexCond: columnsAt(o, ["Index Cond", "TID Cond"]),',
			replacement: 'indexCond: columnsAt(o, ["Index Cond"]),',
			why: "A TID scan's condition is no index condition: a write target read by the tuple id its probe found reads its ctid unbound."
		},
		{
			file: "test/support/advice.ts",
			original: "\t\treturn matchedIn.length === 1",
			replacement: "\t\treturn matchedIn.length >= 1",
			why: "An atom matched in two statements of its scope passes Law 3: an alias two statements share goes unseen there."
		},
		{
			file: "test/support/advice.ts",
			original: "storedAliases.has(a.alias) || storedAliases.has(b.alias)",
			replacement: "false",
			why: "An equality a nested loop's Join Filter states between a stored read's column and another's is read as no lost binding: a keyed read printed as a plain join, its binding claimed nowhere, passes Law 2 (e3 P1)."
		},
		{
			file: "test/support/advice.ts",
			original: "const stored = read.stores.includes(column)",
			replacement: "const stored = true",
			why: "Every column a read binds held to its index condition, one its index does not store among them: the sibling's f2, a residual filter on the rows (doc, f1) reach, is refused, where Law 2 admits it and the budget holds the rows (INDEXES' rule)."
		},
		{
			file: "test/support/advice.ts",
			original: "Option.contains(n.target, read.target) &&",
			replacement: "Option.contains(n.alias, read.alias) &&",
			why: "A read's scan found by the alias EXPLAIN displays, not its range table entry's target: a whole view read at two levels, displayed v1 and v1_1, has its second read judged by its first's scan, f2 outside an index condition that holds it."
		},
		{
			file: "test/support/advice.ts",
			original: '\t...repeated(scope.label, "items", scope.targets),',
			replacement: '\t...repeated(scope.label, "items", scope.aliases),',
			why: "Two items sharing an alias counted as one target: a whole view read at two levels, v1@r4 and v1@r6, its body's one alias at each, fails Law 3."
		},
		{
			file: "test/support/advice.ts",
			original: "\t\t\t\t(a) => !Arr.some(a.relations, (r) => catalog.has(targetText(r)))\n",
			replacement: "\t\t\t\t() => true\n",
			why: "A system catalog's read is held to advice grizzle never carries for it: PostgreSQL's own index of pg_class fails Law 1 for a catalog read sql/catalog.ts states, which stays cost-chosen."
		},
		{
			file: "test/support/advice.ts",
			original: 'disabled: o["Disabled"] === true,',
			replacement: "disabled: false,",
			why: "A node the planner disabled, a path the advice forbade that nothing could replace, passes Law 1 unread."
		}
	]
})
