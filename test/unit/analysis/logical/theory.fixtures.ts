/** What the properties of theory.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import type { Source } from "@bjornpagen/testing/source"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { type Theory } from "#compiler/analysis/theory/theory.ts"
import { type LawId } from "#compiler/core/ids.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { type Roster, rosterOf } from "#compiler/ir/scalar.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import * as G from "#test/support/fixtures/golden/work.ts"
import {
	check,
	closedRelation,
	contained,
	eq,
	f,
	field,
	key,
	mirrors,
	mutable,
	ne,
	on,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	type GenSchema,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { type HostFacts, uuidOf } from "#test/support/unit/analysis/theory/support.ts"
import {
	declaredGen,
	type DeclaredSketch,
	numericGen,
	textGen
} from "#test/support/unit/ir/types.ts"
import {
	type EvidencedTestTheory,
	noImmediate,
	theoryUnder,
	violated
} from "#test/unit/analysis/logical/support.ts"

const lawsOf = (t: Theory, shape: string) => Arr.filter(t.laws, (l) => l.shape === shape)

const lawOf = (t: Theory, shape: string, relation: string) =>
	Option.getOrThrow(
		Arr.findFirst(
			t.laws,
			(l) => l.shape === shape && l.detail.kind === "key" && l.detail.relation === relation
		)
	).id

/**
 * The violations of every law, each law's rows sorted, as a map compared whole: the laws a state violates, each with
 * exactly its witnesses.
 */
export const violatedSorted = (
	t: EvidencedTestTheory,
	facts: HostFacts
): ReadonlyMap<LawId, ReadonlyArray<ReadonlyArray<unknown>>> =>
	new Map(Arr.map([...violated(t, facts)], ([law, rows]) => [law, Arr.sort(rows, byText)]))

/** Rows by their values' text, joined by NUL. */
export const byText: Order.Order<ReadonlyArray<unknown>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<unknown>) => Arr.join(Arr.map(row, String), "\u0000")
)

export type SpanFeature = "no span field" | "one span field" | "several span fields"

/**
 * A field's base carrier, as a containment's pairing keeps it in one class (scalar/compute/types.ts sameCarrier): its
 * carrier with its contracts stripped at every level, natural's among them, a closed id's or a set's roster, a span's
 * endpoint as declared, contract and all, a vector's dimensions; never a numeric's typmod or a text's refinement.
 */
export const carrierOf = (desc: FieldDesc): string => {
	switch (desc.kind) {
		case "pg":
			return desc.type
		case "numeric":
		case "exact":
		case "computedNumeric":
		case "bytes":
		case "sha256":
		case "uuid":
		case "text":
		case "pattern":
			return desc.kind
		case "contract":
			return carrierOf(desc.base)
		case "closedId":
		case "bits":
			return `${desc.kind} of ${desc.roster}`
		case "span":
			return `span over ${endpointOf(desc.endpoint)}`
		case "vector":
			return `vector(${desc.dimensions})`
		case "search":
			return `search document under ${desc.configuration}`
		case "variant":
			return `variant ${desc.name}`
	}
}

/** A span's endpoint as its SQL type names it: a contract's name over its base, which a span over its base is not. */
const endpointOf = (desc: FieldDesc): string =>
	desc.kind === "contract" ? `contract ${desc.name} over ${endpointOf(desc.base)}` : carrierOf(desc)

/**
 * A drawn type's names, each a side's own: a contract `C<side><depth>` but natural, the builtin, and a roster `R<side>`,
 * so two sides share a contract or a roster exactly when one is the other's twin.
 */
export const sided = (sketch: DeclaredSketch, side: string): DeclaredSketch => {
	const rename = (desc: FieldDesc, depth: number): FieldDesc => {
		switch (desc.kind) {
			case "contract":
				return isNaturalDesc(desc)
					? desc
					: { ...desc, name: `C${side}${depth}`, base: rename(desc.base, depth + 1) }
			case "closedId":
			case "bits":
				return { ...desc, roster: `R${side}` }
			case "span":
				return { ...desc, endpoint: rename(desc.endpoint, depth + 1) }
			case "variant":
			case "pg":
			case "numeric":
			case "exact":
			case "computedNumeric":
			case "bytes":
			case "sha256":
			case "uuid":
			case "text":
			case "pattern":
			case "vector":
			case "search":
				return desc
		}
	}
	return {
		desc: rename(sketch.desc, 0),
		rosters: Rec.fromEntries(
			Arr.map(Rec.values(sketch.rosters), (handles) => [`R${side}`, handles])
		)
	}
}

