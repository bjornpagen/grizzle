/**
 * What advice.test.ts reads: its box of plans PostgreSQL 19.0 printed for grizzle's statement shapes, each under the
 * advice a scope carries, and the scope each was planned in. Every plan was measured on a private cluster (lane LAWS,
 * ~/.cache/grizzle/ADVICE e1-e3 and LAWS' l3-l4): tables doc (doc) and node (doc, f1, f2) beside node's index on
 * (doc, f1), counted empty (vacuumed by a second session while their load was open), so every path costs about a row
 * and the planner breaks each tie by the latest index. Keys the laws never read are left out.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Result } from "effect"
import {
	type AdvisedPlan,
	advisedPlanOf,
	type BoundRead,
	type LawScope,
	lawsOver,
	type PlannedScope,
	type ScopeStatement
} from "#test/support/advice.ts"

/** a probe under its whole advice, counted empty (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const probePlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_pkey",
							"Relation Name": "node",
							Alias: "n",
							Disabled: false,
							"Index Cond": "((n.doc = d.doc) AND (n.f1 = 1) AND (n.f2 = $2))"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n@s public.node_pkey) /* matched */\nJOIN_ORDER(d s) /* matched */\nNESTED_LOOP_PLAIN(s) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(s) /* matched */\nNO_GATHER(n@s) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_pkey)\nNO_GATHER(d s n@s)"
	}
]

/** the same probe, its scan's item dropped: the tie's index (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const droppedPlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_doc_f1",
							"Relation Name": "node",
							Alias: "n",
							Disabled: false,
							"Index Cond": "((n.doc = d.doc) AND (n.f1 = 1))",
							Filter: "(n.f2 = $2)"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nJOIN_ORDER(d s) /* matched */\nNESTED_LOOP_PLAIN(s) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(s) /* matched */\nNO_GATHER(n@s) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_doc_f1)\nNO_GATHER(d s n@s)"
	}
]

/** the same probe advised through the sibling (doc, f1) (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const siblingPlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_doc_f1",
							"Relation Name": "node",
							Alias: "n",
							Disabled: false,
							"Index Cond": "((n.doc = d.doc) AND (n.f1 = 1))",
							Filter: "(n.f2 = $2)"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n@s public.node_doc_f1) /* matched */\nJOIN_ORDER(d s) /* matched */\nNESTED_LOOP_PLAIN(s) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(s) /* matched */\nNO_GATHER(n@s) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_doc_f1)\nNO_GATHER(d s n@s)"
	}
]

/** the probe's read printed as a plain join, under the whole advice (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const plainPlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			"Join Filter": "(d.doc = n.doc)",
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Index Scan",
					"Index Name": "node_pkey",
					"Relation Name": "node",
					Alias: "n",
					Disabled: false,
					"Index Cond": "((n.f1 = 1) AND (n.f2 = $2))"
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n public.node_pkey) /* matched */\nJOIN_ORDER(d n) /* matched */\nNESTED_LOOP_PLAIN(n) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(n) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d n)\nNESTED_LOOP_PLAIN(n)\nSEQ_SCAN(d)\nINDEX_SCAN(n public.node_pkey)\nNO_GATHER(d n)"
	}
]

/** a correlated EXISTS (... LIMIT 1), flattened into a semi-join (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const flattenedPlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			"Join Filter": "(d.doc = n.doc)",
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Index Scan",
					"Index Name": "node_doc_f1",
					"Relation Name": "node",
					Alias: "n",
					Disabled: false,
					"Index Cond": "(n.f1 = 1)",
					Filter: "(n.f2 = 2)"
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n@exists_1 public.node_pkey) /* not matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(n@exists_1) /* not matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d n)\nNESTED_LOOP_PLAIN(n)\nSEQ_SCAN(d)\nINDEX_SCAN(n public.node_doc_f1)\nNO_GATHER(d n)"
	}
]

/** the first of two statements whose alias r1 names doc (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const reusedFirstPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r1",
			Disabled: false,
			Filter: "(r1.doc = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched, conflicting, failed */\nINDEX_SCAN(r1 public.node_pkey) /* matched, conflicting, failed */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r1) /* matched */\n",
		"Generated Plan Advice": "SEQ_SCAN(r1)\nNO_GATHER(r1)"
	}
]

