/**
 * A snapshot resolves every read as the installation it records does (deploy/snapshot/served.ts snapshotResolver over
 * SnapshotDerived `resolved`, physical/indexes/ref.ts resolverOf): the index each access request landed on is recorded
 * as data once, so a served compile from snapshot.json alone, an application's, prints the advice generate's does, byte
 * for byte, and never derives an index a second way.
 *
 * Property: over the index engine's drawn requests (indexes.fixtures.ts engineGen), the installation they plan, and its
 * runtime snapshot written (writeRuntimeSnapshot) and read back as an application reads it (servedSnapshot), the
 * snapshot's resolver resolves every access request to the IndexRef the installation's own resolver does, by its name,
 * method, stored columns and whether it returns them; and a request the installation was not planned from, which the
 * table holds no resolution of, is refused as an internal compiler error, never resolved to an index of its relation.
 *
 * Oracle: the specification, the installation's own resolver, which the snapshot's equals.
 *
 * Features: a request resolved through the snapshot; one refused, the table holding none of it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { derivedOf, emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { servedSnapshot, snapshotResolver } from "#compiler/deploy/snapshot/served.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { engineGen, install, requestsOf } from "#test/unit/physical/indexes.fixtures.ts"

type Feature = "a request resolved through the snapshot" | "an unplanned request refused"

/** The snapshot's resolver resolves every access request as its installation's does, and none it was not planned from. */
export const aSnapshotResolvesEveryReadAsTheInstallationItRecordsDoes = property.explore(
	engineGen,
	{
		needs: {},
		situations: [
			"a request resolved through the snapshot",
			"an unplanned request refused"
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
				}
				const [first] = access
				if (first !== undefined) {
					const unplanned: AccessIndexRequest = {
						...first,
						fixed: first.fixed + first.keys.length + 1
					}
					assert.throws(
						() => resolve(unplanned),
						(e) => Str.includes("a missed index")(String(e)),
						"a request the installation was not planned from resolves through the snapshot to none"
					)
					c.note("an unplanned request refused")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the installation's own resolver, which the one its runtime snapshot rebuilds equals"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\tresolved: d.resolved.map((r) => ({\n",
				replacement: "\tresolved: d.resolved.slice(1).map((r) => ({\n",
				why: "The snapshot records every resolution but the first: a served compile from it alone meets a request of an index the installation holds and refuses it as an internal compiler error, where generate's advice names that index."
			},
			{
				file: "packages/engine/src/physical/indexes/ref.ts",
				original:
					"\t\tresolved.get(requestContent({ ...request, relation: installedAs(request.relation) })) ??\n",
				replacement:
					"\t\t(resolved.get(requestContent({ ...request, relation: installedAs(request.relation) })) ?? resolutions[0]?.index) ??\n",
				why: "A request the table holds no resolution of falls back to the first index recorded, one that may not serve it, where it is an internal compiler error."
			}
		]
	}
)
