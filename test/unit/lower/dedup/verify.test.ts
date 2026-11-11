import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { mapTree } from "#compiler/runtime/lower/tree.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { assert, contains, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { defaultQueryConfig, genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import {
	artifactProblems,
	type ChannelProgram,
	channelProblems,
	conservativeChannels
} from "#test/support/oracle/verify/channels.ts"
import {
	type PlanUnderVerification,
	verifyMultiplicity
} from "#test/support/oracle/verify/multiplicity.ts"
import type { VerificationProblem } from "#test/support/oracle/verify/problems.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { testSql } from "#test/support/sql.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * The kernel's verification of a lowering (test/support/oracle/verify): every required set boundary discharged, no
 * sensitive consumer seeing unproved multiplicity, every certificate the one its rewrite's proof gives, and codecs and
 * result channels aligned. That the plans and programs the compiler builds pass is dedup/soundness's over generated
 * cases, and every compiled template's (test/support/compile.ts checkedLowering). Here each rule is held to its break,
 * as planted faults: a population of plans and programs, the oracle generator's query cases and its rooted
 * counterexample cases for what it seldom builds at a root (folds over projections, unions told apart by their tags and
 * not, bounds under an existence, closures), each broken at one drawn site of one drawn break, picked by kind first and
 * aimed at a break no case has reached yet, is reported under the break's rule (exactly that rule where the break
 * touches nothing else), and passes unbroken. That a fused attachment decodes as its pipelined statement does is the
 * optimized differential's, which requires one and holds both artifacts to the rows PostgreSQL delivers
 * (test/pg/oracle/optimized/variants.test.ts).
 */

/** The verification rules. */
type Rule = VerificationProblem["rule"]

const rulesOf = (ps: ReadonlyArray<{ readonly rule: Rule }>) => [
	...new Set(Arr.map(ps, (p) => p.rule))
]

/** What a break must be reported as: exactly these rules, or this rule among those the break also breaks. */
type Expect =
	| { readonly kind: "exactly"; readonly rules: ReadonlyArray<Rule> }
	| { readonly kind: "including"; readonly rule: Rule }
const exactly = (...rules: ReadonlyArray<Rule>): Expect => ({ kind: "exactly", rules })
const including = (rule: Rule): Expect => ({ kind: "including", rule })

const reported = (
	found: ReadonlyArray<{ readonly rule: Rule }>,
	expect: Expect,
	why: string
): void => {
	if (expect.kind === "exactly") {
		unorderedEqual(rulesOf(found), expect.rules, why)
	} else {
		contains(rulesOf(found), expect.rule, why)
	}
}

/**
 * The options a case may take, aimed: those a pending requirement of a steering case names, where one does, else every
 * option, so a witness case spends its draw on a break no case has reached yet.
 */
const aimed = <F extends string, B extends F>(
	c: Case<F>,
	options: Arr.NonEmptyReadonlyArray<B>
): Arr.NonEmptyReadonlyArray<B> => {
	const pending = Arr.filter(options, (b) => Option.exists(c.steering, (p) => p.names(b)))
	return Arr.isReadonlyArrayNonEmpty(pending) ? pending : options
}

/** The rooted counterexample forms the generator seldom builds at a root, beside its tagged unions. */
const rootedForms = oneOf([
	projectRoot,
	keyedJoinRoot,
	fanoutJoinRoot,
	witnessRoot,
	groupRoot,
	projectGroupRoot,
	untaggedUnionRoot,
	existsOverTakeRoot,
	closureRoot(false)
])

/** A generated case, and where it was drawn from. */
type LabelledCase = readonly [label: string, c: QueryCase]

/**
 * A generated case under `config`: one of the oracle generator's, a rooted counterexample, or a union told apart by its
 * arms' tags, which alone places UNION ALL under its certificate.
 */
