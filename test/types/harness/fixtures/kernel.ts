import { drawn, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { Duration, Effect, Formatter } from "effect"

/**
 * The testing library's harness invariants, held by its types (@grizzle/testing): a suite's required features are a
 * closed vocabulary of literal names, stated with the steered phase that reaches them; a case notes what it reached
 * through the Case its property receives, never through a registry; a kept case is its own field of the search, never
 * an argument of drawn, and names a feature it reaches; a note or a required feature outside the vocabulary does not
 * compile. Typechecked, never executed.
 */
type Size = "small" | "large"

const number = int(-1000, 1000)

/** A property notes through its case, in the suite's vocabulary; a kept case states its sketch, draws and reaches. */
export const explores = explore(
	{
		suite: "types/harness",
		draw: sketched(number, (n) => n),
		literal: Formatter.format,
		coverage: required<Size>(["small", "large"], { cases: 1, sense: notesOnly }),
		kept: [{ note: "a small case once failed", sketch: 3, draws: "", reaches: ["small"] }],
		runs: 1,
		shrink: { kind: "complete" },
		concurrency: 1,
		steerEvery: 16,
		caseHang: Duration.minutes(2)
	},
	(n, c) => Effect.sync(() => c.note(n < 10 ? "small" : "large"))
)

/** A literal required feature names no situation: a suite's vocabulary is a closed union. */
export const openVocabulary = required<string>(
	[
		// @ts-expect-error -- TS2322: a requirement takes literal names, never string
		"small"
	],
	{ cases: 1, sense: notesOnly }
)

/** A registry notes nothing: a case notes through c.note. */
export const registry = (): void => {
	// @ts-expect-error -- TS2339: a registry notes nothing: a case notes through c.note
	required<Size>(["small"], { cases: 1, sense: notesOnly }).note("small")
}

/** drawn takes no kept cases: a kept case is the search's own field. */
export const keptInDrawn = drawn(
	number,
	// @ts-expect-error -- TS2554: drawn takes no kept cases: a kept case is the search's own field
	[{ note: "n", sketch: 3, draws: "", reaches: ["small"] }]
)

/** A kept case names a feature it reaches. */
export const reachesNothing: Kept<number, Size> = {
	note: "a small case once failed",
	sketch: 3,
	draws: "",
	// @ts-expect-error -- TS2322: a kept case reaches at least one feature
	reaches: []
}

/** A note outside the suite's vocabulary. */
export const misspeltNote = explore(
	{
		suite: "types/harness",
		draw: drawn(number),
		literal: Formatter.format,
		coverage: required<Size>(["small"], { cases: 1, sense: notesOnly }),
		kept: [],
		runs: 1,
		shrink: { kind: "complete" },
		concurrency: 1,
		steerEvery: 16,
		caseHang: Duration.minutes(2)
	},
	(...[, c]) =>
		Effect.sync(() =>
			// @ts-expect-error -- TS2345: a note outside the suite's vocabulary
			c.note("smal")
		)
)

/** A required feature outside the vocabulary. */
export const misspeltRequirement = required<Size>(
	[
		// @ts-expect-error -- TS2820: a required feature outside the vocabulary
		"smal"
	],
	{ cases: 1, sense: notesOnly }
)
