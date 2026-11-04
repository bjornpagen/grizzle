/**
 * The reference side of the oracle discriminates, and failing cases shrink to printable form.
 *
 * The conservative gate only ever shows the reference agreeing. These checks show that the same runner, with the
 * reference on the right, catches a wrong lowering on PostgreSQL:
 *
 * - the I1 mutant (a DISTINCT dropped from a projection that keeps no key) is told apart from the reference by the
 *   floor stream's generated cases, which the suite's label fixes, and the failure shrinks to the printed case and the
 *   repeated row;
 * - the reference agrees with PostgreSQL's capture on a planted case of every hard spelling (1.00 in numeric(5,2), 1.0,
 *   NaN, -0, money and supplementary-plane text), the control of the structural checks below;
 * - the reference derives the delivered statements from the IR, so a lowering that drops an attachment statement,
 *   delivers one attachment under another's name, or reports a narrowed column type is a structural difference, never
 *   a reference built to match it.
 *
 * The mutant is the left side: the rows it repeats are rows the reference has fewer times.
 *
 * The swapping lowering is the left side, the reference the right; the order of the two is no contract.
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, Run } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { runOfProcess } from "@grizzle/testing/vitest/run"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import {
	type AttachedTree,
	type ConservativeProgram,
	mapTree
} from "#compiler/lower/conservative/types.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, containsEqual, containsText } from "#test/support/assert.ts"
import type { StructuralDifference } from "#test/support/oracle/compare.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	canonicallySpelled,
	float4,
	float8,
	int4,
	numeric,
	scalarOfSpec,
	type SpelledValue
} from "#test/support/oracle/gen/domain.ts"
import { projectRoot, rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { mutantLowering } from "#test/support/oracle/mutants/index.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	type LabelledCase,
	type Lowering,
	oracleKill,
	printOracleCase,
	reference,
	runLabelledOracle,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	account,
	dec,
	facts,
	flt,
	int,
	posting,
	Q,
	relation,
	schema,
	str,
	text
} from "#test/unit/oracle-runner/fixtures.ts"

/** A lowering that post-processes the conservative program. */
const rewriting = (name: string, f: (p: ConservativeProgram) => ConservativeProgram): Lowering => ({
	name,
	lower: (input) => Result.map(conservative.lower(input), f)
})

/** Accounts with two attachments of different headings: the postings' amounts (a1) and their ids (a2). */
const attachCase = (): LabelledCase => {
	const q = new Q()
	const accounts = q.region([{ source: q.base(account), bind: { id: "id" } }])
	const postings = q.region([
		{ source: q.base(posting), bind: { id: "pid", account: "account", amount: "amt" } }
	])
	const a1 = q.attach(accounts, q.project(postings, ["account", "amt"]), [["id", "account"]], "a1")
	return q.case(
		q.attach(a1, q.project(postings, ["account", "pid"]), [["id", "account"]], "a2"),
		facts,
		schema,
		"accounts with two attachments of different headings"
	)
}

const spell = relation(
	"Spell",
	[
		["k", int4],
		["scaled", scalarOfSpec({ carrier: "numericTypmod", precision: 5, scale: 2 })],
		["n", numeric],
		["f", float8],
		["m", scalarOfSpec({ carrier: "money" })],
		["t", text]
	],
	["k"],
	[]
)

/** A value stored in a twin input spelling, which PostgreSQL reads as the value and stores differently. */
const twin = (literal: TypedLiteral, text: string): SpelledValue => ({
	literal,
	spelling: { kind: "twin", text }
})

/** Every column of Spell, bound by name, the hard spellings among its stored values. */
const spellCase = (): LabelledCase => {
	const q = new Q()
	const all = q.region([
		{ source: q.base(spell), bind: { k: "k", scaled: "scaled", n: "n", f: "f", m: "m", t: "t" } }
	])
	return q.case(
		all,
		{
			Spell: [
				[
					canonicallySpelled(int(1)),
					canonicallySpelled(dec("1")),
					twin(dec("1"), "1.0"),
					twin(flt(0), "-0"),
					canonicallySpelled({ kind: "money", value: Money.of(150n) }),
					canonicallySpelled(str("\u{1F600}"))
				],
				[
					canonicallySpelled(int(2)),
					canonicallySpelled(dec("2.5")),
					canonicallySpelled(dec("NaN")),
					canonicallySpelled({ kind: "floatSpecial", value: "NaN" }),
					canonicallySpelled({ kind: "money", value: Money.of(-25n) }),
					canonicallySpelled(str("a\u{10FFFF}"))
				]
			]
		},
		{ ...schema, relations: [spell] },
		"every spelling the raw text comparison observes"
	)
}

