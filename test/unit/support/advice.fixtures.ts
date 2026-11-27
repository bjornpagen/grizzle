/**
 * What advice.test.ts reads: its box of plans PostgreSQL 19.0 printed for grizzle's statement shapes, each under the
 * advice a scope carries, and the scope each was planned in. Every plan was measured on a private cluster (lane LAWS,
 * ~/.cache/grizzle/ADVICE e1-e3 and LAWS' l3-l4): tables doc (doc) and node (doc, f1, f2) beside node's index on
 * (doc, f1), counted empty (vacuumed by a second session while their load was open), so every path costs about a row
 * and the planner breaks each tie by the latest index. Each scan's range table entry and each plan's range table
 * (pg_overexplain's RANGE_TABLE: an entry's index, alias and subplan) were measured again on such a cluster, each
 * statement under its case's advice, its scans those of the plan recorded (lane LAWS2). Keys the laws never read are
 * left out.
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

/** a probe under its whole advice, counted empty (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
					"Scan RTI": 1,
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
							"Scan RTI": 4,
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
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_pkey)\nNO_GATHER(d s n@s)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "s ()" },
			{ RTI: 3, Eref: "unnamed_join (doc, owner, v)" },
			{ RTI: 4, Subplan: "s", Alias: "n ()" }
		]
	}
]

/** the same probe, its scan's item dropped: the tie's index (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
					"Scan RTI": 1,
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
							"Scan RTI": 4,
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
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_doc_f1)\nNO_GATHER(d s n@s)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "s ()" },
			{ RTI: 3, Eref: "unnamed_join (doc, owner, v)" },
			{ RTI: 4, Subplan: "s", Alias: "n ()" }
		]
	}
]

/** the same probe advised through the sibling (doc, f1) (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
					"Scan RTI": 1,
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
							"Scan RTI": 4,
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
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_doc_f1)\nNO_GATHER(d s n@s)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "s ()" },
			{ RTI: 3, Eref: "unnamed_join (doc, owner, v)" },
			{ RTI: 4, Subplan: "s", Alias: "n ()" }
		]
	}
]

/** the probe's read printed as a plain join, under the whole advice (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
					"Scan RTI": 1,
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Index Scan",
					"Index Name": "node_pkey",
					"Relation Name": "node",
					Alias: "n",
					"Scan RTI": 2,
					Disabled: false,
					"Index Cond": "((n.f1 = 1) AND (n.f2 = $2))"
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n public.node_pkey) /* matched */\nJOIN_ORDER(d n) /* matched */\nNESTED_LOOP_PLAIN(n) /* matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(n) /* matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d n)\nNESTED_LOOP_PLAIN(n)\nSEQ_SCAN(d)\nINDEX_SCAN(n public.node_pkey)\nNO_GATHER(d n)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "n ()" },
			{ RTI: 3, Eref: "unnamed_join (doc, owner, doc, f1, f2, v)" }
		]
	}
]

/** a correlated EXISTS (... LIMIT 1), flattened into a semi-join (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
					"Scan RTI": 1,
					Disabled: false,
					Filter: "(d.owner = $1)"
				},
				{
					"Node Type": "Index Scan",
					"Index Name": "node_doc_f1",
					"Relation Name": "node",
					Alias: "n",
					"Scan RTI": 2,
					Disabled: false,
					"Index Cond": "(n.f1 = 1)",
					Filter: "(n.f2 = 2)"
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(d) /* matched */\nINDEX_SCAN(n@exists_1 public.node_pkey) /* not matched */\nNO_GATHER(d) /* matched */\nNO_GATHER(n@exists_1) /* not matched */\n",
		"Generated Plan Advice":
			"JOIN_ORDER(d n)\nNESTED_LOOP_PLAIN(n)\nSEQ_SCAN(d)\nINDEX_SCAN(n public.node_doc_f1)\nNO_GATHER(d n)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "n ()" }
		]
	}
]

/** the first of two statements whose alias r1 names doc (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const reusedFirstPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r1",
			"Scan RTI": 1,
			Disabled: false,
			Filter: "(r1.doc = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched, conflicting, failed */\nINDEX_SCAN(r1 public.node_pkey) /* matched, conflicting, failed */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r1) /* matched */\n",
		"Generated Plan Advice": "SEQ_SCAN(r1)\nNO_GATHER(r1)",
		"Range Table": [{ RTI: 1, Alias: "r1 ()" }]
	}
]

