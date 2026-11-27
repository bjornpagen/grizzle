/**
 * A derived relation's union types each column alike whether the installation reads it live or stores it: a bare head
 * literal takes the type its position in the union proves (check/checker.ts #positionedTypes), and a stored relation's
 * upkeep, which reads each rule of the union apart, per unit a transaction wrote (analysis/theory/unit.ts unitStep),
 * reads the definition with each such literal typed at that type (analysis/theory/leaves.ts typedHeads), so no step
 * grizzle writes delivers a column by a bare literal, which the checker refuses as an internal invariant.
 *
 * Property: over the box, a union of a term arm and a literal arm over relations keyed by a child, the installation
 * with the child a declared unit, which stores the union, installs exactly when the installation without it, which
 * reads the union live, installs, refusing it for the same reason otherwise; and where it installs, the union is
 * stored.
 *
 * Oracle: the live installation, the definition checked once as its author wrote it, the specification of how the
 * union types its columns.
 *
 * Inputs, exhaustive: the column a natural beside 0n or -1n, a text of a pattern beside a literal it admits, or a
 * bigint beside a bigint; the literal's arm first or second; the term arm with or without a negation. A
 * natural beside 0n, second, negated, is metis's Withdrawn (packages/assignment/src/views.ts), which main's storage
 * inference (6d7d06f16) stored and whose upkeep the checker refused, natural against bigint.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { installationOf, shapeGen } from "#test/unit/derived/stored-literals.fixtures.ts"

type Feature = "a literal its union types at the term's type" | "a literal its union refuses"

/** A stored union types its columns as the live one does: its upkeep reads each bare head literal at its column. */
export const aStoredUnionTypesItsColumnsAsTheLiveOneDoesItsUpkeepReadingEachBareHeadLiteralAtItsColumn =
	property.exhaust(shapeGen, {
		needs: {},
		situations: [
			"a literal its union types at the term's type",
			"a literal its union refuses"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (shape) =>
			Effect.sync(() => {
				const live = installationOf(shape, false)
				const stored = installationOf(shape, true)
				if (!live.ok) {
					c.note("a literal its union refuses")
					if (stored.ok) {
						return assert.fail(
							`stored, the union installs where live it is refused: ${live.error.message}`
						)
					}
					assert.equal(stored.error.message, live.error.message, "the one refusal, stored or live")
					return
				}
				if (!stored.ok) {
					return assert.fail(
						`stored, the union is refused where live it installs: ${stored.error.message}`
					)
				}
				assert.equal(
					stored.value.checked.holdings.get("W")?.kind,
					"stored",
					"the union unit-local in its declared unit, stored"
				)
				c.note("a literal its union types at the term's type")
			}),
		oracle: {
			kind: "specification",
			name: "the live installation: the definition checked once, as its author wrote it"
		},
		box: "a term arm and a bare literal arm, the column a natural, a text of a pattern or a bigint, the literal admitted or refused by the term's type, either arm first, the term arm negated or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original:
					"\t\t\t\tconst typed = typedHeads(\n\t\t\t\t\tdefinition,\n\t\t\t\t\tthis.#columns(c.subject.name, definition, c.subject.loc)\n\t\t\t\t)\n",
				replacement: "\t\t\t\tconst typed = definition\n",
				why: "The upkeep reads the definition as its author wrote it: each rule of the union read apart types its bare literal at its JavaScript default, a bigint beside a natural, and the step it stands in delivers the column by a bare literal, the checker's internal invariant."
			}
		]
	})
