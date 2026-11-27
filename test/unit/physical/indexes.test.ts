/**
 * The index request engine's own contract (physical/indexes/engine.ts), judged from its plan and the statements that
 * create its indexes. Over drawn requests on a schema with a plain table, a span key's GiST index and a reverse lookup,
 * in a drawn order:
 *
 * - every request lands on exactly one planned index, of its relation, an installed one where its equalities bind every
 *   key of an installed unique B-tree, that leads with the columns it binds by equality, a law's request of two blocks
 *   (a unit-local law's, its unit's key first, physical/ddl/rules.ts requestsOf) with each block's in turn, never an
 *   index that holds them in another block order;
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
 * B-tree probe, an ordered and a range request, each planted refusal, two methods on one column list, two indexes on
 * one column list, a law request of two blocks, and one beside an index of its columns in another block order.
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
	type ConfinedFeature,
	expectedOrder,
	type FewValuedFeature,
	flaggedReadGen,
	installFlagged,
	installReadPart,
	judgeCrossing,
	partField,
	partKeyed,
	readPartGen,
	spansPart,
	expectedRefusal,
	headingOrder,
	installRack,
	type RackFeature,
	rackFew,
	rackGen,
	type IndexFeature,
	install,
	installPart,
	installShelf,
	boundBlocks,
	boundColumns,
	keyField,
	leadsWithBlocks,
	partGen,
	partSpanning,
	plantedRequests,
	requestsOf,
	restated,
	sameColumns,
	shelfColumnsOf,
	shelfGen,
	shelfLookup,
	type SkipOrderFeature,
	stepsOf,
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
			"a GiST index on a column of few values stated before columns of many values installed",
			"a law request of two blocks",
			"a law request's blocks in another order than an index of its columns"
		] satisfies ReadonlyArray<Reached<IndexFeature>>,
		check: (_, c: Case<IndexFeature>) => (sketch) =>
			Effect.sync(() => {
				const { arrival, planted } = sketch
				const requests = requestsOf(sketch)
				if (planted.kind === "a B-tree and a GiST index on one column list") {
					const created = Arr.filter(
						succeeded(install(plantedRequests(planted))).indexes,
						(x) =>
							x.index.kind === "created" && sameColumns(Arr.map(x.keys, keyField), planted.columns)
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
								classOf(k) === "many" || Arr.every(keys.slice(at + 1), (l) => classOf(l) === "few")
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
					const blocks = boundBlocks(r)
					const keys = Arr.map(index.keys, keyField)
					assert.ok(
						r.method === "gist" ||
							bound.length === 0 ||
							(index.unique && Arr.every(keys, (k) => bound.includes(k))) ||
							leadsWithBlocks(keys, blocks),
						`${index.index.name}(${Arr.join(keys, ", ")}) leads with the columns ${r.relation}(${Arr.join(
							Arr.map(blocks, (b) => Arr.join(b, " ")),
							"; "
						)}) binds by equality, block by block, or is a unique index all of whose keys it binds`
					)
					if (r.role === "lawMaintenance" && blocks.length > 1) {
						c.note("a law request of two blocks")
						if (
							Arr.some(
								installation.indexes,
								(x) =>
									x.relation === r.relation &&
									sameColumns(Arr.take(Arr.map(x.keys, keyField), bound.length), bound) &&
									!leadsWithBlocks(Arr.map(x.keys, keyField), blocks)
							)
						) {
							c.note("a law request's blocks in another order than an index of its columns")
						}
					}
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
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:3.0.2.0.0.3.0.0.0.1.0.0.2.0.1.1.0.0.0.1.0.0.2.1.0.3.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"Event's key lookups of (tenant, unrelated), (tenant, account) and (account, unrelated), three sets no chain covers two of: the plan ordered them by their columns as stated, and the chain cover gave each the lead the one before it left, one plan for each statement of a lookup's columns (the arrival-order law broken at 79fd60c3); the plan compares each block as a set (physical/indexes/engine.ts canonical)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:2.0.2.0.0.2.0.0.6.1.0.0.2.0.0.2.1.0.6.1.0.0.1.2.3.4.5.0.0.0.0.0.0.0"
				),
				reason: "two seeks on (tenant, created) in directions no one index reads both ways",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#theIndexRequestEngineLandsEveryRequestOnExactlyOneIndexPlansAlikeInAnyArrivalOrderAndRefusesWhatItCannotCreate:-:0.0.1.2.3.4.5.5.3.4.0.0.0.0.0.0.0.0"
				),
				reason: "a GiST request on (live, tenant, account), live a boolean stated before two uuids",
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\tx.blocks.flatMap((block) => block.toSorted(keyOrder))",
				replacement: "\t\tx.keys",
				why: "The plan orders requests by their columns as stated, as at 79fd60c3: Event's lookups of (tenant, unrelated), (tenant, account) and (account, unrelated) take their leads in their statement's order, so a lookup that states its columns otherwise makes another plan; the kept case's plans differ."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\t? reversePlacements(blocks, keys, columns)",
				replacement: "\t\t\t\t? equalityPlacements(keys, columns)",
				why: "A law's request is placed as one block of every column it binds, as a workload's equality lookup is, so a probe of two blocks, a unit-local law's whose unit's key leads, lands on an index that holds its columns in another block order: the equality lookup's index of Event (tenant, account) serves the probe of (account; tenant), and the property fails."
			},
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
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\treturn relation === r.relation ? r : { ...r, relation }",
				replacement: "\t\t\treturn { ...r, relation }",
				why: "Every request planned as a copy, an alias's or not, as yonvslxs's canonical aliases planned them: the index a request lands on holds a copy of it, and no reader of the plan finds the request it asked among any index's (red at e42937e8b: the seek on Event(id) landed on no index)."
			}
		]
	}
)

/**
 * A created B-tree's order lets no binding that spans its unit's members step a column to reach it, wherever an order of
 * its columns does (physical/indexes/engine.ts skipFree): PostgreSQL 19 reads a binding through an index whose leading
 * columns it leaves unbound by stepping them, a descent for each value the declared statistics state, at the rows it
 * reaches, and prices those descents below the binding's own index at some size where the stepped column holds a fixed
 * number of values, as the declaration states every column of a member no fact scopes (test/pg/physical/plan-shape's
 * kept case at 16,384 rows). Over a drawn member Part of the unit Doc (doc), keyed (doc, ...) with a key of its own
 * fields or none, up to four equality lookups of its own fields led by doc or not, and a take seek ordered by some of
 * them with nothing bound or none: each created B-tree of Part is, of the orders of its columns that serve every request
 * landed on it and take no step (a binding that spans, holding no scope, lying within the index, holding every column
 * before one it does not hold, no scope, and a column after it), those led by a column no key of Part holds where one
 * is (physical/indexes/engine.ts firstBlockOrder: led by a key's column, the index ties the key's probe at one row), and
 * of them the first by the heading's order, column by column, where one is. A scope, the unit's field or a key's first
 * field, a candidate key's as its index holds it (physical/ddl/tables.ts candidateOrder), is never stepped: PostgreSQL
 * is told it grows with the table and takes no step where its values outnumber the index's pages, so a scope keeps the
 * heading's place behind such a lead. A seek's
 * order keys keep their order, an order an equality block's freedom never moves. A Part whose keys and created indexes
 * cross, so no number of distinct values per column ranks its statements, is refused as README "Declared statistics"
 * states, and the refusal is judged: it stands at Part's declared statistics, names keys of Part among the bounds it
 * crosses and states its remedy (indexes.fixtures.ts judgeCrossing).
 *
 * Oracle: every order of the index's columns, judged by its steps and by the requests it serves, the first by the
 * heading's order; a refusal, by the crossing it names.
 */
