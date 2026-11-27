/** What the properties of verify.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { contains, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, type Gen, map, oneOf, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type DeclaredParamSlot,
	flight
} from "#compiler/lower/conservative/types.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import {
	conservativeStatement,
	type DeliveredPart,
	type FusedStatement,
	type SentStatement
} from "#compiler/lower/shapes/index.ts"
import { mapTree } from "#compiler/runtime/lower/tree.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { Select, UnprintedSql } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { emitText, costChosen } from "#compiler/sql/emit.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
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
import type { ChannelProgram } from "#test/support/oracle/verify/channels.ts"
import type { PlanUnderVerification } from "#test/support/oracle/verify/multiplicity.ts"
import type { VerificationProblem } from "#test/support/oracle/verify/problems.ts"
import { pickGen } from "#test/support/pick.ts"
import { testSql } from "#test/support/sql.ts"
import { present } from "#test/unit/lower/support.ts"

/** The verification rules. */
type Rule = VerificationProblem["rule"]

export const rulesOf = (ps: ReadonlyArray<{ readonly rule: Rule }>) => [
	...new Set(Arr.map(ps, (p) => p.rule))
]

/** What a break must be reported as: exactly these rules, or this rule among those the break also breaks. */
type Expect =
	| { readonly kind: "exactly"; readonly rules: ReadonlyArray<Rule> }
	| { readonly kind: "including"; readonly rule: Rule }

const exactly = (...rules: ReadonlyArray<Rule>): Expect => ({ kind: "exactly", rules })

const including = (rule: Rule): Expect => ({ kind: "including", rule })

