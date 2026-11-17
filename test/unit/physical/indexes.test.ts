/**
 * The index request engine's own contract (physical/indexes/engine.ts), judged from its plan and the statements that
 * create its indexes. Over drawn requests on a schema with a plain table, a span key's GiST index and a reverse lookup,
 * in a drawn order:
 *
 * - every request lands on exactly one planned index, of its relation;
 * - a created index is never unique, in the plan or in its CREATE INDEX;
 * - the plan is the same whatever order the requests arrive in;
 * - a request the engine cannot create, planted alone with drawn columns (an entry beyond its method's limit, more than
 *   INDEX_MAX_KEYS columns, an expression key), is refused as a key is;
 * - created indexes have distinct names, and a B-tree and a GiST request on one drawn column list install as two;
 * - a GiST request over a drawn order of columns of few and of many values (Event's boolean live and its uuids and
 *   bigints) creates an index whose every column of few values follows every column of many values: GiST places an
 *   entry and splits a page by its first column, so a column of few values first ties its entries and a probe follows
 *   more of them down (physical/indexes/engine.ts withinBlock measured 7 to 10 buffers against 4 or 5). Each column's
 *   class is stated here, from its type.
 *
 * Whether the index a request lands on serves it, and whether a created index is needed, is PostgreSQL's to judge in the
 * database suites: nothing here states which index serves which request.
 *
 * Oracle: the engine's contract stated over the requests: one index each, the arrival order's metamorphic invariance,
 * and the refusal each planted request names.
 *
 * Features: served by an installed or a created index, several requests on one created index, a GiST key serving a
 * B-tree probe, an ordered and a range request, each planted refusal, two methods on one column list, and two indexes on
 * one column list.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import {
	engineSpace,
	expectedRefusal,
	type IndexFeature,
	install,
	keyField,
	plantedRequests,
	requestOf,
	sameColumns,
	valueClass
} from "#test/unit/physical/indexes.fixtures.ts"

/** The index request engine lands every request on exactly one index, plans alike in any arrival order, and refuses what it cannot create. Its budget is its suite's before it was a property (test/unit/physical/indexes.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate =
	property.explore(engineSpace, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"served by an installed index",
			"served by a created index",
			"a created index serving several requests",
			"a GiST key serving a B-tree probe",
			"an ordered request",
			"a range request",
			"an unrepresentable entry refused",
			"too many keys refused",
			"an expression key refused",
			"a B-tree and a GiST index on one column list installed",
			"two indexes on one column list",
			"a GiST index on a column of few values stated before columns of many values installed"
		] satisfies ReadonlyArray<Reached<IndexFeature>>,
		check:
			(_, c: Case<IndexFeature>) =>
			({ requests: sketches, arrival, planted }) =>
				Effect.sync(() => {
					const requests = Arr.map(sketches, requestOf)
					if (planted.kind === "a B-tree and a GiST index on one column list") {
						const created = Arr.filter(
							succeeded(install(plantedRequests(planted))).indexes,
							(x) =>
								x.index.kind === "created" &&
								sameColumns(Arr.map(x.keys, keyField), planted.columns)
						)
						assert.deepEqual(
							Arr.sort(
								Arr.map(created, (x) => x.method),
								Order.String
							),
							["btree", "gist"]
						)
						assert.equal(new Set(Arr.map(created, (x) => x.index.name)).size, 2, "two names")
						c.note(`${planted.kind} installed`)
						return
					}
					if (planted.kind === "a GiST index on columns of few and many values") {
						const [gist] = Arr.filter(
							succeeded(install(plantedRequests(planted))).indexes,
							(x) => x.index.kind === "created" && x.method === "gist"
						)
						const keys = Arr.map(defined(gist, "the GiST request's created index").keys, keyField)
						const classOf = (column: string) => defined(valueClass[column], column)
						assert.ok(
							Arr.every(
								keys,
								(k, at) =>
									classOf(k) === "many" ||
									Arr.every(keys.slice(at + 1), (l) => classOf(l) === "few")
							),
							`${Arr.join(keys, ", ")}: every column of few values follows every column of many values`
						)
						const few = Arr.findFirstIndex(planted.columns, (k) => classOf(k) === "few")
						if (
							Option.exists(few, (at) =>
								Arr.some(planted.columns.slice(at + 1), (k) => classOf(k) === "many")
							) &&
							Arr.length(Arr.filter(planted.columns, (k) => classOf(k) === "many")) > 1
						) {
							c.note(
								"a GiST index on a column of few values stated before columns of many values installed"
							)
						}
						return
					}
					if (planted.kind !== "none") {
						c.note(`${planted.kind} refused`)
						refused(install(plantedRequests(planted)), expectedRefusal[planted.kind])
						return
					}
					/** Created indexes are distinct objects of distinct names (identity.accessIndex). */
					const installation: Installation = succeeded(install(requests))
					const created = Arr.filter(installation.indexes, (x) => x.index.kind === "created")
					assert.equal(
						new Set(Arr.map(created, (x) => x.index.name)).size,
						created.length,
						"distinct names"
					)
					const columnsOf = (x: PlannedIndex) => Arr.join(Arr.map(x.keys, keyField), " ")
					if (
						Arr.some(created, (a) =>
							Arr.some(
								created,
								(b) => a !== b && a.relation === b.relation && columnsOf(a) === columnsOf(b)
							)
						)
					) {
						c.note("two indexes on one column list")
					}
					for (const r of requests) {
						const serving = Arr.filter(installation.indexes, (x) => x.requests.includes(r))
						assert.equal(
							serving.length,
							1,
							`one index holds ${r.relation}(${Arr.join(
								Arr.map(r.keys, (k) => ("expr" in k ? String(k.expr) : k.column.kind)),
								","
							)})`
						)
						const index = defined(serving[0])
						assert.equal(
							index.relation,
							r.relation,
							`${index.index.name} is of the request's relation`
						)
						c.note(
							index.index.kind === "created"
								? "served by a created index"
								: "served by an installed index"
						)
						if (index.method === "gist" && r.method === "btree") {
							c.note("a GiST key serving a B-tree probe")
						}
						if (r.role === "access" && (r.use === "take seek" || r.use === "page seek")) {
							c.note("an ordered request")
						}
						if (r.role === "access" && (r.use === "range" || r.use === "prefix search")) {
							c.note("a range request")
						}
					}
					for (const index of created) {
						assert.equal(index.unique, false, `${index.index.name} is not unique`)
						assert.ok(
							Arr.every(
								installation.statements,
								(s) => s.kind !== "createIndex" || s.name !== index.index.name || !s.unique
							),
							`${index.index.name} is created by no CREATE UNIQUE INDEX`
						)
						if (index.requests.length > 1) {
							c.note("a created index serving several requests")
						}
					}
					const shuffled = Arr.map(
						Arr.sort(
							Arr.map(requests, (r, i) => ({ r, key: defined(arrival[i]) })),
							Order.mapInput(Order.Number, (x: { readonly key: number }) => x.key)
						),
						({ r }) => r
					)
					const again = succeeded(install(shuffled))
					assert.deepEqual(again.statements, installation.statements)
					assert.deepEqual(
						Arr.map(again.indexes, (x) => [x.object, x.keys, x.requests.length]),
						Arr.map(installation.indexes, (x) => [x.object, x.keys, x.requests.length])
					)
				}),
		oracle: {
			kind: "specification",
			name: "one index per request, invariance under arrival order, and each planted request's refusal"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:2.0.2.0.0.2.0.0.6.1.0.0.2.0.0.2.1.0.6.1.0.0.1.2.3.4.5.0"
				),
				reason: "two seeks on (tenant, created) in directions no one index reads both ways",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:0.0.1.2.3.4.5.7.3.4.0.0"
				),
				reason: "a GiST request on (live, tenant, account), live a boolean stated before two uuids",
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t})),\n\t\tunique: false,",
				replacement: "\t\t})),\n\t\tunique: true,",
				why: "A created index is unique."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\trequest.relation,\n\t\tmethod,",
				replacement: '\t\trequest.relation,\n\t\t"btree",',
				why: "An index is named as a B-tree whatever its method."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\tgist: (rank, columns) =>\n\t\tcombineAll([\n\t\t\tmapInput(compareBooleans, (k: IndexKey) => columns.holds(k.column) === "few"),\n\t\t\tmapInput(compareNumbers, rank)\n\t\t])',
				replacement: "\tgist: (rank) => mapInput(compareNumbers, rank)",
				why: "A GiST index's columns of few values are no longer placed after its columns of many values: its keys keep the request's order (physical/indexes/engine.ts withinBlock)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t.toSorted(canonical)\n",
				replacement: "",
				why: "The engine plans its requests in the order they arrive, not in their canonical order (indexes/engine.ts planIndexes); the arrival-order invariance fails."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\tconst plan = requests\n",
				replacement: '\t\tconst plan = requests.filter((r) => r.role === "lawMaintenance")\n',
				why: "The engine plans no access index, only law probes: a read's request lands on no index. Moved here from test/pg/bench/gates.test.ts's query gates, which left the test tiers for `pnpm bench`."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\tconst plan = requests\n",
				replacement: '\t\tconst plan = requests.filter((r) => r.role !== "lawMaintenance")\n',
				why: "The engine plans no law probe index: a law's request lands on no index. Moved here from test/pg/bench/gates.test.ts's write and law gates, which left the test tiers for `pnpm bench`."
			}
		]
	})