/** How the contained side's type is drawn against the containing side's. */
type Pairing =
	| "a twin"
	| "another typmod or refinement"
	| "another roster"
	| "a contract over it or its base"
	| "drawn apart"

/**
 * The type one contract level from `a`: a contract's base, or a contract `Cb` of its own over any other type a contract
 * is over; undefined for a set, which no contract is over.
 */
const refinementOf = (a: DeclaredSketch): DeclaredSketch | undefined => {
	if (a.desc.kind === "contract") {
		return { desc: a.desc.base, rosters: a.rosters }
	}
	return a.desc.kind === "bits"
		? undefined
		: {
				desc: { kind: "contract", name: "Cb", base: a.desc, predicate: undefined, facts: [] },
				rosters: a.rosters
			}
}

/**
 * The contained side's type: its twin; another typmod or refinement of it; its roster's handles under a roster of its
 * own; a contract over it, or its base where it is a contract, natural's pg.bigint among them; or a type drawn apart.
 */
export const pairedGen = (a: DeclaredSketch): Gen<readonly [Pairing, DeclaredSketch]> =>
	weighted([
		[1, constant(["a twin", a] as const)],
		[
			1,
			(): readonly [Pairing, DeclaredSketch] => {
				const refined = refinementOf(a)
				return refined === undefined ? ["a twin", a] : ["a contract over it or its base", refined]
			}
		],
		[
			1,
			(source): readonly [Pairing, DeclaredSketch] => {
				switch (a.desc.kind) {
					case "numeric":
						return ["another typmod or refinement", { desc: source.draw(numericGen), rosters: {} }]
					case "text":
						return ["another typmod or refinement", { desc: source.draw(textGen), rosters: {} }]
					case "closedId":
					case "bits":
						return ["another roster", sided(a, "b")]
					case "variant":
					case "pg":
					case "exact":
					case "computedNumeric":
					case "bytes":
					case "sha256":
					case "uuid":
					case "pattern":
					case "contract":
					case "span":
					case "vector":
					case "search":
						return ["a twin", a]
				}
			}
		],
		[2, map(declaredGen, (b): readonly [Pairing, DeclaredSketch] => ["drawn apart", sided(b, "b")])]
	])

export type ClassFeature = "one carrier" | Pairing | "another carrier"

export const t = theoryUnder(W.WorkDesc, noImmediate)

/** The law a statement of Work declares from `from` into `to`. */
const containedOf = (from: string, to: string) =>
	Option.getOrThrowWith(
		Arr.findFirst(
			t.laws,
			(l) =>
				l.shape === "contained" &&
				l.source.kind === "contained" &&
				l.detail.kind === "containment" &&
				l.detail.from.relation === from &&
				l.detail.to.relation === to
		),
		() => new Error(`Work declares a containment from ${from} into ${to}`)
	).id

/**
 * Work's laws, each read from the statement that declares it, as a function from facts to its witnesses: a primary
 * key's values two distinct facts share; a containment's source values its target lacks, over each side's selection;
 * each kind's arm into its kind's tasks and each kind's tasks into its arm, its mirrors; Cents' values below zero.
 */
type Facts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

const factsOf = (facts: Facts, relation: string) => facts[relation] ?? []

const textOf = (value: unknown): string => (typeof value === "bigint" ? `${value}n` : String(value))

const shared = (relation: string, field: string) => (facts: Facts) =>
	Arr.flatMap(
		Arr.dedupe(Arr.map(factsOf(facts, relation), (fact) => textOf(fact[field]))),
		(value) => {
			const holding = Arr.filter(factsOf(facts, relation), (fact) => textOf(fact[field]) === value)
			const [first] = holding
			return holding.length > 1 && first !== undefined ? [[first[field]]] : []
		}
	)

type Side = Readonly<{ relation: string; field: string }>

const lacking =
	(from: Side, to: Side, fromKind: string | undefined, toKind: string | undefined) =>
	(facts: Facts) => {
		const read = (side: Side, kind: string | undefined) =>
			Arr.filter(
				factsOf(facts, side.relation),
				(fact) => kind === undefined || fact["kind"] === kind
			)
		const targets = new Set(Arr.map(read(to, toKind), (fact) => textOf(fact[to.field])))
		const sources = read(from, fromKind)
		return Arr.flatMap(
			Arr.dedupe(Arr.map(sources, (fact) => textOf(fact[from.field]))),
			(value) => {
				const fact = Arr.findFirst(sources, (f) => textOf(f[from.field]) === value)
				return targets.has(value) || Option.isNone(fact) ? [] : [[fact.value[from.field]]]
			}
		)
	}

