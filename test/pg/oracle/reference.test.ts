/**
 * The reference side of the oracle discriminates, and failing cases shrink to printable form.
 *
 * The conservative gate only ever shows the reference agreeing. These checks show that the same runner, with the
 * reference on the right, catches a wrong lowering on PostgreSQL:
 *
 * - the I1 mutant (a DISTINCT dropped from a projection that keeps no key) is told apart from the reference by the
 *   floor stream's generated cases, which the suite's label fixes, and the failure shrinks to the printed case and the
 *   repeated row;
 * - the reference derives the delivered statements from the IR, so a lowering that drops an attachment statement,
 *   delivers one under another name, or reports a narrowed column type is a structural difference, never a reference
 *   built to match it: each fault is planted in the conservative program of a generated case, and the comparison must
 *   report exactly the differences the plant makes, read off the program's statement labels (compare.ts
 *   labeledStatements) before and after it.
 *
 * That the reference agrees with PostgreSQL's capture of every hard spelling is the conservative gate's
 * (conservative.test.ts), whose generated facts store NaN, -0, display scales and supplementary-plane text.
 *
 * The mutant, and every planted lowering, is the left side, the reference the right; the order of the two is no
 * contract.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, Run } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { runOfTest } from "@grizzle/testing/vitest/run"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import * as Result from "#compiler/core/result.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import {
	type AttachedTree,
	type ConservativeProgram,
	type ConservativeStatement,
	mapTree,
	type StatementTree
} from "#compiler/lower/conservative/types.ts"
import { assert, containsText, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	labeledStatements,
	repeatsOn,
	type StructuralDifference
} from "#test/support/oracle/compare.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { float4 } from "#test/support/oracle/gen/domain.ts"
import { projectRoot, rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { mutantLowering } from "#test/support/oracle/mutants/index.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	type Lowering,
	oracleKill,
	printOracleCase,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A fault a lowering may make in a program's structure, each planted in the conservative program. */
type StructureFault = "an attachment dropped" | "an attachment renamed" | "a column's type narrowed"

const structureFaults: readonly [StructureFault, ...ReadonlyArray<StructureFault>] = [
	"an attachment dropped",
	"an attachment renamed",
	"a column's type narrowed"
]

/** The name the planted lowering takes, the left side of every comparison. */
const planted = "planted"

/** The program with the attached tree labelled `target` replaced by `replace` of it: none drops it. */
const editAttached = (
	program: ConservativeProgram,
	target: string,
	replace: (
		tree: AttachedTree<ConservativeStatement>
	) => ReadonlyArray<AttachedTree<ConservativeStatement>>
): ConservativeProgram => {
	const labels = Arr.map(labeledStatements(program.roots), (l) => l.label)
	let at = 0
	const attached = (
		tree: AttachedTree<ConservativeStatement>
	): ReadonlyArray<AttachedTree<ConservativeStatement>> => {
		const label = Arr.getUnsafe(labels, at++)
		const edited: AttachedTree<ConservativeStatement> = {
			...tree,
			attachments: Arr.flatMap(tree.attachments, attached)
		}
		return label === target ? replace(edited) : [edited]
	}
	return {
		...program,
		roots: Arr.map(program.roots, (tree): StatementTree<ConservativeStatement> => {
			at++
			return { ...tree, attachments: Arr.flatMap(tree.attachments, attached) }
		})
	}
}

/** A plant: the program the planted lowering delivers, and the structural differences the comparison must report. */
interface Plant {
	readonly program: ConservativeProgram
	readonly expected: ReadonlyArray<StructuralDifference>
}

/**
 * The plant of `fault` in `program`, its target picked by `pick` among those the program offers: an attachment for a
 * drop or a rename, a double precision column of a delivered heading for a narrowing; none where the program offers no
 * target.
 */
