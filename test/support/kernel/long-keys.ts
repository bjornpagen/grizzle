import { Effect, pipe, String as Str } from "effect"
import { upTo } from "#test/support/up-to.ts"

/**
 * The longest string V8 hashes by its content, in UTF-16 code units: a longer one's hash is its length alone, so a
 * native Map or Set of distinct longer strings of one length holds them all in one chain, a lookup comparing its key
 * with each in turn.
 *
 * @limitKind published
 * @owner V8 14.6, Node 26.13.0's JavaScript engine
 * @unit UTF-16 code units
 * @scope one JavaScript string's hash
 * @constraint compile-time constant
 * @source https://github.com/nodejs/node/blob/v26.13.0/deps/v8/src/objects/string.h#L529
 * @quote For strings longer than this limit the string length is used as the hash value.
 * @verified 2026-11-19
 */
export const longestHashedText = 16383

/**
 * A family of `size` distinct texts of one length past `longestHashedText`, at most 16: a shared run of `a` then each
 * its index in four binary digits spelled `a` and `b`, so every text is letters alone, which any text field a property
 * writes them to admits; texts V8 hashes alike, by their length, so a native Map of two of them holds both in one chain.
 */
export const longFamily = (size: number): ReadonlyArray<string> =>
	upTo(size, (at) =>
		pipe(
			Str.repeat(longestHashedText + 1)("a"),
			Str.concat(
				pipe(
					at.toString(2),
					Str.padStart(4, "0"),
					Str.replaceAll("0", "a"),
					Str.replaceAll("1", "b")
				)
			)
		)
	)

/** Whether a native Map or Set keyed by `key` hashes it by its length alone: a text past `longestHashedText`. */
const hashedByLength = (key: unknown): boolean =>
	typeof key === "string" && key.length > longestHashedText

/**
 * How many times a native Map or Set was keyed by a text V8 hashes by its length alone (`longestHashedText`) while
 * `effect` ran, with its value: every get, set, has, delete, getOrInsert and getOrInsertComputed of a Map, and every
 * add, has and delete of a Set, construction from entries included, which adds through them, counted where its key is
 * such a text. A chain needs two such keys of one length in one Map, so a count of none proves the effect formed none,
 * whatever its texts; a count is work, never time. Each method is wrapped while the effect runs and restored after
 * (the one module that replaces a native method, oxlint.config.ts), so the count is process-wide and the effect runs
 * alone, as a call count's does (kernel/calls.ts callCounts).
 */
export const lengthHashedKeyings = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, number], E, R> =>
	Effect.suspend(() => {
		const tally = { keyings: 0 }
		const note = (key: unknown): void => {
			if (hashedByLength(key)) {
				tally.keyings += 1
			}
		}
		const map = Map.prototype
		const set = Set.prototype
		const natives = {
			get: map.get,
			set: map.set,
			has: map.has,
			delete: map.delete,
			getOrInsert: map.getOrInsert,
			getOrInsertComputed: map.getOrInsertComputed,
			add: set.add,
			setHas: set.has,
			setDelete: set.delete
		}
		const wrap = Effect.sync(() => {
			map.get = function get(this: Map<unknown, unknown>, key: unknown): unknown {
				note(key)
				return natives.get.call(this, key)
			}
			map.set = function set(this: Map<unknown, unknown>, key: unknown, value: unknown) {
				note(key)
				return natives.set.call(this, key, value)
			}
			map.has = function has(this: Map<unknown, unknown>, key: unknown): boolean {
				note(key)
				return natives.has.call(this, key)
			}
			map.delete = function remove(this: Map<unknown, unknown>, key: unknown): boolean {
				note(key)
				return natives.delete.call(this, key)
			}
			map.getOrInsert = function getOrInsert(
				this: Map<unknown, unknown>,
				key: unknown,
				value: unknown
			): unknown {
				note(key)
				return natives.getOrInsert.call(this, key, value)
			}
			map.getOrInsertComputed = function getOrInsertComputed(
				this: Map<unknown, unknown>,
				key: unknown,
				compute: (key: unknown) => unknown
			): unknown {
				note(key)
				return natives.getOrInsertComputed.call(this, key, compute)
			}
			set.add = function add(this: Set<unknown>, value: unknown) {
				note(value)
				return natives.add.call(this, value)
			}
			set.has = function has(this: Set<unknown>, value: unknown): boolean {
				note(value)
				return natives.setHas.call(this, value)
			}
			set.delete = function remove(this: Set<unknown>, value: unknown): boolean {
				note(value)
				return natives.setDelete.call(this, value)
			}
		})
		const restore = Effect.sync(() => {
			map.get = natives.get
			map.set = natives.set
			map.has = natives.has
			map.delete = natives.delete
			map.getOrInsert = natives.getOrInsert
			map.getOrInsertComputed = natives.getOrInsertComputed
			set.add = natives.add
			set.has = natives.setHas
			set.delete = natives.setDelete
		})
		return Effect.acquireUseRelease(
			wrap,
			() => Effect.map(effect, (value) => [value, tally.keyings] as const),
			() => restore
		)
	})
