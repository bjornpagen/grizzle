import { Checkout } from "@bjornpagen/testing/checkout"
import type { Reached } from "@bjornpagen/testing/features"
import {
	type Aimed,
	type BatchedSpec,
	type Case,
	type FiniteSpace,
	type NeedFailed,
	type Property,
	property,
	type Resources,
	type Space
} from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import {
	type Checking,
	caseOwned,
	checkedBatch,
	type Entry,
	ownedLines,
	type Program,
	type TypesDisagreed
} from "#test/types/batch/batch.ts"
import { typeBatchSize } from "#test/types/batch/size.ts"

/**
 * A type agreement: a property whose cases are entries of a generated program, checked a batch at a time (batch.ts),
 * one tsgo check of the batch's program in the batch's own directory, each case's verdict its own lines' diagnostics.
 * Its space draws the cases, so a failing entry prints, shrinks and replays alone; its situations are what the
 * witnesses of the search must reach, which each case notes as `notes` reads it. The compiler reads the sources from
 * disk, so the agreement needs the checkout (Checkout.dir): a mutant reaches it only in a worker tree. It states what
 * a batched property states (situations, oracle, kept, kills, and any budget it cites), less what the agreement
 * supplies: its batch size, its needs, how a case prints and the batch's check.
 */
export type AgreementSpec<C, F extends string> = Omit<
	BatchedSpec<C, F, typeof agreementNeeds, AgreementFailure>,
	"size" | "needs" | "show" | "checkAll"
> &
	Readonly<{
		/** What a case reaches: each feature it notes, and each pair of features it reaches together. */
		notes: (value: C) => Iterable<Reached<F>>
		checking: Checking
		/** The program of a batch's cases, each case's lines owned by its place among them. */
		program: (cases: Arr.NonEmptyReadonlyArray<C>, entry: Entry) => Program
	}>

/** What an agreement's case needs: a directory of its own for its batch's program, and the checkout the compiler reads. */
const agreementNeeds = { dir: Scratch.dir, checkout: Checkout.dir } as const

/** How an agreement's case fails: its lines disagree, or its batch's program could not be written or checked. */
type AgreementFailure = TypesDisagreed | NeedFailed | Effect.Error<ReturnType<typeof checkedBatch>>

/** A program alone spells a repository path as the path itself, as a case prints. */
const printedEntry: Entry = (path) => path

/** Notes on a case's handle everything `reached` names: a feature by itself, a pair as a pair. */
const noteReached = <F extends string>(c: Case<F>, reached: Iterable<Reached<F>>): void => {
	for (const situation of reached) {
		if (typeof situation === "string") {
			c.note(situation)
		} else {
			c.pair(situation[0], situation[1])
		}
	}
}

/** How an agreement's case prints: its own lines, in a program of it alone. */
const shownOf =
	<C, F extends string>(spec: AgreementSpec<C, F>) =>
	(value: C): string =>
		Arr.join(ownedLines(spec.program([value], printedEntry), caseOwned(0)), "\n")

/**
 * An agreement's check of a batch: each case notes what it reaches, then the batch's program is written into the
 * batch's directory and checked against the checkout, each case's verdict its own lines'.
 */
const checkAllOf =
	<C, F extends string>(spec: AgreementSpec<C, F>) =>
	(resources: Resources<typeof agreementNeeds>) =>
	(cases: Arr.NonEmptyReadonlyArray<readonly [C, Case<F>]>) =>
		Effect.gen(function* () {
			const dir = yield* resources.dir
			const checkout = yield* resources.checkout
			for (const [value, c] of cases) {
				noteReached(c, spec.notes(value))
			}
			const verdicts: ReadonlyArray<Effect.Effect<void, AgreementFailure>> = yield* checkedBatch(
				checkout,
				dir,
				spec.checking,
				cases.length,
				(entry) =>
					spec.program(
						Arr.map(cases, ([value]) => value),
						entry
					)
			)
			return verdicts
		})

/** The agreement of `space`'s cases with the engine, as `spec` states it: a batched search of its drawn cases. */
export const agreement = <C, const F extends string>(
	space: Space<C> | Aimed<C, F>,
	spec: AgreementSpec<C, F>
): Property =>
	property.batched<C, F, typeof agreementNeeds, AgreementFailure>(space, {
		...spec,
		size: typeBatchSize,
		needs: agreementNeeds,
		show: shownOf(spec),
		checkAll: checkAllOf(spec)
	})

/**
 * What a box agreement states beside an agreement's spec: the box its cells exhaust, in words. A box is the source's
 * own roster of cells (every setting of a config, every kind of a builder), never a population drawn from a generator,
 * so every cell is checked on every run.
 */
export type BoxSpec<C, F extends string> = AgreementSpec<C, F> & Readonly<{ box: string }>

/**
 * The agreement of every cell of a finite box with the engine: an exhaustion, its cells checked a batch at a time, as
 * an agreement's drawn cases are.
 */
export const boxAgreement = <C, const F extends string>(
	box: FiniteSpace<C>,
	spec: BoxSpec<C, F>
): Property =>
	property.exhaustBatched<C, F, typeof agreementNeeds, AgreementFailure>(box, {
		...spec,
		size: typeBatchSize,
		needs: agreementNeeds,
		show: shownOf(spec),
		checkAll: checkAllOf(spec)
	})