export type LawName =
	| "Account's key"
	| "Task's key"
	| "AutomaticTask's key"
	| "ManualTask's key"
	| "TaskNote's key"
	| "a task's account"
	| "a note's task"
	| "the Automatic arm"
	| "the Manual arm"
	| "Automatic's reverse"
	| "Manual's reverse"
	| "Cents"

export const model: ReadonlyArray<
	readonly [LawName, LawId, (facts: Facts) => ReadonlyArray<ReadonlyArray<unknown>>]
> = [
	["Account's key", lawOf(t, "pk", "Account"), shared("Account", "id")],
	["Task's key", lawOf(t, "pk", "Task"), shared("Task", "id")],
	["AutomaticTask's key", lawOf(t, "pk", "AutomaticTask"), shared("AutomaticTask", "task")],
	["ManualTask's key", lawOf(t, "pk", "ManualTask"), shared("ManualTask", "task")],
	["TaskNote's key", lawOf(t, "pk", "TaskNote"), shared("TaskNote", "task")],
	[
		"a task's account",
		containedOf("Task", "Account"),
		lacking(
			{ relation: "Task", field: "account" },
			{ relation: "Account", field: "id" },
			undefined,
			undefined
		)
	],
	[
		"a note's task",
		containedOf("TaskNote", "Task"),
		lacking(
			{ relation: "TaskNote", field: "task" },
			{ relation: "Task", field: "id" },
			undefined,
			undefined
		)
	],
	[
		"the Automatic arm",
		containedOf("AutomaticTask", "Task"),
		lacking(
			{ relation: "AutomaticTask", field: "task" },
			{ relation: "Task", field: "id" },
			undefined,
			"Automatic"
		)
	],
	[
		"the Manual arm",
		containedOf("ManualTask", "Task"),
		lacking(
			{ relation: "ManualTask", field: "task" },
			{ relation: "Task", field: "id" },
			undefined,
			"Manual"
		)
	],
	[
		"Automatic's reverse",
		containedOf("Task", "AutomaticTask"),
		lacking(
			{ relation: "Task", field: "id" },
			{ relation: "AutomaticTask", field: "task" },
			"Automatic",
			undefined
		)
	],
	[
		"Manual's reverse",
		containedOf("Task", "ManualTask"),
		lacking(
			{ relation: "Task", field: "id" },
			{ relation: "ManualTask", field: "task" },
			"Manual",
			undefined
		)
	],
	[
		"Cents",
		defined(lawsOf(t, "contract")[0]).id,
		(facts) =>
			Arr.map(
				Arr.dedupe(
					Arr.flatMap(factsOf(facts, "AutomaticTask"), (fact) => {
						const budget = fact["budget"]
						return typeof budget === "bigint" && budget < 0n ? [budget] : []
					})
				),
				(budget) => [budget]
			)
	]
]

/** Up to three distinct facts of each relation over small domains, so keys collide and references dangle. */
export const factsGen: Gen<Facts> = (source) => {
	const ids = (lo: number, hi: number) => map(int(lo, hi), (n) => uuidOf(n))
	const facts = <A extends Readonly<Record<string, unknown>>>(fact: Gen<A>) =>
		map(array(fact, { min: 0, max: 3 }), (drawnFacts) =>
			Arr.dedupeWith(drawnFacts, (x, y) =>
				Arr.every(Rec.keys(x), (key) => textOf(x[key]) === textOf(y[key]))
			)
		)
	return {
		Account: source.draw(
			facts((s) => ({ id: s.draw(ids(1, 2)), name: s.draw(boolean) ? "acme" : "beta" }))
		),
		Task: source.draw(
			facts((s) => ({
				id: s.draw(ids(11, 13)),
				account: s.draw(ids(1, 3)),
				kind: s.draw(boolean) ? "Manual" : "Automatic"
			}))
		),
		AutomaticTask: source.draw(
			facts((s) => ({ task: s.draw(ids(11, 13)), budget: s.draw(bigint(-1n, 1n)) * 5n }))
		),
		ManualTask: source.draw(
			facts((s) => ({ task: s.draw(ids(11, 13)), operator: s.draw(boolean) ? "Ann" : "Bo" }))
		),
		TaskNote: source.draw(
			facts((s) => ({ task: s.draw(ids(11, 14)), note: s.draw(boolean) ? "a" : "b" }))
		)
	}
}

