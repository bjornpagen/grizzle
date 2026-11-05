import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { appendNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { conservativeMeta, type RelDag, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight, mapTree } from "#compiler/lower/conservative/types.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import type { FusedAttachment } from "#compiler/lower/shapes/attach/decode.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import type { Expr, Select } from "#compiler/sql/ast.ts"
import { binary, call, core, select, targetAs, types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { assert, contains, nonEmpty, succeeded } from "#test/support/assert.ts"
import { genCatalog, ownedFixture } from "#test/support/evidence.ts"
import { asc, Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { localVectorSchema, productionNames, standInNames } from "#test/support/kernel/naming.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	artifactProblems,
	type ChannelProgram,
	channelProblems,
	conservativeChannels
} from "#test/support/oracle/verify/channels.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	type PlanUnderVerification,
	verifyMultiplicity
} from "#test/support/oracle/verify/multiplicity.ts"
import type { VerificationProblem } from "#test/support/oracle/verify/problems.ts"
import { testSql } from "#test/support/sql.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * The kernel's verification of a lowering (test/support/oracle/verify): every required set boundary discharged, no
 * sensitive consumer seeing unproved multiplicity, every certificate the one its rewrite's proof gives, and codecs and
 * result channels aligned. That the plans and programs the compiler builds pass is dedup/soundness's over generated
 * cases. Here each rule is held
 * to its break: a population of plans and programs (generated query cases, and the Shop fixture's planted ones for what
 * the generator rarely builds: a fold, a recursion, set operations, attachments, heading groups, a zero-column result),
 * each broken at one drawn site of one drawn break, picked by kind first, is reported under the break's rule (exactly
 * that rule where the break touches nothing else). Rules no generated plan reaches (a COUNT or a bound over unproved
 * multiplicity, UNION ALL over arms not told apart or without its certificate) and the fused-attachment comparison
 * are properties over planted sketches.
 */

const Person = relation(
	"Person",
	{ id: f.uuid, email: f.regex("^[a-z]{1,20}$", "u"), city: f.wildcard },
	["id"]
)
const Purchase = relation("Purchase", { id: f.uuid, person: f.uuid }, ["id"])
const Posting = relation("Posting", { id: f.uuid, account: f.uuid, amount: f.bigint }, ["id"])
const Edge = relation("Edge", { src: f.bigint, dst: f.bigint }, ["src", "dst"])
const Schema: SchemaDesc = {
	name: "Shop",
	relations: [Person, Purchase, Posting, Edge],
	statements: [key(on("Person", ["email"]))],
	extends: undefined
}

const fixture = ownedFixture(Schema)

const ir = () => new Ir(new SchemaModel(fixture, {}))

/** The schema's own catalog, every key named as ownership installs it. */
const installed = fixture.catalog

const plan = (dag: RelDag, context: TemplateContext): DedupPlan =>
	succeeded(placeDeduplication(dag, { context, catalog: installed, roots: "result" }))

const problems = (dag: RelDag, p: PlanUnderVerification, context: TemplateContext) =>
	succeeded(verifyMultiplicity(dag, p, { context, catalog: installed, roots: "result" })).problems

const rulesOf = (ps: ReadonlyArray<{ readonly rule: string }>) => [
	...new Set(Arr.map(ps, (p) => p.rule))
]

const without = (p: DedupPlan, drop: (c: Certificate) => boolean): PlanUnderVerification => ({
	...p,
	certificates: Arr.filter(p.certificates, (c) => !drop(c))
})

/** A bound tuple short of the base identity: postings bound only on (account, amount), counted per account. */
const countPerAccount = () => {
	const m = ir()
	const r = m.region(
		[{ source: m.base("Posting"), bind: { account: "account", amount: "amount" }, constants: {} }],
		conservativeMeta
	)
	const g = m.group(
		r,
		["account", "amount"],
		["account"],
		[{ name: "n", agg: "count" }],
		conservativeMeta
	)
	return { dag: m.build(g).dag, r, g }
}

