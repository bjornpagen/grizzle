/**
 * The bench harness's pure parts, each against an oracle:
 *
 * - EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) output, with WAL and SERIALIZE as captured, is read
 *   back exactly as generated (captures.ts prints a generated capture as PostgreSQL prints one, keys no reader reads
 *   among them): every node's figures, conditions, buffers and WAL, the triggers by call count, serialization, the
 *   changed settings and the plan tree alone. Rows read count each stored scan's rows over its loops, a Bitmap Index
 *   Scan's and a re-reading scan's never; rows generated count the generating scans'; a statement's totals are its
 *   root's counters, never a sum over the tree. The roles a plan's nodes were generated in decide the oracle's counts,
 *   never the fields the readers branch on.
 * - Output PostgreSQL never prints, a fault planted in a generated capture, is refused as MalformedPlan, by the tree's
 *   reader too where the fault is in what it reads.
 * - The harness's caller-side retry retries exactly what grizzle classifies as a TransientFailure, up to its policy:
 *   a model of the documented classification judges generated scripts of attempts.
 * - Rows are read once as text cells; two row lists agree, and digest alike, exactly as a model of multisets says.
 * - A verdict fails exactly on its failing checks; a record names exactly the gaps planted in it; a run's record keeps
 *   its cases when only the release fails.
 * - Every gate of the catalog has exactly one bench file, in its owner's directory: an audit of the real tree.
 * - The command line of `pnpm bench` reads exactly what a model of its grammar reads, and refuses the rest.
 *
 * Each property states its oracle and requires the situations its oracle tells apart.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Option, Order, Path, Record as Rec, Result } from "effect"
import {
	benchIdentity,
	readPin,
	repoRoot,
	runIdentity,
	sourceIdentity
} from "#bench/cold/identity.ts"
import { parseBenchArgs } from "#bench/harness/cli.ts"
import {
	indexAccesses,
	MalformedPlan,
	nodeTypeCounts,
	parsePlan,
	parsePlanTree,
	relationsRead,
	rowsGenerated,
	rowsRead,
	statementTotals
} from "#bench/harness/explain.ts"
import { gateFindings, type RecordProblem, recordProblems, verdictOf } from "#bench/harness/gate.ts"
import { gateOwner, ownerDirectories } from "#bench/harness/rules.ts"
import { discoverGates, recordOf } from "#bench/harness/runner.ts"
import {
	MalformedRows,
	resultSet,
	rowsAgree,
	type TextRow,
	textRows
} from "#bench/harness/variant.ts"
import { assert, assertVariant, nonEmpty } from "#test/support/assert.ts"
import {
	captureGen,
	estimatedOf,
	explainedOf,
	planFaults,
	plantedFault,
	printedCapture,
	type PlanFault,
	type Role,
	sketchNodes,
	treeFaults
} from "#test/unit/bench/captures.ts"
import { catalogIds } from "#test/unit/bench/harness.dictionary.ts"
import {
	type CaptureFeature,
	Failure,
	type Read,
	type RecordFeature,
	type RetryFeature,
	type RowsFeature,
	argWords,
	checkGen,
	deliveredGen,
	distinctOf,
	faultCases,
	gate,
	input,
	modelOf,
	pinnedServer,
	plantedGaps,
	ranOf,
	readArgs,
	reasonOf,
	recordGen,
	recordOfSketch,
	result,
	retriedCases,
	rowPairGen,
	sameMultiset
} from "#test/unit/bench/harness.fixtures.ts"

/** EXPLAIN capture reads every generated capture back exactly, counts rows by the roles its nodes play, and keeps a statement's totals at its root. */
export const eXPLAINCaptureReadsEveryGeneratedCaptureBackExactlyCountsRowsByTheRolesItsNodesPlayAndKeepsAStatementsTotalsAtItsRoot =
	property.explore(captureGen, {
		needs: {},
		situations: [
			"a stored scan",
			"a bitmap index scan",
			"a re-read",
			"a generating",
			"a modify",
			"a inner",
			"WAL captured",
			"WAL not captured",
			"serialized",
			"a trigger"
		] satisfies ReadonlyArray<Reached<CaptureFeature>>,
		check: (_, c: Case<CaptureFeature>) => (capture) =>
			Effect.sync(() => {
				const printed = printedCapture(capture)
				const expected = explainedOf(capture)
				const read = Result.getOrThrow(parsePlan(printed))
				assert.deepEqual(read, expected)
				assert.deepEqual(Result.getOrThrow(parsePlanTree(printed)), estimatedOf(capture.plan))
				const nodes = sketchNodes(capture.plan)
				const scanned = (role: Role): number =>
					Arr.reduce(
						Arr.filter(nodes, (n) => n.role === role),
						0,
						(sum, n) =>
							sum +
							(n.fields.actualRows +
								n.fields.rowsRemovedByFilter +
								n.fields.rowsRemovedByIndexRecheck) *
								n.fields.actualLoops
					)
				assert.equal(rowsRead(read.plan), scanned("stored scan"))
				assert.equal(rowsGenerated(read.plan), scanned("generating"))
				assert.deepEqual(
					relationsRead(read.plan),
					Arr.dedupe(
						Arr.flatMap(nodes, (n) =>
							n.role === "modify" ? [] : Option.toArray(n.fields.relation)
						)
					)
				)
				assert.deepEqual(
					indexAccesses(read.plan),
					Arr.flatMap(nodes, (n) =>
						Option.match(n.fields.index, {
							onNone: () => [],
							onSome: (index) => [
								{
									nodeType: n.fields.nodeType,
									relation: n.fields.relation,
									index,
									indexCond: n.fields.indexCond,
									orderBy: n.fields.orderBy,
									filter: n.fields.filter
								}
							]
						})
					)
				)
				assert.deepEqual(
					nodeTypeCounts(read.plan),
					Rec.map(
						Arr.groupBy(nodes, (n) => n.fields.nodeType),
						(group) => group.length
					)
				)
				assert.deepEqual(statementTotals(read), {
					buffers: capture.plan.fields.buffers,
					wal: capture.plan.fields.wal,
					planningBuffers: capture.planningBuffers,
					serialization: capture.serialization,
					triggerCalls: Arr.reduce(capture.triggers, 0, (sum, t) => sum + t.calls)
				})
				for (const n of nodes) {
					c.note(`a ${n.role}`)
				}
				c.note(capture.plan.fields.wal.kind === "captured" ? "WAL captured" : "WAL not captured")
				if (capture.serialization.kind === "captured") {
					c.note("serialized")
				}
				if (Arr.isReadonlyArrayNonEmpty(capture.triggers)) {
					c.note("a trigger")
				}
			}),
		oracle: {
			kind: "universal",
			name: "read ∘ print = id over generated captures, and rows counted by the role each node was generated in"
		},
		kept: [],
		kills: []
	})

