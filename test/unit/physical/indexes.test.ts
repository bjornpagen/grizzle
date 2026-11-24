/**
 * The index request engine's own contract (physical/indexes/engine.ts), judged from its plan and the statements that
 * create its indexes. Over drawn requests on a schema with a plain table, a span key's GiST index and a reverse lookup,
 * in a drawn order:
 *
 * - every request lands on exactly one planned index, of its relation, an installed one where its equalities bind every
 *   key of an installed unique B-tree;
 * - a created index is never unique, in the plan or in its CREATE INDEX;
 * - the plan is the same whatever order the requests arrive in, and whatever order each states the columns it binds by
 *   equality in, so every index that holds one block of columns holds it in one order, the relation's heading's
 *   (physical/indexes/engine.ts withinBlock);
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

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	engineSpace,
	expectedRefusal,
	type IndexFeature,
	install,
	installShelf,
	boundColumns,
	keyField,
	plantedRequests,
	requestOf,
	restated,
	sameColumns,
	shelfColumnsOf,
	shelfGen,
	shelfLookup,
	superkeyOf,
	superkeySeekGen,
	superkeySeekRequest,
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
								r.role === "lawMaintenance"
									? Arr.map(r.blocks.flat(), (k) => k.column.kind)
									: Arr.map(r.keys, (k) => String(k.expr)),
								","
							)})`
						)
						const index = defined(serving[0])
						assert.equal(
							index.relation,
							r.relation,
							`${index.index.name} is of the request's relation`
						)
						const bound = boundColumns(r)
						const keys = Arr.map(index.keys, keyField)
						assert.ok(
							r.method === "gist" ||
								bound.length === 0 ||
								(index.unique && Arr.every(keys, (k) => bound.includes(k))) ||
								(keys.length >= bound.length &&
									Arr.every(Arr.take(keys, bound.length), (k) => bound.includes(k))),
							`${index.index.name}(${Arr.join(keys, ", ")}) leads with exactly the columns ${r.relation}(${Arr.join(bound, ", ")}) binds by equality, or is a unique index all of whose keys it binds`
						)
						assert.ok(
							r.method === "gist" ||
								index.index.kind === "installed" ||
								!Arr.some(
									installation.indexes,
									(x) =>
										x.relation === r.relation &&
										x.index.kind === "installed" &&
										x.unique &&
										x.method === "btree" &&
										Arr.every(x.keys, (k) => bound.includes(keyField(k)))
								),
							`${r.relation}(${Arr.join(bound, ", ")}) binds a key and lands on an installed index, not on ${index.index.name}`
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
					const reordered = succeeded(install(Arr.map(requests, restated)))
					assert.deepEqual(
						reordered.statements,
						installation.statements,
						"the plan is the same whatever order each request states the columns it binds by equality in"
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
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:0.0.1.2.3.4.5.5.3.4.0.0"
				),
				reason: "a GiST request on (live, tenant, account), live a boolean stated before two uuids",
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\tif (!sameSet(keys.slice(at, at + block.length), block)) {",
				replacement: "\t\t\t\tif (!block.every((k) => keys.some((l) => sameKey(l, k)))) {",
				why: "An index serves a block of a request's columns wherever it holds them, not only as its leading run: a lookup lands on an index that holds its columns after one it leaves unbound, which reads every row of that column's values and filters the rest."
			},
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
					'\tgist: (place, columns) =>\n\t\tcombineAll([\n\t\t\tmapInput(compareBooleans, (k: IndexKey) => columns.holds(k.column) === "few"),\n\t\t\tmapInput(compareNumbers, place),\n\t\t\tkeyOrder\n\t\t])',
				replacement: "\tgist: (place) => combineAll([mapInput(compareNumbers, place), keyOrder])",
				why: "A GiST index's columns of few values are no longer placed after its columns of many values: its keys keep the heading's order (physical/indexes/engine.ts withinBlock)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\tbtree: (place) => combineAll([mapInput(compareNumbers, place), keyOrder]),",
				replacement: "\tbtree: () => () => 0,",
				why: "A B-tree's block keeps the order its creating request stated it in, as before: a request restated with its equality columns reversed creates an index of another order, two indexes on one block lead differently, and the plan is no longer one whatever order a request states its columns in."
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

type ShelfFeature =
	| "the lesser key stated first"
	| "the lesser key stated second"
	| "a primary key beside a lesser key"

/**
 * A request two key indexes serve alike lands on the one its content puts first (physical/indexes/engine.ts hostOrder),
 * its relation's primary key before another key, then the fewest keys, then its keys by name, whichever order the keys'
 * statements stand in: over a shelf's two keys of b and a drawn column, stated in either order, its equality lookup on
 * b lands on the key of the lesser column, or on the primary key where the key of the greater column is the shelf's
 * primary key, and the installation is one in both orders. Where the keys stand among the owned statements is their
 * identity digests' order, which no meaning fixes, so a request that took the first serving key moved with it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRequestTwoKeysServeLandsOnTheKeyItsContentPutsFirstWhicheverOrderTheirStatementsStandIn =
	property.explore(shelfGen, {
		needs: {},
		situations: [
			"the lesser key stated first",
			"the lesser key stated second",
			"a primary key beside a lesser key"
		] satisfies ReadonlyArray<Reached<ShelfFeature>>,
		check: (_, c: Case<ShelfFeature>) => (shelf) =>
			Effect.sync(() => {
				const installation = succeeded(installShelf(shelf))
				const [first, second] = shelf.seconds
				const { lesser, greater } = shelfColumnsOf(shelf)
				const host = shelf.primary ? greater : lesser
				const hosts = Arr.filter(installation.indexes, (x) =>
					Arr.some(
						x.requests,
						(r) => r.relation === shelfLookup.relation && r.role === shelfLookup.role
					)
				)
				assert.deepEqual(
					Arr.map(hosts, (x) => Arr.map(x.keys, keyField)),
					[["b", host]],
					`the lookup on b lands on the key (b, ${host}) of (b, ${first}) and (b, ${second}), the primary key (b, ${greater}) where it is one`
				)
				const again = succeeded(installShelf({ ...shelf, flipped: !shelf.flipped }))
				assert.deepEqual(again.statements, installation.statements)
				assert.deepEqual(
					Arr.map(again.indexes, (x) => [x.object, x.keys, x.requests.length]),
					Arr.map(installation.indexes, (x) => [x.object, x.keys, x.requests.length])
				)
				c.note(
					shelf.primary
						? "a primary key beside a lesser key"
						: (lesser === first) !== shelf.flipped
							? "the lesser key stated first"
							: "the lesser key stated second"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the serving primary key, else the serving key of the lesser column, and one installation in either order of the keys' statements"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"\t\tmapInput(compareNumbers, (c: Candidate) => c.index.keys.length),\n\t\tmapInput(listOrder(keyOrder), (c: Candidate) => c.index.keys),\n\t\tmapInput(compareStrings, (c: Candidate) => c.index.index.name)\n",
				replacement: "",
				why: "The request lands on the first serving key in the order the keys' statements stand in, their identity digests', so which of two keys hosts it is no matter of what either is."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\t\tmapInput(compareBooleans, (c: Candidate) => c.standing.kind !== "primary"),\n',
				replacement: "",
				why: "A relation's primary key ranks as any other key, so a lookup its primary key and a narrower-named key both serve lands on the other key, and every law reason a primary key held moves onto a secondary key of its width."
			}
		]
	})

type SuperkeyFeature =
	| "a superkey seek on a key of one column"
	| "a superkey seek on a key of two columns"
	| "a superkey seek binding a column beyond its key"
	| "a superkey seek ordering by two columns"

/**
 * A superkey seek, a take or page seek whose equalities bind every key of a unique index, lands on that index and the
 * engine creates none for it (physical/indexes/engine.ts orderedPlacements): at most one row answers it, which is in
 * every order, so an index of its own would lead with the key's columns beside the key's index, which a lookup binding
 * the key ties with. Over Event's key of one column and Ledger's of two, each seek binding the key's columns and drawn
 * others in a drawn order, then ordering by one or two of the rest in drawn directions.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSuperkeySeekLandsOnItsKeyAndTheEngineCreatesNoIndexForIt = property.explore(
	superkeySeekGen,
	{
		needs: {},
		situations: [
			"a superkey seek on a key of one column",
			"a superkey seek on a key of two columns",
			"a superkey seek binding a column beyond its key",
			"a superkey seek ordering by two columns"
		] satisfies ReadonlyArray<Reached<SuperkeyFeature>>,
		check: (_, c: Case<SuperkeyFeature>) => (seek) =>
			Effect.sync(() => {
				const request = superkeySeekRequest(seek)
				const installation = succeeded(install([request]))
				const key = superkeyOf(seek)
				assert.deepEqual(
					Arr.map(
						Arr.filter(installation.indexes, (x) => x.requests.includes(request)),
						(x) => ({ kind: x.index.kind, unique: x.unique, keys: Arr.map(x.keys, keyField) })
					),
					[{ kind: "installed", unique: true, keys: [...key] }],
					`the seek on ${seek.relation}(${Arr.join(seek.fixed, ", ")}) lands on its key (${Arr.join(key, ", ")})`
				)
				assert.deepEqual(
					Arr.map(
						Arr.filter(
							installation.indexes,
							(x) => x.index.kind === "created" && x.relation === seek.relation
						),
						(x) => x.index.name
					),
					[],
					`no index of ${seek.relation} is created for the seek`
				)
				c.note(
					key.length === 1
						? "a superkey seek on a key of one column"
						: "a superkey seek on a key of two columns"
				)
				if (seek.fixed.length > key.length) {
					c.note("a superkey seek binding a column beyond its key")
				}
				if (seek.ordered.length > 1) {
					c.note("a superkey seek ordering by two columns")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the seek on its key's index, and no index created for it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\t\tothers: isNonEmpty(bound) ? [{ kind: "keyed", method: "btree", within: bound }] : []\n',
				replacement: "\t\tothers: []\n",
				why: "A superkey seek is served only by an index leading with its keys in order, so it creates one leading with the key's columns beside the key's own index, which a lookup binding the key ties with (test/pg/physical/serving.ts, empty as installed)."
			}
		]
	}
)
