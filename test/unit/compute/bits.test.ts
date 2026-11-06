/**
 * The host evaluator's set algebra over a roster (scalar/compute/evaluate.ts evaluateTable), each operation as the
 * registry names it, against a naive model of sets of codes.
 *
 * - The model: a set is a Set<number> of its codes in a roster of five codes, each live or a hole; union, intersection
 *   and difference are the Set operations, cardinality the count, subset and disjointness the membership tests.
 * - The codec as a second reader: each set the evaluator returns, written by the set codec under the installation's
 *   codes, is the model's set as one bit per code in its one text, X then the hex digits of the bits domain's width,
 *   holes and padding 0 (test/support/closed/bit-text.ts), so the host and the bit string PostgreSQL stores agree.
 * - The named invalid variant, refused at typing: a set operation over sets of two rosters, which are two universes
 *   whose codes name other handles.
 *
 * The box, exhausted: every hole pattern of a five-code roster that leaves a handle live, and every pair of subsets of
 * its live handles.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { ExprId } from "#compiler/core/ids.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { builtExpr, OpId, predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Roster, ScalarType } from "#compiler/ir/scalar.ts"
import { bits } from "#compiler/public/fields.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import { closed } from "#compiler/schema/api.ts"
import { assert, defined, nonEmpty, succeeded, throwsRefused } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import { caseHang } from "#test/support/limits.ts"

/** The codes a roster of the box has minted, holes included. */
const size = 5

const kind = succeeded(parseDeclaredName("Kind"))

const handleOf = (code: number): string => `h${code}`

const isSet = (mask: number, code: number): boolean => ((mask >> code) & 1) === 1

const codesOf = (mask: number): ReadonlySet<number> =>
	new Set(
		Arr.filter(
			Array.from({ length: size }, (_, code) => code),
			(code) => isSet(mask, code)
		)
	)

/** The masks below 2^size that `within` covers: its subsets. */
const submasks = (within: number): ReadonlyArray<number> =>
	Arr.filter(
		Array.from({ length: 2 ** size }, (_, mask) => mask),
		(mask) => (mask & ~within) === 0
	)

/** One case: the live codes (a bit mask), and two sets of them (bit masks). */
interface Pattern {
	readonly live: number
	readonly a: number
	readonly b: number
}

/** Every hole pattern that leaves a handle live, and every pair of subsets of its live codes: Σ_k C(5,k)·4^k = 3124. */
const patterns: Gen<Pattern> = (s) => {
	const live = s.draw(int(1, 2 ** size - 1))
	const subsets = submasks(live)
	const a = subsets[s.draw(int(0, subsets.length - 1))] ?? 0
	const b = subsets[s.draw(int(0, subsets.length - 1))] ?? 0
	return { live, a, b }
}

const setOperations = ["union", "intersection", "difference", "subset", "disjoint"] as const
type SetOperation = (typeof setOperations)[number]

type Situation =
	| "a hole"
	| "an empty set"
	| "a strict subset"
	| "disjoint sets"
	| "overlapping sets neither within the other"

const plain = (carrier: "bool" | "int8"): ScalarType => ({
	carrier,
	caps: capabilitiesOf(carrier),
	contract: undefined
})

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

/** The host's value of `root`, which reads no leaf but its literals. */
const evaluated = (root: ScalarExpr): CarrierValue => {
	const table = predicateTable(root)
	return succeeded(
		evaluateTable(
			table.exprs,
			table.root,
			{ value: undefined, column: () => undefined, closed: () => undefined },
			() => false
		),
		"the host evaluates the set algebra"
	)
}

/**
 * Each operation the evaluator applies to two sets of one roster agrees with the model of their codes, and each set it
 * returns is written by the codec as the model's set, one bit per code, its holes 0.
 */
const agrees = ({ live, a, b }: Pattern, c: Case<Situation>) =>
	Effect.sync(() => {
		const codes = Array.from({ length: size }, (_, code): CodeSlot =>
			isSet(live, code) ? { kind: "live", handle: handleOf(code) } : { kind: "hole" }
		)
		const roster: Roster = {
			closed: kind,
			handles: nonEmpty(Arr.map([...codesOf(live)], handleOf))
		}
		const book: Codebook = { rosters: new Map([[kind, rosterCodec(kind, codes)]]) }
		const set: ScalarType = { carrier: "bits", caps: capabilitiesOf("bits"), roster }
		const literal = (mask: number, label: string): ScalarExpr =>
			builtExpr(
				{
					kind: "literal",
					value: {
						kind: "handles",
						handles: Arr.filter(roster.handles, (h) => isSet(mask, Number(Str.slice(1)(h))))
					},
					type: set,
					args: [],
					nonNull: "literal"
				},
				ExprId(label)
			)
		const x = literal(a, "a")
		const y = literal(b, "b")
		const ma = codesOf(a)
		const mb = codesOf(b)
		const model = {
			union: new Set([...ma, ...mb]),
			intersection: new Set(Arr.filter([...ma], (k) => mb.has(k))),
			difference: new Set(Arr.filter([...ma], (k) => !mb.has(k)))
		}
		const codec = scalarCodec(set, book)
		const bitText = (members: ReadonlySet<number>): string =>
			`X${hexOfText(setText(size, [...members]))}`
		for (const [id, fn] of [
			["bitor", "union"],
			["bitand", "intersection"],
			["difference:bits", "difference"]
		] as const) {
			const result = evaluated(opNode(id, [x, y], set, fn))
			if (!(result instanceof Set)) {
				return assert.fail(`${fn} is a set`)
			}
			assert.deepEqual(
				Arr.sort(Arr.map([...result], String), Order.String),
				Arr.sort(Arr.map([...model[fn]], handleOf), Order.String),
				fn
			)
			assert.equal(
				succeeded(codec.encode(result)),
				bitText(model[fn]),
				`${fn} as bit(${wholeDigits(size)})`
			)
		}
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
		if (live !== 2 ** size - 1) {
			c.note("a hole")
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
		if (!subset && !Arr.every([...mb], (k) => ma.has(k)) && !disjoint) {
			c.note("overlapping sets neither within the other")
		}
	})

describe("the host's set algebra", () => {
	it.effect(
		"agrees with a model of sets of codes, and writes its sets one bit per code, holes 0",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/bits",
						generator: patterns,
						literal: Formatter.format,
						limit: 3124,
						coverage: requiredInSpace<Situation>([
							"a hole",
							"an empty set",
							"a strict subset",
							"disjoint sets",
							"overlapping sets neither within the other"
						]),
						caseHang,
						box: "every hole pattern of five codes, every pair of subsets of its live handles",
						oracle: { kind: "second-implementation", name: "a Set<number> model of the codes" }
					},
					agrees
				)
			)
	)

	it.effect(
		"refuses every set operation over sets of two rosters, which name other handles",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/bits-two-rosters",
						generator: element(setOperations),
						literal: Formatter.format,
						limit: setOperations.length,
						coverage: requiredInSpace<SetOperation>(setOperations),
						caseHang,
						box: "every binary set operation",
						oracle: { kind: "specification", name: "a set meets only a set of its roster" }
					},
					(operation, c) =>
						Effect.sync(() => {
							const left = bits(closed("Left", ["a", "b"]))
							const right = bits(closed("Right", ["a", "b"]))
							const x = Compute.literal(left, new Set(["a"]))
							const y = Compute.literal(right, new Set(["a"]))
							throwsRefused(() => Compute[operation](x, y), "MalformedDescription")
							c.note(operation)
						})
				)
			)
	)
})
