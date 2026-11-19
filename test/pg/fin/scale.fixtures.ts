/** What the properties of scale.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import { outcomeText } from "#bench/harness/outcome.ts"
import type { TransactionMeasure } from "#bench/harness/transaction.ts"
import { familyTemplates } from "#test/pg/fin/family.ts"
import { seatTemplate } from "#test/pg/fin/installed.ts"
import { Trees } from "#test/pg/fin/tree.ts"
import { type Shape, SHAPES } from "#test/support/families/theorem.ts"

/** The sizes of one run's case. */
interface Scale {
	readonly shape: Shape
	/** The long family's length. */
	readonly long: number
	/** The import's owners, and its tree's rows and fan-out. */
	readonly owners: number
	readonly tree: number
	readonly fanout: number
	/** A seed for each owner's family length, 0 to 4. */
	readonly lengths: number
}

/** The sizes drawn across runs: long families of 10,000 to 60,000, imports of 500 to 5,000 owners, trees of 5,000 to 40,000. */
export const scaleGen: Gen<Scale> = (source) => ({
	shape: source.draw(element(SHAPES)),
	long: source.draw(int(10_000, 60_000)),
	owners: source.draw(int(500, 5_000)),
	tree: source.draw(int(5_000, 40_000)),
	fanout: source.draw(int(2, 8)),
	lengths: source.draw(int(1, 1_000_000))
})

/** Each owner's family length in an import: 0 to 4, read off the seed. */
export const lengthOf = (scale: Scale, owner: number): number =>
	((owner * 7919 + scale.lengths) % 997) % 5

/** An array literal of whole numbers, typed. */
export const arrayOf = (values: ReadonlyArray<number>, type: "int4" | "int8"): string =>
	`'{${Arr.join(Arr.map(values, String), ",")}}'::${type}[]`

/** Bytes the deferred queue may hold for `events` deferred checks (the header's bound). */
export const queueBound = (events: number): number => 24 * events + 2 * 1024 * 1024

/** The queue's size a measured transaction read before its COMMIT, failing the case where it could not be read. */
export const queueBytes = (m: TransactionMeasure): number => {
	assert.equal(m.deferredEvents.kind, "observed", "the deferred queue is read")
	if (m.deferredEvents.kind !== "observed" || !m.deferredEvents.value.available) {
		return assert.fail(`the deferred queue is unreadable: ${Formatter.format(m.deferredEvents)}`)
	}
	return m.deferredEvents.value.totalBytes
}

/**
 * Fails the case unless the measured transaction `what` names committed, saying how it ended otherwise: where it
 * failed, its SQLSTATE, and PostgreSQL's message and DETAIL, a 40001's reason code among them.
 */
export const committed = (m: TransactionMeasure, what: string): void =>
	assert.equal(m.outcome.kind, "committed", `${what}; it ${outcomeText(m.outcome)}`)

/** Each shape's family installed once per member (family.ts familyTemplates), which each case's seats hold. */
export const scaleFamilies = familyTemplates(import.meta, "scale")

/** The tree installed once per member (installed.ts seatTemplate), which each case's seat holds. */
export const scaleTree = seatTemplate(import.meta, Trees, "scale tree")