const caseGen = (config: GenConfig): Gen<LabelledCase> =>
	weighted<LabelledCase>([
		[2, map(queryCaseGen(config), (c): LabelledCase => ["a generated query", c])],
		[1, map(rootedCaseGen(rootedForms, config), (c): LabelledCase => ["a rooted case", c])],
		[1, map(rootedCaseGen(taggedUnionRoot, config), (c): LabelledCase => ["a tagged union", c])]
	])

/**
 * The programs' population: the generator's own, with roots of several heading groups and attachments drawn as often
 * as plain ones, since the merge and the attachments' channels break only there.
 */
const programConfig: GenConfig = {
	...defaultGenConfig,
	query: { ...defaultQueryConfig, roots: { plain: 2, attach: 1, hetero: 1 } }
}

/** A plan to verify: a DAG and the catalog its plan is placed under. */
interface PlanSubject {
	readonly label: string
	readonly dag: RelDag
	readonly catalog: EvidenceCatalog
}

const planSubjectGen: Gen<PlanSubject> = map(caseGen(defaultGenConfig), ([label, c]) => ({
	label,
	dag: c.query.dag,
	catalog: genCatalog(c.schema)
}))

/** A subject and two picks: the break among those that apply to it, and the site among the break's. */
const brokenGen =
	<S>(subject: Gen<S>): Gen<readonly [S, number, number]> =>
	(source) =>
		[source.draw(subject), source.draw(pickGen), source.draw(pickGen)] as const

type PlanBreak =
	| "a certificate dropped"
	| "a certificate's preserved heading forged"
	| "a placement certificate for a DISTINCT the plan does not place"
	| "a realization dropped"
	| "a realization of no node"
	| "verified for another context"
	| "a set form relaxed"
	| "a DISTINCT on a node that only delivers"
	| "a placed DISTINCT removed"
	| "a UNION relaxed to UNION ALL"

/** What a plan's break reached: the break, and a union's own certificate among the dropped ones. */
type PlanFeature = PlanBreak | "a union's certificate dropped"

/** A plan broken at one site, the context it is verified for, and whether the site drops a union's certificate. */
interface PlanSite {
	readonly plan: PlanUnderVerification
	readonly context: TemplateContext
	readonly union: boolean
}

const site = (plan: PlanUnderVerification, context: TemplateContext): PlanSite => ({
	plan,
	context,
	union: false
})

const planBreaks: Readonly<
	Record<
		PlanBreak,
		{
			readonly expect: Expect
			readonly sites: (p: DedupPlan, dag: RelDag) => ReadonlyArray<PlanSite>
		}
	>