/** EXPLAIN capture refuses output PostgreSQL never prints, a fault planted in a generated capture, as MalformedPlan. */
export const eXPLAINCaptureRefusesOutputPostgreSQLNeverPrintsAFaultPlantedInAGeneratedCaptureAsMalformedPlan =
	property.explore(faultCases, {
		needs: {},
		situations: planFaults satisfies ReadonlyArray<Reached<PlanFault>>,
		check:
			(_, c: Case<PlanFault>) =>
			({ capture, fault }) =>
				Effect.sync(() => {
					const value = Option.getOrThrowWith(
						c.draw(plantedFault(capture, fault)),
						() => new Error(`${fault}: planted in a capture drawn with a place for it`)
					)
					const read = parsePlan(value)
					assertVariant(read, "_tag", "Failure", fault)
					assert.ok(read.failure instanceof MalformedPlan, fault)
					if (treeFaults.has(fault)) {
						const tree = parsePlanTree(value)
						assertVariant(tree, "_tag", "Failure", fault)
						assert.ok(tree.failure instanceof MalformedPlan, fault)
					}
					c.note(fault)
				}),
		oracle: {
			kind: "specification",
			name: "each planted fault is output PostgreSQL never prints, which the reader refuses"
		},
		kept: [],
		kills: []
	})

