/**
 * A generated field whose expression's type shares no value with its declared type is refused when the schema compiles
 * (check/generated.ts generatedTypeRule, disjoint), located at the field and naming both types: its column's domain
 * would refuse every row, so no row could ever be written. Where the two overlap, the domain stays the judge and the
 * field installs. The text analysis decides the overlap by the two types' patterns' conjunction, and by its members
 * within the tighter byte bound.
 *
 * Each case draws the declared type, the stored field's type and the map the expression applies to it, none or ASCII's
 * case fold. Oracle: a search over every text of at most four characters for a stored value whose mapped value the
 * declared type holds (overlapWitness).
 *
 * Features: a disjoint pair by language, by the byte bound, and an overlapping pair, each under each map.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import { refused } from "#test/support/assert.ts"
import {
	type DisjointCase,
	disjointCaseGen,
	type GenerationMap,
	installedCase,
	overlapWitness
} from "#test/unit/check/generated-disjoint.fixtures.ts"

type DisjointFeature =
	| `a disjoint pair by language under ${GenerationMap}`
	| `a disjoint pair by the byte bound under ${GenerationMap}`
	| `an overlapping pair under ${GenerationMap}`

/**
 * A generated field is refused exactly when no value of its expression's type is one of its declared type's. Each case
 * compiles a fresh installation, so its budget is the runner's own 150 runs, which reach its 6 situations.
 */
export const aGeneratedFieldIsRefusedExactlyWhenNoValueOfItsExpressionsTypeIsOneOfItsDeclaredTypes =
	property.explore(disjointCaseGen, {
		needs: {},
		situations: [
			"a disjoint pair by language under identity",
			"a disjoint pair by language under lowerAscii",
			"a disjoint pair by the byte bound under identity",
			"a disjoint pair by the byte bound under lowerAscii",
			"an overlapping pair under identity",
			"an overlapping pair under lowerAscii"
		] satisfies ReadonlyArray<Reached<DisjointFeature>>,
		check: (_, k: Case<DisjointFeature>) => (c: DisjointCase) =>
			Effect.sync(() => {
				const where = `${c.declared.name} generated from ${c.map} of ${c.stored.name}`
				const installed = installedCase(c)
				const witness = overlapWitness(c)
				if (Option.isSome(witness)) {
					assert.ok(
						installed.ok,
						`${where} overlaps at ${Formatter.format(witness.value)}, so it installs`
					)
					k.note(`an overlapping pair under ${c.map}`)
					return
				}
				const { reason } = refused(
					installed,
					"GeneratedRefused",
					`${where} shares no value, so it is refused`
				)
				assertVariant(reason, "_tag", "GeneratedRefused", where)
				assert.equal(reason.field, "value", `${where} is refused at its field`)
				assert.equal(reason.rule.kind, "disjoint", `${where} is refused as disjoint`)
				k.note(
					c.declared.name === "any text of at most 2 bytes" ||
						c.stored.name === "any text of at most 2 bytes"
						? `a disjoint pair by the byte bound under ${c.map}`
						: `a disjoint pair by language under ${c.map}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a search over every text of at most four characters for a stored value whose mapped value the declared type holds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/generated.ts",
				original: "\tif (!patterns.language(both).ok) {\n\t\treturn true\n\t}",
				replacement: "",
				why: "A pair whose patterns share no value is admitted, its domain refusing every row; the property fails."
			},
			{
				file: "packages/engine/src/check/generated.ts",
				original: '\treturn within.kind === "within" && within.bytes === 0',
				replacement: "\treturn false",
				why: "A pair whose common values all pass the tighter byte bound is admitted, its domain refusing every row; the property fails."
			}
		]
	})
