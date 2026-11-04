import { Array as Arr, Effect, Order } from "effect"
import {
	type CaseRecord,
	defineGate,
	jsonText,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure
} from "#bench/harness/transaction.ts"
import { GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	installWrites,
	loadedByOwner,
	owner,
	plainStatement,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	alternatives,
	closed,
	relation,
	schema
} from "#compiler/public/schema.ts"

/**
 * R09: a residual law's checker is specialized to what each write can break, so its first call in a backend compiles
 * only the unit the write fires, and its cost follows that unit's size, never the law's.
 *
 * PostgreSQL compiles a trigger function once per trigger and backend, so a backend's first write to a table pays the
 * compile of the function its event fires. The fixture is an alternatives law over a roster of H handles, every handle
 * armed by its own payload table, or every one but the last. Each measurement opens a fresh backend:
 *
 * - (a) the first COMMIT of one parent and its payload: it compiles the parent's INSERT unit, a CASE over the roster;
 * - (b) one transaction deleting and reinserting one payload in every payload table: it compiles every payload table's
 *   DELETE unit, each its own arm's check alone.
 *
 * The gates: an unarmed handle costs one empty WHEN, so (a) with one unarmed handle is within 1.5 times (a) with every
 * handle armed, at each size; (b) is linear in the payload tables, so from the second-largest size to the largest it
 * grows at most 2.5 times; and (a) grows at most 6 times there, which PostgreSQL's own compile of one CASE allows,
 * quadratic in its WHENs (pl_scanner.c location_lineno_init). This is the only timing the issue's acceptance has: the
 * size of what grizzle installs is the scaling relation's (test/unit/laws/scaling.test.ts), never a clock's.
 */

interface Options extends Readonly<Record<string, unknown>> {
	/** The roster sizes, increasing; the gates compare the last two. */
	readonly sizes: ReadonlyArray<number>
	readonly samples: number
}

/** The schema of a roster of `size` handles, each armed by its own payload table, or every one but the last. */
const rosterSchema = (size: number, armedAll: boolean) => (name: string) => {
	const handles: readonly [string, ...Array<string>] = [
		"h0",
		...Arr.makeBy(size - 1, (i) => `h${i + 1}`)
	]
	const Kind = closed("Kind", handles)
	const Node = relation("Node", { id: pg.integer, kind: closedId(Kind) }, ["id"])
	const armed = armedAll ? size : size - 1
	const arms = Arr.makeBy(armed, (i) =>
		relation(`Arm${i}`, { node: pg.integer, amount: pg.integer }, ["node"])
	)
	const byHandle: Record<string, (typeof arms)[number]> = {}
	for (const [i, arm] of arms.entries()) {
		byHandle[`h${i}`] = arm
	}
	const relations: Record<string, AnyRelation | typeof Kind> = { Kind, Node }
	for (const arm of arms) {
		relations[arm.name] = arm
	}
	return schema(name, relations, [alternatives(Node, "kind", Kind, byHandle)])
}

/** The middle sample: the gate draws an odd number. */
const median = (xs: ReadonlyArray<number>): number => {
	const at = Arr.sort(xs, Order.Number)[Math.floor(xs.length / 2)]
	if (at === undefined) {
		throw GateSetupError.make({ what: "no sample measured" })
	}
	return at
}

const commitMs = (m: TransactionMeasure): number => {
	const ms = m.phases.commitMs
	if (ms === undefined || m.outcome.kind !== "committed") {
		throw GateSetupError.make({
			what: `a measured transaction did not commit: ${jsonText(m.outcome)}`
		})
	}
	return ms
}

