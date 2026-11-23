/**
 * A series' element lies between its ends (r.series, check/checker.ts Checker.series): a rule's term reads it within
 * the least value its low end takes and the greatest its high end takes, with no filter and no guard, so a cast of it
 * stands on that interval alone.
 *
 * - An exhaustive box of series from lo within [a, b] to hi within [c, d], each a bigint contract of ends from -1 to 1
 *   whose intervals hold some element, against every target interval [l, h]: the rule delivering each element cast into
 *   the contract within [l, h] compiles exactly where every element of every series lies within [l, h], by brute
 *   force, every lo, every hi and every integer between them.
 * - The ledger's PresentTime (qti-pie ledger delivery.ts): a piece of presence's days, the series from the day of its
 *   first microsecond to the day of its last, each a date by Time.dateOfEpochDay, compiles with no guard, its ends
 *   bounded by Moment's top, 10000-01-01, through GREATEST, LEAST, Type.base and an integer's division; the same with
 *   its last day bounded by a stamp on a wider clock is refused, naming dateOfEpochDay's bound.
 *
 * Features: a cast admitted; a cast refused; each ledger shape.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	compilesCast,
	compilesLedger,
	elementBox,
	everyElementWithin,
	type LedgerShape,
	ledgerBox,
	ledgerShapes
} from "#test/unit/check/series.fixtures.ts"

type ElementFeature = "a cast admitted" | "a cast refused"

/** A series' element cast into a contract compiles exactly where every element of every series lies within it. */
export const aSeriesElementIsReadWithinItsEndsACastOfItCompilesExactlyWhereEveryElementOfEverySeriesFitsItsTarget =
	property.exhaust(elementBox, {
		box: "every series from lo within [a, b] to hi within [c, d] whose intervals hold some element, ends from -1 to 1, against every target interval of them",
		needs: {},
		situations: ["a cast admitted", "a cast refused"] satisfies ReadonlyArray<
			Reached<ElementFeature>
		>,
		check: (_, c: Case<ElementFeature>) => (k) =>
			Effect.sync(() => {
				const expected = everyElementWithin(k)
				assert.equal(
					compilesCast(k),
					expected,
					`a series from lo in [${k.a}, ${k.b}] to hi in [${k.c}, ${k.d}] cast into [${k.l}, ${k.h}]`
				)
				c.note(expected ? "a cast admitted" : "a cast refused")
			}),
		oracle: {
			kind: "specification",
			name: "brute force: every element of every series from each lo to each hi in their intervals lies within the target's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\treturn this.cx.env(node, loc, this.#leaf, this.scope, this.#paramColumn, reads, held)\n",
				replacement:
					"\t\treturn this.cx.env(node, loc, this.#leaf, this.scope, this.#paramColumn, reads, [])\n",
				why: "No term of the rule reads a series' element within its ends, so it is any exact integer of its digits, and its every cast into a contract is refused, where every element fits it."
			}
		]
	})

/** The ledger's days of a piece of presence compile with no guard; with a last day on a wider clock they are refused. */
export const theLedgersDaysOfAPieceOfPresenceCompileWithNoGuardTheirEndsBoundedByMomentsTop =
	property.exhaust(ledgerBox, {
		box: "the ledger's day split written over its pieces' clock, and with its last day on a wider clock",
		needs: {},
		situations: [...ledgerShapes] satisfies ReadonlyArray<Reached<LedgerShape>>,
		check: (_, c: Case<LedgerShape>) => (shape) =>
			Effect.sync(() => {
				assert.equal(compilesLedger(shape), shape === "days of a piece", `the ledger's ${shape}`)
				c.note(shape)
			}),
		oracle: {
			kind: "specification",
			name: "Moment's top, 10000-01-01: the day of a microsecond before it is a date's, 0001-01-01 to 9999-12-31; a stamp's of 2^62 is not"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t\tconst combined = desc.fn === "least" ? leastBounds : greatestBounds\n',
				replacement: "\t\t\t\tconst combined = hullBounds\n",
				why: "LEAST of the window's end and the next stamp is stated up to the stamp's top, 2^62, so the last day's date is unproved and the ledger's days are refused."
			}
		]
	})
