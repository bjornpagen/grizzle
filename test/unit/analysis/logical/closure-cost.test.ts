/**
 * The work of the logical analysis's closures, counted, each property's own documentation beside its search:
 *
 * - A closure's order and visits (logical/closure.ts closure): a round fires each row as passes over the node's
 *   dependencies in table order would, each column by the passes' row and in their order, and visits a row only once it
 *   can add a column, so a closure that names nothing visits each dependency at most once and tests each whether to
 *   visit it once and again for each determinant reached. Oracle: the passes, run as a second implementation, and
 *   those counts.
 * - A naming closure (logical/closure.ts closure): it names, reaches and fires as the passes' round of namings and then
 *   of every row would, a row asked again once a value it copies is named. Oracle: the passes.
 * - Closures over one table (logical/closure.ts Rows buffers): each runs in the table's one set of buffers and sets back
 *   the rows it touched, so every closure of a sequence over one table, named or not, answers as one over a table of
 *   its own. Oracle: the passes, each on a table of its own.
 * - A closure's visit of a spent row (logical/closure.ts Row targets): decided by its targets' set in a few words, so
 *   over n closed rows of n − 1 targets the target reads grow as n, never n². Oracle: that growth bound.
 * - The factor search's judging closures (logical/closure.ts irredundant, factorClosures): each stops as soon as it
 *   holds the targets it judges, so over m redundant dependencies beside m of no determinant its firings grow as m,
 *   never m². Oracle: that growth bound, and the factors each a_i and b_i alone.
 * - A node's steps' sources (logical/props.ts readingIndex, stepSource) and a source column's class (regionProps):
 *   read off its reading indexed once and the source's classes, so over m bindings and outputs with a step of m
 *   targets each the analysis's calls are affine in m. Oracle: that growth.
 * - A compile's later analysis of a shared sub-DAG (logical/annotate.ts SharedAnalyses): an analysis reading a sub-DAG
 *   an earlier analysis of the compile recorded annotates and walks none of its nodes, so over a shared chain of n
 *   nodes the later query's analysis makes the same calls at every n. Oracle: that count, constant in n.
 * - A DAG reaching a recorded node inside its record both through the record's root and as a root of its own
 *   (logical/annotate.ts SharedAnalyses readers): its readers are counted once, so an attachment there whose child it
 *   alone reads revises the child as an analysis of the DAG alone does, in every order of three DAGs. Oracle: that
 *   analysis.
 * - What an analysis holds (logical/annotate.ts Annotator, logical/props.ts PropsView): over a chain of n projections
 *   under an attachment, an analysis whose caller keeps its root's properties holds, once made, the properties of that
 *   one node and of no other: a node's properties hold its inputs' views, never their properties, its functions read
 *   its own rows alone, and the analysis drops each node's properties once its readers are built. Oracle: the
 *   specification, the functions alive with the analysis held, which its held properties' key functions count, as
 *   many at either length.
 * - A key search's tests (logical/closure.ts minimalKeys): each candidate is tested against the keys found by their
 *   set-trie, so over n columns each alone a key the tests grow as the n² candidates do, never as n³. Oracle: that
 *   growth bound.
 * - Interning (logical/props.ts finish, logical/attributes.ts attributesOver, logical/closure.ts rowsOf): each node's
 *   attributes, and its dependencies over them, are interned once, where its properties are built, however many
 *   closures its own properties and its parents' read off them. Oracle: the specification, one interning a node.
 * - A relation's reading (logical/props.ts leafProps, analysis/physical/rules.ts leafProps): a Base's and a Delta's
 *   logical properties are their relation's reading's, built once for every query of the schema that reads the relation
 *   so, and their physical properties under one catalog likewise, where every Base and every Delta of each query built
 *   both again. Oracle: the specification, one build a reading however many queries read it.
 *
 * The counts are work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts), so
 * neither guard depends on the machine.
 *
 * Features: a closure that adds nothing, one of three passes or more, and a dependency that never fires; a row asked
 * again once a value is named, a value named and a column reached by a row that names nothing; a search from n = 4 and
 * from n = 6; a factor search from m = 4 and from m = 6; one relation and several joined; one query of a reading and several;
 * a shared chain from n = 4 and from n = 6; a child of one column kept beside its correlated one and of two; chains of
 * 40 and 60 analyzed and held, and of 60 and 90.
 */

