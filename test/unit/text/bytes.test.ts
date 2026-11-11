/**
 * str.bytes meets every text a pattern meets, in the engine, generated: test/types/text/bytes.test.ts holds the types
 * to the same cases.
 *
 * Each case is a containment of a source's text in a target's key text drawn as test/support/text/bytes.ts draws them,
 * each side a pattern bounded or not by str.bytes. The oracle: the schema compiles, the containment installed as a
 * foreign key and its target key's UNIQUE; each side's type is text, as its pattern's is, and bounds its bytes at the
 * lesser of its pattern's bound and its byte bound.
 *
 * Features: the meet situations test/support/text/bytes.ts names (meetFeatures).
 *
 * Plants: text-bytes-pattern-bound-kept (a byte bound looser than its pattern's kept, so the tighter one is lost).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { textOf } from "#compiler/ir/scalar.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import { relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import { containedBuilder, onBuilder } from "#compiler/schema/statements.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	featuresOf,
	fieldOf,
	type MeetFeature,
	meetCaseGen,
	meetFeatures,
	type Text
} from "#test/support/text/bytes.ts"

/** The most UTF-8 bytes a side's pattern holds, none for a pattern of no bound. */
const patternBytes = (t: Text): number =>
	t.pattern.kind === "upTo" ? 4 * t.pattern.codePoints : Number.POSITIVE_INFINITY

/** The bytes a side's type bounds, the lesser of its pattern's and its byte bound; none where neither bounds it. */
const expectedBytes = (t: Text): number | undefined => {
	const bound = Math.min(patternBytes(t), t.bytes ?? Number.POSITIVE_INFINITY)
	return Number.isFinite(bound) ? bound : undefined
}

describe("str.bytes meets", () => {
	it.effect(
		"a text a byte bound refines meets every text its pattern meets, and bounds its bytes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the lesser of a side's pattern bound and its byte bound, and the containment installed"
						},
						suite: "unit/text/bytes",
						draw: drawn(meetCaseGen),
						literal: Formatter.format,
						coverage: required<MeetFeature>(meetFeatures, { cases: 200, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const source = fieldOf(c.source)
							const target = fieldOf(c.target)
							for (const [side, field] of [
								[c.source, source],
								[c.target, target]
							] as const) {
								const text = defined(
									textOf(succeeded(describeField(field, SourceLoc("field", []))).scalar),
									"a text side's refinement"
								)
								assert.equal(
									text.byteBound,
									expectedBytes(side),
									"a side's bytes, the lesser bound"
								)
							}
							const A = relation("A", { id: uuid, t: source }, ["id"], [])
							const B = relation("B", { u: target }, ["u"], [])
							const statements: ReadonlyArray<Statement> = [
								containedBuilder(onBuilder(A, ["t"]), onBuilder(B, ["u"]))
							]
							const installation = succeeded(
								Result.flatMap(ownedInput(schema("Meets", { A, B }, statements, [])), (owned) =>
									compileInstallation(owned, installOptions(owned, "owner"))
								),
								"the containment compiles"
							)
							assert.ok(
								Arr.some(installation.laws.natives, (n) => n.object.kind === "ForeignKey"),
								"the containment installed as a foreign key"
							)
							k.noteAll(featuresOf(c))
						})
				)
			)
	)
})