/** Outcomes, retries and loads retry exactly what grizzle classifies as a TransientFailure, up to the caller's policy, the last attempt standing. */
export const outcomesRetriesAndLoadsRetryExactlyWhatGrizzleClassifiesAsATransientFailureUpToTheCallersPolicyTheLastAttemptStanding =
	property.explore(retriedCases, {
		needs: {},
		situations: [
			"committed at once",
			"committed after a retry",
			"the policy ran out",
			"a refusal ended it",
			"a unique abort retried",
			"a unique violation not retried",
			"labelled"
		] satisfies ReadonlyArray<Reached<RetryFeature>>,
		check: (_, c: Case<RetryFeature>) => (r) =>
			Effect.map(ranOf(r), (ran) => {
				const model = modelOf(r)
				assert.deepEqual(ran, model)
				if (ran.outcome.kind === "committed") {
					c.note(ran.attempts === 1 ? "committed at once" : "committed after a retry")
				} else if (reasonOf(r, Arr.getUnsafe(r.steps, ran.attempts - 1)) === undefined) {
					c.note("a refusal ended it")
				} else {
					c.note("the policy ran out")
				}
				for (const step of Arr.take(r.steps, ran.attempts)) {
					if (step.kind === "refused" && (step.code === "23505" || step.code === "23P01")) {
						c.note(
							reasonOf(r, step) === undefined
								? "a unique violation not retried"
								: "a unique abort retried"
						)
					}
				}
				if (Arr.some(ran.retries, (d) => d.label !== undefined)) {
					c.note("labelled")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of grizzle's documented TransientFailure classification over scripted attempts"
		},
		kept: [],
		kills: []
	})

/** Result rows agree, and digest alike, exactly as one multiset of rows that neither list repeats, a cell's NULL apart from its text. */
export const resultRowsAgreeAndDigestAlikeExactlyAsOneMultisetOfRowsThatNeitherListRepeatsACellsNULLApartFromItsText =
	property.explore(rowPairGen, {
		needs: {},
		situations: [
			"one set",
			"a repeat told apart",
			"a row told apart",
			"one digest",
			"two digests"
		] satisfies ReadonlyArray<Reached<RowsFeature>>,
		check:
			(_, c: Case<RowsFeature>) =>
			([left, right]) =>
				Effect.sync(() => {
					const sets = distinctOf(left) === left.length && distinctOf(right) === right.length
					const same = sameMultiset(left, right)
					assert.equal(Option.isNone(rowsAgree(left, right)), sets && same)
					const [a, b] = [resultSet(left), resultSet(right)]
					assert.deepEqual(
						[a.rows, a.distinct, a.repeated],
						[left.length, distinctOf(left), left.length - distinctOf(left)]
					)
					assert.equal(a.digest === b.digest, same)
					c.note(sets && same ? "one set" : sets ? "a row told apart" : "a repeat told apart")
					c.note(same ? "one digest" : "two digests")
				}),
		oracle: {
			kind: "second-implementation",
			name: "rows counted cell by cell, a list agreeing with another when neither repeats a row and the counts match"
		},
		kept: [],
		kills: []
	})

/** Result rows read a statement's rows as text cells, refusing the first cell, in row order, that is neither text nor NULL. */
export const resultRowsReadAStatementsRowsAsTextCellsRefusingTheFirstCellInRowOrderThatIsNeitherTextNorNULL =
	property.explore(
		(source) => ({
			statement: source.draw(int(0, 3)),
			rows: source.draw(array(array(deliveredGen, { min: 0, max: 3 }), { min: 0, max: 4 }))
		}),
		{
			needs: {},
			situations: ["read", "refused"] satisfies ReadonlyArray<Reached<"read" | "refused">>,
			check:
				(_, c: Case<"read" | "refused">) =>
				({ statement, rows }) =>
					Effect.sync(() => {
						const bad = Arr.findFirst(
							Arr.flatMap(rows, (cells, row) =>
								Arr.map(cells, (cell, column) => ({ cell, row, column }))
							),
							({ cell }) => typeof cell !== "string" && cell !== null
						)
						const read = textRows(rows, statement)
						if (Option.isNone(bad)) {
							c.note("read")
							const cells: ReadonlyArray<TextRow> = Arr.map(rows, (row) =>
								Arr.map(row, (cell) => (typeof cell === "string" ? cell : null))
							)
							assert.deepEqual(Result.getOrThrow(read), cells)
							return
						}
						c.note("refused")
						assertVariant(read, "_tag", "Failure")
						assert.ok(read.failure instanceof MalformedRows)
						assert.deepEqual(
							[read.failure.statement, read.failure.row, read.failure.column],
							[statement, bad.value.row, bad.value.column]
						)
					}),
			oracle: {
				kind: "specification",
				name: "a cell is text or NULL, and the first that is neither is named by its statement, row and column"
			},
			kept: [],
			kills: []
		}
	)

/** Verdicts judge a gate by its tagged checks fail on exactly the checks that fail, and pass when every check holds. */
export const verdictsJudgeAGateByItsTaggedChecksFailOnExactlyTheChecksThatFailAndPassWhenEveryCheckHolds =
	property.explore(
		(source) => nonEmpty(source.draw(array(checkGen, { min: 1, max: 4 })), "checks"),
		{
			needs: {},
			situations: ["pass", "fail"] satisfies ReadonlyArray<Reached<"pass" | "fail">>,
			check: (_, c: Case<"pass" | "fail">) => (checks) =>
				Effect.sync(() => {
					const failing = Arr.map(
						Arr.filter(checks, (k) => !k.holds),
						(k) => k.name
					)
					const verdict = verdictOf("R05", { checks })
					c.note(verdict.outcome === "pass" ? "pass" : "fail")
					assert.deepEqual(
						verdict,
						Arr.isReadonlyArrayNonEmpty(failing)
							? { gate: "R05", outcome: "fail", failing, checks }
							: { gate: "R05", outcome: "pass", checks }
					)
				}),
			oracle: {
				kind: "specification",
				name: "a verdict fails on its failing checks, in their order"
			},
			kept: [],
			kills: []
		}
	)

/** Gate records carry their identity and phases name exactly the gaps planted in a record, in the order it is read. */
export const gateRecordsCarryTheirIdentityAndPhasesNameExactlyTheGapsPlantedInARecordInTheOrderItIsRead =
	property.explore(recordGen(catalogIds), {
		needs: {},
		situations: [
			"name",
			"file",
			"benchmark",
			"no verdict",
			"two verdicts",
			"condition",
			"case gate",
			"phase undeclared",
			"no phase timings",
			"complete"
		] satisfies ReadonlyArray<Reached<RecordProblem["kind"] | "complete">>,
		check: (_, c: Case<RecordProblem["kind"] | "complete">) => (r) =>
			Effect.gen(function* () {
				const pin = yield* readPin
				const identity = yield* benchIdentity({
					benchmark: "gate/row-seek",
					server: pinnedServer(pin.version),
					phases: ["executeMs"],
					scope: "a seek",
					options: {},
					source: yield* sourceIdentity
				})
				yield* Effect.sync(() => {
					const expected = plantedGaps(r, identity)
					assert.deepEqual(recordProblems(recordOfSketch(r, identity)), expected)
					if (!Arr.isReadonlyArrayNonEmpty(expected)) {
						c.note("complete")
					}
					for (const gap of expected) {
						if (gap.kind !== "identity") {
							c.note(gap.kind)
						}
					}
				})
			}),
		oracle: {
			kind: "specification",
			name: "each planted gap, named in the order a record is read"
		},
		kept: [],
		kills: []
	})

/** Gate records carry their identity and phases a run's record keeps its cases when only the release fails. */
export const gateRecordsCarryTheirIdentityAndPhasesARunsRecordKeepsItsCasesWhenOnlyTheReleaseFails =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(["passed", "failed"] as const)),
					source.draw(element(["clean", "leaked"] as const))
				] as const
		),
		{
			needs: {},
			situations: [
				"run failed",
				"release clean",
				"release leaked",
				"failed run leaked"
			] satisfies ReadonlyArray<Reached<RecordFeature>>,
			check:
				(_, c: Case<RecordFeature>) =>
				([ran, released]) =>
					Effect.gen(function* () {
						const pin = yield* readPin
						const base = {
							identity: yield* runIdentity({
								benchmark: "gate/row-seek",
								phases: ["executeMs"],
								scope: "a seek",
								options: {},
								source: yield* sourceIdentity
							}),
							file: "bench/query/row-seek.bench.ts",
							quick: true,
							runPhases: { setupMs: 1, runMs: 2 }
						}
						yield* Effect.sync(() => {
							const run =
								ran === "passed"
									? Exit.succeed({ server: pinnedServer(pin.version), result })
									: Exit.fail(new Failure({ what: "the run failed" }))
							const release =
								released === "clean"
									? Exit.void
									: Exit.fail(new Failure({ what: "a role still had sessions" }))
							const record = recordOf(gate, base, run, release)
							if (ran === "failed") {
								c.note("run failed")
								assertVariant(record, "kind", "failed")
								assert.equal(record.release.kind, released)
								assert.equal(
									Arr.some(gateFindings([record]), (f) => f.kind === "leaked"),
									released === "leaked"
								)
								if (released === "leaked") {
									c.note("failed run leaked")
								}
								return
							}
							assertVariant(record, "kind", "ran")
							assert.deepEqual(record.cases, result.cases)
							switch (released) {
								case "clean":
									c.note("release clean")
									assert.deepEqual(record.release, { kind: "clean" })
									assert.deepEqual(record.verdicts, [verdictOf("R05", input)])
									return
								case "leaked":
									c.note("release leaked")
									assert.equal(record.release.kind, "leaked")
									assert.deepEqual(
										Arr.map(record.verdicts, (v) => v.outcome),
										["error"]
									)
									return
							}
						})
					}),
			oracle: {
				kind: "specification",
				name: "a run's record keeps its cases and verdicts when only its release fails, and names the leak"
			},
			box: "every run outcome beside every release outcome",
			kept: [],
			kills: []
		}
	)

