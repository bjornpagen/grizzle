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
 * Features: a span-alone key over a selection, a span-alone key over every fact, a guarded span key with a scalar, a
 * span key with a scalar over every fact.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { type Feature, schemaOf, spanKeyGen } from "#test/unit/laws/model/guarded-span.fixtures.ts"

/** A span key is refused as the law model is built exactly when it compares nothing but its span over a selection. */
export const aSpanKeyIsRefusedAsTheLawModelIsBuiltExactlyWhenItComparesNothingButItsSpanOverASelection =
	property.exhaust(finite(spanKeyGen), {
		needs: {},
		situations: [
			"a span-alone key over a selection",
			"a span-alone key over every fact",
			"a guarded span key with a scalar",
			"a span key with a scalar over every fact"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (k) =>
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
			}),
		oracle: {
			kind: "specification",
			name: "refused with UnsupportedOperation exactly when its side is selected and it compares no scalar"
		},
		box: "a span key of T over every fact or over a selection, beside every ordered choice of its two scalars",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/uniques.ts",
				original:
					'\t\t\t\t(o) => o.object.kind === "span" && o.object.equal.length === 0 && o.object.within.length > 0',
				replacement: '\t\t\t\t(o) => o.object.kind === "span" && o.object.equal.length === 0',
				why: "A span-alone key over every fact is refused too (laws/model/uniques.ts)."
			},
			{
				file: "packages/engine/src/laws/model/uniques.ts",
				original:
					'\t\t\t\t(o) => o.object.kind === "span" && o.object.equal.length === 0 && o.object.within.length > 0',
				replacement: '\t\t\t\t(o) => o.object.kind === "span" && o.object.within.length > 0',
				why: "A selected span key is refused beside a scalar too (laws/model/uniques.ts)."
			}
		]
	})