> = {
	"a certificate dropped": {
		expect: exactly("missingCertificate"),
		sites: (p) =>
			Arr.map(indices(p.certificates.length), (i) => ({
				plan: { ...p, certificates: p.certificates.toSpliced(i, 1) },
				context: p.context,
				union: p.certificates[i]?.rule === "R17.unionAll"
			}))
	},
	"a certificate's preserved heading forged": {
		expect: including("certificate"),
		sites: (p) =>
			Arr.map(p.certificates, (c, i) =>
				site(
					{
						...p,
						certificates: Arr.map(p.certificates, (x, j) =>
							j === i ? { ...c, preservedHeading: [...c.preservedHeading, "forged"] } : x
						)
					},
					p.context
				)
			)
	},
	"a placement certificate for a DISTINCT the plan does not place": {
		expect: exactly("certificate"),
		sites: (p, dag) =>
			Arr.flatMap(p.certificates, (c) =>
				c.rule !== "R17.placement"
					? []
					: Arr.map(
							Arr.filter(
								topoOrder(dag),
								(n) => p.realization[n.id] !== "distinct" && !c.outputs.includes(n.id)
							),
							(n) =>
								site(
									{
										...p,
										certificates: [...p.certificates, { ...c, inputs: [n.id], outputs: [n.id] }]
									},
									p.context
								)
						)
			)
	},
	"a realization dropped": {
		expect: including("realizationCoverage"),
		sites: (p) =>
			Arr.map(Rec.keys(p.realization), (id) =>
				site(
					{
						...p,
						realization: Rec.fromEntries(
							Arr.filter(Rec.toEntries(p.realization), ([k]) => k !== id)
						)
					},
					p.context
				)
			)
	},
	"a realization of no node": {
		expect: exactly("realizationCoverage"),
		sites: (p) => [
			site({ ...p, realization: { ...p.realization, [NodeId("n_absent")]: "plain" } }, p.context)
		]
	},
	"verified for another context": {
		expect: exactly("context"),
		sites: (p) => [site(p, p.context === "snapshot" ? "transaction" : "snapshot")]
	},
	"a set form relaxed": {
		expect: including("pinnedSetForm"),
		sites: (p, dag) =>
			Arr.map(
				Arr.filter(
					topoOrder(dag),
					(n) => n.kind === "Recursive" || n.kind === "Intersect" || n.kind === "Difference"
				),
				(n) => site({ ...p, realization: { ...p.realization, [n.id]: "plain" } }, p.context)
			)
	},
	"a DISTINCT on a node that only delivers": {
		expect: including("unrealizableDistinct"),
		sites: (p, dag) =>
			Arr.map(
				Arr.filter(
					topoOrder(dag),
					(n) => n.kind === "Attach" || n.kind === "OrderedResult" || n.kind === "Forbid"
				),
				(n) => site({ ...p, realization: { ...p.realization, [n.id]: "distinct" } }, p.context)
			)
	},
	/** A DISTINCT the plan places, removed with its placement certificate: what read it as a set sees repeats. */
	"a placed DISTINCT removed": {
		expect: including("unprovedMultiplicity"),
		sites: (p) =>
			Arr.map(p.placements, (placed) =>
				site(
					{
						...p,
						certificates: Arr.filter(
							p.certificates,
							(c) => !(c.rule === "R17.placement" && c.outputs.includes(placed.node))
						),
						realization: { ...p.realization, [placed.node]: "plain" }
					},
					p.context
				)
			)
	},
	/** A union the plan realizes as UNION, its arms not told apart, realized as UNION ALL. */
	"a UNION relaxed to UNION ALL": {
		expect: including("unprovedUnionAll"),
		sites: (p, dag) =>
			Arr.map(
				Arr.filter(topoOrder(dag), (n) => n.kind === "Union" && p.realization[n.id] === "distinct"),
				(n) => site({ ...p, realization: { ...p.realization, [n.id]: "plain" } }, p.context)
			)
	}
}

const planBreakNames: Arr.NonEmptyReadonlyArray<PlanBreak> = [
	"a certificate dropped",
	"a certificate's preserved heading forged",
	"a placement certificate for a DISTINCT the plan does not place",
	"a realization dropped",
	"a realization of no node",
	"verified for another context",
	"a set form relaxed",
	"a DISTINCT on a node that only delivers",
	"a placed DISTINCT removed",
	"a UNION relaxed to UNION ALL"
]