/** @internal */
export default defineGate({
	name: "write-first-call",
	gates: ["R09"],
	title: "A residual law's first call per backend compiles only the unit its write fires",
	scope:
		"An alternatives law over growing rosters, every handle armed or one unarmed: the first COMMIT of a parent in a " +
		"fresh backend, and one transaction rewriting a payload in every payload table in a fresh backend.",
	phases: writePhases,
	options: {
		full: { sizes: [16, 43, 85], samples: 5 },
		quick: { sizes: [8, 16], samples: 3 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const cases: Array<CaseRecord<"R09">> = []
			/** (a) and (b) by size and arming, each the median of its samples. */
			const parent = new Map<string, number>()
			const payloads = new Map<string, number>()
			for (const size of options.sizes) {
				for (const armedAll of [true, false]) {
					const label = `${size} handles, ${armedAll ? "every handle armed" : "one unarmed"}`
					const fx = yield* installWrites(
						rosterSchema(size, armedAll)("FirstCall"),
						"benchfirstcall",
						{
							programs: {},
							logins: []
						}
					)
					const armed = armedAll ? size : size - 1
					const kind = fx.enumType("Kind")
					const N = fx.table("Node")
					const c = (rel: string, f: string) => fx.column(rel, f)
					yield* owner(
						`WITH ${Arr.join(
							Arr.makeBy(
								armed,
								(i) =>
									`a${i} AS (INSERT INTO ${fx.table(`Arm${i}`)} (${c(`Arm${i}`, "node")}, ${c(`Arm${i}`, "amount")}) VALUES (${i + 1}, 1))`
							),
							", "
						)} INSERT INTO ${N} (${c("Node", "id")}, ${c("Node", "kind")}) SELECT g, ('h' || (g - 1)::text)::${kind} FROM pg_catalog.generate_series(1, ${armed}) AS g`
					)
					yield* settle(fx)
					const fresh = (statements: ReadonlyArray<string>, sample: number) =>
						Effect.scoped(
							Effect.flatMap(
								writerSession(fx, fx.world.app, `first call ${label} ${sample}`),
								(w) =>
									measureTransaction(w, {
										readOnly: false,
										statements: Arr.map(statements, (sql, i) =>
											plainStatement(`statement ${i}`, sql, [])
										),
										end: "plain",
										deferredEvents: false,
										wal: false
									})
							)
						)
					const firstParent: Array<TransactionMeasure> = []
					const everyPayload: Array<TransactionMeasure> = []
					for (let sample = 0; sample < options.samples; sample++) {
						const id = 100000 + sample
						const firstParentRun = yield* fresh(
							[
								`INSERT INTO ${N} (${c("Node", "id")}, ${c("Node", "kind")}) VALUES (${id}, 'h0'::${kind})`,
								`INSERT INTO ${fx.table("Arm0")} (${c("Arm0", "node")}, ${c("Arm0", "amount")}) VALUES (${id}, 1)`
							],
							sample
						)
						firstParent.push(firstParentRun)
						const everyPayloadRun = yield* fresh(
							Arr.flatMap(
								Arr.makeBy(armed, (i) => i),
								(i) => [
									`DELETE FROM ${fx.table(`Arm${i}`)} WHERE ${c(`Arm${i}`, "node")} = ${i + 1}`,
									`INSERT INTO ${fx.table(`Arm${i}`)} (${c(`Arm${i}`, "node")}, ${c(`Arm${i}`, "amount")}) VALUES (${i + 1}, ${sample + 2})`
								]
							),
							sample
						)
						everyPayload.push(everyPayloadRun)
					}
					const firstParentMs = median(Arr.map(firstParent, commitMs))
					const everyPayloadMs = median(Arr.map(everyPayload, commitMs))
					parent.set(label, firstParentMs)
					payloads.set(label, everyPayloadMs)
					cases.push({
						name: label,
						gates: ["R09"],
						conditions: writeConditions({
							workload: `in a fresh backend: one parent and its payload committed; and one transaction rewriting a payload in each of ${armed} payload tables`,
							schemaState: loadedByOwner,
							data: `${armed} parents, each with its payload`,
							parameters: { handles: size, armed },
							semantics: "every transaction keeps the law and commits",
							cache: "each sample a fresh backend, so each trigger compiles its function once"
						}),
						phases: {},
						variants: [],
						comparisons: [],
						transactions: {
							firstParent: summarizeTransactions(firstParent),
							everyPayload: summarizeTransactions(everyPayload)
						},
						loads: {},
						measures: {
							firstParentCommitMs: firstParentMs,
							everyPayloadCommitMs: everyPayloadMs
						}
					})
				}
			}
			const at = (m: ReadonlyMap<string, number>, size: number, armedAll: boolean): number => {
				const v = m.get(`${size} handles, ${armedAll ? "every handle armed" : "one unarmed"}`)
				if (v === undefined) {
					throw GateSetupError.make({ what: `no measurement at ${size} handles` })
				}
				return v
			}
			const small = options.sizes.at(-2)
			const large = options.sizes.at(-1)
			if (small === undefined || large === undefined) {
				throw GateSetupError.make({ what: "fewer than two roster sizes" })
			}
			const unarmedRatios = Arr.map(
				options.sizes,
				(size) => at(parent, size, false) / at(parent, size, true)
			)
			const payloadGrowth = at(payloads, large, true) / at(payloads, small, true)
			const parentGrowth = at(parent, large, true) / at(parent, small, true)
			const r09: VerdictInput = {
				checks: [
					mechanism(
						"an unarmed handle costs one empty WHEN: a parent's first COMMIT with one unarmed handle is within 1.5 times every handle armed, at each size",
						Arr.every(unarmedRatios, (r) => r <= 1.5),
						Arr.join(
							Arr.map(unarmedRatios, (r) => r.toFixed(2)),
							", "
						)
					),
					mechanism(
						`a payload table's first write compiles its own arm's check alone: rewriting a payload in every payload table grows at most 2.5 times from ${small} to ${large} handles`,
						payloadGrowth <= 2.5,
						payloadGrowth.toFixed(2)
					),
					mechanism(
						`a parent's first COMMIT compiles the roster's CASE alone: it grows at most 6 times from ${small} to ${large} handles`,
						parentGrowth <= 6,
						parentGrowth.toFixed(2)
					)
				]
			}
			return { cases, verdicts: { R09: r09 } }
		})
})