/** The fixtures both lowerings must agree on, by name. */
const fixtureNames = ["attach", "spell"] as const

type FixtureName = (typeof fixtureNames)[number]

const fixtureCase = (name: FixtureName): LabelledCase => {
	switch (name) {
		case "attach":
			return attachCase()
		case "spell":
			return spellCase()
	}
}

layer(Substrate.layer)("the reference side of the oracle discriminates", (it) => {
	it.effect(
		"tells the I1 mutant from the reference in its floor cases and shrinks to the printed case",
		() =>
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
						caseHang: Duration.minutes(2),
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
				).pipe(Effect.provideServiceEffect(Run, runOfProcess))
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
				assert.ok(outcome.comparison.leftDuplicates > 0)
				assert.equal(outcome.comparison.rightDuplicates, 0)
			}),
		600_000
	)

	it.effect("reports a dropped attachment statement as structure", () =>
		Effect.gen(function* () {
			/** The main statement stays first; the attachment a1 after it is dropped. */
			const dropping = rewriting("dropping", (p) => ({
				...p,
				roots: mapNonEmpty(p.roots, (tree) => ({
					...tree,
					attachments: Arr.filter(tree.attachments, (a) => a.attach.name !== "a1")
				}))
			}))
			const outcome = yield* runLabelledOracle(attachCase(), dropping, reference, defaultRunOptions)
			assert.deepEqual(outcome.comparison.structural, [
				{ kind: "missing", side: "dropping", label: "main/a1" }
			])
		})
	)

	it.effect("reports an attachment delivered under another's name as structure", () =>
		Effect.gen(function* () {
			const swapped = <S>(a: AttachedTree<S>): AttachedTree<S> => ({
				...a,
				attach: { ...a.attach, name: a.attach.name === "a1" ? "a2" : "a1" },
				attachments: Arr.map(a.attachments, swapped)
			})
			const swapping = rewriting("swapping", (p) => ({
				...p,
				roots: mapNonEmpty(p.roots, (tree) => ({
					...tree,
					attachments: Arr.map(tree.attachments, swapped)
				}))
			}))
			const outcome = yield* runLabelledOracle(attachCase(), swapping, reference, defaultRunOptions)
			assert.equal(outcome.comparison.equal, false)
			assert.equal(outcome.comparison.structural.length, 2)
			const a1: StructuralDifference = {
				kind: "heading",
				label: "main/a1",
				left: ["id", "account", "pid"],
				right: ["id", "account", "amt"]
			}
			const a2: StructuralDifference = {
				kind: "heading",
				label: "main/a2",
				left: ["id", "account", "amt"],
				right: ["id", "account", "pid"]
			}
			containsEqual(outcome.comparison.structural, a1)
			containsEqual(outcome.comparison.structural, a2)
		})
	)

	it.effect("reports a narrowed output type as structure, even where the text agrees", () =>
		Effect.gen(function* () {
			const narrowing = rewriting("narrowing", (p) => ({
				...p,
				roots: mapTree(p.roots, (s) => ({
					...s,
					heading: Arr.map(s.heading, (h): HeadingColumn =>
						h.name === "f" && h.type.carrier === "float8" ? { ...h, type: float4 } : h
					)
				}))
			}))
			const outcome = yield* runLabelledOracle(spellCase(), narrowing, reference, defaultRunOptions)
			assert.deepEqual(outcome.comparison.diffs, [])
			assert.deepEqual(outcome.comparison.structural, [
				{ kind: "type", label: "main", column: "f", left: float4, right: float8 }
			])
		})
	)

	it.effect("still agrees with the unmodified conservative lowering on both fixtures", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "oracle/reference-fixtures",
					generator: element(fixtureNames),
					literal: Formatter.format,
					limit: fixtureNames.length,
					coverage: requiredInSpace<FixtureName>(fixtureNames),
					caseHang: Duration.minutes(2)
				},
				(fixture, k) =>
					Effect.gen(function* () {
						const c = fixtureCase(fixture)
						const outcome = yield* runLabelledOracle(c, conservative, reference, defaultRunOptions)
						assert.equal(outcome.comparison.equal, true, printOracleCase(c))
						k.note(fixture)
					})
			)
		)
	)
})