import { queryObjects } from "node:v8"
import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { analyzePhysical, type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ValidDag } from "#compiler/ir/rel.ts"
import {
	analyzeLogical,
	checkerEvidence,
	everyNode,
	keptNodes,
	SharedAnalyses
} from "#compiler/logical/annotate.ts"
import {
	attributesOver,
	type Bits,
	bitsAt,
	bitsOf,
	isEmpty,
	namesOf
} from "#compiler/logical/attributes.ts"
import {
	closure,
	independentFactors,
	minimalKeys,
	namesNothing,
	rowsOf
} from "#compiler/logical/closure.ts"
import { fixedColumns } from "#compiler/logical/props.ts"
import { succeeded } from "#test/support/assert.ts"
import { affine, incrementsAtMostDouble, incrementsDoNotGrow } from "#test/support/growth.ts"
import { callCounts, everyCallCount as callCountsIn } from "#test/support/kernel/calls.ts"
import {
	type ClosureFeature,
	closedMask,
	closedTable,
	columnsIn,
	columnsOf,
	type CyclePoint,
	factorSites,
	type FactorPoint,
	indexedReading,
	dependenciesOf,
	type InterningFeature,
	interning,
	keySearchSites,
	namedStartGen,
	namingOf,
	type NamingFeature,
	passClosure,
	type ReadingFeature,
	type ReadingPoint,
	readingQuery,
	readings,
	type SharedFeature,
	sharedStartsGen,
	targetSites,
	redundantTable,
	insideRecord,
	type SharedPoint,
	sharedChain,
	taskReading,
	sizeOfMask,
	startedGen,
	visitSites
} from "#test/unit/analysis/logical/closure-cost.fixtures.ts"
import { productOf } from "#test/unit/analysis/logical/join-cost.fixtures.ts"

/**
 * A closure fires each row as passes over the table in table order would, and visits each at most once: each column by
 * the passes' row, in the passes' order, a row visited once its determinants are reached, never in a pass that cannot
 * fire it.
 */
export const aClosureFiresEachRowAsPassesInTableOrderWouldVisitingEachAtMostOnce = property.explore(
	startedGen,
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a closure that adds nothing",
			"a closure of three passes or more",
			"a dependency that never fires"
		] satisfies ReadonlyArray<Reached<ClosureFeature>>,
		check:
			(_, c: Case<ClosureFeature>) =>
			({ table, start }) =>
				Effect.gen(function* () {
					const attributes = attributesOver(columnsOf(table), [])
					const rows = rowsOf(attributes, dependenciesOf(table))
					const [reached, counts] = yield* callCounts(
						Effect.sync(() =>
							closure(rows, bitsOf(attributes, columnsIn(table, start)), namesNothing)
						),
						visitSites
					)
					const passes = passClosure(table, start, undefined)
					assert.deepEqual<ReadonlyArray<number>>(
						reached.sequence,
						passes.sequence,
						"the columns, in the passes' order"
					)
					assert.deepEqual<ReadonlyArray<number>>(
						[...reached.by],
						passes.by,
						"each column by the passes' row"
					)
					assert.deepEqual(reached.fired, passes.fired, "the rows that fired, in the passes' order")
					const dependencies = table.dependencies.length
					const determinants = Arr.reduce(table.dependencies, 0, (n, d) => n + sizeOfMask(d.from))
					assert.ok(
						counts.step <= dependencies,
						`${counts.step} visits of ${dependencies} dependencies`
					)
					assert.ok(
						counts.visits <= dependencies + determinants,
						`${counts.visits} tests of ${dependencies} dependencies of ${determinants} determinants`
					)
					const known = closedMask(table, start)
					if ((known & ~start) === 0) {
						c.note("a closure that adds nothing")
					}
					if (Arr.some(passes.passes, (n) => n >= 3)) {
						c.note("a closure of three passes or more")
					}
					if (Arr.some(table.dependencies, (d) => (d.from & ~known) !== 0)) {
						c.note("a dependency that never fires")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "passes over the dependencies in table order until one adds nothing, and one visit a row, one test a row and a determinant"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original:
					'\t\tfor (let i = due.next(); i !== undefined; i = due.next()) {\n\t\t\tthis.step(defined(table[i], "a due row is its closure\'s"), i, admission)\n\t\t}\n',
				replacement:
					'\t\tfor (let changed = true; changed; ) {\n\t\t\tchanged = false\n\t\t\tfor (let i = 0; i < table.length; i++) {\n\t\t\t\tif (this.visits(i, admission)) {\n\t\t\t\t\tthis.step(defined(table[i], "a due row is its closure\'s"), i, admission)\n\t\t\t\t\tchanged = true\n\t\t\t\t}\n\t\t\t}\n\t\t}\n',
				why: "A round passes over every row until a pass adds nothing, testing each in each pass (logical/closure.ts closure); the visits property fails."
			},
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\tconst into = i > this.#at ? this.#now : this.#later",
				replacement: "\t\tconst into = this.#now",
				why: "A row due before the passes' row is visited in this pass, out of the passes' order (logical/closure.ts PassQueue); the order property fails."
			}
		]
	}
)

/**
 * A closure that names values names and fires as passes in table order would: each row asked at its turn once its
 * determinants are reached, and asked again once a value is named, so every value, each column's row and the order are
 * the passes'.
 */