describe("structural obligation verification", () => {
	it.effect(
		"reports each break of a placed plan under its rule, and passes the plan unbroken",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/dedup/verify/plan-breaks",
						literal: Formatter.format,
						kept: [],
						draw: drawn(brokenGen(planSubjectGen)),
						runs: 250,
						shrink: completeShrink,
						oracle: {
							kind: "specification",
							name: "each planted break's rule, and no problem in the plan the placement builds"
						},
						coverage: required<PlanFeature>([...planBreakNames, "a union's certificate dropped"], {
							cases: 300,
							sense: notesOnly
						}),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([subject, kindPick, sitePick], c) =>
						Effect.sync(() => {
							const env = {
								context: "snapshot" as const,
								catalog: subject.catalog,
								roots: "result" as const
							}
							const placed = succeeded(placeDeduplication(subject.dag, env))
							assert.deepEqual(
								succeeded(verifyMultiplicity(subject.dag, placed, env)).problems,
								[],
								`the placed plan of ${subject.label}`
							)
							const applicable = nonEmpty(
								Arr.filter(
									planBreakNames,
									(b) => planBreaks[b].sites(placed, subject.dag).length > 0
								),
								"a break that applies: a realization can always be dropped"
							)
							/** A case steering for a union's certificate drops it where the plan holds one. */
							const unions = Arr.filter(
								planBreaks["a certificate dropped"].sites(placed, subject.dag),
								(s) => s.union
							)
							const aimedAtUnion =
								Arr.isReadonlyArrayNonEmpty(unions) &&
								Option.exists(c.steering, (p) => p.names("a union's certificate dropped"))
							const name = aimedAtUnion
								? "a certificate dropped"
								: pickFrom(aimed(c, applicable), kindPick)
							const chosen = pickFrom(
								Arr.isReadonlyArrayNonEmpty(unions) && aimedAtUnion
									? unions
									: nonEmpty(planBreaks[name].sites(placed, subject.dag), "a site"),
								sitePick
							)
							const found = succeeded(
								verifyMultiplicity(subject.dag, chosen.plan, {
									context: chosen.context,
									catalog: subject.catalog,
									roots: "result"
								})
							).problems
							reported(found, planBreaks[name].expect, `${name} in ${subject.label}`)
							c.note(name)
							if (chosen.union) {
								c.note("a union's certificate dropped")
							}
						})
				)
			)
	)
})

/** A program to verify: the conservative lowering of a generated case over its own schema. */
interface ProgramSubject {
	readonly label: string
	readonly program: ChannelProgram
}

const generatedProgram = (c: QueryCase): ChannelProgram =>
	conservativeChannels(
		succeeded(
			lowerConservative(conservativeInput(c.query), {
				names: standInNames(c.schema.name, schemaCodes(c.schema)),
				params: genParamDecls(c.query),
				subject: { kind: "query" }
			})
		)
	)

const programSubjectGen: Gen<ProgramSubject> = map(caseGen(programConfig), ([label, c]) => ({
	label,
	program: generatedProgram(c)
}))

/** A query with every relation alias `from`, and every column reference through it, renamed `to`. */
const renamedAlias = (ast: Select, from: string, to: string): Select =>
	transformSelect(ast, {
		...identityHooks,
		fromSource: (item) => ("alias" in item && item.alias === from ? { ...item, alias: to } : item),
		expr: (e) => (e.kind === "column" && e.table === from ? { ...e, table: to } : e)
	})

/** The program with statement i replaced. */
const replaced = (
	p: ChannelProgram,
	i: number,
	replace: (s: FusedStatement) => FusedStatement
) => ({
	...p,
	roots: mapTree(p.roots, (s, k) => (k === i ? replace(s) : s))
})

const boolType = plainType("bool")

type ChannelBreak =
	| "the text edited"
	| "the slots dropped"
	| "a slot recast"
	| "a slot added"
	| "a result column renamed"
	| "the result heading cut short"
	| "the main statement twice"
	| "heading groups renumbered"
	| "the merge discriminant changed"
	| "a relation alias respelled"
	| "the text garbled"

/** A statement index and the program with that statement changed. */
const atEach = (
	p: ChannelProgram,
	keep: (s: FusedStatement) => boolean,
	change: (s: FusedStatement) => FusedStatement
): ReadonlyArray<ChannelProgram> =>
	Arr.flatMap(flight(p.roots), (s, i) => (keep(s) ? [replaced(p, i, change)] : []))

/** The relation aliases a statement's FROM items declare. */
const aliasesOf = (ast: Select): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformSelect(ast, {
		...identityHooks,
		fromSource: (item) => {
			if ("alias" in item && typeof item.alias === "string") {
				out.push(item.alias)
			}
			return item
		}
	})
	return out
}

const channelBreaks: Readonly<
	Record<
		ChannelBreak,
		{
			readonly expect: Expect
			readonly sites: (p: ChannelProgram) => ReadonlyArray<ChannelProgram>
		}
	>
