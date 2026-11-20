/**
 * What the properties of lock.test.ts read: claimants racing for one output directory's run lock, and a holder whose
 * scope ends each way a scope ends, with what each leaves in the directory.
 */

import { failureOf } from "@bjornpagen/testing/assert"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { awaitFact } from "@bjornpagen/testing/fact"
import { boolean, finite, type FiniteSpace, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Effect, Exit, FileSystem, Option, Order, Path, Ref } from "effect"
import { acquireRunLock, runLockFileName } from "#write/lock.ts"

/**
 * How many claimants claim the lock at once: a lone one, one beside the holder, and two beside it, which is every
 * count the lock tells apart, since a refused claimant's refusal reads nothing of the others refused beside it.
 */
export const claimantSpace: FiniteSpace<number> = finite(int(1, 3))

export type RaceFeature = "a lone claimant" | "one claimant refused" | "several claimants refused"

/** The feature a race of `claimants` reaches. */
export const raceFeatureOf = (claimants: number): RaceFeature =>
	claimants === 1
		? "a lone claimant"
		: claimants === 2
			? "one claimant refused"
			: "several claimants refused"

/** A claimant's refusal as the lock states it: its tag, and the lock path it names. */
type Refusal = Readonly<{ _tag: string; lockPath: string }>

/**
 * What a race comes to: what each claimant that held the lock saw of its file while it held it, each refused
 * claimant's refusal, and whether a lock file remains once every claimant has ended.
 */
export type Race = Readonly<{
	held: ReadonlyArray<boolean>
	refused: ReadonlyArray<Refusal>
	leftover: boolean
}>

/**
 * Runs `claimants` claims on `dir` at once. A claimant counts itself settled once it holds the lock, or once its
 * refused claim's scope has closed; a holder holds until every claimant has settled (awaitFact), so every refused claim
 * meets a held lock and every refused claimant's scope has closed before the holder looks at its file, and a lock that
 * let several claim is seen holding by each of them, never a hang.
 */
export const raceOf = (dir: string, claimants: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const lockPath = path.join(dir, runLockFileName)
		const settled = yield* Ref.make(0)
		const settle = Ref.update(settled, (count) => count + 1)
		const everyClaimantSettled = awaitFact(
			Ref.get(settled).pipe(Effect.map(Option.liftPredicate((count) => count === claimants)))
		)
		const claimant = Effect.scoped(
			Effect.gen(function* () {
				yield* acquireRunLock(dir)
				yield* settle
				yield* everyClaimantSettled

				return yield* Effect.orDie(fs.exists(lockPath))
			})
		).pipe(Effect.tapError(() => settle))
		const results = yield* Effect.all(
			Array.from({ length: claimants }, () => Effect.result(claimant)),
			{ concurrency: "unbounded" }
		)
		const leftover = yield* fs.exists(lockPath)
		const race: Race = {
			held: Arr.getSuccesses(results),
			refused: Arr.map(Arr.getFailures(results), (error): Refusal => ({
				_tag: error._tag,
				lockPath: error.lockPath
			})),
			leftover
		}
		return { lockPath, race }
	})

/**
 * The race design 3.6 states: one claimant holds and sees its lock while it holds it, every other is refused with
 * RunLockHeld naming the lock path, and no lock remains once all have ended.
 */
export const expectedRace = (lockPath: string, claimants: number): Race => ({
	held: [true],
	refused: Array.from({ length: claimants - 1 }, (): Refusal => ({
		_tag: "RunLockHeld",
		lockPath
	})),
	leftover: false
})

/** How a holder's scope ends. */
export type Ending = "succeeds" | "fails" | "is interrupted"

const ENDINGS = dictionary<Ending>(["succeeds", "fails", "is interrupted"])

/**
 * One holder: the temp siblings it registers, the files beside them it does not register, whether another claim is
 * made while it holds the lock, and how its scope ends.
 */
export type HoldCase = Readonly<{
	temps: ReadonlyArray<string>
	unregistered: ReadonlyArray<string>
	claimedWhileHeld: boolean
	ending: Ending
}>