/** the second, whose r1 names node (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const reusedSecondPlan: unknown = [
	{
		Plan: {
			"Node Type": "Index Scan",
			"Index Name": "node_doc_f1",
			"Relation Name": "node",
			Alias: "r1",
			"Scan RTI": 1,
			Disabled: false,
			"Index Cond": "((r1.doc = $1) AND (r1.f1 = $2))",
			Filter: "(r1.f2 = $3)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched, conflicting, failed */\nINDEX_SCAN(r1 public.node_pkey) /* matched, conflicting, failed */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r1) /* matched */\n",
		"Generated Plan Advice": "INDEX_SCAN(r1 public.node_doc_f1)\nNO_GATHER(r1)",
		"Range Table": [{ RTI: 1, Alias: "r1 ()" }]
	}
]

/** the first statement of a scope of two (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const scopeFirstPlan: unknown = [
	{
		Plan: {
			"Node Type": "Index Scan",
			"Index Name": "doc_pkey",
			"Relation Name": "doc",
			Alias: "r1",
			"Scan RTI": 1,
			Disabled: false,
			"Index Cond": "(r1.doc = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(r1 public.doc_pkey) /* matched */\nSEQ_SCAN(r2) /* not matched */\nINDEX_SCAN(r3@r4 public.node_pkey) /* not matched */\nNO_GATHER(r1) /* matched */\nNO_GATHER(r2) /* not matched */\nNO_GATHER(r3@r4) /* not matched */\n",
		"Generated Plan Advice": "INDEX_SCAN(r1 public.doc_pkey)\nNO_GATHER(r1)",
		"Range Table": [{ RTI: 1, Alias: "r1 ()" }]
	}
]

/** the second, its EXISTS over a probe r4 (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const scopeSecondPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r2",
			"Scan RTI": 1,
			Disabled: false,
			Filter: "((r2.owner = $1) AND EXISTS(SubPlan exists_1))",
			Plans: [
				{
					"Node Type": "Subquery Scan",
					"Subplan Name": "SubPlan exists_1",
					Alias: "r4",
					"Scan RTI": 2,
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
									"Scan RTI": 3,
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
			"SEQ_SCAN(r2)\nINDEX_SCAN(r3@r4 public.node_pkey)\nNO_GATHER(r2 r4@exists_1 r3@r4)",
		"Range Table": [
			{ RTI: 1, Alias: "r2 ()" },
			{ RTI: 2, Subplan: "exists_1", Alias: "r4 ()" },
			{ RTI: 3, Subplan: "r4", Alias: "r3 ()" }
		]
	}
]

/** a FROM-less EXISTS over a probe (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
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
							"Scan RTI": 3,
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
			'INDEX_SCAN(r5@r6 public.node_pkey)\nNO_GATHER("*RESULT*" r6@exists_1 r5@r6)',
		"Range Table": [
			{ RTI: 1, Eref: '"*RESULT*" ()' },
			{ RTI: 2, Subplan: "exists_1", Alias: "r6 ()" },
			{ RTI: 3, Subplan: "r6", Alias: "r5 ()" }
		]
	}
]

/** a DELETE whose target is read by the tuple id a probe found (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const tidPlan: unknown = [
	{
		Plan: {
			"Node Type": "ModifyTable",
			"Relation Name": "node",
			Alias: "r9",
			"Scan RTI": 1,
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
									"Scan RTI": 3,
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
													"Scan RTI": 5,
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
							"Scan RTI": 1,
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
			"JOIN_ORDER(r7 r8 r9)\nNESTED_LOOP_PLAIN(r8 r9)\nINDEX_SCAN(r10@r8 public.node_pkey)\nTID_SCAN(r9)\nNO_GATHER(r9 r7 r8 r10@r8)",
		"Range Table": [
			{ RTI: 1, Alias: "r9 ()" },
			{ RTI: 2, Alias: "r7 (doc, f1, f2)" },
			{ RTI: 3, Alias: "r8 ()" },
			{ RTI: 4, Eref: "unnamed_join (doc, f1, f2, tid)" },
			{ RTI: 5, Subplan: "r8", Alias: "r10 ()" }
		]
	}
]

/** a statement planned under no advice (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const unadvisedPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r1",
			"Scan RTI": 1,
			Disabled: false,
			Filter: "(r1.doc = $1)"
		},
		"Generated Plan Advice": "SEQ_SCAN(r1)\nNO_GATHER(r1)",
		"Range Table": [{ RTI: 1, Alias: "r1 ()" }]
	}
]

/** The probe, its key's equality on f2 by an extension's operator, printed by its schema as PostgreSQL prints an operator outside the search path (serving's red at e42937e8b, a vector key), its range table the probe's. */
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
					"Scan RTI": 1,
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
							"Scan RTI": 4,
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
			"JOIN_ORDER(d s)\nNESTED_LOOP_PLAIN(s)\nSEQ_SCAN(d)\nINDEX_SCAN(n@s public.node_pkey)\nNO_GATHER(d s n@s)",
		"Range Table": [
			{ RTI: 1, Alias: "d ()" },
			{ RTI: 2, Alias: "s ()" },
			{ RTI: 3, Eref: "unnamed_join (doc, owner, v)" },
			{ RTI: 4, Subplan: "s", Alias: "n ()" }
		]
	}
]

