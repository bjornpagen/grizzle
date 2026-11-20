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
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, int, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { addRoutes, removeRoutes, route, type RouteIndex } from "#adapter/live/router.ts"
import { lengthHashedKeyings, longFamily } from "#test/support/kernel/long-keys.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type Drawn,
	type Feature,
	keyGen,
	type LongFeature,
	longKeyed,
	matches
} from "#test/unit/live/router.fixtures.ts"

/**
 * The live router a key reaches exactly the subscriptions it matches, and deregistering keeps no empty bucket.
 *
 * Budget: its suite's count before the conversion (unit/live/router: 600 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveRouterAKeyReachesExactlyTheSubscriptionsItMatchesAndDeregisteringKeepsNoEmptyBucket =
	property.explore(
		(s) => {
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
		},
		{
			needs: {},
			situations: [
				"a keyed key reaching a keyed subscription",
				"a keyed key reaching a table-wide one",
				"a table key reaching a keyed one",
				"a key reaching none",
				"a deregistered subscription a key would have reached",
				"one subscription reached through several keys"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				({ all, removed, routed }) =>
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "a filter of the registered subscriptions"
			},
			budget: { runs: 600, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/live/router.ts",
					original: "\t}\n\tswitch (key.kind) {",
					replacement: '\t}\n\tswitch (key.kind === "keyed" ? "table" : key.kind) {',
					why: "route visits every subscription of the key's table whatever the key's column and value, so every change of a table re-runs every read of it; the routing property fails."
				}
			]
		}
	)

/**
 * The live router keys no native Map or Set by a routed value V8 hashes by its length alone: subscriptions keyed at a
 * family of two to four distinct values of one length past 16,383 units (kernel/long-keys.ts longFamily), each
 * registered and some deregistered, and every value of the family routed, reach exactly the subscriptions still
 * registered at that value, and no native Map or Set was keyed by such a value (kernel/long-keys.ts
 * lengthHashedKeyings): a column's values are identities in a TextsMap (core/text.ts), which hashes each by its digest,
 * where a native Map of them would be one chain, each lookup comparing its value with every value of the chain.
 *
 * Budget: 40 independent cases and 0 steered, each a few long values.
 */
export const theLiveRouterKeysNoNativeMapByAValueV8HashesByItsLength = property.explore(
	(s) => {
		const family = longFamily(s.draw(int(2, 4)))
		const at: ReadonlyArray<number> = s.draw(
			array((t) => t.draw(int(0, family.length - 1)), { min: 1, max: 6 })
		)
		return {
			family,
			at,
			removed: s.draw(
				subset(
					upTo(at.length, (n) => n),
					{ min: 0, max: at.length }
				)
			)
		}
	},
	{
		needs: {},
		situations: [
			"two subscriptions at one value",
			"a value no subscription holds",
			"a deregistered subscription"
		] satisfies ReadonlyArray<Reached<LongFeature>>,
		check:
			(_, c: Case<LongFeature>) =>
			({ family, at, removed }) =>
				Effect.gen(function* () {
					const all: ReadonlyArray<Drawn> = Arr.map(at, (value, name) => ({
						name,
						keys: [longKeyed(defined(family[value], "a value of the family"))]
					}))
					const gone = new Set(removed)
					const [reached, keyings] = yield* lengthHashedKeyings(
						Effect.sync(() => {
							const index: RouteIndex<Drawn> = new Map()
							for (const subscription of all) {
								addRoutes(index, subscription, subscription.keys)
							}
							for (const subscription of all) {
								if (gone.has(subscription.name)) {
									removeRoutes(index, subscription, subscription.keys)
								}
							}
							return Arr.map(family, (value) => {
								const names: Array<number> = []
								route(index, longKeyed(value), (subscription) => {
									names.push(subscription.name)
								})
								return Arr.sort(names, Order.Number)
							})
						})
					)
					assert.equal(keyings, 0, "no native Map or Set keyed by a value past the hashed length")
					for (const [value, names] of reached.entries()) {
						const held = Arr.filter(at, (v, name) => v === value && !gone.has(name))
						assert.deepEqual(
							names,
							Arr.filter(
								upTo(at.length, (n) => n),
								(name) => at[name] === value && !gone.has(name)
							),
							"a value reaches exactly the subscriptions still registered at it"
						)
						if (held.length >= 2) {
							c.note("two subscriptions at one value")
						}
						if (Arr.every(at, (v) => v !== value)) {
							c.note("a value no subscription holds")
						}
					}
					if (gone.size > 0) {
						c.note("a deregistered subscription")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the subscriptions registered at each value, no native keying by it"
		},
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\treturn mintTextsId({ texts, digest: digest >> 1, belowSurrogates })",
				replacement:
					'\treturn mintTextsId({ texts, digest: texts.join("\\u0000"), belowSurrogates })',
				why: "A TextsMap keys its buckets by an identity's texts joined, a native Map of strings, as the router's Map of values by their text did: routing a family of values past the hashed length keys a native Map by each, one chain."
			}
		]
	}
)
