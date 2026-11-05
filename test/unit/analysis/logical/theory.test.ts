import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, int, shuffled, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import {
	immediateEvidence,
	lawIdentityOf,
	provisionalTheory,
	type Theory
} from "#compiler/analysis/theory/theory.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { FieldId, type LawId } from "#compiler/core/ids.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import {
	assert,
	defined,
	nonEmpty,
	refused,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import * as G from "#test/support/fixtures/golden/work.ts"
import {
	capacity,
	check,
	closed,
	contained,
	f,
	field,
	key,
	mirrors,
	ne,
	on,
	onSelected,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import * as Q from "#test/support/fixtures/ir/queue.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type HostFacts,
	theoryOf,
	theoryResult,
	violated
} from "#test/unit/analysis/logical/support.ts"

/**
 * Theory normalization: CheckedTheory from an owned schema, judged by properties over the fixture schemas, the
 * lawful Work facts and every combination of planted violations, and small fact spaces exhausted against the laws'
 * meaning.
 *
 * - every law is one Forbid node over its violation query, and the violation queries mean what the laws say: evaluated
 *   by the reference evaluator they are empty on lawful facts and name exactly the violating witnesses, a model of each
 *   law's meaning written from its statement;
 * - union-find classes over containment pairings keep carrier, contract and roster identity, refuse incompatible
 *   pairings, and keep a typmod or a refinement inside one class;
 * - evidence carries its validity context: keys and checks immediate, a roster containment a descriptor fact, every
 *   other containment committed-snapshot only unless law specialization says otherwise;
 * - law identities are deterministic, independent of declaration order and of unrelated statements, come from the
 *   lawId option, must be distinct, and equivalent declarations are one law keeping both statements;
 * - a containment pairing more than one span field is UnsupportedLawFamily (the span law families themselves are
 *   unit/laws/recognition's).
 */

const schemas: ReadonlyArray<readonly [string, SchemaDesc]> = [
	["Work", W.WorkDesc],
	["Reports", W.ReportsDesc],
	["Plans", W.PlansDesc],
	["Queue", Q.Queue],
	["Payroll", P.PayrollDesc],
	["Reporting", P.ReportingDesc]
]

const theories = Arr.map(
	schemas,
	([name, desc]) => [name, theoryOf(desc, provisionalTheory)] as const
)

const lawsOf = (t: Theory, shape: string) => Arr.filter(t.laws, (l) => l.shape === shape)
const lawOf = (t: Theory, shape: string, relation: string) =>
	Option.getOrThrow(
		Arr.findFirst(t.laws, (l) => l.shape === shape && l.sides[0]?.relation === relation)
	).id

/**
 * The violations of every law, each law's rows sorted, as a map compared whole: the laws a state violates, each with
 * exactly its witnesses.
 */
const violatedSorted = (
	t: Theory,
	facts: HostFacts
): ReadonlyMap<LawId, ReadonlyArray<ReadonlyArray<unknown>>> =>
	new Map(Arr.map([...violated(t, facts)], ([law, rows]) => [law, Arr.sort(rows, byText)]))

/** Rows by their values' text, joined by NUL. */
const byText: Order.Order<ReadonlyArray<unknown>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<unknown>) => Arr.join(Arr.map(row, String), "\u0000")
)

describe("span laws", () => {
	it.effect("refuses a containment pairing more than one span field, and admits one", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/logical/span-pairings",
					generator: element([1, 2]),
					literal: Formatter.format,
					limit: 2,
					coverage: requiredInSpace<"one span field" | "two span fields">([
						"one span field",
						"two span fields"
					]),
					caseHang
				},
				(spans, c) =>
					Effect.sync(() => {
						const Two = relation(
							"Two",
							{ id: f.uuid, a: f.span(f.bigint, undefined), b: f.span(f.bigint, undefined) },
							["id"]
						)
						const Other = relation(
							"Other",
							{ a: f.span(f.bigint, undefined), b: f.span(f.bigint, undefined) },
							["a"]
						)
						const fields = spans === 1 ? ["a"] : ["a", "b"]
						const desc: SchemaDesc = {
							name: "Spans",
							relations: [Two, Other],
							statements: [contained(on("Two", fields), on("Other", fields))],
							extends: undefined
						}
						if (spans === 1) {
							c.note("one span field")
							succeeded(theoryResult(desc, provisionalTheory))
							return
						}
						c.note("two span fields")
						refused(theoryResult(desc, provisionalTheory), "UnsupportedLawFamily")
					})
			)
		)
	)
})