export const aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes =
	property.explore(partGen, {
		needs: {},
		situations: [
			"a block reordered so no spanning binding steps a column",
			"a scope leading beside a spanning binding within the index",
			"a seek's order kept where a spanning binding steps a column",
			"an index no order frees of a step"
		] satisfies ReadonlyArray<Reached<SkipOrderFeature>>,
		check: (_, c: Case<SkipOrderFeature>) => (sketch) =>
			Effect.sync(() => {
				const installed = installPart(sketch)
				if (!installed.ok) {
					c.note("a relation refused for crossing keys")
					judgeCrossing(sketch, installed.error)
					return
				}
				const installation = installed.value
				const spanning = partSpanning(sketch)
				const keyed = partKeyed(sketch)
				for (const x of installation.indexes) {
					if (x.relation !== "Part" || x.index.kind !== "created" || x.method !== "btree") {
						continue
					}
					const keys: ReadonlyArray<string> = Arr.map(x.keys, keyField)
					const expected = expectedOrder(spanning, keyed, keys, x.requests)
					if (expected === undefined) {
						c.note("an index no order frees of a step")
						if (
							expectedOrder(
								spanning,
								keyed,
								keys,
								Arr.filter(x.requests, (r) => r.role !== "access" || r.use !== "take seek")
							) !== undefined
						) {
							c.note("a seek's order kept where a spanning binding steps a column")
						}
						continue
					}
					assert.deepEqual(
						keys,
						expected,
						`Part's index (${Arr.join(keys, ", ")}) is the first order of its columns that serves its requests and lets no spanning binding step a column: its steps ${Arr.join(stepsOf(spanning, keys), "; ")}`
					)
					const heading = headingOrder(keys, x.requests)
					if (heading !== undefined && !Arr.every(heading, (k, at) => keys[at] === k)) {
						c.note("a block reordered so no spanning binding steps a column")
					}
					const [lead] = keys
					if (
						lead !== undefined &&
						spanning.scopes.has(lead) &&
						Arr.some(spanning.bindings, (b) => Arr.every([...b], (k) => keys.includes(k)))
					) {
						c.note("a scope leading beside a spanning binding within the index")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "every order of each created B-tree's columns, judged by its steps and the requests it serves, and a refusal by the crossing it names"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:1.0.0.3.0.3.1.1.1.3.1.2.1.1.1.3"
				),
				reason:
					"Part keyed (doc, f0), lookups of (f1, f2, f3), (doc, f3) and (doc, f1, f3) and a seek ordered by f3 with nothing bound: each chained request lands on its own chain's index, whose order answers to it, never the first created that serves it, which orders its columns for another chain",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:2.1.1.0.3.0.1.3.0.2.1.1.1.1.3.0"
				),
				reason:
					"Part keyed (doc, f1, f3), lookups of f3 alone, of (f1, f3) and of (doc, f3): every column of the first block a key's, so no column of no key leads it, and the block's order is the one no spanning binding steps, f3 before f1 (the kill of `placeable`'s step filter fails it, at 79fd60c3's draws the second and third kept cases did)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:2.0.1.0.2.0.1.2.1.1.2.2.2.0"
				),
				reason:
					"Part keyed (doc, f0, f2), lookups of f2 alone and of (doc, f2) and a seek ordered by (f2, f0): the unit's field doc, a scope, which PostgreSQL never steps, keeps the heading's place where every column is a key's",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:2.0.1.2.2.3.0.1.0.0.2.1.1.0.3.0.0.1.0"
				),
				reason:
					"Part keyed (doc, f0, f2) and (f2, f3), lookups of f0, of (f1, f3) and of (f0, f1, f3): each chained request lands on its own chain's index, whose order answers to it, not the first created that serves it",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:1.1.0.1.1.1.0.0"
				),
				reason:
					"Part keyed (doc, f1) and a lookup of (doc, f0): its index leads with f0, which no key holds, (f0, doc), where led by doc it would share the key's leading column and tie the key's probe at one row (physical/indexes/engine.ts firstBlockOrder); neither order steps a column",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:1.2.2.1.1.3.0.3.1.1.2.0.2.1.3.0.1.2.1.1"
				),
				reason:
					"Part keyed (doc, f2) and (f1, f3), a lookup of (doc, f0, f3) and a seek ordered by (f1, f2) with nothing bound: the created (doc, f0, f3) and (f1, f2) stop the keys' probes at sets apart that cross the keys, so no declaration ranks Part's statements, and the installation refuses it naming both keys and the remedy (README \"Declared statistics\"), where the property demanded an installation (red at e42937e8b; main's ruling 2026-11-26: a crossing is a refusal the property judges)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:1.0.0.3.0.2.2.0.3.1.1.1.2.1.2"
				),
				reason:
					"Part keyed (doc, f0), lookups of (f2, f3), (f1, f2, f3) and (doc, f2), and a seek ordered by f2 with nothing bound: the chain cover grouped the seek with (doc, f2) and drafted (f2, doc) for it, but the seek landed on the first index created that serves it, (f2, f3, f1), so (f2, doc) was ordered for a request it never serves, where (doc, f2) serves the one it does (red at e42937e8b; each chained request lands on its own chain's index since)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/physical/indexes.test.ts#aChainedIndexLetsNoSpanningBindingStepAColumnWhereAnOrderOfItsColumnsDoes:-:1.0.0.3.0.2.1.0.0.3.0.0.0.1.1.1.1.1"
				),
				reason:
					"REDS-PHYS's case at e42937e8b and at SKIPSTAT's 566e851f5b: lookups of (f1, f2), (f0, f1, f2) and (doc, f1) beside a seek ordered by f1, which the chain cover grouped with (doc, f1), drafting (f1, doc), and which landed on (f1, f2, f0): (f1, doc) served the lookup of (doc, f1) alone, ordered for a request it never served",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"\t\t\t(isNonEmpty(before) ? undefined : placeable.find((k) => keylessLead(text(k)))) ??\n",
				replacement: "",
				why: "A unit member's chained index led by the heading's first placeable column whatever keys hold it, as before: Part's lookup of (doc, f0) beside its key (doc, f1) creates (doc, f0), which shares the key's leading column and, priced at one row where no live row is counted, ties the key's probe; the kept case's index is (doc, f0)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\t\t\thost === undefined ? land(entry) : landOn(host, entry),",
				replacement: "\t\t\t\t\t\tland(entry),",
				why: "Each chained request landed on the first index created that serves it, as before, not its own chain's: a seek grouped with a lookup of (doc, f2) orders its chain's index (f2, doc) and lands on another chain's (f2, f3, f1), leaving (f2, doc) ordered for nothing it serves (the second and third kept cases)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"\t\t\t(k) => spanning.scopes.has(text(k)) || reaching.every((binding) => binding.has(text(k)))",
				replacement: "\t\t\t() => true",
				why: "Each block keeps the heading's order whatever binding steps its lead: a member's (f0, f1) beside a spanning lookup of (f1) leads with f0, which the lookup steps (plan-shape's kept case: f1 read through (f0, f1), every row of the index)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t(k) => spanning.scopes.has(text(k)) || reaching.every",
				replacement: "\t\t\t(k) => reaching.every",
				why: "A scope no longer keeps the heading's place: a block led by the unit's field, which PostgreSQL never steps, leads instead with a column a spanning binding binds, an order no step asked for (edullm's Node would lead four indexes with path for its (kind, path) lookup)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"].flatMap((columns) => (columns.some((c) => scopes.has(c)) ? [] : [new Set(columns)]))",
				replacement: "].flatMap((columns) => [new Set(columns)])",
				why: "Every binding is held to the block's order, a scoped one too, whose rows the declaration fixes and whose step never wins: blocks lead with columns no step asked for."
			}
		]
	})