/** The channels of programs the conservative lowering builds, which are aligned by construction. */
const names = productionNames("Shop", { kind: "declared" }, localVectorSchema)

const lowered = (dag: ValidDag, root: RelNode): ChannelProgram =>
	conservativeChannels(
		succeeded(
			lowerConservative(
				{ dag, root },
				{
					names,
					params: [],
					subject: { kind: "query" }
				}
			)
		)
	)

const attachedProgram = () => {
	const m = ir()
	const text = m.column(m.base("Person"), "city").type
	const base = m.base("Person")
	const parent = m.region(
		[
			{
				source: base,
				bind: { id: "u", email: "email" },
				constants: { city: m.param("city", text, "compare") }
			}
		],
		conservativeMeta
	)
	const child = m.region(
		[{ source: m.base("Purchase"), bind: { id: "p", person: "u" }, constants: {} }],
		conservativeMeta
	)
	const a = m.attach(parent, child, "purchases", [["u", "u"]], "array", undefined)
	const { dag, root } = m.build(a)
	return lowered(dag, root)
}

const unionProgram = () => {
	const m = ir()
	const text = m.column(m.base("Person"), "city").type
	const people = m.region(
		[{ source: m.base("Person"), bind: { id: "id", email: "email" }, constants: {} }],
		conservativeMeta
	)
	const buyers = m.region(
		[{ source: m.base("Purchase"), bind: { id: "id", person: "person" }, constants: {} }],
		conservativeMeta
	)
	const u = m.union(
		[
			m.project(
				people,
				[
					["id", "id"],
					["tag", m.lit("person", text)],
					["email", "email"]
				],
				conservativeMeta
			),
			m.project(
				buyers,
				[
					["id", "id"],
					["tag", m.lit("purchase", text)],
					["person", "person"]
				],
				conservativeMeta
			)
		],
		["tag"],
		conservativeMeta
	)
	const { dag, root } = m.build(u)
	return lowered(dag, root)
}

/**
 * The attached program with its attachment fused into the main statement as ARRAY(SELECT to_jsonb(c) ...) over the
 * child's heading, correlated on the parent key: a stand-in for the optimized lowering's fused form.
 */
const fusedProgram = (conservative: ChannelProgram): ChannelProgram => {
	const [root] = conservative.roots
	const main = root.statement
	const [attached] = root.attachments
	if (attached?.statement.role.kind !== "attachment") {
		throw new Error("expected an attached program")
	}
	const child = attached.statement
	const attachment = { attach: attached.attach, parentKey: attached.statement.role.parentKey }
	const body = main.ast.body
	if (body.kind !== "core") {
		throw new Error("expected a core")
	}
	const keyAt = Option.getOrThrowWith(
		Arr.findFirstIndex(main.heading, (c) => c.name === "u"),
		() => new Error("a column the case's own heading holds")
	)
	const parentKey = body.targets[keyAt]?.expr
	if (parentKey === undefined) {
		throw new Error("expected the parent key")
	}
	const purchase = (field: string): Expr => ({
		kind: "column",
		table: "r20",
		column: names.column("Purchase", field)
	})
	const own = child.heading
	if (!Arr.isReadonlyArrayNonEmpty(own)) {
		throw new Error("expected an attachment of at least one column")
	}
	const element: Select = select(
		core(
			[
				targetAs(
					call("to_jsonb", [
						{ kind: "row", items: Arr.map(own, (c) => purchase(c.name === "p" ? "id" : "person")) }
					]),
					"c22"
				)
			],
			[{ kind: "table", table: names.relation("Purchase"), alias: "r20" }],
			binary("=", purchase("person"), parentKey)
		)
	)
	const ast: Select = {
		...main.ast,
		body: {
			...body,
			targets: appendNonEmpty(
				body.targets,
				targetAs({ kind: "array", query: element }, "purchases")
			)
		}
	}
	return {
		roots: [
			{
				statement: {
					...main,
					ast,
					sql: { ...main.sql, text: testSql(printStatement(ast)) },
					fused: [
						{
							attach: attachment.attach.id,
							name: attachment.attach.name,
							parentColumns: Arr.map(attachment.parentKey, (c) => c.name),
							layout: {
								columns: Arr.map(own, (column) => ({ column, source: { from: "element" } }))
							}
						}
					]
				},
				attachments: []
			}
		],
		delivery: { kind: "rows" }
	}
}

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

