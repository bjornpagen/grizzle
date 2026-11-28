/** What judge-scans.test.ts reads: its box of fixed plans of a rule judge's statement, and each one's judgment. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Result } from "effect"
import { parsePlanTree } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { CopyIndex } from "#test/support/pg/physical/copies.ts"
import { type Asked, judgeScans } from "#test/support/pg/physical/plan-bindings.ts"

/**
 * A case: how the plan's one SubPlan reads R0, the judge's NOT EXISTS over R0 kept correlated beneath its scan of R1,
 * as PostgreSQL plans LC-WRITERS' whole judge: by an index condition over the coordinates (doc, f_0) its outer row
 * gives (`bound`), the same with f_0's equality by an operator PostgreSQL prints by its schema, as it prints a vector
 * extension's (`boundQualified`: `OPERATOR(ext.=)`, which serving's key lookup on a vector key reads), or by doc alone,
 * f_0 matched in a Filter after (`underBound`).
 */
export type SubPlanRead = "bound" | "boundQualified" | "underBound"

export const subPlanBox: Gen<SubPlanRead> = (source) =>
	source.draw(element<SubPlanRead>(["bound", "boundQualified", "underBound"]))

/** The table of `relation` in the schema `s`, as the law keys its tables. */
const table = (relation: string): string => `${quoteIdent("s")}.${quoteIdent(relation)}`

/** R0 keyed (doc, f_0, f_1); R1 keyed (doc, f_0) with an index over (doc, q_0), its contained coordinates. */
const indexes: ReadonlyMap<string, ReadonlyArray<CopyIndex>> = new Map([
	[
		table("r_0"),
		[{ name: "r_0_pk", method: "btree", unique: true, columns: ["doc", "f_0", "f_1"] }]
	],
	[
		table("r_1"),
		[
			{ name: "r_1_pk", method: "btree", unique: true, columns: ["doc", "f_0"] },
			{ name: "r_1_ix_doc_q_0", method: "btree", unique: false, columns: ["doc", "q_0"] }
		]
	]
])

/** The containment R1(doc, q_0) in R0(doc, f_0): each side's coordinates its delta asks for. */
const asked: Asked = new Map([
	[table("r_0"), ["doc", "f_0"]],
	[table("r_1"), ["doc", "q_0"]]
])

/**
 * The plan of the judge's statement in a case, as EXPLAIN (VERBOSE, FORMAT JSON) prints it: a nested loop from the
 * delta's reader into R1 by its index over (doc, q_0), whose Filter runs the SubPlan that reads R0 as the case says.
 */
const planOf = (c: SubPlanRead) => [
	{
		Plan: {
			"Node Type": "Nested Loop",
			"Join Type": "Inner",
			"Plan Rows": 1,
			Plans: [
				{
					"Node Type": "Function Scan",
					"Parent Relationship": "Outer",
					Alias: "r1",
					"Plan Rows": 10
				},
				{
					"Node Type": "Index Only Scan",
					"Parent Relationship": "Inner",
					Schema: "s",
					"Relation Name": "r_1",
					Alias: "r11",
					"Index Name": "r_1_ix_doc_q_0",
					"Index Cond": "((r11.doc = r1.c1) AND (r11.q_0 = r1.c2))",
					Filter: "(NOT EXISTS(SubPlan exists_1))",
					"Plan Rows": 1,
					Plans: [
						{
							"Node Type": "Subquery Scan",
							"Parent Relationship": "SubPlan",
							"Subplan Name": "SubPlan exists_1",
							Alias: "r18",
							"Plan Rows": 1,
							Plans: [
								{
									"Node Type": "Index Scan",
									"Parent Relationship": "Subquery",
									Schema: "s",
									"Relation Name": "r_0",
									Alias: "r15",
									"Index Name": "r_0_pk",
									...(c === "bound"
										? { "Index Cond": "((r15.doc = r1.c1) AND (r15.f_0 = r11.q_0))" }
										: c === "boundQualified"
											? {
													"Index Cond":
														'((r15.doc = r1.c1) AND (r15.f_0 OPERATOR("ext".=) r11.q_0))'
												}
											: { "Index Cond": "(r15.doc = r1.c1)", Filter: "(r15.f_0 = r11.q_0)" }),
									"Plan Rows": 1
								}
							]
						}
					]
				}
			]
		}
	}
]

/** The law's problems with a case's plan (plan-bindings.ts judgeScans), its statement named `the judge`. */
export const problemsOf = (c: SubPlanRead): ReadonlyArray<string> =>
	judgeScans(Result.getOrThrow(parsePlanTree(planOf(c))), indexes, asked, "the judge").problems