/**
 * Each B-tree the engine creates for a relation in no unit leads with a column of many values of its first block, where
 * it holds one, of those with one no index of the relation before it leads with, where it holds one, and of those with
 * one no key holds, where it holds one (physical/indexes/engine.ts ownLead): the declaration states each index's first
 * column of many values an anchor
 * there, which PostgreSQL never steps, so a binding reaches an index only where it binds its lead, and a key's index
 * stops short of the binding of an index led by a column no key holds at a set lacking that anchor. Two indexes led
 * alike tied at the anchor's rows whenever the other columns' statistics stated one value or each value its own:
 * test/pg/lower-shapes/attachment-reach's session read at its key through a sitting's (child, stage), and
 * member-control's member read at (package, path, document) through the fold's (package, path, start). Over Rack, under
 * a drawn primary key and key, and up to four drawn equality lookups: each created index's first block, its first
 * columns as many as the narrowest request landed on it binds, holds its lead.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const eachCreatedIndexOfARelationInNoUnitLeadsWithAColumnOfItsOwn = property.explore(
	rackGen,
	{
		needs: {},
		situations: [
			"a lead of many values beside a column of few",
			"a lead no other index leads with",
			"a lead no key holds",
			"a lead a key holds, no other free",
			"every column of the first block leading another index"
		] satisfies ReadonlyArray<Reached<RackFeature>>,
		check: (_, c: Case<RackFeature>) => (rack) =>
			Effect.sync(() => {
				const installation: Installation = succeeded(installRack(rack))
				const racked = Arr.filter(installation.indexes, (x) => x.relation === "Rack")
				const keyed = new Set(
					Arr.flatMap(racked, (x) =>
						x.index.kind === "installed" ? Arr.map(x.keys, keyField) : []
					)
				)
				for (const [at, x] of racked.entries()) {
					if (x.index.kind !== "created" || x.method !== "btree") {
						continue
					}
					const keys = Arr.map(x.keys, keyField)
					const narrowest = Arr.reduce(x.requests, keys.length, (low, r) =>
						Math.min(low, boundColumns(r).length)
					)
					const lead = defined(keys[0])
					const first = Arr.filter(keys.slice(0, narrowest), (k) => k !== rackFew)
					if (first.length < narrowest && first.length > 0) {
						assert.notEqual(
							lead,
							rackFew,
							`Rack(${Arr.join(keys, ", ")}) leads with its column of few values, where ${Arr.join(first, ", ")} of its first block hold many`
						)
						c.note("a lead of many values beside a column of few")
					}
					const before = new Set(Arr.map(racked.slice(0, at), (y) => keyField(defined(y.keys[0]))))
					const free = Arr.filter(first, (k) => !before.has(k))
					if (free.length === 0) {
						c.note("every column of the first block leading another index")
						continue
					}
					assert.ok(
						!before.has(lead),
						`Rack(${Arr.join(keys, ", ")}) leads with ${lead}, which an index before it leads with, where ${Arr.join(free, ", ")} of its first block leads none`
					)
					c.note("a lead no other index leads with")
					if (Arr.some(free, (k) => !keyed.has(k))) {
						assert.ok(
							!keyed.has(lead),
							`Rack(${Arr.join(keys, ", ")}) leads with ${lead}, which a key holds, where ${Arr.join(
								Arr.filter(free, (k) => !keyed.has(k)),
								", "
							)} of its first block leads no index and no key holds it`
						)
						c.note("a lead no key holds")
					} else {
						c.note("a lead a key holds, no other free")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each created index's lead a column of its first block no index before it leads with, and no key holds, wherever one is"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					'\t\t\tmapInput(compareBooleans, (k: IndexKey) => columns.holds(k.column) !== "many"),\n',
				replacement: "",
				why: "A created index may lead with a column of few values, no anchor: a binding of its other columns steps the column's few values to reach it, and a code's equality picks a share of the table."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tmapInput(compareBooleans, (k: IndexKey) => leads.has(text(k))),\n",
				replacement: "",
				why: "A created index may lead with the column another index leads with: two indexes led alike tie at the anchor's rows under statistics no anchor states, and PostgreSQL reads a binding through whichever has fewer pages."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tmapInput(compareBooleans, (k: IndexKey) => keyed.has(text(k))),\n",
				replacement: "",
				why: "A created index may lead with a column a key holds: a key's index stops short of its binding at a set holding that column, priced as the binding is wherever the other columns' statistics state each value its own."
			}
		]
	}
)

/**
 * An index the engine creates for a binding that spans a member's units holds what its requests ask, never a unit field
 * a whole rule's read of the unit appends (physical/indexes/engine.ts spansUnits, confined): its lead is an anchor the
 * declaration pairs with the unit's (physical/statistics/declared.ts spanningLeads), so a read binding the unit and the
 * lead binds more through the unit's own index and is priced below it, where the unit appended would bind as much and
 * tie it (test/pg/contracts/key-reach: M0 keyed (doc, k0, k1), read by k0 alone, created (k0, doc) for its stored
 * derivation's upkeep, which reads (doc, k0)). An index created for no spanning binding, all of whose own keys a unit
 * read binds, is still held to its unit. Over a drawn Part (partGen) beside one or two whole rules' reads of its units,
 * each of doc and one or two of its own fields: each created B-tree whose order answers to a spanning request holds doc
 * only where a request it answers binds doc; each other, all of whose own keys a unit read binds, holds doc. A Part
 * whose keys and indexes cross is refused, the refusal judged as the skip-order property judges it.
 *
 * Oracle: specification, the requests each created index answers to and the unit reads beside them.
 */