export const aNamingClosureNamesAndFiresAsPassesInTableOrderWould = property.explore(
	namedStartGen,
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a row asked again once a value is named",
			"a value named",
			"a column reached by a row that names nothing"
		] satisfies ReadonlyArray<Reached<NamingFeature>>,
		check:
			(_, c: Case<NamingFeature>) =>
			({ table, start, sources }) =>
				Effect.sync(() => {
					const attributes = attributesOver(columnsOf(table), [])
					const rows = rowsOf(attributes, dependenciesOf(table))
					const reached = closure(
						rows,
						bitsOf(attributes, columnsIn(table, start)),
						namingOf(rows, sources)
					)
					const passes = passClosure(table, start, sources)
					assert.deepEqual<ReadonlyArray<number>>(
						reached.sequence,
						passes.sequence,
						"the columns, in the passes' order"
					)
					assert.deepEqual<ReadonlyArray<number>>(
						[...reached.by],
						passes.by,
						"each column by the passes' row"
					)
					assert.deepEqual(reached.fired, passes.fired, "the rows that fired, in the passes' order")
					assert.deepEqual(
						Arr.sort(
							[...reached.named],
							Order.mapInput(Order.Number, ([p]: readonly [number, number]) => p)
						),
						Arr.sort(
							[...passes.named],
							Order.mapInput(Order.Number, ([p]: readonly [number, number]) => p)
						),
						"every value the passes name"
					)
					if (passes.askedAgain) {
						c.note("a row asked again once a value is named")
					}
					if (passes.named.size > 0) {
						c.note("a value named")
					}
					if (Arr.some(passes.sequence, (p) => !passes.named.has(p) && (start & (1 << p)) === 0)) {
						c.note("a column reached by a row that names nothing")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "a round of namings and a round of every row, each passing over the dependencies in table order until a pass adds nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\t\t\t\tmarks[j] = (marks[j] ?? 0) & ~askedMark",
				replacement: "\t\t\t\t\tmarks[j] = marks[j] ?? 0",
				why: "A row asked before a value it copies was named is never asked again (logical/closure.ts closure); the naming property fails."
			}
		]
	}
)

/**
 * Every closure over one table answers as a closure of a table of its own: the table keeps one set of buffers for its
 * closures (logical/closure.ts Rows buffers), each closure setting back the rows it touched when it ends, so over a
 * table closed from several starts in turn, each with its naming or with none, every closure's columns, rows, order and
 * values are the passes'.
 */
export const everyClosureOverOneTableAnswersAsAClosureOfATableOfItsOwn = property.explore(
	sharedStartsGen,
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a named closure after an unnamed one",
			"a closure after one that reached every column",
			"a closure that fires a row the one before it spent"
		] satisfies ReadonlyArray<Reached<SharedFeature>>,
		check:
			(_, c: Case<SharedFeature>) =>
			({ table, sources, starts }) =>
				Effect.sync(() => {
					const attributes = attributesOver(columnsOf(table), [])
					const rows = rowsOf(attributes, dependenciesOf(table))
					const naming = namingOf(rows, sources)
					const every = 2 ** table.width - 1
					let before:
						| {
								readonly named: boolean
								readonly known: number
								readonly fired: ReadonlyArray<number>
						  }
						| undefined
					for (const [i, { start, named }] of starts.entries()) {
						const reached = closure(
							rows,
							bitsOf(attributes, columnsIn(table, start)),
							named ? naming : namesNothing
						)
						const passes = passClosure(table, start, named ? sources : undefined)
						const at = `closure ${i} over the table, from ${start}${named ? ", named" : ""}`
						assert.deepEqual<ReadonlyArray<number>>(
							reached.sequence,
							passes.sequence,
							`${at}: the columns`
						)
						assert.deepEqual<ReadonlyArray<number>>(
							[...reached.by],
							passes.by,
							`${at}: each column's row`
						)
						assert.deepEqual(reached.fired, passes.fired, `${at}: the rows that fired`)
						assert.deepEqual(
							Arr.sort(
								[...reached.named],
								Order.mapInput(Order.Number, ([p]: readonly [number, number]) => p)
							),
							Arr.sort(
								[...passes.named],
								Order.mapInput(Order.Number, ([p]: readonly [number, number]) => p)
							),
							`${at}: the values named`
						)
						if (before !== undefined) {
							if (named && !before.named) {
								c.note("a named closure after an unnamed one")
							}
							if (before.known === every) {
								c.note("a closure after one that reached every column")
							}
							if (Arr.some(reached.fired, (r) => before?.fired.includes(r) === true)) {
								c.note("a closure that fires a row the one before it spent")
							}
						}
						before = { named, known: closedMask(table, start), fired: reached.fired }
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "passes over the dependencies in table order, each closure on a table of its own"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\t\tthis.#missing[i] = determinants[i] ?? 0\n",
				replacement: "",
				why: "A closure leaves its table's counts as it ran them down (logical/closure.ts Closing release): the next closure over the table fires a row before its determinants are reached; the shared-table property fails."
			},
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\t\tthis.#marks[i] = 0\n",
				replacement: "",
				why: "A closure leaves its table's marks (logical/closure.ts Closing release): the next closure over the table never visits a row the last one spent; the shared-table property fails."
			}
		]
	}
)