/** the second, whose r1 names node (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const reusedSecondPlan: unknown = [
	{
		Plan: {
			"Node Type": "Index Scan",
			"Index Name": "node_doc_f1",
			"Relation Name": "node",
			Alias: "r1",
			Disabled: false,
			"Index Cond": "((r1.doc = $1) AND (r1.f1 = $2))",
			Filter: "(r1.f2 = $3)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched, conflicting, failed */\nINDEX_SCAN(r1 public.node_pkey) /* matched, conflicting, failed */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r1) /* matched */\n",
		"Generated Plan Advice": "INDEX_SCAN(r1 public.node_doc_f1)\nNO_GATHER(r1)"
	}
]

/** the first statement of a scope of two (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const scopeFirstPlan: unknown = [
	{
		Plan: {
			"Node Type": "Index Scan",
			"Index Name": "doc_pkey",
			"Relation Name": "doc",
			Alias: "r1",
			Disabled: false,
			"Index Cond": "(r1.doc = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched */\nSEQ_SCAN(r2) /* not matched */\nINDEX_SCAN(r3@r4 public.node_pkey) /* not matched */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r2) /* not matched */\nNO_GATHER(r3@r4) /* not matched */\n",
		"Generated Plan Advice": "INDEX_SCAN(r1 public.doc_pkey)\nNO_GATHER(r1)"
	}
]

/** the second, its EXISTS over a probe r4 (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const scopeSecondPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r2",
			Disabled: false,
			Filter: "((r2.owner = $1) AND EXISTS(SubPlan exists_1))",
			Plans: [
				{
					"Node Type": "Subquery Scan",
					"Subplan Name": "SubPlan exists_1",
					Alias: "r4",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Limit",
							Disabled: false,
							Plans: [
								{
									"Node Type": "Index Scan",
									"Index Name": "node_pkey",
									"Relation Name": "node",
									Alias: "r3",
									Disabled: false,
									"Index Cond":
										"((r3.doc = r2.doc) AND (r3.f1 = '1'::bigint) AND (r3.f2 = '2'::bigint))"
								}
							]
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* not matched */\nSEQ_SCAN(r2) /* matched */\nINDEX_SCAN(r3@r4 public.node_pkey) /* matched */\nNO_GATHER(r1) /* not matched */\nNO_GATHER(r2) /* matched */\nNO_GATHER(r3@r4) /* matched */\n",
		"Generated Plan Advice":
			"SEQ_SCAN(r2)\nINDEX_SCAN(r3@r4 public.node_pkey)\nNO_GATHER(r2 r4@exists_1 r3@r4)"
	}
]

/** a FROM-less EXISTS over a probe (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const resultPlan: unknown = [
	{
		Plan: {
			"Node Type": "Result",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Limit",
					"Subplan Name": "InitPlan exists_1",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_pkey",
							"Relation Name": "node",
							Alias: "r5",
							Disabled: false,
							"Index Cond": "((r5.doc = $1) AND (r5.f1 = $2) AND (r5.f2 = $3))"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r5@r6 public.node_pkey) /* matched */\nNO_GATHER(r5@r6) /* matched */\n",
		"Generated Plan Advice":
			'INDEX_SCAN(r5@r6 public.node_pkey)\nNO_GATHER("*RESULT*" r6@exists_1 r5@r6)'
	}
]

/** a DELETE whose target is read by the tuple id a probe found (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const tidPlan: unknown = [
	{
		Plan: {
			"Node Type": "ModifyTable",
			"Relation Name": "node",
			Alias: "r9",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Nested Loop",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Nested Loop",
							Disabled: false,
							Plans: [
								{ "Node Type": "Function Scan", Alias: "r7", Disabled: false },
								{
									"Node Type": "Subquery Scan",
									Alias: "r8",
									Disabled: false,
									Plans: [
										{
											"Node Type": "Limit",
											Disabled: false,
											Plans: [
												{
													"Node Type": "Index Scan",
													"Index Name": "node_pkey",
													"Relation Name": "node",
													Alias: "r10",
													Disabled: false,
													"Index Cond":
														"((r10.doc = r7.doc) AND (r10.f1 = r7.f1) AND (r10.f2 = r7.f2))"
												}
											]
										}
									]
								}
							]
						},
						{
							"Node Type": "Tid Scan",
							"Relation Name": "node",
							Alias: "r9",
							Disabled: false,
							"TID Cond": "(r9.ctid = r8.tid)"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r10@r8 public.node_pkey) /* matched */\nTID_SCAN(r9) /* matched */\nJOIN_ORDER(r7 r8 r9) /* matched */\nNESTED_LOOP_PLAIN(r8) /* matched */\nNESTED_LOOP_PLAIN(r9) /* matched */\nNO_GATHER(r7) /* matched */\nNO_GATHER(r8) /* matched */\nNO_GATHER(r9) /* matched */\nNO_GATHER(r10@r8) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(r7 r8 r9)\nNESTED_LOOP_PLAIN(r8 r9)\nINDEX_SCAN(r10@r8 public.node_pkey)\nTID_SCAN(r9)\nNO_GATHER(r9 r7 r8 r10@r8)"
	}
]

