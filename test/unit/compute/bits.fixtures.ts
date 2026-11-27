/** What the properties of bits.test.ts read: its spaces, models and helpers. */

import { assert, assertNot, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { ExprId } from "#compiler/core/ids.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { builtExpr, OpId, predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { type NativeFn, nativeOp } from "#compiler/scalar/compute/registry.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { capabilitiesOf } from "#compiler/scalar/registry.ts"
import type { HostValue } from "#compiler/scalar/values/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import { upTo } from "#test/support/up-to.ts"
import { paramText } from "#test/support/wire.ts"

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
export const patterns: Gen<Pattern> = (s) => {
	const live = s.draw(int(1, 2 ** size - 1))
	const subsets = submasks(live)
	const a = subsets[s.draw(int(0, subsets.length - 1))] ?? 0
	const b = subsets[s.draw(int(0, subsets.length - 1))] ?? 0
	return { live, a, b }
}

/** The catalogue member a JavaScript caller names each operation over two values by, the registry's function name. */
export const twoOperandCores: Readonly<
	Partial<Record<NativeFn, (a: unknown, b: unknown) => unknown>>
> = {
	eq: computeCore.eq,
	ne: computeCore.ne,
	union: computeCore.union,
	intersection: computeCore.intersection,
	difference: computeCore.difference,
	subset: computeCore.subset,
	disjoint: computeCore.disjoint
}

export type Situation =
	| "a singleton at the first code"
	| "a singleton at the last code"
	| "a singleton past a hole, its code no position"
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

/** The host's value of `root`, which reads no leaf but its literals and a closed read that answers NULL. */
const hostValue = (root: ScalarExpr) => {
	const table = predicateTable(root)
	return succeeded(
		compiledExpr(table)(
			{ value: undefined, column: () => undefined, closed: () => sqlNull, param: noParamLeaf },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates the set algebra"
	)
}

/** The host's value of `root`, no operand of which is NULL. */
const evaluated = (root: ScalarExpr): HostValue => {
	const value = hostValue(root)
	assertNot(value, sqlNull, "the host's set is a value, no operand being NULL")
	return value
}

/**
 * Each operation the evaluator applies to two sets of one roster agrees with the model of their codes, and each set it
 * returns is written by the codec as the model's set, one bit per code, its holes 0.
 */
export const agrees = ({ live, a, b }: Pattern, c: Case<Situation>) =>
	Effect.sync(() => {
		const codes = Array.from({ length: size }, (_, code): CodeSlot =>
			isSet(live, code) ? { kind: "live", handle: handleOf(code) } : { kind: "hole" }
		)
		const roster = Roster.of(kind, "ordered", nonEmpty(Arr.map([...codesOf(live)], handleOf)))
		const book: Codebook = {
			rosters: new Map([[kind, rosterCodec(kind, codes)]]),
			spellings: noSpellings
		}
		const set: ScalarType = {
			carrier: "bits",
			caps: capabilitiesOf("bits"),
			contract: undefined,
			roster
		}
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
		const code: ScalarType = {
			carrier: "code",
			caps: capabilitiesOf("code"),
			contract: undefined,
			roster,
			only: undefined
		}
		const adjoined = (to: ScalarExpr, handle: ScalarExpr, label: string): ScalarExpr =>
			opNode("set_bit(bit,integer,integer)", [to, handle], set, label)
		const empty = literal(0, "empty")
		const handleLiteral = (k: number): ScalarExpr =>
			builtExpr(
				{
					kind: "literal",
					value: { kind: "handle", handle: handleOf(k) },
					type: code,
					args: [],
					nonNull: "literal"
				},
				ExprId(`h${k}`)
			)
		const liveCodes = nonEmpty([...codesOf(live)], "a live code")
		for (const k of liveCodes) {
			const handle = handleLiteral(k)
			const single = evaluated(adjoined(empty, handle, "singleton"))
			if (!(single instanceof Set)) {
				return assert.fail("a singleton is a set")
			}
			assert.deepEqual([...single], [handleOf(k)], `the singleton of code ${k}`)
			assert.equal(
				succeeded(codec.encode(single)),
				paramText(bitText(new Set([k]))),
				`the singleton of code ${k} as bit(${setWidth(size)}), the set Bits.of writes for its handle`
			)
			const grown = evaluated(adjoined(x, handle, "adjoin"))
			if (!(grown instanceof Set)) {
				return assert.fail("a set with one more handle is a set")
			}
			assert.equal(
				succeeded(codec.encode(grown)),
				paramText(bitText(new Set([...ma, k]))),
				`a with code ${k} added`
			)
			if (k === 0) {
				c.note("a singleton at the first code")
			}
			if (k === size - 1) {
				c.note("a singleton at the last code")
			}
			if (
				Arr.some(
					upTo(k, (below) => below),
					(below) => !isSet(live, below)
				)
			) {
				c.note("a singleton past a hole, its code no position")
			}
		}
		const absent = builtExpr(
			{
				kind: "closedAt",
				relation: "Pick",
				field: "kind",
				args: [handleLiteral(liveCodes[0])],
				type: code,
				nonNull: "absentRefused"
			},
			ExprId("absent")
		)
		assert.equal(
			hostValue(adjoined(empty, absent, "singleton of NULL")),
			sqlNull,
			"the singleton of a NULL handle is NULL"
		)
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
				paramText(bitText(model[fn])),
				`${fn} as bit(${setWidth(size)})`
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
