/**
 * A lookup of a stored derived relation that binds one bytes column of no byte bound alone reads a hash index on it
 * (physical/indexes/engine.ts planIndexes): no B-tree entry holds the value, and a stored relation is the installation's
 * own inference, so its lookup is not refused for want of a bound; the hash index's entry is the value's 4-byte hash
 * code, and the rows it finds are the lookup's own. A lookup binding several such columns as one row equality (AccessUse
 * `row equality`) reads a hash index over their row, `ROW(<columns>)::<type>`, the type its own composite object of
 * those columns in the index's key order, created before the index; one binding them by an equality of each is refused
 * as UnsupportedOperation, since a hash index on one of them reads every row sharing that one value. Over AccountNote, a
 * sealed unit's stored relation of two bytes columns, a lookup of one of them, of both by an equality of each, and of
 * both as a row.
 *
 * Oracle: the rule, stated over the lookup's columns: one created hash index on the one column, or on the row of both,
 * after its composite type, the request resolving to it, storing and returning nothing; a refusal of two by an
 * equality of each.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	installNoted,
	boundlessColumns,
	boundlessLookup
} from "#test/unit/physical/boundless-lookups.fixtures.ts"

type BoundlessFeature =
	| "one column read through a hash index"
	| "two columns refused"
	| "two columns read through a hash of their row"

/** A stored lookup of one column of no byte bound alone, or of several as a row, reads a hash index; several by an equality of each are refused. */
export const aStoredLookupOfOneColumnOfNoByteBoundReadsAHashIndexOnIt = property.exhaust(
	finite(int(1, 3)),
	{
		needs: {},
		box: "a lookup of AccountNote by one of its two bytes columns alone, by both, and by both as a row",
		situations: [
			"one column read through a hash index",
			"two columns refused",
			"two columns read through a hash of their row"
		] satisfies ReadonlyArray<Reached<BoundlessFeature>>,
		check: (_, c: Case<BoundlessFeature>) => (bound) =>
			Effect.sync(() => {
				const columns = Arr.take(boundlessColumns, bound)
				const rowed = bound > boundlessColumns.length
				if (columns.length > 1 && !rowed) {
					refused(
						installNoted([boundlessLookup(columns, "equality lookup")]),
						"UnsupportedOperation"
					)
					c.note("two columns refused")
					return
				}
				const request = boundlessLookup(columns, rowed ? "row equality" : "equality lookup")
				const installation = succeeded(installNoted([request]))
				const created = Arr.filter(
					installation.indexes,
					(x) => x.relation === "AccountNote" && x.index.kind === "created"
				)
				const statements = installation.statements
				const indexAt = Arr.findFirstIndex(
					statements,
					(st) => st.kind === "createIndex" && st.method === "hash"
				)
				const typeAt = Arr.findFirstIndex(statements, (st) => st.kind === "createRowType")
				assert.deepEqual(
					{
						indexes: Arr.map(created, (x) => ({
							method: x.method,
							serves: x.requests.includes(request),
							keys: x.keys.length
						})),
						keyedByRow: Arr.some(
							statements,
							(st) =>
								st.kind === "createIndex" &&
								st.method === "hash" &&
								Arr.some(st.keys, (k) => k.key.kind === "expr")
						),
						typeBeforeIndex:
							Option.isSome(typeAt) && Option.isSome(indexAt) && typeAt.value < indexAt.value
					},
					{
						indexes: [{ method: "hash", serves: true, keys: columns.length }],
						keyedByRow: rowed,
						typeBeforeIndex: rowed
					},
					`the lookup by ${Arr.join(columns, ", ")} reads one created hash index`
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
					{ name: host.index.name, method: "hash", stores: 0, returns: false },
					`the lookup by ${Arr.join(columns, ", ")} resolves to its hash index`
				)
				c.note(
					rowed
						? "two columns read through a hash of their row"
						: "one column read through a hash index"
				)
			}),
		oracle: {
			kind: "specification",
			name: "one hash index on the one column or on the row of both after its type, the request resolved to it; a refusal of two by an equality of each"
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
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\tif (request.role === "access" && request.use === "row equality") {\n\t\treturn hashPlacements(keys)\n\t}\n',
				replacement: "",
				why: "A row equality placed as any B-tree request of its use: no B-tree serves it, and the installation refuses it as a malformed request."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\tconst rowed = method === "hash" && isNonEmpty(more) ? hashedRow([first, ...more]) : undefined\n',
				replacement: "\tconst rowed = undefined\n",
				why: "A hash index over several columns created over each, which PostgreSQL refuses (hash supports one column), and no read's row equality matches it."
			}
		]
	}
)