/** a statement planned under no advice (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const unadvisedPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r1",
			Disabled: false,
			Filter: "(r1.doc = $1)"
		},
		"Generated Plan Advice": "SEQ_SCAN(r1)\nNO_GATHER(r1)"
	}
]

/** The probe, its key's equality on f2 by an extension's operator, printed by its schema as PostgreSQL prints an operator outside the search path (serving's red at e42937e8b, a vector key). */
const qualifiedPlan: unknown = [
	{
		Plan: {
			"Node Type": "Nested Loop",
			Disabled: false,
			Plans: [
				{
					"Node Type": "Seq Scan",
					"Relation Name": "doc",
					Alias: "d",
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_pkey",
							"Relation Name": "node",
							Alias: "n",
							Disabled: false,
							"Index Cond": '((n.doc = d.doc) AND (n.f1 = 1) AND (n.f2 OPERATOR("ext".=) $2))'
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n@s public.node_pkey) /* matched */\nJOIN_ORDER(d s) /* matched */\nNESTED_LOOP_PLAIN(s) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(s) /* matched */\nNO_GATHER(n@s) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_pkey)\nNO_GATHER(d s n@s)"
	}
]

/** An index advised for a read no index condition serves: its seq scan disabled (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)). */
const disabledPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "node",
			Alias: "n",
			Disabled: true,
			Filter: "(n.v = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(n public.node_doc_f1) /* matched, failed */\nNO_GATHER(n) /* matched */\n",
		"Generated Plan Advice": "SEQ_SCAN(n)\nNO_GATHER(n)"
	}
]

/**
 * A case of the box: a plan, or the plans of a scope, of a shape grizzle prints or a mutant of it:
 * - `probe`: a key read of node per doc row, printed as grizzle's probe (`CROSS JOIN LATERAL (... LIMIT 1) s`), under
 *   its whole advice: every bound column an index condition;
 * - `dropped`: the same probe, its scan's INDEX_SCAN item dropped: PostgreSQL breaks the tie by (doc, f1), f2 a filter;
 * - `sibling`: the probe advised through the sibling (doc, f1): obeyed and matched, f2 a filter;
 * - `plain`: the probe's read printed as a plain join under the whole advice: doc in the Join Filter (e3 P1);
 * - `flattened`: a correlated EXISTS (... LIMIT 1) PostgreSQL flattens into a semi-join (e3 P5);
 * - `qualified`: the probe, its key's equality by an extension's operator, which PostgreSQL prints by its schema
 *   (`OPERATOR("ext".=)`, as a vector key's): bound all the same;
 * - `reused`: a scope of two statements whose alias r1 names doc in one and node in the other;
 * - `scope`: a scope of two statements, the second's EXISTS over a probe r4;
 * - `result`: a FROM-less EXISTS over a probe: NO_GATHER of `"*RESULT*"` and of the probe at the sublink's level are
 *   PostgreSQL's;
 * - `tid`: a DELETE whose target a probe found, read by its tuple id;
 * - `disabled`: an index advised for a read by a column no index holds: PostgreSQL disables the one path left;
 * - `unadvised`: a flight that carried its advice to no transaction.
 */
export const adviceCases = [
	"probe",
	"dropped",
	"sibling",
	"plain",
	"flattened",
	"qualified",
	"reused",
	"scope",
	"result",
	"tid",
	"disabled",
	"unadvised"
] as const

export type AdviceCase = (typeof adviceCases)[number]

export const adviceBox: Gen<AdviceCase> = (source) => source.draw(element(adviceCases))

/** A plan of the box, read: one PostgreSQL printed is always one the reader reads. */
const read = (cell: unknown): AdvisedPlan => Result.getOrThrow(advisedPlanOf(cell))

