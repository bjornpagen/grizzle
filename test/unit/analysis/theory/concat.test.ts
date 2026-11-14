/**
 * Monoid.concat, text's free monoid, folds a sequence (ir/monoid.ts): the empty text, then each member's step value
 * after the running text. Its law means what the fold says: evaluated by the reference evaluator over every state of
 * a small box, the violation query of a concat fold over an ordered family, its (before, after) pair named, is empty
 * exactly on the states a naive left fold calls lawful. Its combine is the equation `after = before || x`, which the
 * Compute lowering decides without building the concatenation (compute/lower.ts concatEquation), so the law reads no
 * text longer than one PostgreSQL holds.
 *
 * A concat fold names its pair, and folds only a sequence: the fold rule refuses one over a counted family, whose
 * order is hidden, and one whose accumulators are hidden, whose law would need an ordered aggregate (check/fold.ts
 * foldRule).
 *
 * - The fold: over every state of one owner's ordered family of 0 to 2 members, each step '', 'a' or 'b', its
 *   accumulators and total '', 'a', 'b' or 'ab', the violation query is empty exactly where a naive left fold holds.
 *   Oracle: the naive left fold, a second implementation. Plant: concat-equation-tail-unchecked (the equation's
 *   concatenation checked by its length and its head alone).
 * - The rule: an ordered or counted family, its pair named or hidden, admitted exactly as an ordered family's named
 *   pair, each other refused by the named refusal foldRule states. Oracle: that rule. Plant:
 *   concat-over-counted-admitted (a counted family's hidden concat refused for its hidden pair, not its order).
 *
 * Plants are patches in ~/.cache/grizzle-release/BR03/plants. Features: each verdict of each box.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { assert, refused } from "#test/support/assert.ts"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	accumulatedOf,
	drawnNatural,
	type HostFacts,
	lawOfShape,
	schemaOf,
	theoryOf,
	theoryResult,
	uuidOf,
	violates
} from "#test/unit/analysis/theory/support.ts"

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

const concatState: Gen<ConcatState> = (source) => ({
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

type ConcatFault =
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
const concatFault = (s: ConcatState): ConcatFault => {
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
const concatSchema = (order: "ordered" | "counted", pair: boolean): SchemaDesc =>
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

describe("a concat fold", () => {
	const visible = theoryOf(concatSchema("ordered", true))
	it.effect("is violated exactly when its accumulators are not the naive fold's", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/theory/concat-fold",
					generator: concatState,
					literal: Formatter.format,
					box: "one owner's ordered family of 0 to 2 members, each step '', 'a' or 'b', accumulators and total '', 'a', 'b' or 'ab'",
					oracle: { kind: "second-implementation", name: "a naive left fold of the slots' texts" },
					coverage: requiredInSpace<ConcatFault>([
						"lawful",
						"a wrong fold accumulator at slot 0",
						"a stale predecessor",
						"a wrong step",
						"a wrong end",
						"an empty step"
					]),
					caseHang,
					concurrency: 1
				},
				(s, k) =>
					Effect.sync(() => {
						const fault = concatFault(s)
						k.note(fault)
						if (fault === "lawful" && Arr.some(s.members, (m) => m.x === "")) {
							k.note("an empty step")
						}
						const facts: HostFacts = {
							O: [{ id: uuidOf(1), n: BigInt(s.members.length), total: s.total }],
							F: Arr.map(s.members, (m, i) => ({
								fid: uuidOf(100 + i),
								o: uuidOf(1),
								at: BigInt(i),
								x: m.x,
								before: m.before,
								after: m.after
							}))
						}
						assert.equal(
							violates(visible, lawOfShape(visible, "fold"), facts),
							fault !== "lawful",
							`${Formatter.format(s)} is ${fault}`
						)
					})
			)
		)
	)

	/** A fold's declaration the rule judges: its family's order and whether it names its pair. */
	interface Declared {
		readonly order: "ordered" | "counted"
		readonly pair: boolean
	}

	type Verdict = "an ordered family's named pair admitted" | "refused"

	it.effect("folds only a sequence, and names its (before, after) pair there", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/theory/concat-fold-rule",
					generator: (source): Declared => ({
						order: element(["ordered", "counted"] as const)(source),
						pair: element([true, false] as const)(source)
					}),
					literal: Formatter.format,
					box: "an ordered or counted family, its pair named or hidden",
					oracle: {
						kind: "specification",
						name: "a non-commutative monoid folds a sequence by its named pair (check/fold.ts foldRule)"
					},
					coverage: requiredInSpace<Verdict>([
						"an ordered family's named pair admitted",
						"refused"
					]),
					caseHang,
					concurrency: 1
				},
				(d, k) =>
					Effect.sync(() => {
						const built = theoryResult(concatSchema(d.order, d.pair))
						const admitted = d.order === "ordered" && d.pair
						if (admitted) {
							assert.ok(built.ok, `${Formatter.format(d)} builds its theory`)
							k.note("an ordered family's named pair admitted")
							return
						}
						const e = refused(built, "Refused", `${Formatter.format(d)} is refused`)
						assert.equal(
							e.reason._tag === "Refused" ? e.reason.refusal : undefined,
							d.order === "counted"
								? "a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"
								: "a concat fold names its (before, after) pair after its value: its law reads each member's running value"
						)
						k.note("refused")
					})
			)
		)
	)
})