/** The program with statement i's members changed, its role and what the role carries kept. */
const edit = (
	p: ChannelProgram,
	i: number,
	change: (s: FusedStatement) => Partial<Omit<FusedStatement, "role" | "dependsOn">>
) => replaced(p, i, (s) => ({ ...s, ...change(s) }))

/** A zero-column result: the person ids projected to nothing, delivered through the private unit column. */
const unitProgram = () => {
	const m = ir()
	const r = m.region(
		[{ source: m.base("Person"), bind: { id: "id" }, constants: {} }],
		conservativeMeta
	)
	const { dag, root } = m.build(m.project(r, [], conservativeMeta))
	return lowered(dag, root)
}

/** The fused program with its one fused attachment changed. */
const reshape = (p: ChannelProgram, change: (f: FusedAttachment) => FusedAttachment) =>
	edit(p, 0, (s) => ({ fused: Arr.map(s.fused, change) }))

const boolType = plainType("bool")

/** The verification rules. */
type Rule = VerificationProblem["rule"]

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
		assert.deepEqual(rulesOf(found), [...expect.rules], why)
	} else {
		contains(rulesOf(found), expect.rule, why)
	}
}

/** A plan to verify: a DAG and the catalog its plan was placed under. */
interface PlanSubject {
	readonly label: string
	readonly dag: RelDag
	readonly catalog: EvidenceCatalog
}

/** What a fused-attachment edit is caught by: the named rules of one check, or only by the other check. */
type Checked =
	| { readonly kind: "checked"; readonly rules: ReadonlyArray<Rule> }
	| { readonly kind: "the other check's" }

const checked = (...rules: ReadonlyArray<Rule>): Checked => ({ kind: "checked", rules })

const otherCheck: Checked = { kind: "the other check's" }

/**
 * The Shop fixture's planted DAGs, for what generated queries rarely hold: a fold, a bound over a repeating projection,
 * a recursion, an intersection, an ordered result, an attachment, a tagged union and an existence.
 */
const shopSubjects = (): ReadonlyArray<PlanSubject> => {
	const subject = (label: string, build: (m: Ir) => RelNode): PlanSubject => {
		const m = ir()
		return { label, dag: m.build(build(m)).dag, catalog: installed }
	}
	/** Every person's city, once per person. */
	const cities = (m: Ir) =>
		m.region(
			[{ source: m.base("Person"), bind: { city: "city" }, constants: {} }],
			conservativeMeta
		)
	return [
		{
			label: "a count over a bound tuple short of the key",
			dag: countPerAccount().dag,
			catalog: installed
		},
		subject("a bound over a projection that repeats", (m) =>
			m.take(cities(m), asc("city"), { kind: "literal", k: 2n }, conservativeMeta)
		),
		subject("a recursion", (m) => reachOver(m)),
		subject("an intersection", (m) => {
			const l = m.region(
				[{ source: m.base("Person"), bind: { id: "id" }, constants: {} }],
				conservativeMeta
			)
			const r = m.region(
				[{ source: m.base("Purchase"), bind: { person: "id" }, constants: {} }],
				conservativeMeta
			)
			return m.b.node({
				kind: "Intersect",
				left: l,
				right: r,
				heading: l.heading,
				loc: undefined,
				meta: conservativeMeta
			})
		}),
		subject("an ordered result", (m) => m.ordered(cities(m), asc("city"))),
		subject("an attachment", (m) => {
			const parent = m.region(
				[{ source: m.base("Person"), bind: { id: "u", city: "city" }, constants: {} }],
				conservativeMeta
			)
			const child = m.region(
				[{ source: m.base("Purchase"), bind: { id: "p", person: "u" }, constants: {} }],
				conservativeMeta
			)
			return m.attach(parent, child, "purchases", [["u", "u"]], "array", undefined)
		}),
		subject("a tagged union", (m) => taggedArms(m, ["person", "purchase"])),
		subject("an existence", (m) => {
			const people = m.region(
				[{ source: m.base("Person"), bind: { id: "id" }, constants: {} }],
				conservativeMeta
			)
			const buyers = m.region(
				[{ source: m.base("Purchase"), bind: { person: "person" }, constants: {} }],
				conservativeMeta
			)
			return m.semi(people, buyers, [["id", "person"]])
		})
	]
}