const plantIn = (
	program: ConservativeProgram,
	fault: StructureFault,
	pick: number
): Option.Option<Plant> => {
	const labeled = labeledStatements(program.roots)
	const subtree = (label: string): ReadonlyArray<string> =>
		Arr.filter(
			Arr.map(labeled, (l) => l.label),
			(l) => l === label || Str.startsWith(`${label}/`)(l)
		)
	const attachments = Arr.filter(labeled, (l) => l.attach !== undefined)
	switch (fault) {
		case "an attachment dropped":
		case "an attachment renamed": {
			if (!Arr.isReadonlyArrayNonEmpty(attachments)) {
				return Option.none()
			}
			const target = Arr.getUnsafe(attachments, pickIndex(pick, attachments.length))
			const lost = Arr.map(subtree(target.label), (label): StructuralDifference => ({
				kind: "missing",
				side: planted,
				label
			}))
			if (fault === "an attachment dropped") {
				return Option.some({
					program: editAttached(program, target.label, () => []),
					expected: lost
				})
			}
			const renamedLabel = `${target.label}_renamed`
			if (Arr.some(labeled, (l) => l.label === renamedLabel)) {
				return Option.none()
			}
			return Option.some({
				program: editAttached(program, target.label, (tree) => [
					{ ...tree, attach: { ...tree.attach, name: `${tree.attach.name}_renamed` } }
				]),
				expected: [
					...lost,
					...Arr.map(subtree(target.label), (label): StructuralDifference => ({
						kind: "missing",
						side: reference.name,
						label: `${renamedLabel}${Str.slice(target.label.length)(label)}`
					}))
				]
			})
		}
		case "a column's type narrowed": {
			const columns = Arr.flatMap(labeled, (l, position) =>
				Arr.flatMap(l.statement.heading, (column: HeadingColumn) =>
					column.type.carrier === "float8" ? [{ position, label: l.label, column }] : []
				)
			)
			if (!Arr.isReadonlyArrayNonEmpty(columns)) {
				return Option.none()
			}
			const target = Arr.getUnsafe(columns, pickIndex(pick, columns.length))
			const narrowed = Arr.getUnsafe(labeled, target.position).statement
			return Option.some({
				program: {
					...program,
					roots: mapTree(program.roots, (s) =>
						s === narrowed
							? {
									...s,
									heading: Arr.map(s.heading, (h): HeadingColumn =>
										h === target.column ? { ...h, type: float4 } : h
									)
								}
							: s
					)
				},
				expected: [
					{
						kind: "type",
						label: target.label,
						column: target.column.name,
						left: float4,
						right: target.column.type
					}
				]
			})
		}
	}
}

layer(Substrate.layer)("the reference side of the oracle discriminates", (it) => {
	it.effect(
		"tells the I1 mutant from the reference in its floor cases and shrinks to the printed case",
		(ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const name = yield* s.schema({ create: false, label: "oracle" })
				const harnessErrors: Array<string> = []
				/** Unperturbed, as the kill population always ran: the kill rests on the facts as drawn. */
				const result = yield* oracleKill(
					drawn(rootedCaseGen(projectRoot, defaultGenConfig)),
					{
						suite: "oracle/reference-i1",
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						perturb: "none"
					},
					(c) =>
						Effect.gen(function* () {
							const harnessFailure = (e: unknown) =>
								Effect.sync(() => {
									harnessErrors.push(`${String(e)}\n${printOracleCase(c)}`)
								})
							const outcome = yield* runOracle(c, mutantLowering(mutants.I1), reference, {
								...defaultRunOptions,
								schema: { kind: "named", name: name }
							}).pipe(Effect.catchTags({ OracleFailure: harnessFailure, SqlError: harnessFailure }))
							if (outcome !== undefined && !outcome.comparison.equal) {
								return yield* comparisonFailed(outcome)
							}
						})
				).pipe(Effect.provideServiceEffect(Run, runOfTest(ctx)))
				assert.deepEqual(harnessErrors, [], Arr.join(harnessErrors, "\n\n"))
				if (result.kind === "survived") {
					return assert.fail("the I1 mutant survived every case")
				}
				if (result.kind === "unwitnessed") {
					return assert.fail(
						`the I1 mutant survived its witnesses, the floor and steered cases: only a case the run's seed drew killed it\n${result.report}`
					)
				}
				if (result.kind === "failed") {
					return assert.fail(result.report)
				}
				if (result.verdict.kind === "invariance") {
					return assert.fail(
						`the I1 mutant was caught by its own second reading, never told from the reference\n${result.report}`
					)
				}
				const outcome = result.verdict.outcome
				containsText(result.report, printOracleCase(result.counterexample))
				assert.ok(
					Arr.some(outcome.comparison.diffs, (d) => d.missing.length > 0),
					result.report
				)
				assert.deepEqual(outcome.comparison.structural, [])
				assert.ok(repeatsOn(outcome.comparison, "left") > 0)
				assert.equal(repeatsOn(outcome.comparison, "right"), 0)
			})
	)

	it.effect(
		"reports exactly the structure a lowering drops, renames or narrows, planted in a generated case's program",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "oracle/reference-structure",
						draw: drawn((source) => ({
							case: source.draw(queryCaseGen(defaultGenConfig)),
							fault: source.draw(element(structureFaults)),
							pick: source.draw(pickGen)
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the structural differences a plant makes, read off the program's statement labels before and after it"
						},
						coverage: required<StructureFault>(structureFaults, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const plants: Array<Plant> = []
							const lowering: Lowering = {
								name: planted,
								lower: (input) =>
									Result.map(conservative.lower(input), (program) =>
										Option.match(plantIn(program, drawnCase.fault, drawnCase.pick), {
											onNone: () => program,
											onSome: (plant) => {
												plants.push(plant)
												return plant.program
											}
										})
									)
							}
							const outcome = yield* runOracle(
								drawnCase.case,
								lowering,
								reference,
								defaultRunOptions
							)
							const [plant] = plants
							yield* c.assume(plant !== undefined)
							if (plant === undefined) {
								return
							}
							c.note(drawnCase.fault)
							assert.equal(outcome.comparison.equal, false)
							unorderedEqual(outcome.comparison.structural, plant.expected)
						})
				)
			)
	)
})