/** The gate catalog gives every catalog gate exactly one bench file, in its owner's directory. */
export const theGateCatalogGivesEveryCatalogGateExactlyOneBenchFileInItsOwnersDirectory =
	property.exhaust(finite(word(catalogIds)), {
		needs: {},
		situations: ["query", "write"] satisfies ReadonlyArray<Reached<"query" | "write">>,
		check: (_, c: Case<"query" | "write">) => (id) =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				const discovered = yield* discoverGates(
					Arr.map(
						[...ownerDirectories.query, ...ownerDirectories.write],
						(dir) => `${repoRoot}/${dir}`
					)
				)
				const listed = new Set(catalogIds)
				yield* Effect.sync(() => {
					c.note(gateOwner(id))
					const covering = Arr.filter(discovered, (d) => Arr.contains(d.gate.gates, id))
					assert.equal(covering.length, 1, id)
					for (const d of covering) {
						assert.ok(
							Arr.contains(ownerDirectories[gateOwner(id)], path.dirname(d.file)),
							`${d.file} covers ${id}`
						)
						assert.deepEqual(
							Arr.sort(Rec.keys(d.gate.options(true)), Order.String),
							Arr.sort(Rec.keys(d.gate.options(false)), Order.String),
							d.file
						)
					}
					assert.deepEqual(
						Arr.filter(
							Arr.flatMap(discovered, (d) => d.gate.gates),
							(gate) => !listed.has(gate)
						),
						[]
					)
				})
			}),
		oracle: {
			kind: "specification",
			name: "one bench file a gate, in its owner's directory, its sizes alike at both scales"
		},
		box: "every gate of the catalog, against the bench files under the owners' directories",
		kept: [],
		kills: []
	})