/** Every holder of up to two temp siblings and one unregistered file, claimed while held or not, ending each way. */
export const holdSpace: FiniteSpace<HoldCase> = finite((source) => ({
	temps: source.draw(subarray([".a.tmp", ".b.tmp"])),
	unregistered: source.draw(subarray(["keep.txt"])),
	claimedWhileHeld: source.draw(boolean),
	ending: source.draw(word(ENDINGS))
}))

export type HoldFeature =
	| `a scope that ${Ending}`
	| "a registered temp sibling"
	| "a file the holder did not register"
	| "a claim refused while held"

/** The features a holder reaches. */
export const holdFeaturesOf = (c: HoldCase): ReadonlyArray<HoldFeature> => [
	`a scope that ${c.ending}`,
	...(Arr.isReadonlyArrayNonEmpty(c.temps) ? ["a registered temp sibling" as const] : []),
	...(Arr.isReadonlyArrayNonEmpty(c.unregistered)
		? ["a file the holder did not register" as const]
		: []),
	...(c.claimedWhileHeld ? ["a claim refused while held" as const] : [])
]

/** What a claim made while the lock is held comes to: the refusal's tag, and whether the holder's lock stays. */
type HeldClaim = Readonly<{ refusal: string; lockStays: boolean }>

/** What a holder leaves: how its scope ended, the claim made while it held, and the directory's files after. */
export type Held = Readonly<{
	ending: Ending
	claim: Option.Option<HeldClaim>
	left: ReadonlyArray<string>
}>

const endWith = (ending: Ending): Effect.Effect<void, "boom"> => {
	switch (ending) {
		case "succeeds":
			return Effect.void
		case "fails":
			return Effect.fail("boom" as const)
		case "is interrupted":
			return Effect.interrupt
	}
}

const endingOf = (exit: Exit.Exit<unknown, unknown>): Ending =>
	Exit.match(exit, {
		onSuccess: () => "succeeds",
		onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? "is interrupted" : "fails")
	})

/** A claim of `dir`'s lock, released at once when it is granted. */
const claim = (dir: string) => Effect.scoped(acquireRunLock(dir).pipe(Effect.andThen(Effect.void)))

/**
 * Places the unregistered files in `dir`, then holds its lock in a scope that writes and registers each temp sibling,
 * claims the lock again when the case says so, and ends as the case says; then reads what the directory holds.
 */
export const heldOf = (dir: string, c: HoldCase) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const lockPath = path.join(dir, runLockFileName)
		yield* Effect.forEach(c.unregistered, (name) => fs.writeFileString(path.join(dir, name), name))
		const claimed = yield* Ref.make(Option.none<HeldClaim>())
		const exit = yield* Effect.exit(
			Effect.scoped(
				Effect.gen(function* () {
					const lock = yield* acquireRunLock(dir)
					yield* Effect.forEach(c.temps, (name) => {
						const temp = path.join(dir, name)
						return fs.writeFileString(temp, name).pipe(Effect.andThen(lock.registerTemp(temp)))
					})
					if (c.claimedWhileHeld) {
						const refusal = yield* failureOf(claim(dir))
						const lockStays = yield* fs.exists(lockPath)
						yield* Ref.set(claimed, Option.some({ refusal: refusal._tag, lockStays }))
					}
					return yield* endWith(c.ending)
				})
			)
		)
		const left = yield* fs.readDirectory(dir)
		const held: Held = {
			ending: endingOf(exit),
			claim: yield* Ref.get(claimed),
			left: Arr.sort(left, Order.String)
		}
		return held
	})

/**
 * What design 3.6 states of a holder: its scope ends as it was ended, a claim made while it holds is refused with
 * RunLockHeld and leaves its lock in place, and once the scope has closed, however it closed, its registered temp
 * siblings and its lock are gone and every file it did not register stays.
 */
export const expectedHeld = (c: HoldCase): Held => ({
	ending: c.ending,
	claim: c.claimedWhileHeld
		? Option.some({ refusal: "RunLockHeld", lockStays: true })
		: Option.none(),
	left: Arr.sort(c.unregistered, Order.String)
})
