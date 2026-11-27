/** What the properties of counted.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { AnySchema } from "#compiler/public/schema.ts"
/**
 * Counted swap-with-last through grizzle's lowering, on PostgreSQL 19 (fin.md §4.2, §11, "Counted swap-with-last
 * with the deferred closure FK"): a counted family hides its index ‹i› and its fold's accumulators, so removing a
 * member moves the last member into the freed slot, refolds the hidden accumulators from that slot on, and lowers the
 * count with the new end (test/support/families/counted.ts swapWithLast). Between the delete and the move the freed
 * slot's successor has no predecessor, so the predecessor axis must be deferred, and the installed one is.
 *
 * - **Two implementations agreeing:** the reference fold (families/fold.ts) and the host's fill (runtime/write/fill.ts
 *   filler) of the families swap-with-last leaves must be one state; every swap-with-last commits to those families,
 *   its stored state that fold of them, and the end unchanged but for the removed member's step,
 *   since every monoid is commutative.
 * - **The fold's model** (fold.ts foldPredicted) judges every order: the move before the delete is refused by the key,
 *   the count before the delete by the bound (the count's cascade), each at its statement; and with the predecessor
 *   axis made immediate (SET CONSTRAINTS, the control), the prescribed order is refused at its delete by that axis
 *   whenever the slot freed is not the last.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the five step values of
 * each counted fold seat (folds.ts), each member's removal, sent in the prescribed order, move first and count first,
 * and in the prescribed order with the predecessor axis immediate.
 *
 * Each case is one transaction from an empty seat: it writes its family, then sends its removal, checked as its COMMIT
 * would check it and rolled back, or ended by a real COMMIT whose rows are then read, as the case draws its end on
 * its tape (installed.ts endGen; folds.ts judgedFold): the box holds every case under both ends.
 */
import {
	FOLD_SPECS,
	type FoldVerdict,
	orCountedOf,
	type Standing,
	sumCountedOf
} from "#test/pg/fin/folds.ts"
import { type EndFeature, seatTemplate } from "#test/pg/fin/installed.ts"
import { type FoldStatement } from "#test/support/families/fold.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * How a swap-with-last's statements are sent: in the prescribed order, with its first update or its count moved first,
 * prescribed with the predecessor axis immediate, or, over an immutable owner, the family rewritten whole
 * (test/support/families/counted.ts rewrittenWhole).
 */
type Sending = "prescribed" | "move first" | "count first" | "closure immediate" | "rewritten whole"

/** Each standing's sendings: every order of the swap over mutable relations; over the immutable default, the swap,
 * which the owner's guard refuses, and the family rewritten whole. */
const SENDINGS: Readonly<Record<Standing, Arr.NonEmptyReadonlyArray<Sending>>> = {
	mutable: ["prescribed", "move first", "count first", "closure immediate"],
	immutable: ["prescribed", "rewritten whole"]
}

const STANDINGS: Arr.NonEmptyReadonlyArray<Standing> = ["mutable", "immutable"]

interface Sketch {
	readonly values: Arr.NonEmptyReadonlyArray<number>
	readonly at: number
	readonly standing: Standing
	readonly sending: Sending
}

export const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(int(1, 4))
	const values = nonEmpty(
		Arr.map(
			upTo(n, (i) => i + 1),
			() => source.draw(element([0, 1, 2, 3, 4] as const))
		)
	)
	const standing = source.draw(element(STANDINGS))
	return {
		values,
		at: source.draw(int(0, n - 1)),
		standing,
		sending: source.draw(element(SENDINGS[standing]))
	}
}

/** A plan's statements in a sending: the prescribed order, or with its first update or its count moved first. */
export const sent = (
	statements: ReadonlyArray<FoldStatement>,
	sending: Sending
): ReadonlyArray<FoldStatement> => {
	const first = (kind: FoldStatement["kind"]) => {
		const at = Arr.findFirstIndex(statements, (s) => s.kind === kind)
		return Option.match(at, {
			onNone: () => statements,
			onSome: (i) => [Arr.getUnsafe(statements, i), ...Arr.remove(statements, i)]
		})
	}
	switch (sending) {
		case "prescribed":
		case "closure immediate":
		case "rewritten whole":
			return statements
		case "move first":
			return first("update")
		case "count first":
			return first("count")
	}
}

export type Position = "the last slot" | "a slot before the last"

export type CountedFeature =
	| `${string} ${Position} ${Sending} ${FoldVerdict}`
	| `${string} immutable ${Position} ${Sending} ${FoldVerdict | "refused immutable guard"}`
	| EndFeature

export const COUNTED = Object.freeze(Arr.filter(FOLD_SPECS, (s) => s.shape === "counted"))

/** Each counted fold spec's schema with its owner and member declared mutable, its own spec's being the immutable
 * default (folds.ts Standing). */
const MUTABLE: Readonly<Record<string, AnySchema>> = {
	"sum of int4 over a counted family": sumCountedOf("mutable"),
	"or of a set over a counted family": orCountedOf("mutable")
}

/** Each counted fold spec's schema under each standing, installed once per member (installed.ts seatTemplate), which
 * its cases' seats clone. */
export const countedSeats = Rec.fromEntries(
	Arr.map(COUNTED, (spec) => {
		const mutable = defined(MUTABLE[spec.label], `${spec.label} over mutable relations`)
		return [
			spec.label,
			{
				mutable: seatTemplate(import.meta, mutable, `swap ${spec.label}`),
				immutable: seatTemplate(import.meta, spec.schema, `swap ${spec.label} immutable`)
			}
		] as const
	})
)