describe("field-compatibility classes", () => {
	/**
	 * A pairing of two fields: of one identity (the same carrier, a typmod or a refinement apart), or of different
	 * identities: another carrier, a contract against its base, two rosters sharing handle names, a capacity's target
	 * against its source.
	 */
	type Pairing =
		| "a typmod and a refinement apart"
		| "another carrier"
		| "a contract against its base"
		| "two rosters sharing handles"
		| "a capacity across carriers"
	it.effect(
		"refuses a pairing of fields of different identity, and keeps a typmod and a refinement inside one class",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/field-classes",
						generator: element<Pairing>([
							"a typmod and a refinement apart",
							"another carrier",
							"a contract against its base",
							"two rosters sharing handles",
							"a capacity across carriers"
						]),
						literal: Formatter.format,
						limit: 5,
						coverage: requiredInSpace<Pairing>([
							"a typmod and a refinement apart",
							"another carrier",
							"a contract against its base",
							"two rosters sharing handles",
							"a capacity across carriers"
						]),
						caseHang
					},
					(pairing, c) =>
						Effect.sync(() => {
							c.note(pairing)
							switch (pairing) {
								case "a typmod and a refinement apart": {
									const A = relation(
										"A",
										{ id: f.uuid, code: f.regex("^[a-z]{1,4}$", "u"), n: f.numeric(10, 2) },
										["id"]
									)
									const B = relation(
										"B",
										{ code: f.regex("^[a-z]{1,8}$", "u"), n: f.numeric(12, 2) },
										["code", "n"]
									)
									const t = theoryOf(
										{
											name: "R",
											relations: [A, B],
											statements: [contained(on("A", ["code", "n"]), on("B", ["code", "n"]))],
											extends: undefined
										},
										provisionalTheory
									)
									assert.deepEqual(
										Option.map(
											Arr.findFirst(t.classes, (x) => x.fields.includes(FieldId("A", "code"))),
											(x) => Arr.map(x.members, (m) => m.field)
										),
										Option.some([FieldId("A", "code"), FieldId("B", "code")])
									)
									assert.equal(
										violated(t, {
											A: [{ id: G.t1, code: "abc", n: "1.50" }],
											B: [{ code: "abc", n: "1.5" }]
										}).size,
										0
									)
									unorderedEqual(
										[...violated(t, { A: [{ id: G.t1, code: "abc", n: "1.50" }], B: [] }).values()],
										[[["abc", "1.5"]]]
									)
									return
								}
								case "another carrier":
									refused(
										theoryResult(
											{
												...W.WorkDesc,
												statements: [
													...W.WorkDesc.statements,
													contained(on("Task", ["account"]), on("Account", ["name"]))
												]
											},
											provisionalTheory
										),
										"MalformedDescription"
									)
									return
								case "a contract against its base": {
									const A = relation("A", { id: f.uuid, amount: W.CentsDesc }, ["id"])
									const B = relation("B", { amount: f.bigint }, ["amount"])
									refused(
										theoryResult(
											{
												name: "C",
												relations: [A, B],
												statements: [contained(on("A", ["amount"]), on("B", ["amount"]))],
												extends: undefined
											},
											provisionalTheory
										),
										"MalformedDescription"
									)
									return
								}
								case "two rosters sharing handles": {
									const Kind = closed("Kind", ["Automatic", "Manual"])
									const Shade = closed("Shade", ["Automatic", "Manual", "Dark"])
									const Tagged = relation("Tagged", { id: f.uuid, kind: f.closedId("Kind") }, [
										"id"
									])
									const Painted = relation("Painted", { shade: f.closedId("Shade") }, ["shade"])
									refused(
										theoryResult(
											{
												name: "R",
												relations: [Kind, Shade, Tagged, Painted],
												statements: [contained(on("Tagged", ["kind"]), on("Painted", ["shade"]))],
												extends: undefined
											},
											provisionalTheory
										),
										"MalformedDescription"
									)
									return
								}
								case "a capacity across carriers": {
									const Pool = relation("Pool", { id: f.uuid }, ["id"])
									const Draw = relation("Draw", { id: f.uuid, pool: f.wildcard }, ["id"])
									refused(
										theoryResult(
											{
												name: "K",
												relations: [Pool, Draw],
												statements: [
													capacity(on("Pool", ["id"]), on("Draw", ["pool"]), within(0n, 1n), {
														kind: "count"
													})
												],
												extends: undefined
											},
											provisionalTheory
										),
										"MalformedDescription"
									)
								}
							}
						})
				)
			)
	)
})