/** An index advised for a read no index condition serves: its seq scan disabled (PostgreSQL 19.0, EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON)). */
const disabledPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "node",
			Alias: "n",
			"Scan RTI": 1,
			Disabled: true,
			Filter: "(n.v = $1)"
		},
		"Supplied Plan Advice":
			"INDEX_SCAN(n public.node_doc_f1) /* matched, failed */\nNO_GATHER(n) /* matched */\n",
		"Generated Plan Advice": "SEQ_SCAN(n)\nNO_GATHER(n)",
		"Range Table": [{ RTI: 1, Alias: "n ()" }]
	}
]

/**
 * A read of one whole view at two levels, a view wn over node whose body names node v1 (CREATE VIEW wn AS SELECT ... FROM
 * node AS v1), as a role's whole view's does: targets v1@r4 and v1@r6, which EXPLAIN displays as v1 and v1_1, the first
 * bound at (doc, f1) through node_doc_f1, the second at (doc, f1, f2) through node_pkey (PostgreSQL 19.0, EXPLAIN
 * (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON), lane LAWS2).
 */
const viewsPlan: unknown = [
	{
		Plan: {
			"Node Type": "Seq Scan",
			"Relation Name": "doc",
			Alias: "r1",
			"Scan RTI": 1,
			Disabled: false,
			Filter: "((r1.owner = $1) AND EXISTS(SubPlan exists_1) AND EXISTS(SubPlan exists_2))",
			Plans: [
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_doc_f1",
							"Relation Name": "node",
							Alias: "v1",
							"Scan RTI": 4,
							Disabled: false,
							"Index Cond": "((v1.doc = r1.doc) AND (v1.f1 = '1'::bigint))"
						}
					]
				},
				{
					"Node Type": "Limit",
					Disabled: false,
					Plans: [
						{
							"Node Type": "Index Scan",
							"Index Name": "node_pkey",
							"Relation Name": "node",
							Alias: "v1_1",
							"Scan RTI": 7,
							Disabled: false,
							"Index Cond":
								"((v1_1.doc = r1.doc) AND (v1_1.f1 = '2'::bigint) AND (v1_1.f2 = '3'::bigint))"
						}
					]
				}
			]
		},
		"Supplied Plan Advice":
			"SEQ_SCAN(r1) /* matched */\nINDEX_SCAN(v1@r4 public.node_doc_f1) /* matched */\nINDEX_SCAN(v1@r6 public.node_pkey) /* matched */\nNO_GATHER(r1) /* matched */\nNO_GATHER(v1@r4) /* matched */\nNO_GATHER(v1@r6) /* matched */\n",
		"Generated Plan Advice":
			"SEQ_SCAN(r1)\nINDEX_SCAN(v1@r4 public.node_doc_f1 v1@r6 public.node_pkey)\nNO_GATHER(r1 r4@exists_1 v1@r4 r6@exists_2 v1@r6)",
		"Range Table": [
			{ RTI: 1, Alias: "r1 ()" },
			{ RTI: 2, Subplan: "exists_1", Alias: "r4 ()" },
			{ RTI: 3, Subplan: "r4", Alias: "r3 ()" },
			{ RTI: 4, Subplan: "r4", Alias: "v1 ()" },
			{ RTI: 5, Subplan: "exists_2", Alias: "r6 ()" },
			{ RTI: 6, Subplan: "r6", Alias: "r5 ()" },
			{ RTI: 7, Subplan: "r6", Alias: "v1 ()" }
		]
	}
]