export const reported = (
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
 * The options a case may take, aimed: those it aims at (brokenSpace), where it aims at any, else every option,
 * so a witness case spends its draw on a break no case has reached yet.
 */
export const aimedOptions = <F extends string, B extends F>(
	aims: ReadonlyArray<F>,
	options: Arr.NonEmptyReadonlyArray<B>
): Arr.NonEmptyReadonlyArray<B> => {
	const pending = Arr.filter(options, (b) => Arr.contains(aims, b))
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

export const planSubjectGen: Gen<PlanSubject> = map(caseGen(defaultGenConfig), ([label, c]) => ({
	label,
	dag: c.query.dag,
	catalog: genCatalog(c.schema)
}))

/**
 * A subject, two picks (the break among those that apply to it, and the site among the break's), and the features the
 * case aims at.
 */
type Broken<S, F extends string> = readonly [
	subject: S,
	kindPick: number,
	sitePick: number,
	aims: ReadonlyArray<F>
]

/** A broken subject: a subject, two picks, and `aims`, the features the case aims at. */
const brokenGen =
	<S, F extends string>(subject: Gen<S>, aims: ReadonlyArray<F>): Gen<Broken<S, F>> =>
	(source) => [source.draw(subject), source.draw(pickGen), source.draw(pickGen), aims]

/**
 * Broken subjects aimed at `features`: a case whose turn aims at one of them draws a subject that aims at it alone, so
 * the case spends its draw on that break; every other case aims at none and runs as drawn.
 */
export const brokenSpace = <S, const F extends string>(
	subject: Gen<S>,
	features: Arr.NonEmptyReadonlyArray<F>
): Aimed<Broken<S, F>, F> =>
	aimed(
		brokenGen(subject, []),
		Arr.map(features, (feature) => [feature, brokenGen(subject, [feature])] as const)
	)

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
export type PlanFeature = PlanBreak | "a union's certificate dropped"

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

export const planBreaks: Readonly<
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

export const planBreakNames: Arr.NonEmptyReadonlyArray<PlanBreak> = [
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

export const planFeatures: Arr.NonEmptyReadonlyArray<PlanFeature> = [
	...planBreakNames,
	"a union's certificate dropped"
]

/** A program to verify: the conservative lowering of a generated case over its own schema. */
interface ProgramSubject {
	readonly label: string
	readonly program: ChannelProgram
}

const generatedProgram = (c: QueryCase): ChannelProgram =>
	conservativeStatement(
		succeeded(
			lowerConservative(conservativeInput(c.query), {
				names: standInNames(c.schema.name, schemaCodes(c.schema)),
				params: genParamDecls(c.query),
				subject: { kind: "query" }
			})
		)
	)

export const programSubjectGen: Gen<ProgramSubject> = map(caseGen(programConfig), ([label, c]) => ({
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

/** The program with the statement it sends changed. */
const sentAs = (
	p: ChannelProgram,
	change: (s: SentStatement) => SentStatement
): ChannelProgram => ({
	...p,
	statement: change(p.statement)
})

/** The program with its one part's lowered statement changed, where it has one part `keep` holds of. */
const oneAs = (
	p: ChannelProgram,
	keep: (s: FusedStatement<DeclaredParamSlot, UnprintedSql>) => boolean,
	change: (
		s: FusedStatement<DeclaredParamSlot, UnprintedSql>
	) => FusedStatement<DeclaredParamSlot, UnprintedSql>
): ReadonlyArray<ChannelProgram> =>
	p.parts.kind === "one" && keep(p.parts.delivered)
		? [{ ...p, parts: { kind: "one", delivered: change(p.parts.delivered) } }]
		: []

const boolType = plainType("bool")

export type ChannelBreak =
	| "the text edited"
	| "the slots dropped"
	| "a slot recast"
	| "a slot added"
	| "a result column renamed"
	| "the result heading cut short"
	| "a part's cells cut short"
	| "the main statement twice"
	| "heading groups renumbered"
	| "the merge discriminant changed"
	| "a relation alias respelled"
	| "the text garbled"

/** For each delivered relation `keep` holds of, the program with that relation changed. */
const atEach = (
	p: ChannelProgram,
	keep: (s: DeliveredPart) => boolean,
	change: (s: DeliveredPart) => DeliveredPart
): ReadonlyArray<ChannelProgram> =>
	Arr.flatMap(flight(p.roots), (s, i) =>
		keep(s) ? [{ ...p, roots: mapTree(p.roots, (t, k) => (k === i ? change(t) : t)) }] : []
	)

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

export const channelBreaks: Readonly<
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
		sites: (p) => [sentAs(p, (s) => ({ ...s, ast: { ...s.ast } }))]
	},
	"the slots dropped": {
		expect: exactly("placeholders"),
		sites: (p) => (p.statement.params.length > 0 ? [sentAs(p, (s) => ({ ...s, params: [] }))] : [])
	},
	"a slot recast": {
		expect: exactly("paramTypes"),
		sites: (p) =>
			Arr.some(
				p.statement.params,
				(slot) => slot.kind === "scalar" && slot.sqlType !== types.bigint
			)
				? [
						sentAs(p, (s) => ({
							...s,
							params: Arr.map(s.params, (slot) =>
								slot.kind === "scalar" && slot.sqlType !== types.bigint
									? { ...slot, sqlType: types.bigint }
									: slot
							)
						}))
					]
				: []
	},
	"a slot added": {
		expect: including("placeholders"),
		sites: (p) =>
			Arr.flatMap(
				Option.toArray(Arr.findFirst(flight(p.roots), (r) => r.heading.length > 0)),
				(r) => [
					sentAs(p, (s) => ({
						...s,
						params: [
							...s.params,
							{
								kind: "scalar",
								placeholder: "value",
								number: s.params.length + 1,
								param: ParamId("p_added"),
								type: present(r.heading[0], "a column").type,
								sqlType: types.uuid
							}
						]
					}))
				]
			)
	},
	"a result column renamed": {
		expect: including("resultColumns"),
		sites: (p) =>
			oneAs(
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
			oneAs(
				p,
				(s) => s.heading.length > 0,
				(s) => ({ ...s, heading: s.heading.slice(1) })
			)
	},
	"a part's cells cut short": {
		expect: including("parts"),
		sites: (p) =>
			atEach(
				p,
				(s) => s.heading.length > 1,
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
			aliasesOf(p.statement.ast).length > 0
				? [
						sentAs(p, (s) => {
							const ast = renamedAlias(
								s.ast,
								present(aliasesOf(s.ast)[0], "an alias"),
								"x_respelled"
							)
							return { ...s, ast, sql: emitText(ast, s.sql.nameMap, costChosen()) }
						})
					]
				: []
	},
	"the text garbled": {
		expect: exactly("statementText", "placeholders"),
		sites: (p) => [
			sentAs(p, (s) => ({ ...s, sql: { ...s.sql, text: testSql(`${s.sql.text} '`) } }))
		]
	}
}

export const channelBreakNames: Arr.NonEmptyReadonlyArray<ChannelBreak> = [
	"the text edited",
	"the slots dropped",
	"a slot recast",
	"a slot added",
	"a result column renamed",
	"the result heading cut short",
	"a part's cells cut short",
	"the main statement twice",
	"heading groups renumbered",
	"the merge discriminant changed",
	"a relation alias respelled",
	"the text garbled"
]

export type ArtifactBreak =
	| "a delivered column retyped"
	| "a delivering statement dropped"
	| "the heading-group merge dropped"

export const artifactBreaks: Readonly<
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

export const artifactBreakNames: Arr.NonEmptyReadonlyArray<ArtifactBreak> = [
	"a delivered column retyped",
	"a delivering statement dropped",
	"the heading-group merge dropped"
]
