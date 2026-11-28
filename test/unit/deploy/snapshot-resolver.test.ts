/**
 * A snapshot resolves every read as the installation it records does (deploy/snapshot/served.ts snapshotResolver over
 * SnapshotDerived `indexSet`, physical/indexes/engine.ts resolverOf): resolution is one function of the installation's
 * indexes and the request, the coverage rule planning lands its requests by, so a served compile from snapshot.json
 * alone, an application's or a test's, prints the advice generate's does, byte for byte, and a read no compile planned
 * resolves to the index that serves it all the same.
 *
 * Property: over the index engine's drawn requests (indexes.fixtures.ts engineGen), the installation they plan, and its
 * runtime snapshot written (writeRuntimeSnapshot) and read back as an application reads it (servedSnapshot):
 * - the snapshot's resolver resolves every access request to the IndexRef the installation's own resolver does, by its
 *   name, method, stored columns and whether it returns them;
 * - every lookup, an equality on each of its columns, resolves to an index of its relation that leads with exactly its
 *   columns or is unique with every key among them, by the specification of coverage (docs/limits.md "Keys and indexes"), apart
 *   from the rule both resolvers read, so a mutation of that rule breaks the two together and is caught;
 * - a read by a key no request asked resolves through the snapshot to that key's index (the kept case: a put compiled
 *   against an installation whose workload never held it, its probe of the facts it displaces by the key, which the
 *   resolution table of the planned requests alone refused as a missed index);
 * - a read no index of the installation serves is refused through the snapshot as UninstalledIndex, a refusal of the
 *   program that reads it, and is a missed index, an internal compiler error, of the installation's own resolver, never
 *   resolved to an index of its relation.
 *
 * Oracle: the specification of coverage for lookups, and the installation's own resolver, which the snapshot's equals.
 *
 * Features: a request resolved through the snapshot; a lookup resolved to an index the specification admits; a key read
 * no request planned resolved; an unserved request refused.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { derivedOf, emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { servedSnapshot, snapshotResolver } from "#compiler/deploy/snapshot/served.ts"
import { type AccessIndexRequest, accessKeyText } from "#compiler/ir/products.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import {
	engineGen,
	install,
	keyField,
	requestsOf,
	sameColumns,
	unplannedKeyRead,
	unservedRead
} from "#test/support/unit/physical/indexes.fixtures.ts"

type Feature =
	| "a request resolved through the snapshot"
	| "a lookup resolved to an index the specification admits"
	| "a key read no request planned resolved"
	| "an unserved request refused"

/** The uses whose every key a read binds by equality, which the specification's lookup arm covers. */
const lookups: ReadonlySet<AccessIndexRequest["use"]> = new Set([
	"key lookup",
	"equality lookup",
	"join key",
	"write target"
])

/** The snapshot's resolver resolves every access request as its installation's does, and none no index serves. */
export const aSnapshotResolvesEveryReadAsTheInstallationItRecordsDoes = property.explore(
	engineGen,
	{
		needs: {},
		situations: [
			"a request resolved through the snapshot",
			"a lookup resolved to an index the specification admits",
			"a key read no request planned resolved",
			"an unserved request refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (sketch) =>
			Effect.sync(() => {
				const installation = succeeded(install(requestsOf(sketch)))
				const text = succeeded(
					writeRuntimeSnapshot(
						emptySnapshot({ schemaName: "Indexed", schema: installation.names.schema }),
						derivedOf(installation)
					),
					"the runtime snapshot writes"
				)
				const served = succeeded(servedSnapshot(jsonOf(text), 0), "the runtime snapshot reads")
				const resolve = snapshotResolver(served, installation.checked)
				const access = Arr.flatMap(requestsOf(sketch), (r): ReadonlyArray<AccessIndexRequest> =>
					r.role === "access" ? [r] : []
				)
				/** The index of the installation a resolved reference names. */
				const indexNamed = (name: string) =>
					defined(
						Option.getOrUndefined(
							Arr.findFirst(installation.indexes, (x) => x.index.name === name)
						),
						`the installation's index ${name}`
					)
				for (const r of access) {
					const own = installation.resolve(r)
					const recorded = resolve(r)
					assert.deepEqual(
						{
							name: recorded.name,
							method: recorded.method,
							stores: recorded.stores,
							returns: recorded.returns
						},
						{ name: own.name, method: own.method, stores: own.stores, returns: own.returns },
						`the ${r.use} of ${r.relation} resolves through the snapshot as through its installation`
					)
					c.note("a request resolved through the snapshot")
					if (!lookups.has(r.use) || r.fixed !== r.keys.length) {
						continue
					}
					const index = indexNamed(recorded.name.name)
					const asked = Arr.map(r.keys, (k) => accessKeyText(k.expr))
					const keys = Arr.map(index.keys, keyField)
					assert.ok(
						index.relation === r.relation &&
							(sameColumns(Arr.take(keys, asked.length), asked) ||
								(index.unique && Arr.every(keys, (k) => asked.includes(k)))),
						`the ${r.use} of ${r.relation} on (${Arr.join(asked, ", ")}) resolves to ${recorded.name.name} on (${Arr.join(keys, ", ")}), which leads with its columns or is unique within them`
					)
					c.note("a lookup resolved to an index the specification admits")
				}
				const key = indexNamed(resolve(unplannedKeyRead).name.name)
				assert.ok(
					key.index.kind === "installed" &&
						key.unique &&
						sameColumns(Arr.map(key.keys, keyField), ["account", "entry"]),
					`a read by Ledger's key, which no request planned, resolves through the snapshot to its key's index, not ${key.index.name}`
				)
				c.note("a key read no request planned resolved")
				const refused = catchRefusal(() => resolve(unservedRead))
				assert.ok(
					!refused.ok && refused.error.reason._tag === "UninstalledIndex",
					"a read no index of the installation serves is refused through the snapshot as UninstalledIndex"
				)
				assert.throws(
					() => installation.resolve(unservedRead),
					(e) => Str.includes("a missed index")(String(e)),
					"a read no index of the installation serves resolves through its own resolver to none"
				)
				c.note("an unserved request refused")
			}),
		oracle: {
			kind: "specification",
			name: "coverage's lookup arm, and the installation's own resolver, which the one its runtime snapshot rebuilds equals"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\t\tindexes: d.indexSet.indexes.map((i) => ({\n",
				replacement: "\t\tindexes: d.indexSet.indexes.slice(1).map((i) => ({\n",
				why: "The snapshot records every index but the first: a served compile from it alone resolves a read the first index serves to another or refuses it, where generate's advice names that index."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"\tconst [host] = set.indexes.filter((c) => serves(c, entry)).toSorted(hostOrder(entry))\n",
				replacement:
					"\tconst [host] = set.indexes\n\t\t.filter((c) => c.relation === entry.request.relation)\n\t\t.toSorted(hostOrder(entry))\n",
				why: "The coverage rule mutated in its one place, every request landing on its relation's first index whether it serves it or not: planning and the snapshot's resolver agree on it, and the read no index serves resolves to Ledger's key all the same."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\tconst host = hostIn(set, covered.value)\n",
				replacement:
					"\tconst host = hostIn(set, covered.value) ?? set.indexes.find((c) => c.relation === relation)\n",
				why: "A read no index serves falls back to an index of its relation, one that does not serve it, where it is refused through the snapshot and an internal compiler error of the installation's own resolver."
			}
		]
	}
)