describe("violation queries mean what their laws say", () => {
	const t = theoryOf(W.WorkDesc, provisionalTheory)
	const family = defined(t.families[0])
	const manualHalf = Option.getOrThrow(
		Arr.findFirst(family.arms, (a) => a.handles.includes("Manual"))
	).forward
	const contract = defined(lawsOf(t, "contract")[0]).id
	/**
	 * The planted violations of the lawful Work facts, each breaking one law with its witnesses: a second task at t1's
	 * key (the key, witnessed by it); a note of a task that does not exist (the containment, by the note's task); a
	 * manual task with no ManualTask (the family law alone, by the task); t1's payload moved to the other arm (that arm's
	 * half and the family law, by the task); t3's budget below the contract (the contract, by the value).
	 */
	type Mutation =
		| "a second key"
		| "an orphan note"
		| "a parent without its arm"
		| "a payload in the other arm"
		| "a refused budget"
	const mutations: Arr.NonEmptyReadonlyArray<Mutation> = [
		"a second key",
		"an orphan note",
		"a parent without its arm",
		"a payload in the other arm",
		"a refused budget"
	]
	const apply = (facts: HostFacts, m: Mutation): HostFacts => {
		const of = (name: string) => defined(facts[name])
		switch (m) {
			case "a second key":
				return { ...facts, Task: [...of("Task"), { id: G.t1, account: G.a2, kind: "Automatic" }] }
			case "an orphan note":
				return { ...facts, TaskNote: [...of("TaskNote"), { task: G.tMissing, note: "orphan" }] }
			case "a parent without its arm":
				return { ...facts, Task: [...of("Task"), { id: G.tLate, account: G.a1, kind: "Manual" }] }
			case "a payload in the other arm":
				return {
					...facts,
					AutomaticTask: Arr.filter(of("AutomaticTask"), (a) => a["task"] !== G.t1),
					ManualTask: [...of("ManualTask"), { task: G.t1, operator: "Ann" }]
				}
			case "a refused budget":
				return {
					...facts,
					AutomaticTask: Arr.map(of("AutomaticTask"), (a) =>
						a["task"] === G.t3 ? { task: G.t3, budget: -5n } : a
					)
				}
		}
	}
	const witnesses = (m: Mutation): ReadonlyArray<readonly [LawId, ReadonlyArray<unknown>]> => {
		switch (m) {
			case "a second key":
				return [[lawOf(t, "pk", "Task"), [G.t1]]]
			case "an orphan note":
				return [[lawOf(t, "contained", "TaskNote"), [G.tMissing]]]
			case "a parent without its arm":
				return [[family.reverse, [G.tLate]]]
			case "a payload in the other arm":
				return [
					[manualHalf, [G.t1]],
					[family.reverse, [G.t1]]
				]
			case "a refused budget":
				return [[contract, [-5n]]]
		}
	}
	it.effect(
		"every law holds over the lawful Work facts, and every combination of planted violations is exactly its laws' witnesses",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/work-violations",
						generator: subarray(mutations),
						literal: Formatter.format,
						limit: 32,
						coverage: requiredInSpace<Mutation | "lawful" | "several at once">([
							...mutations,
							"lawful",
							"several at once"
						]),
						caseHang
					},
					(applied, c) =>
						Effect.sync(() => {
							for (const m of applied) {
								c.note(m)
							}
							if (applied.length === 0) {
								c.note("lawful")
							}
							if (applied.length > 1) {
								c.note("several at once")
							}
							const facts = Arr.reduce(applied, G.workFacts, apply)
							const expected = new Map<LawId, Array<ReadonlyArray<unknown>>>()
							for (const [law, row] of Arr.flatMap(applied, witnesses)) {
								expected.set(law, [...(expected.get(law) ?? []), row])
							}
							assert.deepEqual(
								violatedSorted(t, facts),
								new Map(Arr.map([...expected], ([law, rows]) => [law, Arr.sort(rows, byText)]))
							)
						})
				)
			)
	)

	it.effect(
		"a row check's witnesses are exactly the keys of the rows its predicate refuses",
		(ctx) => {
			const Report = relation("Report", { employee: f.uuid, manager: f.uuid }, ["employee"])
			const rt = theoryOf(
				{
					name: "Org",
					relations: [Report],
					statements: [check("NotOwnManager", "Report", ne(field("employee"), field("manager")))],
					extends: undefined
				},
				provisionalTheory
			)
			const checkLaw = defined(lawsOf(rt, "check")[0])
			assert.deepEqual(checkLaw.sides, [
				{ relation: "Report", fields: ["employee", "manager"], selection: [] }
			])
			const people = [G.a1, G.a2, G.a3]
			const manager = element<string>(["none", ...people])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/row-check-violations",
						generator: (source) =>
							[source.draw(manager), source.draw(manager), source.draw(manager)] as const,
						literal: Formatter.format,
						limit: 64,
						coverage: requiredInSpace<"a self-managed employee" | "lawful">([
							"a self-managed employee",
							"lawful"
						]),
						caseHang
					},
					(managers, c) =>
						Effect.sync(() => {
							const rows = Arr.flatMap(managers, (m, i) =>
								m === "none" ? [] : [{ employee: defined(people[i]), manager: m }]
							)
							const own = Arr.map(
								Arr.filter(rows, (r) => r.employee === r.manager),
								(r) => [r.employee]
							)
							c.note(own.length > 0 ? "a self-managed employee" : "lawful")
							assert.deepEqual(
								violatedSorted(rt, { Report: rows }),
								own.length > 0 ? new Map([[checkLaw.id, Arr.sort(own, byText)]]) : new Map()
							)
						})
				)
			)
		}
	)

	it.effect(
		"a candidate key's witnesses are the values two facts share, and a pure set's key has nothing to differ on",
		(ctx) => {
			const Label = relation("Label", { account: f.uuid, label: f.regex("^[a-z]{1,9}$", "u") }, [
				"account",
				"label"
			])
			const Account = relation("Account", { id: f.uuid, name: f.regex("^[a-z]{1,9}$", "u") }, [
				"id"
			])
			const kt = theoryOf(
				{
					name: "K",
					relations: [Label, Account],
					statements: [key("Account", ["name"])],
					extends: undefined
				},
				provisionalTheory
			)
			const nameKey = Option.getOrThrow(Arr.findFirst(kt.laws, (l) => l.shape === "key")).id
			const ids = [G.a1, G.a2, G.a3]
			const named = element<"none" | "acme" | "beta">(["none", "acme", "beta"])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/candidate-key-violations",
						generator: (source) =>
							[
								[source.draw(named), source.draw(named), source.draw(named)] as const,
								source.draw(subarray(["x", "y"]))
							] as const,
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<"a shared name" | "lawful" | "labels">([
							"a shared name",
							"lawful",
							"labels"
						]),
						caseHang
					},
					([names, labels], c) =>
						Effect.sync(() => {
							const accounts = Arr.flatMap(names, (n, i) =>
								n === "none" ? [] : [{ id: defined(ids[i]), name: n }]
							)
							if (labels.length > 0) {
								c.note("labels")
							}
							const shared = Arr.map(
								Arr.filter(
									[...new Set(Arr.map(accounts, (a) => a.name))],
									(n) => Arr.filter(accounts, (a) => a.name === n).length > 1
								),
								(n) => [n]
							)
							c.note(shared.length > 0 ? "a shared name" : "lawful")
							assert.deepEqual(
								violatedSorted(kt, {
									Account: accounts,
									Label: Arr.map(labels, (label) => ({ account: G.a1, label }))
								}),
								shared.length > 0 ? new Map([[nameKey, Arr.sort(shared, byText)]]) : new Map()
							)
						})
				)
			)
		}
	)

	it.effect(
		"capacity counts and sums per target over complete source facts, the empty group included",
		(ctx) => {
			const Pool = relation("Pool", { id: f.uuid, budget: f.bigint }, ["id"])
			const Draw = relation(
				"Draw",
				{ id: f.uuid, pool: f.uuid, amount: f.bigint, kept: f.boolean },
				["id"]
			)
			const ct = theoryOf(
				{
					name: "Cap",
					relations: [Pool, Draw],
					statements: [
						capacity(on("Pool", ["id"]), on("Draw", ["pool"]), within(1n, 2n), { kind: "count" }),
						capacity(
							on("Pool", ["id"]),
							onSelected("Draw", ["pool"], { kept: true }),
							within(0n, "budget"),
							{
								kind: "field",
								field: "amount"
							}
						)
					],
					extends: undefined
				},
				provisionalTheory
			)
			const weighted = (w: boolean) =>
				Option.getOrThrow(
					Arr.findFirst(
						lawsOf(ct, "capacity"),
						(l) => l.detail.kind === "capacity" && (l.detail.weight.kind !== "count") === w
					)
				).id
			const [count, sum] = [weighted(false), weighted(true)]
			const pools = [G.a1, G.a2, G.a3]
			const drawIds = [G.t1, G.t2, G.t3, G.t4, G.t5]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/capacity-violations",
						draw: drawn(
							(source) =>
								[
									source.draw(array(element([0n, 10n, 100n]), { min: 1, max: 3 })),
									source.draw(
										array(
											(draw) => ({
												pool: draw.draw(int(0, 2)),
												amount: draw.draw(element([0n, 6n, 40n, 60n])),
												kept: draw.draw(boolean)
											}),
											{ min: 0, max: 5 }
										)
									)
								] as const
						),
						literal: Formatter.format,
						coverage: required<
							"an empty group" | "a crowded group" | "a sum over budget" | "lawful"
						>(["an empty group", "a crowded group", "a sum over budget", "lawful"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([budgets, draws], c) =>
						Effect.sync(() => {
							const poolFacts = Arr.map(budgets, (budget, i) => ({ id: defined(pools[i]), budget }))
							const drawFacts = Arr.map(
								Arr.filter(draws, (d) => d.pool < poolFacts.length),
								(d, i) => ({
									id: defined(drawIds[i]),
									pool: defined(pools[d.pool]),
									amount: d.amount,
									kept: d.kept
								})
							)
							const expected = new Map<LawId, Array<ReadonlyArray<unknown>>>()
							for (const p of poolFacts) {
								const mine = Arr.filter(drawFacts, (d) => d.pool === p.id)
								if (mine.length === 0 || mine.length > 2) {
									c.note(mine.length === 0 ? "an empty group" : "a crowded group")
									expected.set(count, [...(expected.get(count) ?? []), [p.id]])
								}
								const total = Arr.reduce(
									Arr.filter(mine, (d) => d.kept),
									0n,
									(acc, d) => acc + d.amount
								)
								if (total < 0n || total > p.budget) {
									c.note("a sum over budget")
									expected.set(sum, [...(expected.get(sum) ?? []), [p.id]])
								}
							}
							if (expected.size === 0) {
								c.note("lawful")
							}
							assert.deepEqual(
								violatedSorted(ct, { Pool: poolFacts, Draw: drawFacts }),
								new Map(Arr.map([...expected], ([law, rows]) => [law, Arr.sort(rows, byText)]))
							)
						})
				)
			)
		}
	)
})

