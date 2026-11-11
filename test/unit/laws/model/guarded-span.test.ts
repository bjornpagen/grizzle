/**
 * A span key compares its scalar fields and overlaps its span (laws/model/uniques.ts relationLaws), over every fact of
 * its relation or over a selection, whose rows a guard holds. A span key over a selected side that compares nothing
 * beside its span is a span unique object whose rows its selection guards and whose key binds no scalar: a write's
 * probe and its pair check read no selection over a span, so the law model refuses it as it is built, a typed
 * UnsupportedOperation at generate. Every other span key compiles: over every fact, its span alone or beside scalars,
 * and over a selection, beside a scalar.
 *
 * Property: every span key of T (an id, scalar fields a and b, a selector kind and a span during), over every fact or
 * over the facts of one kind, keyed by its span beside any ordered choice of a and b, none included, builds its
 * schema's artifacts exactly when its side is every fact or it compares a scalar, and is refused with
 * UnsupportedOperation otherwise.
 *
 * Box: both sides by every ordered choice of the scalars, ten keys, exhausted. Oracle: the rule above, a specification.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): guarded-span-whole-side (a span-alone key over every fact is refused
 * too), guarded-span-scalar-refused (a selected span key is refused beside a scalar too).
 *
 * Features: a span-alone key over a selection, a span-alone key over every fact, a guarded span key with a scalar, a
 * span key with a scalar over every fact.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, type Gen, shuffled } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { keyBuilder, onBuilder, selectBuilder } from "#compiler/schema/statements.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

/** A span key of T: over every fact or a selection of them, and the scalars it compares beside its span, in order. */
interface SpanKey {
	readonly selected: boolean
	readonly scalars: ReadonlyArray<"a" | "b">
}

const spanKeyGen: Gen<SpanKey> = (source) => ({
	selected: source.draw(boolean),
	scalars: source.draw(shuffled(["a", "b"] as const, { min: 0, max: 2 }))
})

type TRow = { readonly kind: RowTerm } & typeof rowHelpers

/** The schema whose one relation T states the span key `k`. */
const schemaOf = (k: SpanKey) => {
	const T = relation(
		"T",
		{ id: uuid, kind: pg.integer, a: uuid, b: pg.integer, during: span(pg.bigint) },
		["id"],
		[]
	)
	const side = k.selected ? selectBuilder(T, (r: TRow) => r.eq(r.kind, 1)) : T
	return schema("GuardedSpan", { T }, [keyBuilder(onBuilder(side, [...k.scalars, "during"]))], [])
}

type Feature =
	| "a span-alone key over a selection"
	| "a span-alone key over every fact"
	| "a guarded span key with a scalar"
	| "a span key with a scalar over every fact"

describe("a span key", () => {
	it.effect(
		"is refused as the law model is built exactly when it compares nothing but its span over a selection",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/guarded-span",
						generator: spanKeyGen,
						literal: Formatter.format,
						box: "a span key of T over every fact or over a selection, beside every ordered choice of its two scalars",
						oracle: {
							kind: "specification",
							name: "refused with UnsupportedOperation exactly when its side is selected and it compares no scalar"
						},
						coverage: requiredInSpace<Feature>([
							"a span-alone key over a selection",
							"a span-alone key over every fact",
							"a guarded span key with a scalar",
							"a span key with a scalar over every fact"
						]),
						caseHang
					},
					(k, c) =>
						Effect.sync(() => {
							const built = testArtifacts(schemaOf(k), testCompile)
							const alone = k.scalars.length === 0
							c.note(
								k.selected
									? alone
										? "a span-alone key over a selection"
										: "a guarded span key with a scalar"
									: alone
										? "a span-alone key over every fact"
										: "a span key with a scalar over every fact"
							)
							if (k.selected && alone) {
								refused(built, "UnsupportedOperation", "a span-alone key over a selection")
								return
							}
							succeeded(built, "a span key over every fact, or beside a scalar, compiles")
						})
				)
			)
	)
})