export const anIndexCreatedForASpanningBindingIsHeldToNoUnitRead = property.explore(readPartGen, {
	needs: {},
	situations: [
		"an index created for a spanning binding beside a unit read binding its keys",
		"an index a unit read holds to its unit"
	] satisfies ReadonlyArray<Reached<ConfinedFeature>>,
	check: (_, c: Case<ConfinedFeature>) => (sketch) =>
		Effect.sync(() => {
			const installed = installReadPart(sketch)
			if (!installed.ok) {
				judgeCrossing(sketch.part, installed.error)
				return
			}
			const { scopes } = partSpanning(sketch.part)
			const reads = Arr.map(sketch.reads, (fields) => Arr.map(fields, partField))
			for (const x of installed.value.indexes) {
				if (x.relation !== "Part" || x.index.kind !== "created" || x.method !== "btree") {
					continue
				}
				const keys: ReadonlyArray<string> = Arr.map(x.keys, keyField)
				const own = Arr.filter(keys, (k) => k !== "doc")
				const confining = Arr.some(reads, (read) => Arr.every(own, (k) => read.includes(k)))
				const answers = x.index.answers
				if (Arr.some(answers, (r) => spansPart(scopes, r))) {
					if (confining) {
						c.note("an index created for a spanning binding beside a unit read binding its keys")
					}
					assert.equal(
						keys.includes("doc"),
						Arr.some(answers, (r) => boundColumns(r).includes("doc")),
						`Part's index (${Arr.join(keys, ", ")}), created for a binding that spans its units, holds doc only where a request it answers binds doc`
					)
				} else if (confining) {
					c.note("an index a unit read holds to its unit")
					assert.ok(
						keys.includes("doc"),
						`Part's index (${Arr.join(keys, ", ")}), all of whose own keys a unit read binds, is held to its unit`
					)
				}
			}
		}),
	oracle: {
		kind: "specification",
		name: "the requests each created index answers to, and the unit reads beside them"
	},
	kept: [
		{
			token: ReplayToken(
				"test/unit/physical/indexes.test.ts#anIndexCreatedForASpanningBindingIsHeldToNoUnitRead:-:2.0.1.2.2.1.0.1.2.0.1.1.2"
			),
			reason:
				"Part keyed (doc, f0, f2), a key (f2, f3) whose index leads with f3, outside the primary key (physical/ddl/tables.ts candidateOrder), a lookup of f2 alone and a unit read of (doc, f2): f2 is no key's lead, so the lookup spans the units and its index (f2) holds no doc, where the model read the key in its declared order and took f2 for a scope",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/indexes/engine.ts",
			original: "\t\t\t\t\tdrafted.answers.some(spans) ? [] : confining,",
			replacement: "\t\t\t\t\tconfining,",
			why: "An index created for a spanning binding held to the unit reads beside it, as before: the lookup of k0 beside its upkeep's read of (doc, k0) creates (k0, doc), which binds the upkeep's read as wholly as the unit's own index and ties it, a column that spans the units leading a read that binds the unit (key-reach's red)."
		}
	]
})