> = {
	"the text edited": {
		expect: exactly("statementText"),
		sites: (p) =>
			atEach(
				p,
				() => true,
				(s) => ({ ...s, sql: { ...s.sql, text: testSql(`${s.sql.text}\n`) } })
			)
	},
	"the slots dropped": {
		expect: exactly("placeholders"),
		sites: (p) =>
			atEach(
				p,
				(s) => s.params.length > 0,
				(s) => ({ ...s, params: [] })
			)
	},
	"a slot recast": {
		expect: exactly("paramTypes"),
		sites: (p) =>
			atEach(
				p,
				(s) =>
					Arr.some(s.params, (slot) => slot.kind === "scalar" && slot.sqlType !== types.bigint),
				(s) => ({
					...s,
					params: Arr.map(s.params, (slot) =>
						slot.kind === "scalar" && slot.sqlType !== types.bigint
							? { ...slot, sqlType: types.bigint }
							: slot
					)
				})
			)
	},
	"a slot added": {
		expect: including("placeholders"),
		sites: (p) =>
			atEach(
				p,
				(s) => s.heading.length > 0,
				(s) => ({
					...s,
					params: [
						...s.params,
						{
							kind: "scalar",
							placeholder: "value",
							number: s.params.length + 1,
							param: ParamId("p_added"),
							type: present(s.heading[0], "a column").type,
							sqlType: types.uuid
						}
					]
				})
			)
	},
	"a result column renamed": {
		expect: including("resultColumns"),
		sites: (p) =>
			atEach(
				p,
				(s) => s.heading.length > 0,
				(s) => ({
					...s,
					heading: Arr.map(s.heading, (c, i) => (i === 0 ? { ...c, name: "renamed" } : c))
				})
			)
	},
	"the result heading cut short": {
		expect: including("resultColumns"),
		sites: (p) =>
			atEach(
				p,
				(s) => s.heading.length > 0,
				(s) => ({ ...s, heading: s.heading.slice(1) })
			)
	},
	"the main statement twice": {
		expect: including("statementRoles"),
		sites: (p) =>
			Arr.map(
				Arr.filter(flight(p.roots), (s) => s.role.kind === "main"),
				(s) => ({
					...p,
					roots: [
						{ statement: s, attachments: [] },
						{ statement: s, attachments: [] }
					]
				})
			)
	},
	"heading groups renumbered": {
		expect: exactly("merge"),
		sites: (p) =>
			p.roots.length < 2
				? []
				: [
						{
							...p,
							roots: mapNonEmpty(p.roots, (tree, i) => {
								const role = tree.statement.role
								return role.kind === "headingGroup"
									? {
											...tree,
											statement: {
												...tree.statement,
												role: { ...role, group: p.roots.length - 1 - i }
											}
										}
									: tree
							})
						}
					]
	},
	"the merge discriminant changed": {
		expect: exactly("merge"),
		sites: (p) =>
			p.delivery.kind === "headingGroups"
				? [
						{
							...p,
							delivery: { ...p.delivery, discriminant: [...p.delivery.discriminant, "absent"] }
						}
					]
				: []
	},
	"a relation alias respelled": {
		expect: exactly("statementAudit"),
		sites: (p) =>
			atEach(
				p,
				(s) => aliasesOf(s.ast).length > 0,
				(s) => {
					const ast = renamedAlias(s.ast, present(aliasesOf(s.ast)[0], "an alias"), "x_respelled")
					return { ...s, ast, sql: { ...s.sql, text: testSql(printStatement(ast)) } }
				}
			)
	},
	"the text garbled": {
		expect: exactly("statementText", "placeholders"),
		sites: (p) =>
			atEach(
				p,
				() => true,
				(s) => ({ ...s, sql: { ...s.sql, text: testSql(`${s.sql.text} '`) } })
			)
	}
}

const channelBreakNames: Arr.NonEmptyReadonlyArray<ChannelBreak> = [
	"the text edited",
	"the slots dropped",
	"a slot recast",
	"a slot added",
	"a result column renamed",
	"the result heading cut short",
	"the main statement twice",
	"heading groups renumbered",
	"the merge discriminant changed",
	"a relation alias respelled",
	"the text garbled"
]