/** Pnpm bench's command line reads exactly what its grammar reads, and refuses every other command line. */
export const pnpmBenchsCommandLineReadsExactlyWhatItsGrammarReadsAndRefusesEveryOtherCommandLine =
	property.explore(array(element(argWords), { min: 0, max: 5 }), {
		needs: {},
		situations: ["refused", "suite", "full", "gates", "list", "all"] satisfies ReadonlyArray<
			Reached<Read["kind"]>
		>,
		check: (_, c: Case<Read["kind"]>) => (argv) =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				const model = readArgs(argv)
				c.note(model.kind)
				const parsed = yield* Effect.result(parseBenchArgs(argv))
				if (model.kind === "refused") {
					assertVariant(parsed, "_tag", "Failure")
					assert.equal(parsed.failure._tag, "UsageError")
					return
				}
				const command = Result.getOrThrow(parsed)
				switch (model.kind) {
					case "suite":
					case "full":
						assert.deepEqual(command, model)
						return
					case "gates":
					case "list":
					case "all": {
						assertVariant(command, "kind", model.kind)
						const directories = Arr.map(model.directories, (d) => path.resolve(d))
						if (command.kind === "all") {
							assert.equal(command.quick, model.quick)
						}
						if (command.kind !== "all" && Arr.isReadonlyArrayNonEmpty(directories)) {
							assert.deepEqual(command.directories, directories)
						}
						if (command.kind === "gates") {
							assert.deepEqual(
								[command.quick, command.report, command.only],
								[model.quick, model.report, model.only]
							)
							if (Option.isSome(model.out)) {
								assert.equal(command.outDir, path.resolve(model.out.value))
							}
						}
					}
				}
			}),
		oracle: { kind: "second-implementation", name: "a model of pnpm bench's grammar" },
		kept: [],
		kills: []
	})