/**
 * A closure's visit decides in a few words that a row has no target left to reach: each row holds its targets as a set
 * (logical/closure.ts Row targets), so over n closed rows of n − 1 targets each, every column alone determining every
 * other, the closure from one column reads each target it adds and none of a row it visits spent, and its reads grow
 * no faster than n, where reading every target of every visited row grew as n².
 */
export const aClosureVisitDecidesARowWithNothingLeftToReachInAFewWordsReadsLinearInTheTable =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from n = 4", "from n = 6"] satisfies ReadonlyArray<Reached<CyclePoint>>,
		check: (_, c: Case<CyclePoint>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 2 ? "from n = 4" : "from n = 6")
				const counted = new Map<number, number>()
				for (const n of [2 * half, 4 * half, 6 * half]) {
					const table = closedTable(n)
					const rows = rowsOf(table.attributes, table.dependencies)
					const [reached, counts] = yield* callCounts(
						Effect.sync(() => closure(rows, table.start, namesNothing)),
						targetSites
					)
					assert.deepEqual(
						namesOf(table.attributes, reached.reached),
						Arr.map(indices(n), (i) => `c${i}`),
						"every column"
					)
					assert.deepEqual(reached.fired, [0], "by the first row alone")
					counted.set(n, counts.holdsAt)
				}
				incrementsDoNotGrow(
					(n) => defined(counted.get(n), `the target reads at n = ${n}`),
					half,
					"a closure's reads of its rows' targets"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "n closed rows at 2h, 4h and 6h, h at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\tif (subsetOf(row.targets, reached)) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A visit reads every target of a row it finds spent (logical/closure.ts Closing step), as it did before rows held their targets as a set; the reads grow as n²."
			},
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\tif (subsetOf(row.targets, reached)) {\n",
				replacement: "\t\tif (subsetOf(row.from, reached)) {\n",
				why: "A visit finds spent a row that still has a target to reach, the shortcut citing its determinants for its targets (logical/closure.ts Closing step): the closure reaches no column past its start; this property and the order, naming and shared-table properties fail."
			}
		]
	})

/**
 * A key search tests each candidate against the keys it found by their set-trie, never one by one: over n columns each
 * alone a key, every one determining the next round a cycle, the search tests n candidates for each of the n keys, and
 * its tests grow no faster than those candidates, quadratically in n, where a scan of the keys found for each grew
 * cubically.
 */
export const aKeySearchTestsACandidateAgainstTheKeysFoundByTheirTrieNeverOneByOne =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from n = 4", "from n = 6"] satisfies ReadonlyArray<Reached<CyclePoint>>,
		check: (_, c: Case<CyclePoint>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 2 ? "from n = 4" : "from n = 6")
				const counted = new Map<number, number>()
				for (const n of [2 * half, 4 * half, 6 * half]) {
					const columns = Arr.map(indices(n), (i) => `c${i}`)
					const attributes = attributesOver(columns, [])
					/** Each column determines the next, the last the first: every column alone determines all. */
					const isKey = (cs: Bits): boolean => !isEmpty(cs)
					const [keys, counts] = yield* callCounts(
						Effect.sync(() =>
							minimalKeys(
								attributes.heading,
								[attributes.heading],
								(cs) => (isKey(cs) ? true : undefined),
								Arr.map(indices(n), (i) => ({
									from: bitsAt(attributes, [i]),
									to: bitsAt(attributes, [(i + 1) % n])
								}))
							)
						),
						keySearchSites
					)
					assert.deepEqual(
						Arr.map(keys, (k) => namesOf(attributes, k.key)),
						Arr.map(columns, (column) => [column]),
						"every column alone, in heading order"
					)
					counted.set(n, counts.subsetOf + counts.keyWithin)
				}
				incrementsAtMostDouble(
					(n) => defined(counted.get(n), `the tests at n = ${n}`),
					2 * half,
					"a key search's tests of its candidates"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than quadratically increments by at most twice as much over its second equal step"
		},
		box: "n columns at 2h, 4h and 6h, h at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original:
					"\tconst contains = (set: Bits) => keyWithin(index, positions(set), 0, sizeOf(set) + 1, 0)",
				replacement: "\tconst contains = (set: Bits) => found.some((k) => subsetOf(k.key, set))",
				why: "Each candidate tested against every key found (logical/closure.ts minimalKeys); the tests property fails."
			}
		]
	})

