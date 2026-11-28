/** What the properties of roster-set.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Data, Effect, Formatter, Result } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { bit } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { storedLiteral } from "#compiler/scalar/literal.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"

/** The names both rosters draw their handles from. */
export const names = ["low", "high", "dark"] as const

export type Door =
	| "a scalar literal"
	| "a comparison's operand"
	| "a closed relation's fact"
	| "the codec"

/** Who made the set: Bit.of over the first roster or the second, or a plain Set, which states none. */
export type Maker = "Alpha" | "Beta" | "a plain Set"

export type Feature =
	| `${Door} ${"admitted" | "refused"}`
	| "a set of another roster whose names the field holds"

/** The handles a mask over the names picks, in the names' order. */
export const picked = (mask: number): ReadonlyArray<string> =>
	Arr.filter(names, (_, i) => (mask >> i) % 2 === 1)

/** A nonempty pick of handles: a mask of at least one name. */
export const handlesOf = (mask: number): NonEmptyReadonlyArray<string> =>
	defined(
		Arr.match(picked(mask), { onEmpty: () => undefined, onNonEmpty: (h) => h }),
		"a nonempty pick"
	)

/** Whether the door admitted the set, and the handles its literal holds where the door makes one. */
type Verdict =
	| { readonly kind: "admitted"; readonly handles: ReadonlyArray<string> | undefined }
	| { readonly kind: "refused" }

/** The handles of a set literal; undefined for a literal of any other kind. */
const literalHandles = (literal: LiteralDesc): ReadonlyArray<string> | undefined =>
	typeof literal === "object" && "handles" in literal ? literal.handles : undefined

/** The literal operand of a predicate or a term a scalar builder recorded: the comparison's right side, or itself. */
const literalIn = (expr: OpenExpr): ReadonlyArray<string> | undefined =>
	expr.kind === "literal"
		? literalHandles(expr.value)
		: expr.kind === "compare" && expr.right.kind === "literal"
			? literalHandles(expr.right.value)
			: undefined

/** What a builder threw where it refused its operands. */
class BuilderThrew extends Data.TaggedError("BuilderThrew")<{ readonly cause: unknown }> {}

/** A builder's verdict: admitted with what it recorded, or refused as MalformedDescription. */
const built = (make: () => { readonly expr: OpenExpr }): Effect.Effect<Verdict> =>
	Effect.map(
		Effect.result(Effect.try({ try: make, catch: (cause) => new BuilderThrew({ cause }) })),
		(made): Verdict => {
			if (Result.isSuccess(made)) {
				return { kind: "admitted", handles: literalIn(made.success.expr) }
			}
			const thrown = made.failure.cause
			assert.ok(
				thrown instanceof CompileError && thrown.reason._tag === "MalformedDescription",
				`a refused set is MalformedDescription: ${Formatter.format(thrown)}`
			)
			return { kind: "refused" }
		}
	)

/** The verdict of `door` on `set` at the set field `field`, whose roster's handles `members` are drawn against. */
export const doorVerdict = (
	door: Door,
	field: ReturnType<typeof bit>,
	set: ReadonlySet<string>,
	members: ReadonlyArray<string>
): Effect.Effect<Verdict> => {
	const described = describeFieldOrThrow(field, SourceLoc("the set's field", []))
	const roster = defined(rosterOf(described.scalar), "a set field's roster")
	switch (door) {
		case "a scalar literal":
			return built(() => computeCore.literal(field, set))
		case "a comparison's operand":
			return built(() => computeCore.eq(computeCore.literal(field, new Set<string>()), set))
		case "a closed relation's fact": {
			const literal = storedLiteral(described.scalar, set)
			return Effect.succeed(
				literal.ok
					? { kind: "admitted", handles: literalHandles(literal.value) }
					: { kind: "refused" }
			)
		}
		case "the codec": {
			const codec = scalarCodec(described.scalar, firstCodebook([roster]))
			const encoded = codec.encode(set)
			if (!encoded.ok) {
				assert.ok(
					encoded.error === "bitsMember" || encoded.error === "bitsType",
					`the codec refuses a set as a set's fault: ${encoded.error}`
				)
				return Effect.succeed({ kind: "refused" })
			}
			const plain = codec.encode(new Set(members))
			assert.ok(plain.ok && plain.value === encoded.value, "a set encodes as its handles do")
			return Effect.succeed({ kind: "admitted", handles: undefined })
		}
	}
}