/**
 * A workload's equality read binding columns of few values alone asks for no index, but where it binds a whole key,
 * whose unique index serves it (physical/indexes/engine.ts planIndexes): the declaration prices it at a share of the
 * table at any size, so PostgreSQL reads it by a scan, and an index of its own would be one no plan reads and every
 * write keeps (test/pg/physical/serving: a key lookup on Shift's standby read by a Seq Scan of half the table beside
 * the B-tree created for it). Over Flagged, keyed by id with booleans flag and gate and a bigint n, and a key over
 * (flag, gate) half the time: an equality read of a drawn use binding flag or gate alone, or both, lands on no index
 * and the engine creates none, but on the key's index where it binds the key; one binding n too lands on an index
 * created for it.
 *
 * Oracle: specification, the indexes the plan holds and the one each request lands on.
 */
export const anEqualityReadOfColumnsOfFewValuesAloneAsksForNoIndex = property.explore(
	flaggedReadGen,
	{
		needs: {},
		situations: [
			"a read of columns of few values alone",
			"a read of a whole key of columns of few values",
			"a read of columns of few values beside one of many"
		] satisfies ReadonlyArray<Reached<FewValuedFeature>>,
		check: (_, c: Case<FewValuedFeature>) => (read) =>
			Effect.sync(() => {
				const { request, installation } = installFlagged(read)
				const indexes = Arr.filter(succeeded(installation).indexes, (x) => x.relation === "Flagged")
				const landed = Arr.filter(indexes, (x) => x.requests.includes(request))
				const created = Arr.filter(indexes, (x) => x.index.kind === "created")
				const fewOnly = !read.bound.includes("n")
				const wholeKey = read.keyed && read.bound.includes("flag") && read.bound.includes("gate")
				if (!fewOnly) {
					c.note("a read of columns of few values beside one of many")
					assert.equal(landed.length, 1, "a read binding n lands on one index")
					return
				}
				if (wholeKey) {
					c.note("a read of a whole key of columns of few values")
					assert.deepEqual(
						Arr.map(landed, (x) => ({ kind: x.index.kind, keys: Arr.map(x.keys, keyField) })),
						[{ kind: "installed", keys: ["flag", "gate"] }],
						"a read binding the key (flag, gate) lands on its unique index"
					)
				} else {
					c.note("a read of columns of few values alone")
					assert.deepEqual(
						landed,
						[],
						`a read binding (${Arr.join(read.bound, ", ")}) alone lands on no index`
					)
				}
				assert.deepEqual(
					Arr.map(created, (x) => Arr.map(x.keys, keyField)),
					[],
					"the engine creates no index for a read of columns of few values alone"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the indexes the plan holds and the one each request lands on"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: '\t\t\t\t\tkeys.every((k) => columns.holds(k.column) === "few") &&',
				replacement:
					'\t\t\t\t\tr.role === "lawMaintenance" &&\n\t\t\t\t\tkeys.every((k) => columns.holds(k.column) === "few") &&',
				why: "A workload's read of booleans alone asks for an index as any read does: the engine creates a B-tree on Shift's standby, which PostgreSQL never reads, a Seq Scan of half the table its plan by the declaration, and which every write keeps."
			}
		]
	}
)