/**
 * The factor search judges a dependency of several determinants by a closure that stops as soon as it holds the targets
 * it judges, and fires the dependencies of no determinant only where its start alone does not reach them: over m
 * dependencies {a_i, b_i} → c_i each made redundant by a_i → c_i, beside m dependencies of no determinant, its firings
 * grow no faster than m, where every judging closure fired every dependency of no determinant, m² of them.
 */
export const theFactorSearchJudgesADependencyByAClosureThatStopsAtItsTargetsFiringsLinearInTheTable =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from m = 4", "from m = 6"] satisfies ReadonlyArray<Reached<FactorPoint>>,
		check: (_, c: Case<FactorPoint>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 2 ? "from m = 4" : "from m = 6")
				const counted = new Map<number, number>()
				for (const m of [2 * half, 4 * half, 6 * half]) {
					const table = redundantTable(m)
					const [factors, counts] = yield* callCounts(
						Effect.sync(() => independentFactors(table.columns, table.stated).factors),
						factorSites
					)
					assert.deepEqual(
						Arr.map(factors, (f) => namesOf(table.attributes, f)),
						table.factors,
						"each a_i and b_i alone, in heading order"
					)
					counted.set(m, counts.fire)
				}
				incrementsDoNotGrow(
					(m) => defined(counted.get(m), `the firings at m = ${m}`),
					half,
					"the factor search's firings"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "m redundant dependencies at 2h, 4h and 6h, h at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original: "\t\t\t\tif (done()) {\n\t\t\t\t\treturn\n\t\t\t\t}\n\t\t\t\tfire(row)",
				replacement: "\t\t\t\tfire(row)",
				why: "Every judging closure fires every dependency of no determinant, as each closure of the search did (logical/closure.ts factorClosures); the firings grow as m²."
			}
		]
	})

/**
 * A node's steps read what they fix off its reading indexed once (logical/props.ts readingIndex, stepSource): a
 * projection's outputs by name and a region's bindings by variable, each target of each step one lookup, and a region
 * finds a source column's class in the source's classes: so over projections of m outputs and a region of m bindings
 * between them, each with a step of m targets, the analysis's calls are affine in m, where each target scanned the
 * outputs or bindings and each column the source's heading, m² of them.
 */
export const aNodesStepsReadTheirSourcesOffItsReadingIndexedOnceAffineInItsColumns =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from m = 8", "from m = 12"] satisfies ReadonlyArray<Reached<ReadingPoint>>,
		check: (_, c: Case<ReadingPoint>) => (step) =>
			Effect.gen(function* () {
				c.note(step === 2 ? "from m = 8" : "from m = 12")
				const counted = new Map<number, number>()
				for (const m of [4 * step, 8 * step, 12 * step]) {
					analyzedOnce(indexedReading(m))
					const [analysis, counts] = yield* callCountsIn(
						Effect.sync(() => {
							const dag = indexedReading(m)
							return { dag, analyzed: succeeded(analyzeLogical(dag, checkerEvidence, everyNode)) }
						}),
						Str.endsWith("logical/props.ts")
					)
					const root = defined(analysis.dag.roots[0], "the projection")
					assert.equal(
						defined(analysis.analyzed.props.get(root), "the projection's properties, kept").columns
							.length,
						m,
						"the projection's m outputs"
					)
					counted.set(
						m,
						Arr.reduce([...counts.values()], 0, (n, k) => n + k)
					)
				}
				affine(
					(m) => defined(counted.get(m), `the calls at m = ${m}`),
					4 * step,
					"the analysis's calls in props.ts"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a size made of a fixed part and a part per column increments alike over two equal steps"
		},
		box: "m columns at 4s, 8s and 12s, s at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tconst out = index.outputs.get(column)",
				replacement: "\t\t\tconst out = index.node.out.find((o) => o.name === column)",
				why: "Each target of a projection's step scans its outputs (logical/props.ts stepSource); the calls grow as m²."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tconst binding = occurrence.bindings.get(column)",
				replacement:
					"\t\t\tconst binding = occurrence.occurrence.bindings.find((b) => b.var.name === column)",
				why: "Each target of a region's step scans its occurrence's bindings (logical/props.ts stepSource); the calls grow as m²."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "(src.classes.get(c) ?? []).find((m) => varsAt.has(m))",
				replacement:
					"src.columns.filter((m) => rootIn(src.forest, m) === rootIn(src.forest, c)).find((m) => varsAt.has(m))",
				why: "A region finds a source column's class by scanning the source's heading for each column it gives (logical/props.ts regionProps givenBy); the calls grow as m²."
			}
		]
	})

