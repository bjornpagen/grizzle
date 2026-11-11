/**
 * The live router (packages/grizzle/src/adapter/live/router.ts): a layer's index of its subscriptions under the route
 * keys each registered, and the route of a key a change source delivers. Subscriptions, their keys, the ones later
 * deregistered and the key routed are drawn over a small universe of tables, columns and values, values holding `:`
 * and `=` among them, so keys collide often.
 *
 * - A key reaches exactly the subscriptions some key of which it matches: of one table, and a table key on either
 *   side, or both keyed at one column and one value. Oracle: that filter over every subscription still registered, a
 *   second implementation, which reads no index.
 * - Deregistering keeps no empty bucket: the index holds a table exactly when some subscription still registered holds
 *   a key of it. Oracle: the registered subscriptions' tables.
 *
 * Features: a keyed key reaching a keyed subscription, a keyed key reaching a table-wide one, a table key reaching a
 * keyed one, a key reaching none, a deregistered subscription a key would have reached, and one subscription registered
 * under several keys a key reaches.
 *
 * Plant (~/.cache/grizzle-release/LIVE-SUBSCRIBE/plants/routing-key-ignored.patch): route visits every subscription of
 * the key's table whatever the key's column and value, so every change of a table re-runs every read of it.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { addRoutes, removeRoutes, route, type RouteIndex } from "#adapter/live/router.ts"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A drawn subscription: its name, and the keys it registers under, at least one. */
interface Drawn {
	readonly name: number
	readonly keys: ReadonlyArray<RouteKey>
}

const tables = ["a", "b"] as const
const columns = ["c", "d"] as const
const values = ["", "1", "x=y:z"] as const

const keyGen: Gen<RouteKey> = (source) => {
	const table = admittedIdentifier<"table">(source.draw(element(tables)))
	return source.draw(int(0, 2)) === 0
		? { kind: "table", table }
		: {
				kind: "keyed",
				table,
				column: admittedIdentifier<"column">(source.draw(element(columns))),
				value: source.draw(element(values))
			}
}

/** Whether a key routed reaches a key registered (see the header). */
const matches = (registered: RouteKey, routed: RouteKey): boolean =>
	registered.table === routed.table &&
	(registered.kind === "table" ||
		routed.kind === "table" ||
		(registered.column === routed.column && registered.value === routed.value))

/** The features a case shows. */
type Feature =
	| "a keyed key reaching a keyed subscription"
	| "a keyed key reaching a table-wide one"
	| "a table key reaching a keyed one"
	| "a key reaching none"
	| "a deregistered subscription a key would have reached"
	| "one subscription reached through several keys"

describe("the live router", () => {
	it.effect(
		"a key reaches exactly the subscriptions it matches, and deregistering keeps no empty bucket",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a filter of the registered subscriptions"
						},
						suite: "unit/live/router",
						draw: drawn((s) => {
							const subscriptions = s.draw(
								array((t) => t.draw(array(keyGen, { min: 1, max: 3 })), { min: 0, max: 6 })
							)
							const all: ReadonlyArray<Drawn> = Arr.map(subscriptions, (keys, name) => ({
								name,
								keys
							}))
							return {
								all,
								removed: s.draw(
									subset(
										Arr.map(all, (d) => d.name),
										{ min: 0, max: all.length }
									)
								),
								routed: s.draw(keyGen)
							}
						}),
						literal: Formatter.format,
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"a keyed key reaching a keyed subscription",
								"a keyed key reaching a table-wide one",
								"a table key reaching a keyed one",
								"a key reaching none",
								"a deregistered subscription a key would have reached",
								"one subscription reached through several keys"
							],
							{ cases: 600, sense: notesOnly }
						)
					},
					({ all, removed, routed }, c) =>
						Effect.sync(() => {
							const index: RouteIndex<Drawn> = new Map()
							for (const subscription of all) {
								addRoutes(index, subscription, subscription.keys)
							}
							const gone = new Set(removed)
							for (const subscription of all) {
								if (gone.has(subscription.name)) {
									removeRoutes(index, subscription, subscription.keys)
								}
							}
							const registered = Arr.filter(all, (d) => !gone.has(d.name))
							const reached = new Set<number>()
							route(index, routed, (subscription) => {
								reached.add(subscription.name)
							})
							const expected = new Set(
								Arr.map(
									Arr.filter(registered, (d) => Arr.some(d.keys, (key) => matches(key, routed))),
									(d) => d.name
								)
							)
							assert.deepEqual(
								Arr.sort([...reached], Order.Number),
								Arr.sort([...expected], Order.Number),
								"the key reaches exactly the subscriptions it matches"
							)
							assert.deepEqual(
								Arr.sort([...index.keys()], Order.String),
								Arr.sort(
									[...new Set(Arr.flatMap(registered, (d) => Arr.map(d.keys, (key) => key.table)))],
									Order.String
								),
								"the index holds a table exactly when a registered subscription holds a key of it"
							)
							for (const d of registered) {
								const hits = Arr.filter(d.keys, (key) => matches(key, routed))
								for (const key of hits) {
									if (routed.kind === "keyed" && key.kind === "keyed") {
										c.note("a keyed key reaching a keyed subscription")
									} else if (routed.kind === "keyed") {
										c.note("a keyed key reaching a table-wide one")
									} else if (key.kind === "keyed") {
										c.note("a table key reaching a keyed one")
									}
								}
								if (hits.length > 1) {
									c.note("one subscription reached through several keys")
								}
							}
							if (expected.size === 0) {
								c.note("a key reaching none")
							}
							if (
								Arr.some(
									all,
									(d) => gone.has(d.name) && Arr.some(d.keys, (key) => matches(key, routed))
								)
							) {
								c.note("a deregistered subscription a key would have reached")
							}
						})
				)
			)
	)
})
