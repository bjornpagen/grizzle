/** What calls.test.ts reads: the function its counts count, work that calls it, and its strays. */

import { fileURLToPath } from "node:url"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Effect, FileSystem } from "effect"
import type { ChildWork } from "#test/support/kernel/child-counts.ts"
import type { CountedFunction } from "#test/support/kernel/coverage.ts"

/** The function every count here counts: one call a tick. */
export const tick = (): number => 1

/** `n` calls of `tick`. */
export const ticks = (n: number): number => {
	let sum = 0
	for (let i = 0; i < n; i++) {
		sum += tick()
	}
	return sum
}

/** The one site the counts read: `tick`, in this module. */
export const sites = Object.freeze({
	tick: { file: "test/unit/kernel/calls.fixtures.ts", name: "tick" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** A case: the ticks the counted work makes, and the ticks the strays beside it make. */
export interface Ticking {
	readonly work: number
	readonly stray: number
}

export const tickingGen: Gen<Ticking> = (source) => ({
	work: source.draw(element([1, 7, 40])),
	stray: source.draw(element([0, 3, 50]))
})

/**
 * Work that waits on I/O, then ticks: a read of this module's file, the turns of its event loop given up, then `work`
 * ticks. A counting child counts it (kernel/child-counts.ts), and its value is its ticks' count.
 */
export const waitingTicks: ChildWork<{ readonly work: number }> = ({ work }, counts) =>
	Effect.map(
		counts.sites(
			Effect.andThen(
				Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
					Effect.orDie(fs.readFileString(fileURLToPath(import.meta.url)))
				),
				Effect.sync(() => ticks(work))
			),
			sites
		),
		([, counted]) => counted.tick
	)

/**
 * This module again, under a query of its own, so its import evaluates it again: a stray module evaluation, which ticks
 * as many times as the query's `stray` names (below), each tick counted under this module's site, the calls a count
 * beside it must not hold.
 */
export const strayModule = (stray: number, at: number): string => {
	const url = new URL(import.meta.url)
	url.search = `?stray=${stray}&at=${at}`
	return url.href
}

/** The ticks this evaluation of the module made: its stray's count under a stray's query, none under no query. */
export const strayTicks = ticks(Number(new URL(import.meta.url).searchParams.get("stray") ?? "0"))
