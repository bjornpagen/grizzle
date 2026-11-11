/**
 * A span key over a selected side that compares nothing beside its span, `key(on(select(T, kind = j), "during"))`, is a
 * span unique object whose rows its selection guards and whose key binds no scalar: a write's probe and its pair check
 * read no selection over a span, so the law model refuses it as it is built (laws/model/uniques.ts relationLaws), a
 * typed refusal at generate, as it was refused before span-alone keys compiled. The box is exhausted over the
 * selection's value.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

/** The selections the box keys: `kind = j` for each of these. */
const kinds = 3

/** The schema whose one relation T keys its selected side `kind = j` by its span alone. */
const guardedSpanKey = (j: number) => {
	const T = relation("T", { id: uuid, kind: pg.integer, during: span(pg.bigint) }, ["id"])
	return schema("GuardedSpan", { T }, [
		key(
			on(
				select(T, (t) => t.eq(t.kind, j)),
				"during"
			)
		)
	])
}

describe("a span-alone key over a selected side", () => {
	it.effect(
		"is refused as the law model is built, at generate, when it compares nothing but its span",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "specification", name: "a typed refusal naming the selected span key" },
						suite: "unit/laws/model/guarded-span",
						generator: int(0, kinds - 1),
						literal: Formatter.format,
						limit: kinds,
						coverage: noCoverage,
						caseHang
					},
					(j) =>
						Effect.sync(() => {
							const built = testArtifacts(guardedSpanKey(j), testCompile)
							assert.equal(
								built.ok,
								false,
								`the span-alone key over the selection kind = ${j} compiled`
							)
							if (!built.ok) {
								assert.equal(
									built.error.reason._tag,
									"UnsupportedOperation",
									Formatter.format(built.error)
								)
							}
						})
				)
			)
	)
})