describe("evidence and its validity context", () => {
	it.effect(
		"keys and checks are immediate storage facts, under ownership's constraint names",
		(ctx) => {
			const relations = Arr.flatMap(schemas, ([name, desc]) => {
				const owned = ownedFixture(desc).owned
				const t = theoryOf(desc, provisionalTheory)
				return Arr.flatMap(Rec.values(t.relations), (r) =>
					r.kind === "relation"
						? [
								{
									name,
									t,
									relation: r.name,
									owned: Option.match(Rec.get(owned.relations, r.name), {
										onNone: () => [],
										onSome: (o) => o.keys
									})
								}
							]
						: []
				)
			})
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/key-evidence",
						generator: element(nonEmpty(relations, "a relation of the fixture schemas")),
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<"a candidate key" | "a primary key alone">([
							"a candidate key",
							"a primary key alone"
						]),
						caseHang
					},
					({ t, relation, owned }, c) =>
						Effect.sync(() => {
							c.note(owned.length > 1 ? "a candidate key" : "a primary key alone")
							unorderedEqual(
								Arr.map(
									Arr.filter(t.evidence.keys, (k) => k.relation === relation),
									(k) => [k.fields, k.primary, k.constraint, k.context] as const
								),
								Arr.map(owned, (k) => [k.fields, k.primary, k.constraint, "immediate"] as const)
							)
							for (const check of t.evidence.checks) {
								assert.equal(check.context, "immediate")
							}
						})
				)
			)
		}
	)

	it.effect(
		"a containment into a roster its field is typed by is a descriptor fact; any other holds in committed snapshots",
		(ctx) => {
			const facts = Arr.flatMap(theories, ([name, t]) =>
				Arr.map(t.evidence.containments, (containment) => ({ name, t, containment }))
			)
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/containment-evidence",
						generator: element(nonEmpty(facts, "a containment of the fixture schemas")),
						literal: Formatter.format,
						limit: 500,
						coverage: requiredInSpace<"a roster membership" | "a committed-snapshot containment">([
							"a roster membership",
							"a committed-snapshot containment"
						]),
						caseHang
					},
					({ t, containment }, c) =>
						Effect.sync(() => {
							const [field] = containment.from.fields
							const typedByTarget = Rec.get(t.relations, containment.from.relation).pipe(
								Option.flatMap((r) => Arr.findFirst(r.heading, (h) => h.name === field)),
								Option.exists((h) => {
									const base = baseOf(h.type)
									return base.carrier === "enum" && base.roster.closed === containment.to.relation
								})
							)
							const roster =
								containment.from.fields.length === 1 &&
								typedByTarget &&
								t.relations[containment.to.relation]?.kind === "closed"
							c.note(roster ? "a roster membership" : "a committed-snapshot containment")
							assert.equal(containment.context, roster ? "descriptor" : "committedSnapshot")
							const immediate = immediateEvidence(t.evidence)
							assert.deepEqual(immediate.keys, t.evidence.keys)
							assert.equal(immediate.containments.includes(containment), roster)
						})
				)
			)
		}
	)

	it.effect(
		"law specialization states which containments are immediate through the containmentContext option",
		(ctx) => {
			const containedLaws = Arr.map(
				Arr.filter(
					theoryOf(W.WorkDesc, provisionalTheory).laws,
					(l) => l.source.kind === "contained"
				),
				(l) => l.id
			)
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/containment-context-option",
						generator: subarray(containedLaws),
						literal: Formatter.format,
						limit: 64,
						coverage: requiredInSpace<"none named" | "some named">(["none named", "some named"]),
						caseHang
					},
					(named, c) =>
						Effect.sync(() => {
							c.note(named.length === 0 ? "none named" : "some named")
							const t = theoryOf(W.WorkDesc, {
								...provisionalTheory,
								containmentContext: (law) =>
									named.includes(law.id) ? "immediate" : "committedSnapshot"
							})
							for (const k of t.evidence.containments) {
								if (k.statement !== "contained" || k.context === "descriptor") {
									continue
								}
								assert.equal(
									k.context,
									Arr.some(named, (n) => n === k.law) ? "immediate" : "committedSnapshot",
									k.from.relation
								)
							}
							unorderedEqual(
								Arr.map(
									Arr.filter(
										immediateEvidence(t.evidence).containments,
										(k) => k.context === "immediate"
									),
									(k) => k.law
								),
								Arr.map(
									Arr.filter(
										t.evidence.containments,
										(k) => k.context !== "descriptor" && Arr.some(named, (n) => n === k.law)
									),
									(k) => k.law
								)
							)
						})
				)
			)
		}
	)
})

