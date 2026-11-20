/**
 * A coverage law, a containment pairing a span field of each side, lowers natively (fin.md §7, w4-w7 §2.5): each
 * selected side's guarded term, its scalar, is a law column and its span its own field (laws/model/plan.ts
 * sideColumns); the target is keyed WITHOUT OVERLAPS over exactly its terms, by its declared
 * span key or by a key over its projected side; and the law is `FOREIGN KEY (f…, PERIOD s) REFERENCES B (g…, PERIOD t)`
 * with the index over its referencing columns, and always deferred: it references the target's span as a period, so
 * one ChangeSet may replace the facts covering a source's span by others that still cover it, a span cut or split,
 * which the target's WITHOUT OVERLAPS key admits only once the facts they overlap are deleted, after the reference is
 * checked if it were immediate. A target whose spans may overlap within a key, one keyed
 * WITHOUT OVERLAPS over no such terms, is refused with fin.md §7's sentence.
 *
 * Every installation holds a span key's law columns before the key names them, so a key over a selected side is its own
 * ALTER TABLE ... ADD CONSTRAINT after them (42703 otherwise).
 *
 * The oracle is fin.md §7 turned into a checker, over the natives' structure: PostgreSQL's PERIOD references are no
 * part of the host model of the natives, so their semantics are NP's (test/pg/laws/coverage.test.ts), judged by
 * PostgreSQL.
 *
 * Bound: every coverage of a source selected or not into five targets: unselected and keyed by its span key, with a
 * payload field or none; unselected and unkeyed; selected and keyed by a key over its side; selected and unkeyed. Ten
 * shapes, exhausted.
 *
 * Features: a selected source, a selected target, an unkeyed target, a replaceable target, an irreplaceable target.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	checkShape,
	type Feature,
	features,
	shapeGen
} from "#test/unit/laws/model/coverage.fixtures.ts"

/** A coverage law lowers to a PERIOD reference into a WITHOUT OVERLAPS key every coverage of a selected or unselected source into a selected or unselected, keyed or unkeyed target. */
export const aCoverageLawLowersToAPERIODReferenceIntoAWITHOUTOVERLAPSKeyEveryCoverageOfASelectedOrUnselectedSourceIntoASelectedOrUnselectedKeyedOrUnkeyedTarget =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				if (s.source === "selected") {
					c.note("a selected source")
				}
				if (s.target === "selected") {
					c.note("a selected target")
				}
				if (!s.keyed) {
					c.note("an unkeyed target")
				} else {
					c.note(
						s.target === "selected" || s.payload
							? "a replaceable target"
							: "an irreplaceable target"
					)
				}
				checkShape(s)
			}),
		oracle: {
			kind: "specification",
			name: "fin.md §7's coverage lowering and its refusal as a checker"
		},
		box: "a source selected or not into a target selected or not, keyed or not, with a payload field or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\tif (!declared && !projected) {\n\t\t\treturn refuse("UnsupportedLawFamily", loc, coverageKeySentence)\n\t\t}',
				replacement: "",
				why: "A coverage into a target keyed WITHOUT OVERLAPS over none of its terms lowers instead of being refused (laws/model/plan.ts coverage)."
			}
		]
	})
