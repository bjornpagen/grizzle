/**
 * The seek predicate of the window variants (packages/engine/src/lower/shapes/page/seek.ts).
 *
 * The predicate is checked exhaustively against its definition, the declared lexicographic order: for every
 * comparator sequence of one to three keys in every direction combination, each seek (strictly after or before), and
 * every tuple and boundary over a three-value domain, a direct evaluation of the emitted SQL expression agrees with the
 * declared order, and so does the empty comparison tuple of the zero-column relation, which nothing strictly follows or
 * precedes.
 *
 * A backward fetch reverses every direction of an order, and reversing twice is the order: checked on every order of
 * one to four keys.
 *
 * Oracles: the declared lexicographic order, a specification, for the predicate; each key's opposite direction for the
 * reversal.
 *
 * Features: zero to three keys.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { directions, opposite } from "#compiler/core/order.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import {
	reversedCompletedOrder,
	reversedOrder,
	seekPredicate
} from "#compiler/lower/shapes/page/seek.ts"
import { asc, col, desc } from "#compiler/sql/build.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import {
	declared,
	directionSets,
	evaluate,
	expected,
	keysOf,
	names,
	seeks,
	shownTuple,
	tuples
} from "#test/unit/page/seek.fixtures.ts"

/** The seek predicate agrees with the declared lexicographic order on every tuple, boundary, direction and seek. */
export const theSeekPredicateAgreesWithTheDeclaredLexicographicOrderOnEveryTupleBoundaryDirectionAndSeek =
	property.exhaust(
		finite((source) => {
			const m = source.draw(element([0, 1, 2, 3]))
			return {
				dirs: source.draw(element(nonEmpty(directionSets(m), "the direction sets"))),
				seek: source.draw(element(seeks)),
				m
			}
		}),
		{
			needs: {},
			situations: ["0 keys", "1 keys", "2 keys", "3 keys"] satisfies ReadonlyArray<
				Reached<`${0 | 1 | 2 | 3} keys`>
			>,
			check:
				(_, c: Case<`${0 | 1 | 2 | 3} keys`>) =>
				({ dirs, seek, m }) =>
					Effect.sync(() => {
						c.note(m === 0 ? "0 keys" : m === 1 ? "1 keys" : m === 2 ? "2 keys" : "3 keys")
						const predicate = seekPredicate(keysOf(dirs), seek, names)
						for (const t of tuples(m)) {
							for (const bound of tuples(m)) {
								const holds = evaluate(predicate, t, bound) === true
								assert.equal(
									holds,
									expected(seek, declared(dirs)(t, bound)),
									`${Arr.join(dirs, ",")} ${Formatter.format(seek)} ${shownTuple(t)} vs ${shownTuple(bound)}`
								)
							}
						}
					}),
			oracle: { kind: "specification", name: "the declared lexicographic order" },
			box: "every direction set of zero to three keys, each seek, every tuple and boundary over three values",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/build.ts",
					original: '\targs.length === 1 ? args[0] : { kind: "or", args }',
					replacement: '\targs.length === 1 ? { kind: "or", args } : args[0]',
					why: 'Operator mutant (arm-swap) at packages/engine/src/sql/build.ts:285 in or: `args.length === 1 ? args[0] : { kind: "or", args }` becomes `args.length === 1 ? { kind: "or", args } : args[0]`; the property fails (lane CATCH, grizzle 0baff5d6).'
				}
			]
		}
	)

/** Window variants reverse every direction of an order for a backward fetch, and reversing twice is the order. */
export const windowVariantsReverseEveryDirectionOfAnOrderForABackwardFetchAndReversingTwiceIsTheOrder =
	property.exhaust(finite(array(element(directions), { min: 1, max: 4 })), {
		needs: {},
		situations: [],
		check: () => (dirs) =>
			Effect.sync(() => {
				const items = Arr.map(dirs, (d, i) =>
					d === "asc" ? asc(col("r", `c${i}`)) : desc(col("r", `c${i}`))
				)
				assert.deepEqual(
					reversedOrder(items),
					Arr.map(dirs, (d, i) =>
						opposite(d) === "asc" ? asc(col("r", `c${i}`)) : desc(col("r", `c${i}`))
					)
				)
				const order: CompletedOrder = {
					keys: Arr.map(dirs, (dir, i) => ({ column: `c${i}`, dir }))
				}
				assert.deepEqual(reversedCompletedOrder(order), {
					keys: Arr.map(dirs, (dir, i) => ({ column: `c${i}`, dir: opposite(dir) }))
				})
				assert.deepEqual(reversedCompletedOrder(reversedCompletedOrder(order)), order)
			}),
		oracle: { kind: "specification", name: "each key's opposite direction" },
		box: "every order of one to four keys",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/page/seek.ts",
				original:
					'\titems.map((item) => (item.direction === "DESC" ? asc(item.expr) : desc(item.expr)))',
				replacement:
					'\titems.map((item, i) =>\n\t\ti > 0 ? item : item.direction === "DESC" ? asc(item.expr) : desc(item.expr)\n\t)',
				why: "reversedOrder reverses the first key alone; the reversal property fails."
			}
		]
	})
