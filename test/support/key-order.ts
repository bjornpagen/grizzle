/**
 * Records written in another key order, and the order grizzle installs a record's names in, restated: what the
 * key-order properties (test/unit/schema/key-order, test/pg/served/key-order) and the declared functions' sketches
 * (test/support/declared-functions.ts) read. A heading's fields and a declared function's arguments are records, sets of
 * names, which PostgreSQL reads by position, so grizzle installs both in one order of their names whatever order the
 * record's keys were written in (schema/function.ts byName).
 */

import { type Gen, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"

/** A name's code points, the Unicode scalar values of its characters, in order. */
const codePoints = (name: string): ReadonlyArray<number> =>
	Arr.map(Array.from(name), (c) =>
		Option.getOrThrowWith(Str.codePointAt(c, 0), () => new Error("a character's code point"))
	)

/**
 * Names in code point order, restated from their code points: compared one by one, a name before every name it begins.
 * The order oxlint's sort-keys holds a record's keys to, and so the order a record of sorted keys is written in.
 */
export const byCodePoints: Order.Order<string> = Order.mapInput(
	Order.Array(Order.Number),
	codePoints
)

/**
 * Names in the order grizzle installs them in, restated: code point order (byCodePoints), the order of a row type's
 * attributes and of a function's parameters, whichever order a record wrote them in.
 */
export const installedOrder = <N extends string>(names: ReadonlyArray<N>): ReadonlyArray<N> =>
	Arr.sort(names, byCodePoints)

/**
 * `record` with its keys written in `order`, a permutation of them, each holding the value it holds: the same record to
 * every reader but one that reads its keys' order. Each key moved to the front, the last of `order` first, leaves
 * `order`'s first in front, since a key a literal already holds keeps its place when a spread sets it again.
 */
export const inOrder = <T extends object>(record: T, order: ReadonlyArray<keyof T>): T =>
	Arr.reduce(Arr.reverse(order), record, (written, key) => ({ [key]: written[key], ...written }))

/** An order of `keys`, a permutation of every one of them: the order a case writes a record's keys in. */
export const orderOf = <K>(keys: ReadonlyArray<K>): Gen<ReadonlyArray<K>> =>
	shuffled(keys, { min: keys.length, max: keys.length })