/**
 * A case of the box: a plan, or the plans of a scope, of a shape grizzle prints or a mutant of it:
 * - `probe`: a key read of node per doc row, printed as grizzle's probe (`CROSS JOIN LATERAL (... LIMIT 1) s`), under
 *   its whole advice: every bound column an index condition;
 * - `dropped`: the same probe, its scan's INDEX_SCAN item dropped: PostgreSQL breaks the tie by (doc, f1), f2 a filter;
 * - `sibling`: the probe advised through the sibling (doc, f1): obeyed and matched, f2, which the sibling does not
 *   store, a residual filter on what (doc, f1) reach, which Law 2 admits and the budget holds;
 * - `plain`: the probe's read printed as a plain join under the whole advice: doc in the Join Filter (e3 P1);
 * - `unclaimed`: the same plain join, its plan claiming the read bound at (f1, f2) alone, as a binder that made the
 *   keyed read a set join would claim it: only the Join Filter's equality tells the binding lost;
 * - `flattened`: a correlated EXISTS (... LIMIT 1) PostgreSQL flattens into a semi-join (e3 P5);
 * - `qualified`: the probe, its key's equality by an extension's operator, which PostgreSQL prints by its schema
 *   (`OPERATOR("ext".=)`, as a vector key's): bound all the same;
 * - `reused`: a scope of two statements whose alias r1 names doc in one and node in the other;
 * - `scope`: a scope of two statements, the second's EXISTS over a probe r4;
 * - `result`: a FROM-less EXISTS over a probe: NO_GATHER of `"*RESULT*"` and of the probe at the sublink's level are
 *   PostgreSQL's;
 * - `tid`: a DELETE whose target a probe found, read by its tuple id;
 * - `disabled`: an index advised for a read by a column no index holds: PostgreSQL disables the one path left;
 * - `views`: a whole view read at two levels, its body's one alias at each, apart by their levels alone;
 * - `unadvised`: a flight that carried its advice to no transaction.
 */