/** The probe's statement and its read of node, bound at (doc, f1, f2). */
const probeStatement: ScopeStatement = {
	label: "the probe",
	sql: "SELECT s.v FROM doc d CROSS JOIN LATERAL (SELECT n.v FROM node n WHERE n.doc = d.doc AND n.f1 = 1 AND n.f2 = $2 LIMIT 1) s WHERE d.owner = $1"
}
const nodeRead: BoundRead = { alias: "n", bound: ["doc", "f1", "f2"] }

/** A flight of one statement, carrying `advice`, minting `minted`, its reads `reads`. */
const flight = (
	advice: string,
	minted: ReadonlyArray<string>,
	reads: ReadonlyArray<BoundRead>,
	statement: ScopeStatement
): LawScope => ({
	label: "the flight",
	advice,
	minted,
	reads,
	statements: [statement],
	vehicle: { kind: "flight" }
})

const probeAdvice =
	"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) INDEX_SCAN(n@s public.node_pkey) NO_GATHER(d s n@s)"

/** Each case's scope and the plans PostgreSQL made under it. */
const cases: { readonly [C in AdviceCase]: readonly [LawScope, PlannedScope] } = {
	probe: [
		flight(probeAdvice, ["d", "s", "n"], [nodeRead], probeStatement),
		{ inForce: probeAdvice, plans: [read(probePlan)] }
	],
	dropped: [
		flight(
			"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) NO_GATHER(d s n@s)",
			["d", "s", "n"],
			[nodeRead],
			probeStatement
		),
		{
			inForce: "JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) NO_GATHER(d s n@s)",
			plans: [read(droppedPlan)]
		}
	],
	sibling: [
		flight(
			"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) INDEX_SCAN(n@s public.node_doc_f1) NO_GATHER(d s n@s)",
			["d", "s", "n"],
			[nodeRead],
			probeStatement
		),
		{
			inForce:
				"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) INDEX_SCAN(n@s public.node_doc_f1) NO_GATHER(d s n@s)",
			plans: [read(siblingPlan)]
		}
	],
	plain: [
		flight(
			"JOIN_ORDER(d n) NESTED_LOOP_PLAIN(n) SEQ_SCAN(d) INDEX_SCAN(n public.node_pkey) NO_GATHER(d n)",
			["d", "n"],
			[nodeRead],
			{
				label: "the plain join",
				sql: "SELECT n.v FROM doc d JOIN node n ON n.doc = d.doc AND n.f1 = 1 AND n.f2 = $2 WHERE d.owner = $1"
			}
		),
		{
			inForce:
				"JOIN_ORDER(d n) NESTED_LOOP_PLAIN(n) SEQ_SCAN(d) INDEX_SCAN(n public.node_pkey) NO_GATHER(d n)",
			plans: [read(plainPlan)]
		}
	],
	flattened: [
		flight(
			"SEQ_SCAN(d) INDEX_SCAN(n@exists_1 public.node_pkey) NO_GATHER(d n@exists_1)",
			["d", "n", "exists_1"],
			[{ alias: "n", bound: ["doc", "f1", "f2"] }],
			{
				label: "the EXISTS",
				sql: "SELECT d.doc FROM doc d WHERE d.owner = $1 AND EXISTS (SELECT FROM node n WHERE n.doc = d.doc AND n.f1 = 1 AND n.f2 = 2 LIMIT 1)"
			}
		),
		{
			inForce: "SEQ_SCAN(d) INDEX_SCAN(n@exists_1 public.node_pkey) NO_GATHER(d n@exists_1)",
			plans: [read(flattenedPlan)]
		}
	],
	qualified: [
		flight(probeAdvice, ["d", "s", "n"], [nodeRead], probeStatement),
		{ inForce: probeAdvice, plans: [read(qualifiedPlan)] }
	],
	reused: [
		{
			label: "the flight",
			advice:
				"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) INDEX_SCAN(r1 public.node_pkey) NO_GATHER(r1)",
			minted: ["r1", "r1"],
			reads: [{ alias: "r1", bound: ["doc"] }],
			statements: [
				{
					label: "the doc read",
					sql: "SELECT r1.owner FROM public.doc AS r1 WHERE r1.doc = $1::int8"
				},
				{
					label: "the node read",
					sql: "SELECT r1.v FROM public.node AS r1 WHERE r1.doc = $1::int8 AND r1.f1 = $2::int8 AND r1.f2 = $3::int8"
				}
			],
			vehicle: { kind: "flight" }
		},
		{
			inForce:
				"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) INDEX_SCAN(r1 public.node_pkey) NO_GATHER(r1)",
			plans: [read(reusedFirstPlan), read(reusedSecondPlan)]
		}
	],
	scope: [
		{
			label: "the flight",
			advice:
				"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) SEQ_SCAN(r2) INDEX_SCAN(r3@r4 public.node_pkey) NO_GATHER(r2) NO_GATHER(r3@r4)",
			minted: ["r1", "r2", "r3", "r4"],
			reads: [
				{ alias: "r1", bound: ["doc"] },
				{ alias: "r3", bound: ["doc", "f1", "f2"] }
			],
			statements: [
				{
					label: "the doc read",
					sql: "SELECT r1.owner FROM public.doc AS r1 WHERE r1.doc = $1::int8"
				},
				{
					label: "the owner's docs",
					sql: "SELECT r2.doc FROM public.doc AS r2 WHERE r2.owner = $1::int8 AND EXISTS (SELECT FROM (SELECT r3.v FROM public.node AS r3 WHERE r3.doc = r2.doc AND r3.f1 = 1::int8 AND r3.f2 = 2::int8 LIMIT 1) AS r4)"
				}
			],
			vehicle: { kind: "flight" }
		},
		{
			inForce:
				"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) SEQ_SCAN(r2) INDEX_SCAN(r3@r4 public.node_pkey) NO_GATHER(r2) NO_GATHER(r3@r4)",
			plans: [read(scopeFirstPlan), read(scopeSecondPlan)]
		}
	],
	result: [
		flight(
			"INDEX_SCAN(r5@r6 public.node_pkey) NO_GATHER(r5@r6)",
			["r5", "r6"],
			[{ alias: "r5", bound: ["doc", "f1", "f2"] }],
			{
				label: "the EXISTS",
				sql: "SELECT EXISTS (SELECT FROM (SELECT FROM public.node AS r5 WHERE r5.doc = $1::int8 AND r5.f1 = $2::int8 AND r5.f2 = $3::int8 LIMIT 1) AS r6)"
			}
		),
		{ inForce: "INDEX_SCAN(r5@r6 public.node_pkey) NO_GATHER(r5@r6)", plans: [read(resultPlan)] }
	],
	tid: [
		flight(
			"JOIN_ORDER(r7 r8 r9) NESTED_LOOP_PLAIN(r8) NESTED_LOOP_PLAIN(r9) INDEX_SCAN(r10@r8 public.node_pkey) TID_SCAN(r9) NO_GATHER(r7 r8 r9 r10@r8)",
			["r7", "r8", "r9", "r10"],
			[
				{ alias: "r10", bound: ["doc", "f1", "f2"] },
				{ alias: "r9", bound: ["ctid"] }
			],
			{
				label: "the delete",
				sql: "DELETE FROM public.node AS r9 USING ROWS FROM (pg_catalog.unnest($1::int8[]), pg_catalog.unnest($2::int8[]), pg_catalog.unnest($3::int8[])) AS r7(doc, f1, f2) CROSS JOIN LATERAL (SELECT r10.ctid AS tid FROM public.node AS r10 WHERE r10.doc = r7.doc AND r10.f1 = r7.f1 AND r10.f2 = r7.f2 LIMIT 1) AS r8 WHERE r9.ctid = r8.tid"
			}
		),
		{
			inForce:
				"JOIN_ORDER(r7 r8 r9) NESTED_LOOP_PLAIN(r8) NESTED_LOOP_PLAIN(r9) INDEX_SCAN(r10@r8 public.node_pkey) TID_SCAN(r9) NO_GATHER(r7 r8 r9 r10@r8)",
			plans: [read(tidPlan)]
		}
	],
	disabled: [
		flight("INDEX_SCAN(n public.node_doc_f1) NO_GATHER(n)", ["n"], [], {
			label: "the read by v",
			sql: "SELECT n.f1 FROM node n WHERE n.v = $1::text"
		}),
		{ inForce: "INDEX_SCAN(n public.node_doc_f1) NO_GATHER(n)", plans: [read(disabledPlan)] }
	],
	unadvised: [
		flight(
			"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1)",
			["r1"],
			[{ alias: "r1", bound: ["doc"] }],
			{
				label: "the doc read",
				sql: "SELECT r1.owner FROM public.doc AS r1 WHERE r1.doc = $1::int8"
			}
		),
		{ inForce: "", plans: [read(unadvisedPlan)] }
	]
}

/** The problems Laws 1 to 3 find with a case. */
export const problemsOf = (c: AdviceCase): ReadonlyArray<string> => {
	const [scope, planned] = cases[c]
	return lawsOver(scope, planned)
}