/** The closure of Edge from every edge: its step joins the feedback to Edge. */
const reachOver = (m: Ir): RelNode => {
	const t = m.column(m.base("Edge"), "src").type
	const seed = m.region(
		[{ source: m.base("Edge"), bind: { src: "src", dst: "dst" }, constants: {} }],
		conservativeMeta
	)
	return m.recursive(
		"reach",
		[
			["src", t],
			["dst", t]
		],
		seed,
		(self) => {
			const r = m.region(
				[
					{ source: self, bind: { src: "src", dst: "mid" }, constants: {} },
					{ source: m.base("Edge"), bind: { src: "mid", dst: "dst" }, constants: {} }
				],
				conservativeMeta
			)
			return m.project(
				r,
				[
					["src", "src"],
					["dst", "dst"]
				],
				conservativeMeta
			)
		}
	)
}

/** The ids of people and of purchases, each arm tagged by a text literal: told apart when the tags differ. */
const taggedArms = (m: Ir, tags: readonly [string, string]): RelNode => {
	const text = m.column(m.base("Person"), "city").type
	const arm = (rel: "Person" | "Purchase", tag: string) =>
		m.project(
			m.region([{ source: m.base(rel), bind: { id: "id" }, constants: {} }], conservativeMeta),
			[
				["id", "id"],
				["tag", m.lit(tag, text)]
			],
			conservativeMeta
		)
	return m.union([arm("Person", tags[0]), arm("Purchase", tags[1])], [], conservativeMeta)
}

/**
 * Generated query cases over their own schemas, and the Shop fixture's planted DAGs.
 * Planted: every break on the first planted subject it applies to, its pick the break's place among the breaks that
 * apply there, since a subject drawn from the generator or the planted ones meets some breaks a few times a run.
 */
const plantedBreaks = <S, B extends string>(
	subjects: ReadonlyArray<S>,
	breakNames: ReadonlyArray<B>,
	applies: (name: B, subject: S) => boolean
): ReadonlyArray<Kept<readonly [S, number, number], B>> =>
	Arr.map(breakNames, (name) => {
		const subject = Option.getOrThrowWith(
			Arr.findFirst(subjects, (s) => applies(name, s)),
			() => new Error(`a planted subject ${name} applies to`)
		)
		return {
			note: name,
			sketch: [
				subject,
				Arr.filter(breakNames, (b) => applies(b, subject)).indexOf(name),
				0
			] as const,
			draws: "",
			reaches: [name]
		}
	})

const planSubjectGen: Gen<PlanSubject> = oneOf([
	map(queryCaseGen(defaultGenConfig), (c): PlanSubject => ({
		label: "a generated query",
		dag: c.query.dag,
		catalog: genCatalog(c.schema)
	})),
	element(nonEmpty(shopSubjects(), "the Shop fixture's subjects"))
])

