import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, int, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter, Record as Rec } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { finitePassWithin } from "#compiler/lower/optimize/finite/index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Q, T, Task, uuidOf } from "#test/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	queryOf,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * R07: keep finite schema facts visible to PostgreSQL. A membership-only match of declared facts becomes
 * native constant membership, tuple membership keeps each fact's correlation ("for tuple rosters, independent column
 * IN lists are not equivalent"), a roster-covering enum match is a tautology, a one-column membership is rewritten
 * at any size, and only a tuple membership whose disjunction holds more equalities than the pass's bound
 * (core/limits.ts finiteMembershipMaxTerms in production, a drawn one here, through finitePassWithin's own parameter)
 * keeps its VALUES join.
 */

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const kind = (h: string): TypedLiteral => ({ kind: "enum", handle: h })

/**
 * The task facts every membership is judged over, every subset of them: (Automatic, 7) holds each value of some
 * declared fact without being one when the facts are (Automatic, 5) and (Manual, 7), and 9 is no fact's amount.
 */
const tasks = factSubsets({
	Task: [
		[u(1), u(10), kind("Automatic"), i8(5)],
		[u(2), u(10), kind("Automatic"), i8(7)],
		[u(3), u(11), kind("Manual"), i8(7)],
		[u(4), u(11), kind("Manual"), i8(9)]
	]
})

/** The declared facts a membership may state: every subset of these (kind, amount) pairs. */
const declarable: ReadonlyArray<ReadonlyArray<TypedLiteral>> = [
	[kind("Automatic"), i8(5)],
	[kind("Automatic"), i8(7)],
	[kind("Manual"), i8(5)],
	[kind("Manual"), i8(7)]
]

/** Which of the declared facts' columns the membership binds to the task's variables. */
type Bound = "kind" | "amount" | "both"

const bindingOf: Readonly<Record<Bound, Readonly<Record<string, string>>>> = {
	kind: { kind: "k" },
	amount: { amount: "a" },
	both: { kind: "k", amount: "a" }
}

/** Each task's id, matched against the declared facts on the bound columns. */
const membership = (facts: ReadonlyArray<ReadonlyArray<TypedLiteral>>, bound: Bound) => {
	const q = new Q()
	const closed = q.closed(
		"Facts",
		[
			{ name: "kind", type: T.kind },
			{ name: "amount", type: T.int8 }
		],
		facts
	)
	const region = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", kind: "k", amount: "a" },
			constants: {}
		},
		{ source: closed, bind: bindingOf[bound], constants: {} }
	])
	return q.build(q.project(region, [["id", "id"]], conservativeMeta)).dag
}

/** What the memberships reach: the rewrite on each binding, and the terms bound holding it back. */
type FiniteFeature = `rewritten binding ${Bound}` | "held back by its terms bound"

describe("finite membership", () => {
	it.effect(
		"keeps each fact's pair: (Automatic, 7) matches neither fact although each value is some fact's",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/finite-membership",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(subarray(declarable)),
								source.draw(element<Bound>(["kind", "amount", "both"])),
								source.draw(int(0, 8))
							] as const,
						limit: 432,
						coverage: requiredInSpace<FiniteFeature>([
							"rewritten binding kind",
							"rewritten binding amount",
							"rewritten binding both",
							"held back by its terms bound"
						]),
						caseHang
					},
					([facts, bound, maxTerms], c) =>
						Effect.sync(() => {
							const dag = membership(facts, bound)
							const ran = succeeded(
								runPasses(
									queryOf(dag, []),
									[finitePassWithin(maxTerms)],
									makePassContext({
										evidenceContext: "snapshot",
										catalog: ledgerCatalog
									})
								)
							)
							/** A tuple membership of some fact is a disjunction of its facts' equalities on both columns. */
							const disjunction = bound === "both" && facts.length > 0
							const equalities = facts.length * Rec.keys(bindingOf[bound]).length
							const rewritten = !disjunction || equalities <= maxTerms
							c.note(rewritten ? `rewritten binding ${bound}` : "held back by its terms bound")
							assert.equal(rulesOf(ran.certificates).includes("R07.finiteMembership"), rewritten)
							deliversAlikeOn(tasks, [Task], [], queryOf(dag, []), ran.query)
						})
				)
			)
	)
})