/** Each node's attributes and dependencies are interned once, however many closures read them. */
export const eachNodesAttributesAndDependenciesAreInternedOnceHoweverManyClosuresReadThem =
	property.exhaust(finite(int(1, 6)), {
		needs: {},
		situations: ["one relation", "several relations"] satisfies ReadonlyArray<
			Reached<InterningFeature>
		>,
		check: (_, c: Case<InterningFeature>) => (k) =>
			Effect.gen(function* () {
				c.note(k === 1 ? "one relation" : "several relations")
				const [, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(analyzeLogical(productOf(k, "both keys"), checkerEvidence, everyNode))
					),
					interning
				)
				assert.equal(
					counts.finish,
					k + 1,
					"a node's properties each of the k relations and the region"
				)
				assert.equal(counts.attributesOver, counts.finish, "one interning of a node's attributes")
				assert.equal(counts.rowsOf, counts.finish, "one interning of a node's dependencies")
				assert.ok(
					counts.closure > counts.finish,
					`${counts.closure} closures over ${counts.finish} nodes`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one interning of a node's attributes and dependencies, counted by V8's precise coverage"
		},
		box: "k relations from one to six",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					'const coverOf = (props: Pick<Table, "stated">, start: Bits): Closure<never> =>\n\tclosure<never>(props.stated, start, namesNothing)',
				replacement:
					'const coverOf = (props: Pick<Table, "stated">, start: Bits): Closure<never> =>\n\tclosure<never>(\n\t\trowsOf(\n\t\t\tattributesOver(props.columns, props.stated.attributes.hidden),\n\t\t\tprops.stated.rows.map((row) => row.dependency)\n\t\t),\n\t\tstart,\n\t\tnamesNothing\n\t)',
				why: "Each closure interns its node's attributes and dependencies again, sets built per closure (logical/props.ts coverOf); the interning property fails."
			}
		]
	})

/**
 * A relation's reading is analyzed once however many queries read it: n queries of one schema, each its own DAG, each
 * a Base and a Delta over one relation, build the Base's and the Delta's logical properties once each, and each query's
 * own join of them once; and their physical properties under the schema's catalog once each.
 */
export const aRelationsReadingIsAnalyzedOnceHoweverManyQueriesReadIt = property.exhaust(
	finite(int(1, 6)),
	{
		needs: {},
		situations: ["one query of a reading", "several queries of a reading"] satisfies ReadonlyArray<
			Reached<ReadingFeature>
		>,
		check: (_, c: Case<ReadingFeature>) => (n) =>
			Effect.gen(function* () {
				c.note(n === 1 ? "one query of a reading" : "several queries of a reading")
				const reading = taskReading()
				/** The schema's catalog, an object of this case's own, so no other case's analysis shares its readings. */
				const env: PhysicalEnv = {
					context: "snapshot",
					catalog: { ...reading.model.fixture.catalog },
					realization: unplaced,
					roots: "result"
				}
				const [, counts] = yield* callCounts(
					Effect.sync(() => {
						for (const _ of indices(n)) {
							analyzePhysical(
								succeeded(analyzeLogical(readingQuery(reading), checkerEvidence, everyNode)).dag,
								env
							)
						}
					}),
					readings
				)
				assert.equal(
					counts.finish,
					2 + n,
					"the Base's and the Delta's logical properties once, and each query's semi-join's"
				)
				assert.deepEqual(
					{ baseProps: counts.baseProps, deltaProps: counts.deltaProps },
					{ baseProps: 1, deltaProps: 1 },
					"the Base's and the Delta's physical properties once"
				)
			}),
		oracle: {
			kind: "specification",
			name: "one build of a relation's reading however many queries read it, counted by V8's precise coverage"
		},
		box: "n queries from one to six",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\tconst known = byText.get(text)\n",
				replacement: "\tconst known: Props | undefined = undefined\n",
				why: "Every Base and every Delta builds its reading's properties again (logical/props.ts leafProps), as every node of every query did; the reading property fails."
			},
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original: "\t\t\tconst known = byText.get(reading.text)\n",
				replacement: "\t\t\tconst known: PhysicalProps | undefined = undefined\n",
				why: "Every Base and every Delta builds its reading's physical properties again (analysis/physical/rules.ts leafProps); the reading property fails."
			}
		]
	}
)

/**
 * The modules a walk over a DAG's nodes runs in: its folds (ir/fold.ts), its edges (ir/rel.ts inputsOf) and its
 * traversals and scopes (ir/dag.ts). A key proof's grounding walks its derivation, not the DAG (ir/keys.ts
 * groundImplication), so an attachment's proof over a chain of n projections grounds n steps of it however the nodes
 * are analyzed.
 */
const walks = ["engine/src/ir/fold.ts", "engine/src/ir/rel.ts", "engine/src/ir/dag.ts"] as const