/**
 * A subject and two picks, the break among those that apply to it and the site among the break's, each read modulo the
 * count the property finds.
 */
const brokenGen =
	<S>(subject: Gen<S>): Gen<readonly [S, number, number]> =>
	(source) =>
		[
			source.draw(subject),
			source.draw(int(0, 2 ** 31 - 1)),
			source.draw(int(0, 2 ** 31 - 1))
		] as const

type PlanBreak =
	| "a certificate dropped"
	| "a certificate's preserved heading forged"
	| "a placement certificate for a DISTINCT the plan does not place"
	| "a realization dropped"
	| "a realization of no node"
	| "a fold form dropped"
	| "a fold form of no fold"
	| "verified for another context"
	| "a set form relaxed"
	| "a DISTINCT on a node that only delivers"

/** A plan broken at one site, and the context it is verified for. */
interface PlanSite {
	readonly plan: PlanUnderVerification
	readonly context: TemplateContext
}

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
				context: p.context
			}))
	},
	"a certificate's preserved heading forged": {
		expect: including("certificate"),
		sites: (p) =>
			Arr.map(p.certificates, (c, i) => ({
				plan: {
					...p,
					certificates: Arr.map(p.certificates, (x, j) =>
						j === i ? { ...c, preservedHeading: [...c.preservedHeading, "forged"] } : x
					)
				},
				context: p.context
			}))
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
							(n) => ({
								plan: {
									...p,
									certificates: [...p.certificates, { ...c, inputs: [n.id], outputs: [n.id] }]
								},
								context: p.context
							})
						)
			)
	},
	"a realization dropped": {
		expect: including("realizationCoverage"),
		sites: (p) =>
			Arr.map(Rec.keys(p.realization), (id) => ({
				plan: {
					...p,
					realization: Rec.fromEntries(Arr.filter(Rec.toEntries(p.realization), ([k]) => k !== id))
				},
				context: p.context
			}))
	},
	"a realization of no node": {
		expect: exactly("realizationCoverage"),
		sites: (p) => [
			{
				plan: { ...p, realization: { ...p.realization, [NodeId("n_absent")]: "plain" } },
				context: p.context
			}
		]
	},
	"a fold form dropped": {
		expect: including("foldCoverage"),
		sites: (p) =>
			Arr.map(Rec.keys(p.folds), (id) => ({
				plan: {
					...p,
					folds: Rec.fromEntries(Arr.filter(Rec.toEntries(p.folds), ([k]) => k !== id))
				},
				context: p.context
			}))
	},
	"a fold form of no fold": {
		expect: exactly("foldCoverage"),
		sites: (p, dag) =>
			Arr.map(
				Arr.filter(topoOrder(dag), (n) => !(n.id in p.folds)),
				(n) => ({
					plan: { ...p, folds: { ...p.folds, [n.id]: { input: "plain" } } },
					context: p.context
				})
			)
	},
	"verified for another context": {
		expect: exactly("context"),
		sites: (p) => [{ plan: p, context: p.context === "snapshot" ? "transaction" : "snapshot" }]
	},
	"a set form relaxed": {
		expect: including("pinnedSetForm"),
		sites: (p, dag) =>
			Arr.map(
				Arr.filter(
					topoOrder(dag),
					(n) => n.kind === "Recursive" || n.kind === "Intersect" || n.kind === "Difference"
				),
				(n) => ({
					plan: { ...p, realization: { ...p.realization, [n.id]: "plain" } },
					context: p.context
				})
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
				(n) => ({
					plan: { ...p, realization: { ...p.realization, [n.id]: "distinct" } },
					context: p.context
				})
			)
	}
}

const planBreakNames: Arr.NonEmptyReadonlyArray<PlanBreak> = [
	"a certificate dropped",
	"a certificate's preserved heading forged",
	"a placement certificate for a DISTINCT the plan does not place",
	"a realization dropped",
	"a realization of no node",
	"a fold form dropped",
	"a fold form of no fold",
	"verified for another context",
	"a set form relaxed",
	"a DISTINCT on a node that only delivers"
]

