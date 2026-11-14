/**
 * A set states its roster at every door a set enters: Bits.of(R, handles) over one of two rosters whose handles share
 * names, entered at a field over either roster as a Compute literal, a comparison's operand, a closed relation's fact
 * (schema/literal.ts) and the codec a parameter or a written fact is encoded by (codec/scalar.ts), beside a plain Set of
 * the same names, which states no roster.
 *
 * The oracle: every door admits the set exactly when it states the field's own roster or none and every handle is one
 * the field's roster holds, a literal's refusal MalformedDescription and the codec's the fault bitsMember or bitsType;
 * an admitted literal holds exactly its handles, in the field roster's order, and the codec encodes the set as it
 * encodes a plain Set of the same handles.
 *
 * Features: each door admitting and refusing, and a set of another roster whose names the field holds.
 *
 * Plants: compute-bits-door-unstated (the codec's door reads a set's handles alone, its stated roster unchecked, so
 * Bits.of(Alpha, ["low"]) at a field over Beta is admitted where Beta holds "low").
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Result } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { Bits, bits } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { literalResult } from "#compiler/schema/literal.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The names both rosters draw their handles from. */
const names = ["low", "high", "dark"] as const

type Door =
	| "a Compute literal"
	| "a comparison's operand"
	| "a closed relation's fact"
	| "the codec"

/** Who made the set: Bits.of over the first roster or the second, or a plain Set, which states none. */
type Maker = "Alpha" | "Beta" | "a plain Set"

type Feature =
	| `${Door} ${"admitted" | "refused"}`
	| "a set of another roster whose names the field holds"

/** The handles a mask over the names picks, in the names' order. */
const picked = (mask: number): ReadonlyArray<string> =>
	Arr.filter(names, (_, i) => (mask >> i) % 2 === 1)

/** A nonempty pick of handles: a mask of at least one name. */
const handlesOf = (mask: number): NonEmptyReadonlyArray<string> =>
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

/** The literal operand of a predicate or a term a Compute builder recorded: the comparison's right side, or itself. */
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
const doorVerdict = (
	door: Door,
	field: ReturnType<typeof bits>,
	set: ReadonlySet<string>,
	members: ReadonlyArray<string>
): Effect.Effect<Verdict> => {
	const described = describeFieldOrThrow(field, SourceLoc("the set's field", []))
	const roster = defined(rosterOf(described.scalar), "a set field's roster")
	switch (door) {
		case "a Compute literal":
			return built(() => Compute.literal(field, set))
		case "a comparison's operand":
			return built(() => Compute.eq(Compute.literal(field, new Set<string>()), set))
		case "a closed relation's fact": {
			const literal = literalResult(described.desc, set, roster.handles)
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

describe("a set over a roster", () => {
	it.effect(
		"is admitted at a field exactly when it states that field's roster or none, at every door",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/roster-set",
						oracle: {
							kind: "specification",
							name: "a set states its roster, or none, at every door"
						},
						box: "two rosters over three names, every maker and pick of a set, at a field over either, at every door",
						generator: (source) => ({
							alpha: source.draw(int(1, 7)),
							beta: source.draw(int(1, 7)),
							maker: source.draw(element<Maker>(["Alpha", "Beta", "a plain Set"])),
							members: source.draw(int(0, 7)),
							field: source.draw(element<"Alpha" | "Beta">(["Alpha", "Beta"])),
							door: source.draw(
								element<Door>([
									"a Compute literal",
									"a comparison's operand",
									"a closed relation's fact",
									"the codec"
								])
							)
						}),
						literal: Formatter.format,
						coverage: requiredInSpace<Feature>([
							"a Compute literal admitted",
							"a Compute literal refused",
							"a comparison's operand admitted",
							"a comparison's operand refused",
							"a closed relation's fact admitted",
							"a closed relation's fact refused",
							"the codec admitted",
							"the codec refused",
							"a set of another roster whose names the field holds"
						]),
						caseHang,
						concurrency: 1
					},
					(c, k) =>
						Effect.gen(function* () {
							const rosters = {
								Alpha: closed("Alpha", handlesOf(c.alpha)),
								Beta: closed("Beta", handlesOf(c.beta))
							}
							const made = c.maker === "a plain Set" ? undefined : rosters[c.maker]
							const pool = made === undefined ? names : made.handles
							const members = Arr.filter(picked(c.members), (h) => pool.includes(h))
							const set: ReadonlySet<string> =
								made === undefined ? new Set(members) : Bits.of(made, members)
							const field = bits(rosters[c.field])
							const described = describeFieldOrThrow(field, SourceLoc("the set's field", []))
							const roster = defined(rosterOf(described.scalar), "a set field's roster")
							const held = Arr.every(members, (h) => roster.handles.includes(h))
							const expected = (c.maker === "a plain Set" || c.maker === c.field) && held
							const verdict = yield* doorVerdict(c.door, field, set, members)
							assert.equal(verdict.kind, expected ? "admitted" : "refused", Formatter.format(c))
							if (verdict.kind === "admitted" && verdict.handles !== undefined) {
								assert.deepEqual(
									verdict.handles,
									Arr.filter(roster.handles, (h) => members.includes(h))
								)
							}
							k.note(`${c.door} ${verdict.kind}`)
							if (c.maker !== "a plain Set" && c.maker !== c.field && held && isNonEmpty(members)) {
								k.note("a set of another roster whose names the field holds")
							}
						})
				)
			)
	)
})