/**
 * A compile's later analysis of a sub-DAG it shares reads its record: over two queries reading one shared chain of n
 * nodes, the second query's analysis, under the compile's shared analyses after the first recorded the chain, makes the
 * same calls in logical/** and in the modules a walk over nodes runs in at n, 2n and 3n, so it annotates none of the
 * chain's nodes, walks none to count their readers and folds no scope of theirs, where it annotated and walked every
 * one of them again.
 */
export const aCompilesLaterAnalysisOfASharedSubDagReadsItsRecordAndWalksNoneOfItsNodes =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from n = 4", "from n = 6"] satisfies ReadonlyArray<Reached<SharedPoint>>,
		check: (_, c: Case<SharedPoint>) => (step) =>
			Effect.gen(function* () {
				c.note(step === 2 ? "from n = 4" : "from n = 6")
				const counted = new Map<number, number>()
				for (const n of [2 * step, 4 * step, 6 * step]) {
					const { shared, inner, queries } = sharedChain(n)
					const analyses = new SharedAnalyses(checkerEvidence, (node) => node === shared)
					const first = succeeded(
						analyzeLogical(queries[0], analyses, keptNodes(queries[0].roots)),
						"the first query's analysis"
					)
					const [analysis, counts] = yield* callCountsIn(
						Effect.sync(() =>
							succeeded(
								analyzeLogical(queries[1], analyses, keptNodes(queries[1].roots)),
								"the second query's"
							)
						),
						(file) =>
							Str.includes("engine/src/logical/")(file) ||
							Arr.some(walks, (module) => Str.endsWith(module)(file))
					)
					assert.equal(
						analysis.of(inner).node,
						first.of(inner).node,
						"the second query reads the chain's annotation the first recorded"
					)
					counted.set(
						n,
						Arr.reduce([...counts.values()], 0, (m, k) => m + k)
					)
				}
				const at = (n: number): number => defined(counted.get(n), `the calls at n = ${n}`)
				assert.equal(at(4 * step), at(2 * step), "the second query's calls at 2n as at n")
				assert.equal(at(6 * step), at(2 * step), "the second query's calls at 3n as at n")
			}),
		oracle: {
			kind: "universal",
			name: "a later analysis's calls, constant in the shared sub-DAG's size"
		},
		box: "a chain of n nodes at 2s, 4s and 6s, s at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original:
					"\t\t\tenv instanceof SharedAnalyses ? env : new SharedAnalyses(env, () => false)",
				replacement:
					"\t\t\tnew SharedAnalyses(env instanceof SharedAnalyses ? env.env : env, () => false)",
				why: "Every analysis annotates every node again (logical/annotate.ts analyzeLogical), the compile's records unread; the second query's calls grow with n."
			},
			{
				file: "packages/engine/src/logical/annotate.ts",
				original: "\t\tif (entry?.record.root === node) {",
				replacement: "\t\tif (entry?.record.root === node && pending.length < 0) {",
				why: "The readers' walk goes through a recorded root (logical/annotate.ts SharedAnalyses readers), counting the chain node by node; the second query's calls grow with n."
			},
			{
				file: "packages/engine/src/logical/annotate.ts",
				original: "\t\tconst scopes = scopesOver((node) => entryOf(shared.state, node)?.scope)",
				replacement: "\t\tconst scopes = scopesOver(() => undefined)",
				why: "The scope fold folds the chain again (logical/annotate.ts run), reading no recorded scope; the second query's calls grow with n."
			}
		]
	})

export type InsideFeature = "a child of one column besides its correlated one" | "a child of two"

/**
 * A DAG reaching a recorded node inside its record both through the record's root and as a root of its own counts its
 * readers once: over a shared node S above a correlated attachment A whose child only A reads, three DAGs analyzed in
 * each of three orders by one SharedAnalyses sharing S, the one rooted at A and S among them, each analysis fixes every
 * node's columns as an analysis of its DAG alone does, so A revises its child there relative to itself.
 */