/** The rules no generated plan breaks, each over a planted Shop plan: its unbroken plan passes, and the break is reported. */
type PlantedPlanBreak =
	| "a count over unproved multiplicity"
	| "a bound over a projection that repeats"
	| "UNION ALL over arms not told apart"
	| "UNION ALL over tagged arms without its certificate"

const plantedPlans: Readonly<
	Record<
		PlantedPlanBreak,
		{
			readonly expect: Expect
			readonly broken: () => {
				readonly dag: RelDag
				readonly good: DedupPlan
				readonly bad: PlanUnderVerification
			}
		}
	>
> = {
	/** The fold's contribution DISTINCT removed, and its placement certificate with it. */
	"a count over unproved multiplicity": {
		expect: exactly("unprovedMultiplicity"),
		broken: () => {
			const { dag, g } = countPerAccount()
			const good = plan(dag, "snapshot")
			return {
				dag,
				good,
				bad: {
					...without(good, (c) => c.rule === "R17.placement"),
					folds: { [g.id]: { input: "plain" } }
				}
			}
		}
	},
	/** The projection's DISTINCT removed: the take's elision rested on it, so its certificate no longer holds either. */
	"a bound over a projection that repeats": {
		expect: exactly("unprovedMultiplicity", "certificate"),
		broken: () => {
			const m = ir()
			const r = m.region(
				[{ source: m.base("Person"), bind: { city: "city" }, constants: {} }],
				conservativeMeta
			)
			const dag = m.build(m.take(r, asc("city"), { kind: "literal", k: 2n }, conservativeMeta)).dag
			const good = plan(dag, "snapshot")
			return {
				dag,
				good,
				bad: {
					...without(good, (c) => c.rule === "R17.placement"),
					realization: { ...good.realization, [r.id]: "plain" }
				}
			}
		}
	},
	"UNION ALL over arms not told apart": {
		expect: exactly("unprovedUnionAll", "unprovedMultiplicity"),
		broken: () => {
			const m = ir()
			const u = taggedArms(m, ["x", "x"])
			const dag = m.build(u).dag
			const good = plan(dag, "snapshot")
			return { dag, good, bad: { ...good, realization: { ...good.realization, [u.id]: "plain" } } }
		}
	},
	"UNION ALL over tagged arms without its certificate": {
		expect: exactly("missingCertificate"),
		broken: () => {
			const m = ir()
			const dag = m.build(taggedArms(m, ["person", "purchase"])).dag
			const good = plan(dag, "snapshot")
			return { dag, good, bad: without(good, (c) => c.rule === "R17.unionAll") }
		}
	}
}

