import { Effect } from "effect"
import { KINDS } from "#lint/fixtures/no-case-list/dictionary.ts"
import { ROSTER } from "#lint/fixtures/no-case-list/roster.ts"
import {
	array,
	constant,
	drawn,
	element,
	exhaust,
	explore,
	integer,
	map,
	notASearch,
	oneOf,
	record,
	sketched,
	weighted
} from "#lint/fixtures/no-case-list/testing.ts"

const rangeOf = (from: number, to: number): ReadonlyArray<number> =>
	Array.from({ length: to - from }, (_, at) => from + at)

const rows = [
	{ input: 1, expected: 2 },
	{ input: 2, expected: 3 }
] as const

export const bounded = exhaust({ suite: "bounded", generator: integer(0, 3) }, () => Effect.void)

export const dictionary = exhaust({ suite: "dictionary", generator: element(KINDS) }, () => Effect.void)

export const roster = exhaust({ suite: "roster", generator: element(ROSTER) }, () => Effect.void)

export const spreads = exhaust(
	{ suite: "spreads", generator: element([...KINDS, ...ROSTER]) },
	() => Effect.void
)

export const range = exhaust(
	{ suite: "range", generator: element(rangeOf(0, 4)) },
	() => Effect.void
)

export const sequences = exhaust(
	{ suite: "sequences", generator: array(element(["a", "b"]), { min: 0, max: 2 }) },
	() => Effect.void
)

export const product = exhaust(
	{ suite: "product", generator: record({ kind: element(["a", "b"]), size: integer(0, 3) }) },
	() => Effect.void
)

export const union = exhaust(
	{ suite: "union", generator: oneOf([element(["a"]), map(integer(0, 3), String)]) },
	() => Effect.void
)

export const written = exhaust(
	{
		suite: "written",
		generator: weighted([
			[1, constant("none")],
			[5, (pick) => String(pick)]
		])
	},
	() => Effect.void
)

const hoisted = weighted([
	[1, constant("none")],
	[5, (pick: number) => String(pick)]
])

export const held = explore({ suite: "held", draw: drawn(hoisted), kept: [] }, () => Effect.void)

export const explored = explore(
	{ suite: "explored", draw: drawn(integer(0, 9)), kept: [4, 7] },
	() => Effect.void
)

export const sketch = explore(
	{ suite: "sketch", draw: sketched(record({ size: integer(0, 3) }), (s) => s.size), kept: [] },
	() => Effect.void
)

export const other = notASearch({ generator: element(rows) })
