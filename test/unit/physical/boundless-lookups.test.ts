/**
 * A lookup of a stored derived relation that binds one bytes column of no byte bound alone reads a hash index on it
 * (physical/indexes/engine.ts planIndexes): no B-tree entry holds the value, and a stored relation is the installation's
 * own inference, so its lookup is not refused for want of a bound; the hash index's entry is the value's 4-byte hash
 * code, and the rows it finds are the lookup's own. A lookup binding several such columns alone is refused as
 * UnsupportedOperation, since a hash index on one of them reads every row sharing that one value. Over AccountNote, a
 * sealed unit's stored relation of two bytes columns, a lookup of one of them, and of both.
 *
 * Oracle: the rule, stated over the lookup's columns: one created hash index on the one column, the request resolving
 * to it, returning nothing; a refusal of two.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	installNoted,
	boundlessColumns,
	boundlessLookup
} from "#test/unit/physical/boundless-lookups.fixtures.ts"

type BoundlessFeature = "one column read through a hash index" | "two columns refused"

/** A stored lookup of one column of no byte bound alone reads a hash index on it, and one of two such alone is refused. */
export const aStoredLookupOfOneColumnOfNoByteBoundReadsAHashIndexOnIt = property.exhaust(
	finite(int(1, 2)),
	{
		needs: {},
		box: "a lookup of AccountNote by one of its two bytes columns alone, and by both",
		situations: [
			"one column read through a hash index",
			"two columns refused"
		] satisfies ReadonlyArray<Reached<BoundlessFeature>>,
		check: (_, c: Case<BoundlessFeature>) => (bound) =>
			Effect.sync(() => {
				const [column, ...more] = Arr.take(boundlessColumns, bound)
				if (column === undefined || Arr.isReadonlyArrayNonEmpty(more)) {
					refused(installNoted([boundlessLookup(boundlessColumns)]), "UnsupportedOperation")
					c.note("two columns refused")
					return
				}
				const request = boundlessLookup([column])
				const installation = succeeded(installNoted([request]))
				const created = Arr.filter(
					installation.indexes,
					(x) => x.relation === "AccountNote" && x.index.kind === "created"
				)
				assert.deepEqual(
					Arr.map(created, (x) => ({ method: x.method, serves: x.requests.includes(request) })),
					[{ method: "hash", serves: true }],
					`the lookup by ${column} reads one created hash index`
				)
				const ref = installation.resolve(request)
				const host = defined(created[0], "the created hash index")
				assert.deepEqual(
					{
						name: ref.name.name,
						method: ref.method,
						stores: ref.stores.length,
						returns: ref.returns
					},
					{ name: host.index.name, method: "hash", stores: 1, returns: false },
					`the lookup by ${column} resolves to its hash index`
				)
				c.note("one column read through a hash index")
			}),
		oracle: {
			kind: "specification",
			name: "one hash index on the one column, the request resolved to it; a refusal of two"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\t\t\t\t\t\tplacements: hashPlacements(keys),\n",
				replacement: "\t\t\t\t\t\t\t\t\tplacements,\n",
				why: "A lookup of one bytes column planned on a B-tree as any lookup is: its entry holds no column, and the installation is refused for an index it cannot build."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\t\treturn isNonEmpty(keys.slice(1))\n",
				replacement: "\t\t\t\t\treturn false\n",
				why: "A lookup of two bytes columns read through a hash index on the first: every row sharing that value is read for each lookup, and the lookup is never refused."
			}
		]
	}
)