describe("structural obligation verification", () => {
	it.effect("reports each break of a placed plan under its rule", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/verify/plan-breaks",
					literal: Formatter.format,
					kept: plantedBreaks(shopSubjects(), planBreakNames, (name, subject) => {
						const placed = succeeded(
							placeDeduplication(subject.dag, {
								context: "snapshot",
								catalog: subject.catalog,
								roots: "result"
							})
						)
						return planBreaks[name].sites(placed, subject.dag).length > 0
					}),
					draw: drawn(brokenGen(planSubjectGen)),
					runs: 250,
					shrink: completeShrink,
					coverage: required<PlanBreak>(planBreakNames, { cases: 250, sense: notesOnly }),
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([subject, kindPick, sitePick], c) =>
					Effect.sync(() => {
						const placed = succeeded(
							placeDeduplication(subject.dag, {
								context: "snapshot",
								catalog: subject.catalog,
								roots: "result"
							})
						)
						const applicable = Arr.filter(
							planBreakNames,
							(b) => planBreaks[b].sites(placed, subject.dag).length > 0
						)
						const name = present(applicable[kindPick % applicable.length], "an applicable break")
						const sites = planBreaks[name].sites(placed, subject.dag)
						const site = present(sites[sitePick % sites.length], "a site")
						const found = succeeded(
							verifyMultiplicity(subject.dag, site.plan, {
								context: site.context,
								catalog: subject.catalog,
								roots: "result"
							})
						).problems
						reported(found, planBreaks[name].expect, `${name} in ${subject.label}`)
						c.note(name)
					})
			)
		)
	)

	it.effect(
		"reports the planted breaks no generated plan holds, and passes their unbroken plans",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/dedup/verify/planted-plans",
						literal: Formatter.format,
						generator: element<PlantedPlanBreak>([
							"a count over unproved multiplicity",
							"a bound over a projection that repeats",
							"UNION ALL over arms not told apart",
							"UNION ALL over tagged arms without its certificate"
						]),
						limit: 4,
						coverage: requiredInSpace<PlantedPlanBreak>([
							"a count over unproved multiplicity",
							"a bound over a projection that repeats",
							"UNION ALL over arms not told apart",
							"UNION ALL over tagged arms without its certificate"
						]),
						caseHang
					},
					(name, c) =>
						Effect.sync(() => {
							const { dag, good, bad } = plantedPlans[name].broken()
							assert.deepEqual(problems(dag, good, "snapshot"), [], name)
							const found = problems(dag, bad, "snapshot")
							reported(found, plantedPlans[name].expect, name)
							c.note(name)
						})
				)
			)
	)
})

/**
 * A program to verify: the conservative lowering of a generated query over its own schema, or of a planted Shop query
 * (an attachment with a parameter, heading groups, a zero-column result).
 */
interface ProgramSubject {
	readonly label: string
	readonly program: ChannelProgram
}

const generatedProgram = (c: QueryCase): ChannelProgram =>
	conservativeChannels(
		succeeded(
			lowerConservative(conservativeInput(c.query), {
				names: standInNames(c.schema.name),
				params: genParamDecls(c.query),
				subject: { kind: "query" }
			})
		)
	)

const plantedPrograms: ReadonlyArray<ProgramSubject> = [
	{ label: "an attachment", program: attachedProgram() },
	{ label: "heading groups", program: unionProgram() },
	{ label: "a zero-column result", program: unitProgram() }
]

const programSubjectGen: Gen<ProgramSubject> = oneOf([
	map(queryCaseGen(defaultGenConfig), (c): ProgramSubject => ({
		label: "a generated query",
		program: generatedProgram(c)
	})),
	element(nonEmpty(plantedPrograms, "the planted programs"))
])

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

type ArtifactBreak =
	| "a delivered column retyped"
	| "a delivering statement dropped"
	| "the heading-group merge dropped"
	| "another program"

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
		p.delivery.kind === "headingGroups" ? [{ ...p, delivery: { kind: "rows" } }] : [],
	"another program": (p) => [
		Arr.some(flight(p.roots), (s) => s.role.kind === "headingGroup")
			? attachedProgram()
			: unionProgram()
	]
}

const artifactBreakNames: Arr.NonEmptyReadonlyArray<ArtifactBreak> = [
	"a delivered column retyped",
	"a delivering statement dropped",
	"the heading-group merge dropped",
	"another program"
]

