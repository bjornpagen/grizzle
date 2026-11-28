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
} from "#test/support/types/batch/batch.ts"
import { typeBatches, typeWindow } from "#test/support/types/batch/size.ts"

/**
 * A type agreement: a property whose cases are entries of a generated program, checked a batch at a time (batch.ts),
 * one tsgo check of the batch's program in the batch's own directory, each case's verdict its own lines' diagnostics.
 * Its space draws the cases, so a failing entry prints, shrinks and replays alone; its situations are what the
 * witnesses of the search must reach, which each case notes as `notes` reads it. The compiler reads the sources from
 * disk, so the agreement needs the checkout (Checkout.dir): a mutant reaches it only in a worker tree. It states what
 * a batched property states (situations, oracle, kept, kills, and any budget it cites), less what the agreement
 * supplies: its window and batches (size.ts), its needs, how a case prints and the batch's check.
 */
export type AgreementSpec<C, F extends string> = Omit<
	BatchedSpec<C, F, typeof agreementNeeds, AgreementFailure>,
	"window" | "batches" | "needs" | "show" | "checkAll"
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

/**
 * How long one agreement case may run: a batch of one (a kept case, a shrink candidate) pays its program's whole fixed
 * load alone, one tsgo check of the sources its prelude reaches, and a batch of n cases runs n times this long. A check
 * that stops making progress is the stall guard's (compiler.ts stallWindow), so this bounds only a check still working.
 *
 * @limitKind measured
 * @owner the type tier's agreements (test/support/types/batch/agreement.ts)
 * @unit milliseconds
 * @scope one case of an agreement or a box agreement, a batch of n cases n times it
 * @evidence ~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/evidence.default.txt, evidence.old-240.txt and
 *   faults.old-152.txt (toolchain-test run of one property, eight runs at once); measure/evidence.txt (the access
 *   program of one login under GNU time)
 * @observed 2026-11-16, 08:40 to 08:53 UTC; 02:30 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, Node 26.13, TypeScript 7.1.0-beta (tsgo), toolchain 2fd6250;
 *   load average 470 to 670 from other sessions and the eight runs
 * @workload the evidence and faults agreements' kept cases, each replayed alone as a batch of one (three modules of a
 *   query and its prelude); the access agreement's program of one login
 * @result each of the three kept cases ran past the runner's 60 s case deadline and was reported hung, its search never
 *   reaching its streams; at load 317 the access program of one login took 15.2 s of wall for 8.2 s of CPU, its fixed
 *   load
 * @decision 300 s: a batch of one's check is about 8 s of CPU, which a machine at load 600 and more stretches past 60 s;
 *   300 s is five times that, as the stall guard's case deadline is
 * @revalidate a TypeScript 7 or tsgo upgrade; an agreement whose program of one case passes 20 s of CPU; another machine
 */
const agreementCaseDeadline = 300_000

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
		caseDeadline: agreementCaseDeadline,
		...spec,
		window: typeWindow,
		batches: typeBatches,
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
		caseDeadline: agreementCaseDeadline,
		...spec,
		window: typeWindow,
		batches: typeBatches,
		needs: agreementNeeds,
		show: shownOf(spec),
		checkAll: checkAllOf(spec)
	})