/** The first closed id a relation of a generated schema holds: its relation, its field and its roster. */
const firstClosedId = (
	schema: GenSchema
): Readonly<{ relation: string; field: string; roster: Roster }> | undefined => {
	for (const r of schema.relations) {
		for (const column of r.columns) {
			const roster = column.type.carrier === "code" ? rosterOf(column.type) : undefined
			if (roster !== undefined) {
				return { relation: r.name, field: column.name, roster }
			}
		}
	}
	return undefined
}

/**
 * A schema the differential oracle draws, described, with a check over its first relation's first field, and, where a
 * relation holds a closed id of a roster, a closed relation keyed by that roster's live handles and a containment of
 * the closed id into it.
 */
export const evidenceSchemaGen: Gen<SchemaDesc> = (source) => {
	const schema = source.draw(
		resolveSchema(
			source.draw(schemaSketchGen(defaultSchemaLimits)),
			{ mode: "drawn", edge: false },
			fullDataSwarm
		)
	)
	const desc = schemaDesc(schema)
	const coded = firstClosedId(schema)
	const [first] = schema.relations
	const checked = first === undefined ? undefined : first.columns[0]
	const intoClosed =
		coded !== undefined && source.draw(boolean)
			? {
					relation: closedRelation(
						"Lookup",
						{ k: { kind: "closedId", roster: coded.roster.closed, only: undefined } },
						["k"],
						Arr.map(coded.roster.handles, (handle) => ({ k: handle }))
					),
					statement: contained(on(coded.relation, [coded.field]), on("Lookup", ["k"]))
				}
			: undefined
	return {
		...desc,
		relations: [...desc.relations, ...(intoClosed === undefined ? [] : [intoClosed.relation])],
		statements: [
			...desc.statements,
			...(intoClosed === undefined ? [] : [intoClosed.statement]),
			...(first === undefined || checked === undefined
				? []
				: [check("Checked", first.name, eq(field(checked.name), field(checked.name)))])
		]
	}
}

export type EvidenceFeature =
	| "a candidate key"
	| "a primary key alone"
	| "a check"
	| "a containment into a closed relation"
	| "a committed-snapshot containment"

export const base = theoryUnder(W.WorkDesc, noImmediate)

export type DeclaredFeature = "one declaration" | "several declarations" | "the reverse undeclared"

const Report = relation("Report", { employee: f.uuid, manager: f.uuid }, ["employee"])

export const rt = theoryUnder(
	{
		name: "Org",
		relations: [Report],
		statements: [check("NotOwnManager", "Report", ne(field("employee"), field("manager")))],
		bases: []
	},
	noImmediate
)

export const checkLaw = defined(lawsOf(rt, "check")[0])

export const people = [G.a1, G.a2, G.a3] as const

export const manager = element<string>(["none", ...people])

const Label = relation("Label", { account: f.uuid, label: f.regex("^[a-z]{1,9}$", "u") }, [
	"account",
	"label"
])

const Account = relation("Account", { id: f.uuid, name: f.regex("^[a-z]{1,9}$", "u") }, ["id"])

export const kt = theoryUnder(
	{
		name: "K",
		relations: [Label, Account],
		statements: [key(on("Account", ["name"]))],
		bases: []
	},
	noImmediate
)

export const nameKey = Option.getOrThrow(Arr.findFirst(kt.laws, (l) => l.shape === "key")).id

export const named = element<"none" | "acme" | "beta">(["none", "acme", "beta"])

/**
 * The statements a law identity must not see: a containment Work does not state, which its schema orders after every
 * statement Work states, and Account declared mutable, in the unit its id leads, which no law reads and which the schema
 * orders before every statement a law of Work comes from, so each law's statement index moves by one (the law's
 * `statements`) while its identity stays.
 */
export const extra = [
	contained(on("Task", ["id"]), on("TaskNote", ["task"])),
	mutable("Account")
] as const

const note = on("TaskNote", ["task"])

const task = on("Task", ["id"])

/**
 * Each declaration is TaskNote(task) in Task(id), its reverse, or both (mirrors, sugar for its two containments);
 * Work states the first itself, so it is one law whatever is declared, and its reverse one law exactly when some
 * declaration states it.
 */
export const declaration = (source: Source): ReadonlyArray<StatementDesc> => {
	const spelling = source.draw(int(0, 3))
	return spelling === 0
		? [contained(note, task)]
		: spelling === 1
			? [contained(task, note)]
			: spelling === 2
				? mirrors(note, task)
				: mirrors(task, note)
}

/** What the search built once before its cases (ids), now once per worker: every case on it reads them. */
export const idsNeed = {
	key: "test/unit/analysis/logical/theory.fixtures.ts idsNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const ids = [G.a1, G.a2, G.a3]
		return Effect.succeed(ids)
	})
} as const satisfies Need<unknown>
