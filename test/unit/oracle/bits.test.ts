/**
 * The reference evaluator's set algebra (test/support/oracle/evaluate/catalog.ts evaluate), each operation over two
 * sets of one roster's handles, against a naive model of sets of codes.
 *
 * - The oracle, a second implementation: a set is a Set<number> of its codes in a roster of five handles; union,
 *   intersection and difference are the Set operations, cardinality the count, subset and disjointness the membership
 *   tests, and a set with one more handle (set_bit, Compute.singleton's over the empty set) the set with its code
 *   added. It shares no code with the evaluator, which reads sets of handles.
 * - The box, exhausted: every pair of subsets of the five handles (1,024 cases), each with every handle added to the
 *   first and to the empty set.
 * - Features, required in the space: an empty set, a strict subset, disjoint sets, overlapping sets.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/bits-strict-subset.patch (subset read as a strict subset) turns the
 * property red.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Result } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { builtExpr, OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"

const size = 5

const handleOf = (code: number): string => `h${code}`

const codesOf = (mask: number): ReadonlySet<number> =>
	new Set(
		Arr.filter(
			Arr.makeBy(size, (code) => code),
			(code) => ((mask >> code) & 1) === 1
		)
	)

/** One case: two sets of the roster's codes, each a bit mask. */
interface Pair {
	readonly a: number
	readonly b: number
}

const pairs: Gen<Pair> = (s) => ({
	a: s.draw(int(0, 2 ** size - 1)),
	b: s.draw(int(0, 2 ** size - 1))
})

type Situation = "an empty set" | "a strict subset" | "disjoint sets" | "overlapping sets"

const roster = Roster.of(succeeded(parseDeclaredName("Kind")), nonEmpty(Arr.makeBy(size, handleOf)))
const set: ScalarType = { carrier: "bits", caps: capabilitiesOf("bits"), roster }
const code: ScalarType = {
	carrier: "code",
	caps: capabilitiesOf("code"),
	contract: undefined,
	roster
}
const plain = (carrier: "bool" | "int8"): ScalarType => ({
	carrier,
	caps: capabilitiesOf(carrier),
	contract: undefined
})

const literal = (mask: number, label: string): ScalarExpr =>
	builtExpr(
		{
			kind: "literal",
			value: { kind: "handles", handles: Arr.map([...codesOf(mask)], handleOf) },
			type: set,
			args: [],
			nonNull: "literal"
		},
		ExprId(label)
	)

/** The registry's node of `id` over `args`, of `type`. */
const opNode = (id: string, args: ReadonlyArray<ScalarExpr>, type: ScalarType, label: string) => {
	const op = defined(nativeOp(OpId(id)), `the registry lists ${id}`)
	if (op.partial) {
		return assert.fail(`${id} is total`)
	}
	return builtExpr(
		{ kind: "op", op: op.id, args, type, nonNull: "strict", volatility: "immutable" },
		ExprId(label)
	)
}

/** The evaluator's value of `root`, which reads no leaf but its literals: exact, never declined. */
const evaluated = (root: ScalarExpr): unknown => {
	const r = evaluate(root, constantEnv)
	return Result.isSuccess(r) ? r.success : assert.fail(`declined: ${Formatter.format(r.failure)}`)
}

const handlesOf = (value: unknown): ReadonlyArray<string> =>
	value instanceof Set
		? Arr.sort(Arr.map([...value], String), Order.String)
		: assert.fail(`a set, not ${Formatter.format(value)}`)

const agrees = ({ a, b }: Pair, c: Case<Situation>) =>
	Effect.sync(() => {
		const x = literal(a, "a")
		const y = literal(b, "b")
		const ma = codesOf(a)
		const mb = codesOf(b)
		const sorted = (codes: Iterable<number>): ReadonlyArray<string> =>
			Arr.sort(Arr.map([...codes], handleOf), Order.String)
		assert.deepEqual(
			handlesOf(evaluated(opNode("bitor", [x, y], set, "union"))),
			sorted(new Set([...ma, ...mb])),
			"union"
		)
		assert.deepEqual(
			handlesOf(evaluated(opNode("bitand", [x, y], set, "intersection"))),
			sorted(Arr.filter([...ma], (k) => mb.has(k))),
			"intersection"
		)
		assert.deepEqual(
			handlesOf(evaluated(opNode("difference:bits", [x, y], set, "difference"))),
			sorted(Arr.filter([...ma], (k) => !mb.has(k))),
			"difference"
		)
		assert.equal(
			evaluated(opNode("bit_count(bit)", [x], plain("int8"), "cardinality")),
			BigInt(ma.size),
			"cardinality"
		)
		const subset = Arr.every([...ma], (k) => mb.has(k))
		const disjoint = !Arr.some([...ma], (k) => mb.has(k))
		assert.equal(
			evaluated(opNode("subset:bits", [x, y], plain("bool"), "subset")),
			subset,
			"subset"
		)
		assert.equal(
			evaluated(opNode("disjoint:bits", [x, y], plain("bool"), "disjoint")),
			disjoint,
			"disjoint"
		)
		for (const k of Arr.makeBy(size, (k) => k)) {
			const handle = builtExpr(
				{
					kind: "literal",
					value: { kind: "handle", handle: handleOf(k) },
					type: code,
					args: [],
					nonNull: "literal"
				},
				ExprId(`h${k}`)
			)
			assert.deepEqual(
				handlesOf(
					evaluated(
						opNode("set_bit(bit,integer,integer)", [literal(0, "empty"), handle], set, "singleton")
					)
				),
				sorted([k]),
				`the singleton of code ${k}`
			)
			assert.deepEqual(
				handlesOf(evaluated(opNode("set_bit(bit,integer,integer)", [x, handle], set, "adjoin"))),
				sorted(new Set([...ma, k])),
				`a with code ${k} added`
			)
		}
		if (ma.size === 0 || mb.size === 0) {
			c.note("an empty set")
		}
		if (subset && ma.size < mb.size) {
			c.note("a strict subset")
		}
		if (disjoint && ma.size > 0 && mb.size > 0) {
			c.note("disjoint sets")
		}
		if (!subset && !disjoint) {
			c.note("overlapping sets")
		}
	})

describe("the reference evaluator's set algebra", () => {
	it.effect("agrees with a model of sets of codes", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/oracle/bits",
					generator: pairs,
					literal: Formatter.format,
					limit: 1024,
					coverage: requiredInSpace<Situation>([
						"an empty set",
						"a strict subset",
						"disjoint sets",
						"overlapping sets"
					]),
					caseHang,
					box: "every pair of subsets of a roster of five handles",
					oracle: { kind: "second-implementation", name: "a Set<number> model of the codes" }
				},
				agrees
			)
		)
	)
})
