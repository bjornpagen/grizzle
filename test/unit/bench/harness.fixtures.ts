/** What the properties of harness.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Option, Path, String as Str } from "effect"
import { repoRoot } from "#bench/cold/identity.ts"
import {
	type DiscardedAttempt,
	type OperationResult,
	type RetryOptions,
	sqlAttempted,
	withRetries
} from "#bench/harness/load.ts"
import {
	failedAt,
	failedAtStatement,
	type FailedOutcome,
	type Outcome,
	type OutcomeCause
} from "#bench/harness/outcome.ts"
import { ownerDirectories } from "#bench/harness/rules.ts"
import { discoverGates } from "#bench/harness/runner.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { UniqueAbort } from "#compiler/runtime/write/steps.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { catalogIds } from "#test/unit/bench/harness.dictionary.ts"

/** The SQLSTATEs a script draws: the two grizzle always retries, the two a listed constraint makes transient, others. */
const codes = ["40001", "40P01", "23505", "23P01", "23000", "23503", "XX000"] as const
type Code = (typeof codes)[number]

/** The cause each SQLSTATE drawn is tallied by, as outcome.ts states it. */
const causes: Readonly<Record<Code, OutcomeCause>> = {
	"40001": "serialization",
	"40P01": "deadlock",
	"23505": "uniqueViolation",
	"23P01": "exclusionViolation",
	"23000": "lawViolation",
	"23503": "foreignKeyViolation",
	XX000: "other"
}

/** The constraints a script names: three an operation may list among its unique aborts, and one no operation lists. */
const constraintNames = ["item_pkey", "seat_key", "slot_key", "item_name_key"] as const
type Named = (typeof constraintNames)[number]

const listable: Arr.NonEmptyReadonlyArray<readonly [Named, UniqueAbort["reason"]]> = [
	["item_pkey", "UnseenOccupant"],
	["seat_key", "PutTargetConflict"],
	["slot_key", "UnseenOccupant"]
]

/**
 * One scripted attempt: it commits, or PostgreSQL refuses it with `code`, naming a constraint or none, with a DETAIL or
 * none, at `at`.
 */
type Step =
	| { readonly kind: "commits" }
	| {
			readonly kind: "refused"
			readonly code: Code
			readonly constraint: Option.Option<Named>
			readonly detail: Option.Option<string>
			readonly at: FailedOutcome["at"]
	  }

type Refused = Extract<Step, { readonly kind: "refused" }>

/** A retried operation: its policy's retries, the unique aborts it lists, whether the gate labels a retry, its attempts. */
interface Retried {
	readonly times: number
	readonly listed: ReadonlyArray<readonly [Named, UniqueAbort["reason"]]>
	readonly labelled: boolean
	readonly steps: ReadonlyArray<Step>
}

const stepGen: Gen<Step> = (source) =>
	source.draw(boolean)
		? { kind: "commits" }
		: {
				kind: "refused",
				code: source.draw(element(codes)),
				constraint: source.draw(boolean)
					? Option.some(source.draw(element(constraintNames)))
					: Option.none(),
				detail: source.draw(boolean) ? Option.some("Reason code: drawn.") : Option.none(),
				at: source.draw(element(["statement", "begin", "deferredChecks", "commit"] as const))
			}

/** An operation with as many scripted attempts as its policy allows. */
const retriedGen: Gen<Retried> = (source) => {
	const times = source.draw(int(0, 3))
	return {
		times,
		listed: source.draw(subarray(listable)),
		labelled: source.draw(boolean),
		steps: source.draw(array(stepGen, { min: times + 1, max: times + 1 }))
	}
}

/**
 * An operation whose first attempt is a unique or exclusion violation at its statement on a constraint it lists, with a
 * retry left: a unique abort retried, which a drawn script seldom holds.
 */
const uniqueAbortGen: Gen<Retried> = (source) => {
	const times = source.draw(int(1, 3))
	const abort = source.draw(element(listable))
	const [name] = abort
	return {
		times,
		listed: [abort, ...Arr.filter(source.draw(subarray(listable)), ([other]) => other !== name)],
		labelled: source.draw(boolean),
		steps: [
			{
				kind: "refused",
				code: source.draw(element(["23505", "23P01"] as const)),
				constraint: Option.some(name),
				detail: source.draw(boolean) ? Option.some("Reason code: drawn.") : Option.none(),
				at: "statement"
			},
			...source.draw(array(stepGen, { min: times, max: times }))
		]
	}
}

/** The failed outcome a refused step must be recorded as. */
const failedOf = (step: Refused): FailedOutcome => {
	const constraint = Option.match(step.constraint, {
		onNone: () => ({ kind: "none" }) as const,
		onSome: (name) => ({ kind: "named", name: wild.constraint(name) }) as const
	})
	const reported = {
		sqlstate: step.code,
		cause: causes[step.code],
		constraint,
		message: "refused",
		detail: step.detail
	}
	return step.at === "statement"
		? { kind: "failed", at: "statement", statement: "write", ...reported }
		: { kind: "failed", at: step.at, ...reported }
}

/**
 * A step's transient reason by grizzle's classification of a TransientFailure: 40001 and 40P01 wherever PostgreSQL
 * raises them, and a unique or exclusion violation at its statement on a constraint the operation lists.
 */
