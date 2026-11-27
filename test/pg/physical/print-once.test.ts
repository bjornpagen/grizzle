/**
 * Print once's planning, on PostgreSQL 19: a statement of single-use CTEs plans in time linear in its size. PostgreSQL
 * inlines each CTE its statement reads once by a walk of the whole statement (subselect.c inline_cte), so k such CTEs
 * printed as CTEs cost O(k * size); the printer prints each in place (sql/print-once.ts), and PostgreSQL meets none.
 *
 * The statement is k pairs: a plain CTE reading a table, and a MATERIALIZED CTE reading it once, which no reference
 * reads, so PostgreSQL plans neither of them but still inlines each plain one by its walk; its body reads nothing. It is
 * the shape print once governs alone: no set operation, no join and no sub-link, whose planning PostgreSQL 19 spends
 * superlinear time on for reasons of its own (choose_plan_name's numbered names, an appendrel's translated vars).
 *
 * Its measure is the backend's own CPU (/proc/<pid>/schedstat) under EXPLAIN (GENERIC_PLAN), the least of three, for k
 * and for 8k: a ratio, which a loaded machine leaves as it is where a millisecond count moves with the load. Linear time
 * gives about 8, quadratic about 64.
 */

import { assert } from "@bjornpagen/testing/assert"
import { int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import type { Cte } from "#compiler/sql/ast.ts"
import {
	col,
	core,
	cteRefAs,
	lit,
	operandSelect,
	provedSelect,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { fileText } from "#test/support/files.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The pairs of the smaller statement: enough that, printed as CTEs, PostgreSQL's walks outweigh its parse of the text
 * at both sizes, so the ratio a quadratic planning gives is near its 64 and far from linear's 8.
 *
 * @limitKind measured
 * @owner lane INLINEPRINT, 2026-11-24
 * @unit CTE pairs
 * @scope the least smaller statement this property plans: k is drawn from [pairs, 2 * pairs]
 * @constraint the walk of k CTEs over 2k CTEs' bodies must outweigh the parse of 2k bodies: at 200 a CTE printed as one
 *   made the ratio 48 (PLANSIZE's measured walk and parse costs per node), at 25 under 20
 * @source this file's property, killed by its kill
 * @verified 2026-11-24
 */
const pairs = 200

/** The factor between the two statements' pairs. */
const scale = 8

/**
 * The ratio between linear time's 8 and quadratic time's 64: their geometric mean, as far from each in ratio, so the
 * load's noise in either measure moves the ratio far less than the distance to it.
 *
 * @limitKind derived
 * @owner lane INLINEPRINT, 2026-11-24
 * @unit ratio of backend CPU time
 * @scope the 8k statement's planning CPU over the k statement's
 * @constraint sqrt(scale * scale^2) = scale^1.5 = 22.6 for scale 8
 * @source the complexity classes this property separates
 * @verified 2026-11-24
 */
const linearBound = scale ** 1.5

/** The statement of `k` pairs (the module header), printed. */
const statementOf = (k: number): string => {
	const ctes: Array<Cte> = []
	for (let i = 0; i < k; i += 1) {
		const plain = `r${1000 + 2 * i}`
		const fenced = `r${1001 + 2 * i}`
		ctes.push({
			name: plain,
			materialized: undefined,
			query: operandSelect(
				core(
					[targetAs(col(`r${100000 + 2 * i}`, "a"), `c${1000 + 2 * i}`)],
					[table("pg_temp", "print_once", `r${100000 + 2 * i}`)],
					undefined
				)
			)
		})
		ctes.push({
			name: fenced,
			materialized: "MATERIALIZED",
			query: operandSelect(
				core(
					[targetAs(col(`r${100001 + 2 * i}`, `c${1000 + 2 * i}`), `c${1001 + 2 * i}`)],
					[cteRefAs(plain, `r${100001 + 2 * i}`)],
					undefined
				)
			)
		})
	}
	const [first, ...rest] = ctes
	if (first === undefined) {
		throw new Error("a statement of at least one pair")
	}
	return printStatement({
		...provedSelect("oneRow", [target(lit.int(1, types.integer))], [], undefined),
		with: { recursive: false, ctes: [first, ...rest] }
	})
}

/** The backend's CPU time so far, in nanoseconds: the first field of its schedstat. */
const cpuOf = (pid: number): Effect.Effect<number> =>
	Effect.map(fileText(`/proc/${pid}/schedstat`), (text) => Number(Str.split(text, " ")[0]))

/** A statement of single-use CTEs plans in time linear in its size, never quadratic. */
export const aStatementOfSingleUseCtesPlansInTimeLinearInItsSize = property.explore(
	int(pairs, 2 * pairs),
	{
		budget: { runs: 2, steered: 2 },
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["planned at k and 8k"] as const,
		check:
			({ substrate }, c: Case<"planned at k and 8k">) =>
			(k: number) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { admin } = yield* Substrate
						yield* admin.query("CREATE TEMPORARY TABLE print_once (a integer)", [])
						const least = (sql: string) =>
							Effect.gen(function* () {
								let best = Number.POSITIVE_INFINITY
								for (let run = 0; run < 3; run += 1) {
									const before = yield* cpuOf(admin.processId)
									yield* admin.query(`EXPLAIN (GENERIC_PLAN) ${sql}`, [])
									const after = yield* cpuOf(admin.processId)
									best = Math.min(best, after - before)
								}
								return best
							})
						const small = yield* least(statementOf(k))
						const large = yield* least(statementOf(k * scale))
						c.note("planned at k and 8k")
						assert.ok(
							large / small < linearBound,
							`planning ${k * scale} pairs took ${(large / small).toFixed(1)} times ${k}'s CPU, past ${linearBound.toFixed(1)}: linear is ${scale}, quadratic ${scale ** 2}`
						)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's planning CPU, k against 8k, linear's ratio 8 against quadratic's 64"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print-once.ts",
				original:
					"\tconst nested = transformStatement(statement, { ...identityHooks, select: queryPrintedOnce })\n\tconst printed = pulledUpStatement(isDmlWithWith(nested) ? dmlPrintedOnce(nested) : nested)\n\tassertPrintedOnce(printed)\n",
				replacement: "\tconst printed = pulledUpStatement(statement)\n",
				why: "Every single-use CTE printed as a CTE, left to PostgreSQL's walk of the whole statement for each: planning O(k * size)."
			}
		]
	}
)