export const adviceCases = [
	"probe",
	"dropped",
	"sibling",
	"plain",
	"unclaimed",
	"flattened",
	"qualified",
	"reused",
	"scope",
	"result",
	"tid",
	"disabled",
	"views",
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
const nodeRead: BoundRead = {
	alias: "n",
	target: "n@s",
	bound: ["doc", "f1", "f2"],
	stores: ["doc", "f1", "f2"]
}

/**
 * A flight of one statement, carrying `advice`, its plan's items `aliases` with their `targets` and named levels
 * `levels`, its reads `reads`.
 */
const flight = (
	advice: string,
	aliases: ReadonlyArray<string>,
	targets: ReadonlyArray<string>,
	levels: ReadonlyArray<string>,
	reads: ReadonlyArray<BoundRead>,
	statement: ScopeStatement
): LawScope => ({
	label: "the flight",
	advice,
	aliases,
	targets,
	levels,
	reads,
	statements: [statement],
	vehicle: { kind: "flight", advice }
})

const probeAdvice =
	"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) INDEX_SCAN(n@s public.node_pkey) NO_GATHER(d s n@s)"

/** Each case's scope and the plans PostgreSQL made under it. */
const cases: { readonly [C in AdviceCase]: readonly [LawScope, PlannedScope] } = {
	probe: [
		flight(probeAdvice, ["d", "s", "n"], ["d", "s", "n@s"], ["s"], [nodeRead], probeStatement),
		{ inForce: probeAdvice, plans: [read(probePlan)] }
	],
	dropped: [
		flight(
			"JOIN_ORDER(d s) NESTED_LOOP_PLAIN(s) SEQ_SCAN(d) NO_GATHER(d s n@s)",
			["d", "s", "n"],
			["d", "s", "n@s"],
			["s"],
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
			["d", "s", "n@s"],
			["s"],
			[{ ...nodeRead, stores: ["doc", "f1"] }],
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
			["d", "n"],
			[],
			[{ ...nodeRead, target: "n" }],
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
	unclaimed: [
		flight(
			"JOIN_ORDER(d n) NESTED_LOOP_PLAIN(n) SEQ_SCAN(d) INDEX_SCAN(n public.node_pkey) NO_GATHER(d n)",
			["d", "n"],
			["d", "n"],
			[],
			[{ alias: "n", target: "n", bound: ["f1", "f2"], stores: ["f1", "f2"] }],
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
			["d", "n"],
			["d", "n@exists_1"],
			["exists_1"],
			[
				{
					alias: "n",
					target: "n@exists_1",
					bound: ["doc", "f1", "f2"],
					stores: ["doc", "f1", "f2"]
				}
			],
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
		flight(probeAdvice, ["d", "s", "n"], ["d", "s", "n@s"], ["s"], [nodeRead], probeStatement),
		{ inForce: probeAdvice, plans: [read(qualifiedPlan)] }
	],
	reused: [
		{
			label: "the flight",
			advice:
				"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) INDEX_SCAN(r1 public.node_pkey) NO_GATHER(r1)",
			aliases: ["r1", "r1"],
			targets: ["r1", "r1"],
			levels: [],
			reads: [{ alias: "r1", target: "r1", bound: ["doc"], stores: ["doc"] }],
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
			vehicle: {
				kind: "flight",
				advice:
					"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) INDEX_SCAN(r1 public.node_pkey) NO_GATHER(r1)"
			}
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
			aliases: ["r1", "r2", "r3", "r4"],
			targets: ["r1", "r2", "r3@r4", "r4"],
			levels: ["r4"],
			reads: [
				{ alias: "r1", target: "r1", bound: ["doc"], stores: ["doc"] },
				{ alias: "r3", target: "r3@r4", bound: ["doc", "f1", "f2"], stores: ["doc", "f1", "f2"] }
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
			vehicle: {
				kind: "flight",
				advice:
					"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1) SEQ_SCAN(r2) INDEX_SCAN(r3@r4 public.node_pkey) NO_GATHER(r2) NO_GATHER(r3@r4)"
			}
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
			["r5@r6", "r6"],
			["r6"],
			[{ alias: "r5", target: "r5@r6", bound: ["doc", "f1", "f2"], stores: ["doc", "f1", "f2"] }],
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
			["r7", "r8", "r9", "r10@r8"],
			["r8"],
			[
				{ alias: "r10", target: "r10@r8", bound: ["doc", "f1", "f2"], stores: ["doc", "f1", "f2"] },
				{ alias: "r9", target: "r9", bound: ["ctid"], stores: ["ctid"] }
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
		flight("INDEX_SCAN(n public.node_doc_f1) NO_GATHER(n)", ["n"], ["n"], [], [], {
			label: "the read by v",
			sql: "SELECT n.f1 FROM node n WHERE n.v = $1::text"
		}),
		{ inForce: "INDEX_SCAN(n public.node_doc_f1) NO_GATHER(n)", plans: [read(disabledPlan)] }
	],
	views: [
		{
			label: "the flight",
			advice:
				"SEQ_SCAN(r1) INDEX_SCAN(v1@r4 public.node_doc_f1) INDEX_SCAN(v1@r6 public.node_pkey) NO_GATHER(r1 v1@r4 v1@r6)",
			aliases: ["r1", "r4", "v1", "r6", "v1"],
			targets: ["r1", "r4", "v1@r4", "r6", "v1@r6"],
			levels: ["r4", "r6"],
			reads: [
				{ alias: "v1", target: "v1@r4", bound: ["doc", "f1"], stores: ["doc", "f1"] },
				{ alias: "v1", target: "v1@r6", bound: ["doc", "f1", "f2"], stores: ["doc", "f1", "f2"] }
			],
			statements: [
				{
					label: "the owner's docs",
					sql: "SELECT r1.doc FROM public.doc AS r1 WHERE r1.owner = $1::int8 AND EXISTS (SELECT FROM (SELECT FROM public.wn AS r3 WHERE r3.doc = r1.doc AND r3.f1 = 1::int8 LIMIT 1) AS r4) AND EXISTS (SELECT FROM (SELECT FROM public.wn AS r5 WHERE r5.doc = r1.doc AND r5.f1 = 2::int8 AND r5.f2 = 3::int8 LIMIT 1) AS r6)"
				}
			],
			vehicle: {
				kind: "flight",
				advice:
					"SEQ_SCAN(r1) INDEX_SCAN(v1@r4 public.node_doc_f1) INDEX_SCAN(v1@r6 public.node_pkey) NO_GATHER(r1 v1@r4 v1@r6)"
			}
		},
		{
			inForce:
				"SEQ_SCAN(r1) INDEX_SCAN(v1@r4 public.node_doc_f1) INDEX_SCAN(v1@r6 public.node_pkey) NO_GATHER(r1 v1@r4 v1@r6)",
			plans: [read(viewsPlan)]
		}
	],
	unadvised: [
		flight(
			"INDEX_SCAN(r1 public.doc_pkey) NO_GATHER(r1)",
			["r1"],
			["r1"],
			[],
			[{ alias: "r1", target: "r1", bound: ["doc"], stores: ["doc"] }],
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