type ArtifactBreak =
	| "a delivered column retyped"
	| "a delivering statement dropped"
	| "the heading-group merge dropped"

const artifactBreaks: Readonly<
	Record<ArtifactBreak, (p: ChannelProgram) => ReadonlyArray<ChannelProgram>>
> = {
	"a delivered column retyped": (p) =>
		atEach(
			p,
			(s) => s.role.kind !== "attachment" && Arr.some(s.heading, (c) => c.type.carrier !== "bool"),
			(s) => ({
				...s,
				heading: Arr.map(s.heading, (c) => ({
					...c,
					type: c.type.carrier === "bool" ? c.type : boolType
				}))
			})
		),
	"a delivering statement dropped": (p) => {
		const [first, ...rest] = p.roots
		return rest.length === 0 ? [] : [{ ...p, roots: [first, ...rest.slice(0, -1)] }]
	},
	"the heading-group merge dropped": (p) =>
		p.delivery.kind === "headingGroups" ? [{ ...p, delivery: { kind: "rows" } }] : []
}

const artifactBreakNames: Arr.NonEmptyReadonlyArray<ArtifactBreak> = [
	"a delivered column retyped",
	"a delivering statement dropped",
	"the heading-group merge dropped"
]

describe("codec and result-channel alignment", () => {
	it.effect(
		"reports each break of a lowered program's statements under its rule, and passes the program unbroken",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/dedup/verify/channel-breaks",
						literal: Formatter.format,
						kept: [],
						draw: drawn(brokenGen(programSubjectGen)),
						runs: 300,
						shrink: completeShrink,
						oracle: {
							kind: "specification",
							name: "each planted break's rule, and no problem in the program the conservative lowering builds"
						},
						coverage: required<ChannelBreak>(channelBreakNames, { cases: 300, sense: notesOnly }),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([subject, kindPick, sitePick], c) =>
						Effect.sync(() => {
							assert.deepEqual(channelProblems(subject.program, "statement"), [], subject.label)
							const applicable = nonEmpty(
								Arr.filter(
									channelBreakNames,
									(b) => channelBreaks[b].sites(subject.program).length > 0
								),
								"a break that applies: a text can always be edited"
							)
							const name = pickFrom(aimed(c, applicable), kindPick)
							const broken = pickFrom(
								nonEmpty(channelBreaks[name].sites(subject.program), "a site"),
								sitePick
							)
							reported(
								channelProblems(broken, "statement"),
								channelBreaks[name].expect,
								`${name} in ${subject.label}`
							)
							c.note(name)
						})
				)
			)
	)

	it.effect(
		"reports each artifact that delivers other rows channels than its twin, in both directions",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/dedup/verify/artifact-breaks",
						literal: Formatter.format,
						kept: [],
						draw: drawn(brokenGen(programSubjectGen)),
						runs: 150,
						shrink: completeShrink,
						oracle: {
							kind: "specification",
							name: "each planted break is the artifacts rule both ways, and a program is its own twin"
						},
						coverage: required<ArtifactBreak>(artifactBreakNames, { cases: 200, sense: notesOnly }),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([subject, kindPick, sitePick], c) =>
						Effect.sync(() => {
							assert.deepEqual(
								artifactProblems(subject.program, subject.program),
								[],
								subject.label
							)
							const applicable = Arr.filter(
								artifactBreakNames,
								(b) => artifactBreaks[b](subject.program).length > 0
							)
							if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
								return
							}
							const name = pickFrom(aimed(c, applicable), kindPick)
							const broken = pickFrom(
								nonEmpty(artifactBreaks[name](subject.program), "a site"),
								sitePick
							)
							assert.deepEqual(
								rulesOf(artifactProblems(broken, subject.program)),
								["artifacts"],
								name
							)
							assert.deepEqual(
								rulesOf(artifactProblems(subject.program, broken)),
								["artifacts"],
								name
							)
							c.note(name)
						})
				)
			)
	)
})
