import { Effect } from "effect"
import { exhaust, integer } from "#lint/fixtures/test-case-is-search/testing.ts"

export const searchedSuite = (suite: string): Effect.Effect<void> =>
	exhaust({ suite, generator: integer(0, 3) }, () => Effect.void)

export const heldSearch = Effect.suspend(() => searchedSuite("held"))

export const relayed = (): Effect.Effect<void> => searchedSuite("relayed")

export function even(n: number): Effect.Effect<void> {
	return n === 0 ? searchedSuite("even") : odd(n - 1)
}

export function odd(n: number): Effect.Effect<void> {
	return n === 0 ? Effect.void : even(n - 1)
}

export function ping(n: number): Effect.Effect<void> {
	return n === 0 ? Effect.void : pong(n - 1)
}

export function pong(n: number): Effect.Effect<void> {
	return n === 0 ? Effect.void : ping(n - 1)
}

export const checkOne = (value: number): Effect.Effect<void> =>
	Effect.sync(() => value + 1)

export const caseOf = (check: () => Effect.Effect<void>): Effect.Effect<void> => check()

export const suites = { searched: () => searchedSuite("registry"), example: () => checkOne(3) }

export const scripted = (scenario: () => Effect.Effect<void>): Effect.Effect<void> =>
	exhaust({ suite: "scripted", generator: integer(0, 3) }, () => scenario())

export const relayedScript = (): Effect.Effect<void> => scripted(() => checkOne(7))