export const aDagReachingARecordedNodeInsideItsRecordCountsItsReadersOnce = property.exhaust(
	finite(int(2, 3)),
	{
		needs: {},
		situations: [
			"a child of one column besides its correlated one",
			"a child of two"
		] satisfies ReadonlyArray<Reached<InsideFeature>>,
		check: (_, c: Case<InsideFeature>) => (width) =>
			Effect.sync(() => {
				c.note(width === 2 ? "a child of one column besides its correlated one" : "a child of two")
				const { shared, dags } = insideRecord(width)
				for (const sequence of [
					[0, 1, 2, 0],
					[1, 0, 2, 1],
					[2, 0, 1, 2]
				] as const) {
					const analyses = new SharedAnalyses(checkerEvidence, (node) => node === shared)
					for (const at of sequence) {
						const dag = dags[at]
						/** Every node kept: a node's properties read where the DAG judges its record's attachments. */
						const kept = keptNodes(topoOrder(dag))
						const reading = succeeded(analyzeLogical(dag, analyses, kept), "a shared analysis")
						const alone = succeeded(
							analyzeLogical(dag, checkerEvidence, kept),
							"the DAG's analysis alone"
						)
						for (const node of topoOrder(dag)) {
							assert.deepEqual(
								fixedColumns(defined(reading.props.get(node), "the node's properties, kept")),
								fixedColumns(defined(alone.props.get(node), "the node's properties, kept")),
								`${node.id} (${node.kind}) in DAG ${at} of ${Arr.join(
									Arr.map(sequence, (i) => `${i}`),
									""
								)}`
							)
						}
					}
				}
			}),
		oracle: { kind: "second-implementation", name: "an analysis of each DAG alone" },
		box: "a child keeping its correlated column and one or two more, the three DAGs in three orders",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original: "\t\t\t\twalked.set(input, (walked.get(input) ?? 0) - 1)",
				replacement: "\t\t\t\twalked.set(input, walked.get(input) ?? 0)",
				why: "A recorded node inside a record, reached by the walk, is counted again where its record counts it (logical/annotate.ts SharedAnalyses readers), so the attachment's child has two readers and stays unrevised; the property fails."
			}
		]
	}
)

export type HeldFeature = "chains of 40 and 60" | "chains of 60 and 90"

/**
 * The functions alive, counted by V8 after a full collection (node:v8 queryObjects): a node's logical properties hold
 * their key functions (logical/props.ts Props prove, whole) and the closures those read, so the functions an analysis
 * holds grow with the properties it holds.
 */
const functionsAlive = (): number => queryObjects(Function, { format: "count" })

/**
 * A first analysis of `dag`, uncounted, made in a frame of its own before a count of its twin: it reads its relation's
 * reading every later analysis shares (logical/props.ts leafProps), and it runs every function the count reads, which V8
 * counts the calls of only once the function has its feedback, which a warm worker's earlier properties may have left
 * it without (kernel/calls.ts); an interpreted frame holds a value it no longer reads until it returns, so one made in
 * the caller's frame would stay alive beside the analysis the caller counts.
 */
const analyzedOnce = (dag: ValidDag): void => {
	succeeded(analyzeLogical(dag, checkerEvidence, keptNodes(dag.roots)), "a first analysis")
}

/**
 * An analysis holds the properties of the nodes its caller keeps and of no other: over chains of n and 3n/2
 * projections under an attachment, each analyzed with its root's properties kept after a first analysis has read the
 * chain's relation (whose reading every later analysis shares, logical/props.ts leafProps), the functions alive with
 * the analysis held beside those alive before it are as many at either length, so it holds nothing per node of the
 * chain but its annotated node, where it held every node's properties: through the fold's memo of every node's
 * annotation, through each node's reading of its inputs' properties, or through its key functions' scope, which read
 * the node's steps over that reading.
 */
export const anAnalysisHoldsThePropertiesOfTheNodesItsCallerKeepsAndOfNoOther = property.exhaust(
	finite(int(2, 3)),
	{
		needs: {},
		situations: ["chains of 40 and 60", "chains of 60 and 90"] satisfies ReadonlyArray<
			Reached<HeldFeature>
		>,
		check: (_, c: Case<HeldFeature>) => (step) =>
			Effect.sync(() => {
				c.note(step === 2 ? "chains of 40 and 60" : "chains of 60 and 90")
				const heldAt = (n: number): number => {
					const dag = sharedChain(n).queries[0]
					analyzedOnce(dag)
					const before = functionsAlive()
					const held = succeeded(
						analyzeLogical(dag, checkerEvidence, keptNodes(dag.roots)),
						"the analysis held"
					)
					const alive = functionsAlive() - before
					assert.equal(held.props.size, 1, "the root's properties, kept")
					return alive
				}
				assert.equal(
					heldAt(30 * step),
					heldAt(20 * step),
					`the functions an analysis holds of a chain of ${30 * step} as of ${20 * step}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "an analysis holds the properties its caller keeps, counted live"
		},
		box: "chains of 20s and 30s projections under an attachment, s at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original:
					"\t\treturn { node: annotation.node, judged: annotation.judged, restated: annotation.restated }",
				replacement: "\t\treturn annotation",
				why: "The fold's memo holds each node's annotation with its properties (logical/annotate.ts run), so the analysis holds every node's for as long as it lives."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\tview: { node, reading: subject.views, provenance, fixed },",
				replacement:
					"\t\tview: { node, reading: subject.views, provenance, fixed },\n\t\treading: subject.reading,",
				why: "A node's properties hold its reading, its inputs' properties (logical/props.ts finish), so the root's hold every node's."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\tconst reached = coverOf({ stated }, key)",
				replacement: "\t\tconst reached = coverOf(steps, key)",
				why: "A node's key functions close over its steps (logical/props.ts finish), whose reading holds its inputs' properties, so the root's hold every node's."
			}
		]
	}
)