export const reasonOf = (r: Retried, step: Step): DiscardedAttempt["reason"] | undefined => {
	if (step.kind === "commits") {
		return undefined
	}
	switch (step.code) {
		case "40001":
			return "SerializationFailure"
		case "40P01":
			return "Deadlock"
		case "23505":
		case "23P01":
			return step.at === "statement"
				? Option.getOrUndefined(
						Option.flatMap(step.constraint, (name) =>
							Option.map(
								Arr.findFirst(r.listed, ([listed]) => listed === name),
								([, reason]) => reason
							)
						)
					)
				: undefined
		case "23000":
		case "23503":
		case "XX000":
			return undefined
	}
}

/** What the model says the operation reports: attempts while transient, up to the policy, the last one standing. */
export const modelOf = (r: Retried): OperationResult => {
	const retries: Array<DiscardedAttempt> = []
	for (const [i, step] of r.steps.entries()) {
		const reason = reasonOf(r, step)
		if (step.kind === "commits") {
			return { outcome: { kind: "committed" }, attempts: i + 1, retries }
		}
		const failed = failedOf(step)
		if (reason === undefined || i === r.times) {
			return { outcome: failed, attempts: i + 1, retries }
		}
		retries.push({ reason, failed, label: r.labelled ? failed.sqlstate : undefined })
	}
	return assert.fail("a script of as many attempts as the policy allows ends")
}

/** The server error a refused step stands for, as the driver reports one. */
const errorOf = (step: Refused) => ({
	code: step.code,
	message: "refused",
	...Option.match(step.constraint, {
		onNone: () => ({}),
		onSome: (name) => ({ constraint: wild.constraint(name) })
	}),
	...Option.match(step.detail, {
		onNone: () => ({}),
		onSome: (detail) => ({ detail })
	})
})

/** The operation the harness runs: each attempt the step its number names, read as a hand-written attempt. */
export const ranOf = (r: Retried): Effect.Effect<OperationResult> => {
	const options: RetryOptions = {
		uniqueAborts: Arr.map(r.listed, ([name, reason]) => ({
			constraint: wild.constraint(name),
			relation: StoredRelationName("Item"),
			reason
		})),
		label: (failed) => (r.labelled ? failed.sqlstate : undefined)
	}
	return withRetries(
		(n) =>
			Effect.sync(() => {
				const step = Arr.getUnsafe(r.steps, n - 1)
				const outcome: Outcome =
					step.kind === "commits"
						? { kind: "committed" }
						: Option.getOrThrow(
								step.at === "statement"
									? failedAtStatement(errorOf(step), "write")
									: failedAt(errorOf(step), step.at)
							)
				return sqlAttempted(outcome, options)
			}),
		{ times: r.times, baseMs: 0 }
	)
}

export type RetryFeature =
	| "committed at once"
	| "committed after a retry"
	| "the policy ran out"
	| "a refusal ended it"
	| "a unique abort retried"
	| "a unique violation not retried"
	| "labelled"

const listedCommands = ["gates", "list", "all"] as const
type Listed = (typeof listedCommands)[number]
const flagsOf: Readonly<Record<Listed, ReadonlyArray<string>>> = {
	gates: ["--quick", "--only", "--dir", "--out", "--report"],
	list: ["--dir"],
	all: ["--quick"]
}

/** The flags a listed command has read. */
interface Flags {
	readonly quick: boolean
	readonly report: boolean
	readonly only: ReadonlyArray<string>
	readonly directories: ReadonlyArray<string>
	readonly out: Option.Option<string>
}

/** The flags of `args`, each allowed to `command`, or none when one is not. */
const flagsRead = (
	command: Listed,
	args: ReadonlyArray<string>,
	flags: Flags
): Option.Option<Flags> => {
	const [flag, ...rest] = args
	if (flag === undefined) {
		return Option.some(flags)
	}
	if (!Arr.contains(flagsOf[command], flag)) {
		return Option.none()
	}
	if (flag === "--quick" || flag === "--report") {
		return flagsRead(
			command,
			rest,
			flag === "--quick" ? { ...flags, quick: true } : { ...flags, report: true }
		)
	}
	const [value, ...after] = rest
	if (value === undefined || Str.startsWith("--")(value)) {
		return Option.none()
	}
	return flagsRead(
		command,
		after,
		flag === "--only"
			? {
					...flags,
					only: [
						...flags.only,
						...Arr.filter(Arr.map(Str.split(value, ","), Str.trim), (s) => s !== "")
					]
				}
			: flag === "--dir"
				? { ...flags, directories: [...flags.directories, value] }
				: { ...flags, out: Option.some(value) }
	)
}

/** An operation with as many scripted attempts as its policy allows, aimed at a unique abort retried. */
export const retriedCases = aimed<Retried, RetryFeature>(retriedGen, [
	["a unique abort retried", uniqueAbortGen]
])

/** What the search built once before its cases (path, discovered, listed), now once per worker: every case on it reads them. */
export const gatesNeed = {
	key: "test/unit/bench/harness.fixtures.ts gatesNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const path = yield* Path.Path
		const discovered = yield* discoverGates(
			Arr.map([...ownerDirectories.query, ...ownerDirectories.write], (dir) => `${repoRoot}/${dir}`)
		)
		const listed = new Set(catalogIds)
		return { path, discovered, listed }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/bench/harness.fixtures.ts gatesNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
