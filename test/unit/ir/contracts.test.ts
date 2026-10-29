import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, element, int, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order } from "effect"
import {
	contextAdmits,
	type EvidenceContext,
	evidenceContexts,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import { insertKey, type PhysicalKey } from "#compiler/ir/multiplicity.ts"
import { assert } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"

const pk = {
	kind: "constraint",
	constraint: wild.constraint("task_pk"),
	constraintKind: "primaryKey"
} as const

/**
 * The context order, written once: a snapshot read may rely on committed-snapshot facts, a read inside a transaction
 * only on what holds at every statement, and validated-transaction evidence on no execution context yet.
 */
const executions = ["transaction", "snapshot"] as const satisfies ReadonlyArray<TemplateContext>
const admitted = (execution: TemplateContext, context: EvidenceContext): boolean =>
	context === "descriptor" ||
	context === "immediate" ||
	context === "queryLocal" ||
	(context === "committedSnapshot" && execution === "snapshot")

describe("evidence contexts", () => {
	it.effect("admit and refuse evidence as the context order says, over every context", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/evidence-admission",
					generator: (source) =>
						[source.draw(element(executions)), source.draw(element(evidenceContexts))] as const,
					literal: Formatter.format,
					limit: 100,
					features: features<"admitted" | "not admitted">(["admitted", "not admitted"]),
					caseHang: Duration.minutes(2)
				},
				([execution, context], c) =>
					Effect.sync(() => {
						const verdict = admitted(execution, context)
						c.note(verdict ? "admitted" : "not admitted")
						assert.equal(
							contextAdmits(execution, context),
							verdict,
							`${execution} admits ${context}`
						)
					})
			)
		)
	)
})

describe("multiplicity antichains", () => {
	const key = (columns: ReadonlyArray<string>): PhysicalKey => ({ columns, proof: [pk] })
	const subsetOf = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
		Arr.every(a, (c) => b.includes(c))
	/**
	 * The deterministic order a full antichain keeps by (multiplicity.ts): fewer columns first, then the sorted columns
	 * compared column by column.
	 */
	const byPolicy: Order.Order<ReadonlyArray<string>> = Order.combine(
		Order.mapInput(Order.Number, (columns: ReadonlyArray<string>) => columns.length),
		Order.Array(Order.String)
	)
	const sorted = (columns: ReadonlyArray<string>) => Arr.sort([...columns], Order.String)

	it.effect("keeps the minimal keys, at most the bound, dropping the largest first", (ctx) => {
		/** A key's columns: one to three of a, b and c, a repeat deduplicated, so every nonempty set in every order. */
		const columns = map(array(element(["a", "b", "c"]), { min: 1, max: 3 }), (cs) => [
			...new Set(cs)
		])
		const keys = array(columns, { min: 0, max: 3 })
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/multiplicity-antichain",
					generator: (source) => [source.draw(keys), source.draw(int(0, 3))] as const,
					literal: Formatter.format,
					limit: 300_000,
					features: features<
						| "a redundant key"
						| "a key dropping its supersets"
						| "a full antichain dropping its largest"
					>([
						"a redundant key",
						"a key dropping its supersets",
						"a full antichain dropping its largest"
					]),
					caseHang: Duration.minutes(2)
				},
				([inserted, bound], c) =>
					Effect.sync(() => {
						let chain: ReadonlyArray<PhysicalKey> = []
						for (const k of inserted) {
							const next = insertKey(chain, key(k), bound)
							const old = Arr.map(chain, (x) => x.columns)
							if (Arr.some(old, (x) => subsetOf(x, k))) {
								c.note("a redundant key")
								assert.deepEqual(next, chain)
							} else {
								const candidates = [...Arr.filter(old, (x) => !subsetOf(k, x)), sorted(k)]
								if (candidates.length <= old.length) {
									c.note("a key dropping its supersets")
								}
								if (candidates.length > bound) {
									c.note("a full antichain dropping its largest")
								}
								assert.deepEqual(
									Arr.map(next, (x) => x.columns),
									Arr.sort(candidates, byPolicy).slice(0, bound)
								)
							}
							for (const x of next) {
								assert.deepEqual(x.proof, [pk])
							}
							chain = next
						}
					})
			)
		)
	})
})