describe("codec and result-channel alignment", () => {
	it.effect("reports each break of a lowered program's statements under its rule", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/verify/channel-breaks",
					literal: Formatter.format,
					kept: plantedBreaks(
						plantedPrograms,
						channelBreakNames,
						(name, subject) => channelBreaks[name].sites(subject.program).length > 0
					),
					draw: drawn(brokenGen(programSubjectGen)),
					runs: 300,
					shrink: completeShrink,
					coverage: required<ChannelBreak>(channelBreakNames, { cases: 300, sense: notesOnly }),
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([subject, kindPick, sitePick], c) =>
					Effect.sync(() => {
						assert.deepEqual(channelProblems(subject.program, "statement"), [], subject.label)
						const applicable = Arr.filter(
							channelBreakNames,
							(b) => channelBreaks[b].sites(subject.program).length > 0
						)
						const name = present(applicable[kindPick % applicable.length], "an applicable break")
						const sites = channelBreaks[name].sites(subject.program)
						const broken = present(sites[sitePick % sites.length], "a site")
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
						kept: plantedBreaks(
							plantedPrograms,
							artifactBreakNames,
							(name, subject) => artifactBreaks[name](subject.program).length > 0
						),
						draw: drawn(brokenGen(programSubjectGen)),
						runs: 150,
						shrink: completeShrink,
						coverage: required<ArtifactBreak>(artifactBreakNames, { cases: 150, sense: notesOnly }),
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
							const name = present(applicable[kindPick % applicable.length], "an applicable break")
							const sites = artifactBreaks[name](subject.program)
							const broken = present(sites[sitePick % sites.length], "a site")
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

	/** The optimized artifact's fused attachment, planted: the conservative lowering pipelines every attachment. */
	type FusedBreak =
		| "fused as built"
		| "its heading narrowed to an array"
		| "stitched to another parent column"
		| "not fused at all"
		| "stitched to an undelivered parent column"
	const fusedBreaks: Readonly<
		Record<
			FusedBreak,
			{
				readonly program: (fused: ChannelProgram) => ChannelProgram
				/**
				 * The fused column's own structure, checked by the statement's channels, and what it decodes to, checked by
				 * the comparison with the pipelined artifact: each where the break touches it.
				 */
				readonly channel: Checked
				readonly artifacts: Checked
			}
		>
	> = {
		"fused as built": { program: (p) => p, channel: checked(), artifacts: checked() },
		"its heading narrowed to an array": {
			program: (p) =>
				reshape(p, (fused) => ({
					...fused,
					layout: { columns: fused.layout.columns.slice(0, 1) }
				})),
			channel: otherCheck,
			artifacts: checked("artifacts")
		},
		"stitched to another parent column": {
			program: (p) => reshape(p, (fused) => ({ ...fused, parentColumns: ["email"] })),
			channel: otherCheck,
			artifacts: checked("artifacts")
		},
		"not fused at all": {
			program: (p) => edit(p, 0, () => ({ fused: [] })),
			channel: checked("resultColumns"),
			artifacts: checked("artifacts")
		},
		"stitched to an undelivered parent column": {
			program: (p) => reshape(p, (fused) => ({ ...fused, parentColumns: ["v"] })),
			channel: checked("attachment"),
			artifacts: otherCheck
		}
	}

	it.effect(
		"compares the decoded result, so a fused attachment matches its pipelined statement and nothing else does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/dedup/verify/fused",
						literal: Formatter.format,
						generator: element<FusedBreak>([
							"fused as built",
							"its heading narrowed to an array",
							"stitched to another parent column",
							"not fused at all",
							"stitched to an undelivered parent column"
						]),
						limit: 5,
						coverage: requiredInSpace<"matches" | "differs">(["matches", "differs"]),
						caseHang
					},
					(name, c) =>
						Effect.sync(() => {
							const conservative = attachedProgram()
							const { program, channel, artifacts } = fusedBreaks[name]
							const optimized = program(fusedProgram(conservative))
							if (channel.kind === "checked") {
								assert.deepEqual(
									rulesOf(channelProblems(optimized, "statement")),
									[...channel.rules],
									name
								)
							}
							if (artifacts.kind === "checked") {
								assert.deepEqual(
									rulesOf(artifactProblems(optimized, conservative)),
									[...artifacts.rules],
									name
								)
								assert.deepEqual(
									rulesOf(artifactProblems(conservative, optimized)),
									[...artifacts.rules],
									name
								)
							}
							c.note(name === "fused as built" ? "matches" : "differs")
						})
				)
			)
	)
})
