/** What the properties of concat.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	accumulatedOf,
	drawnNatural,
	schemaOf,
	theoryOf
} from "#test/support/unit/analysis/theory/support.ts"

/** A member of the box: its step value and its two accumulators. */
interface Stepped {
	readonly x: string
	readonly before: string
	readonly after: string
}

interface ConcatState {
	readonly members: ReadonlyArray<Stepped>
	readonly total: string
}

/** The step values, and the texts the accumulators and the end range over: every concatenation of two steps. */
const steps = ["", "a", "b"] as const

const texts = ["", "a", "b", "ab"] as const

export const concatState: Gen<ConcatState> = (source) => ({
	members: array(
		(s): Stepped => ({
			x: element(steps)(s),
			before: element(texts)(s),
			after: element(texts)(s)
		}),
		{ min: 0, max: 2 }
	)(source),
	total: element(texts)(source)
})

export type ConcatFault =
	| "lawful"
	| "a wrong fold accumulator at slot 0"
	| "a stale predecessor"
	| "a wrong step"
	| "a wrong end"
	| "an empty step"

/**
 * The fold's meaning, a naive left fold: the first before is the empty text, each before its predecessor's after,
 * each after its before then its step value, and the owner's total its last after, or the empty text for none.
 */
export const concatFault = (s: ConcatState): ConcatFault => {
	const [first] = s.members
	if (first !== undefined && first.before !== "") {
		return "a wrong fold accumulator at slot 0"
	}
	for (const [i, m] of s.members.entries()) {
		const prior = s.members[i - 1]
		if (prior !== undefined && m.before !== prior.after) {
			return "a stale predecessor"
		}
		if (m.after !== `${m.before}${m.x}`) {
			return "a wrong step"
		}
	}
	const last = s.members[s.members.length - 1]
	return s.total === (last === undefined ? "" : last.after) ? "lawful" : "a wrong end"
}

const text = f.wildcard

/** A statement as a test's schema description states one, unlocated. */
type Statement = SchemaDesc["statements"][number]

const fold = (step: ReadonlyArray<string>): Statement => ({
	kind: "fold",
	family: { owner: "O", count: "n" },
	monoid: "concat",
	step: on("F", step),
	end: on("O", ["id", "total"])
})

const family = (order: "ordered" | "counted"): Statement => ({
	kind: "family",
	order,
	member: on("F", order === "ordered" ? ["o", "at"] : ["o"]),
	slots: { owner: "O", count: "n" }
})

/** O's family of F, ordered or counted, and a concat fold of x over it, its pair named or hidden. */
export const concatSchema = (order: "ordered" | "counted", pair: boolean): SchemaDesc =>
	schemaOf(
		[
			relation("O", { id: f.uuid, n: drawnNatural, total: accumulatedOf(text, "") }, ["id"]),
			relation(
				"F",
				{
					fid: f.uuid,
					o: f.uuid,
					...(order === "ordered" ? { at: drawnNatural } : {}),
					x: text,
					...(pair ? { before: accumulatedOf(text, ""), after: accumulatedOf(text, "") } : {})
				},
				["fid"]
			)
		],
		[family(order), fold(pair ? ["o", "x", "before", "after"] : ["o", "x"])]
	)

export const visible = theoryOf(concatSchema("ordered", true))

/** A fold's declaration the rule judges: its family's order and whether it names its pair. */
export interface Declared {
	readonly order: "ordered" | "counted"
	readonly pair: boolean
}

export type Verdict = "an ordered family's named pair admitted" | "refused"
