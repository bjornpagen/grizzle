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
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { textInfoBounds, textOf } from "#compiler/ir/scalar.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { describeField } from "#compiler/scalar/registry.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { containedBuilder, onBuilder } from "#compiler/schema/statements.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	featuresOf,
	fieldOf,
	meetCaseGen,
	type MeetFeature,
	meetFeatures
} from "#test/support/text/bytes.ts"
import { expectedBytes } from "#test/unit/text/bytes.fixtures.ts"

/** Str.bytes meets a text a byte bound refines meets every text its pattern meets, and bounds its bytes. Its budget is its suite's before it was a property (test/unit/text/bytes.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const strBytesMeetsATextAByteBoundRefinesMeetsEveryTextItsPatternMeetsAndBoundsItsBytes =
	property.explore(meetCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: meetFeatures satisfies ReadonlyArray<Reached<MeetFeature>>,
		check: (_, k: Case<MeetFeature>) => (c) =>
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
						textInfoBounds(text)?.bytes,
						expectedBytes(side),
						"a side's bytes, the lesser bound"
					)
				}
				const A = relation("A", { id: Id, t: source }, ["id"], [])
				const B = relation("B", { u: target }, ["u"], [])
				const statements: ReadonlyArray<Statement> = [
					containedBuilder(onBuilder(A, ["t"]), onBuilder(B, ["u"]))
				]
				const installation = succeeded(
					Result.flatMap(ownedInput(schema("Meets", [A, B], statements, [])), (owned) =>
						compileInstallation(owned, installOptions(owned))
					),
					"the containment compiles"
				)
				assert.ok(
					Arr.some(installation.laws.natives, (n) => n.object.kind === "ForeignKey"),
					"the containment installed as a foreign key"
				)
				k.noteAll(featuresOf(c))
			}),
		oracle: {
			kind: "specification",
			name: "the lesser of a side's pattern bound and its byte bound, and the containment installed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/install/compile.ts",
				original:
					"\tif (settings.levels.some((l) => identifierOf(l) === settings.extensionSchema)) {",
				replacement: "\tif (settings.levels.some((l) => true)) {",
				why: "Operator mutant (boolean-return) at packages/engine/src/physical/install/compile.ts:331 in admittedSettings: `identifierOf(l) === settings.extensionSchema` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