describe("law identities", () => {
	const base = theoryOf(W.WorkDesc, provisionalTheory)
	it.effect(
		"are deterministic, independent of declaration order and of unrelated statements",
		(ctx) => {
			const extra: ReadonlyArray<StatementDesc> = [
				mirrors(on("TaskNote", ["task"]), on("Task", ["id"]))
			]
			return searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/law-ids-position",
						draw: drawn(
							(source) =>
								[
									source.draw(
										shuffled([...W.WorkDesc.statements.keys()], {
											min: W.WorkDesc.statements.length,
											max: W.WorkDesc.statements.length
										})
									),
									source.draw(subarray([...extra.keys()])),
									source.draw(
										array(int(0, W.WorkDesc.statements.length), {
											min: extra.length,
											max: extra.length
										})
									)
								] as const
						),
						literal: Formatter.format,
						coverage: required<"reordered" | "an unrelated statement">(
							["reordered", "an unrelated statement"],
							{ cases: 50, sense: notesOnly }
						),
						kept: [],
						runs: 50,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([order, added, at], c) =>
						Effect.sync(() => {
							const statements: Array<StatementDesc> = Arr.map(order, (i) =>
								defined(W.WorkDesc.statements[i])
							)
							if (Arr.some(order, (i, j) => i !== j)) {
								c.note("reordered")
							}
							for (const [j, which] of added.entries()) {
								c.note("an unrelated statement")
								statements.splice(
									Math.min(defined(at[j]), statements.length),
									0,
									defined(extra[which])
								)
							}
							const moved = theoryOf({ ...W.WorkDesc, statements }, provisionalTheory)
							for (const law of base.laws) {
								assert.deepEqual(
									Option.map(
										Arr.findFirst(moved.laws, (l) => l.id === law.id),
										(l) => l.shape
									),
									Option.some(law.shape),
									`${law.id} keeps its identity`
								)
							}
							for (const law of moved.laws) {
								const { id, named, violation, loc, ...identity } = law
								assert.ok(
									identifierOf(lawIdentityOf(identity)) === id,
									`${id} is its identity's identifier`
								)
								assert.ok(identifierOf(named) === id, `${id} is its named identity's identifier`)
							}
						})
				)
			)
		}
	)

	it.effect("make equivalent declarations one law that keeps both statements", (ctx) => {
		const forward = mirrors(on("TaskNote", ["task"]), on("Task", ["id"]))
		const backward = mirrors(on("Task", ["id"]), on("TaskNote", ["task"]))
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/logical/law-ids-equivalent",
					generator: element<ReadonlyArray<StatementDesc>>([
						[forward],
						[backward],
						[forward, backward],
						[backward, forward]
					]),
					literal: Formatter.format,
					limit: 4,
					coverage: requiredInSpace<"one declaration" | "two declarations">([
						"one declaration",
						"two declarations"
					]),
					caseHang
				},
				(declared, c) =>
					Effect.sync(() => {
						c.note(declared.length === 1 ? "one declaration" : "two declarations")
						const both = theoryOf(
							{ ...W.WorkDesc, statements: [...W.WorkDesc.statements, ...declared] },
							provisionalTheory
						)
						const halves = Arr.filter(
							both.laws,
							(l) =>
								l.shape === "mirrorsHalf" &&
								l.source.kind === "mirrors" &&
								l.source.alternatives === undefined &&
								Arr.some(l.sides, (s) => s.relation === "TaskNote")
						)
						assert.equal(halves.length, 2)
						for (const half of halves) {
							assert.equal(half.statements.length, declared.length)
						}
					})
			)
		)
	})
})
