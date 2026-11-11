/**
 * Theory normalization: CheckedTheory from an owned schema, judged by properties over the differential oracle's
 * generated schemas and drawn field types, the lawful Work facts and every combination of planted violations, and small
 * fact spaces exhausted against the laws' meaning.
 *
 * - every law is one Forbid node over its violation query, and the violation queries mean what the laws say: evaluated
 *   by the reference evaluator they are empty on lawful facts and name exactly the violating witnesses, a model of each
 *   law's meaning written from its statement;
 * - union-find classes over containment pairings keep carrier, contract and roster identity, refuse incompatible
 *   pairings, and keep a typmod or a refinement inside one class, over pairs of generated field types;
 * - evidence carries its validity context: keys and checks immediate, a containment into a closed relation immediate,
 *   every other containment committed-snapshot only unless law specialization says otherwise;
 * - law identities are deterministic, independent of declaration order and of unrelated statements, come from the
 *   lawId option, must be distinct, and equivalent declarations, however often stated, are one law of one statement;
 * - a containment pairing more than one span field is UnsupportedLawFamily (the span law families themselves are
 *   unit/laws/recognition's).
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): span-pairing-two-admitted (a containment pairing two span fields
 * admitted) for the span pairings; field-classes-any-pairing (two fields of one carrier paired whatever their contract
 * or roster) for the classes; key-violation-no-differs (a key's violation pairs any two facts sharing the key, a fact
 * with itself) for the Work violations and the candidate key; check-violation-unnegated (a row check's violation names
 * the rows it holds of) for the row check; evidence-closed-target-deferred (a containment into a closed relation only
 * committed-snapshot evidence) for the evidence context; evidence-immediate-set-ignored (law specialization's immediate
 * set unread) for the containment context; law-id-names-its-statement (a law's identity names the statement it comes
 * from) for the identities' independence; the equivalent declarations share law-id-names-its-statement too, since a
 * restated law would take its later statement's identity.
 *
 * Features: each search's verdicts, pairings and contexts.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	shuffled,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { immediateEvidence, lawIdentityOf, type Theory } from "#compiler/analysis/theory/theory.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { FieldId, type LawId } from "#compiler/core/ids.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import { assert, defined, refused, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import * as G from "#test/support/fixtures/golden/work.ts"
import {
	check,
	closed,
	closedRelation,
	contained,
	eq,
	f,
	field,
	key,
	mirrors,
	ne,
	on,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	type GenSchema,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import {
	noImmediate,
	type EvidencedTestTheory,
	theoryResultOf,
	theoryUnder,
	violated
} from "#test/unit/analysis/logical/support.ts"
import { type HostFacts, uuidOf } from "#test/unit/analysis/theory/support.ts"
import { type DeclaredSketch, declaredGen, numericGen, textGen } from "#test/unit/ir/types.ts"

const lawsOf = (t: Theory, shape: string) => Arr.filter(t.laws, (l) => l.shape === shape)
const lawOf = (t: Theory, shape: string, relation: string) =>
	Option.getOrThrow(
		Arr.findFirst(
			t.laws,
			(l) => l.shape === shape && l.detail.kind === "key" && l.detail.relation === relation
		)
	).id
/** The containment an alternatives statement expands to from `from` into `to`: an arm's, or a handle's reverse. */
const alternativeOf = (t: Theory, from: string, to: string) =>
	Option.getOrThrowWith(
		Arr.findFirst(
			t.laws,
			(l) =>
				l.shape === "contained" &&
				l.source.kind === "alternatives" &&
				l.detail.kind === "containment" &&
				l.detail.from.relation === from &&
				l.detail.to.relation === to
		),
		() => new Error(`the alternatives expand to a containment from ${from} into ${to}`)
	).id

/**
 * The violations of every law, each law's rows sorted, as a map compared whole: the laws a state violates, each with
 * exactly its witnesses.
 */
const violatedSorted = (
	t: EvidencedTestTheory,
	facts: HostFacts
): ReadonlyMap<LawId, ReadonlyArray<ReadonlyArray<unknown>>> =>
	new Map(Arr.map([...violated(t, facts)], ([law, rows]) => [law, Arr.sort(rows, byText)]))

/** Rows by their values' text, joined by NUL. */
const byText: Order.Order<ReadonlyArray<unknown>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<unknown>) => Arr.join(Arr.map(row, String), "\u0000")
)

describe("span laws", () => {
	type SpanFeature = "no span field" | "one span field" | "several span fields"
	it.effect(
		"refuses a containment pairing more than one span field, whatever else it pairs, and admits one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/span-pairings",
						generator: (source) => {
							const spans = source.draw(int(0, 3))
							return [spans, source.draw(int(spans === 0 ? 1 : 0, 2))] as const
						},
						literal: Formatter.format,
						limit: 12,
						box: "a containment of zero to three span fields beside zero to two uuid fields",
						oracle: { kind: "specification", name: "a coverage law pairs one span field" },
						coverage: requiredInSpace<SpanFeature>([
							"no span field",
							"one span field",
							"several span fields"
						]),
						caseHang
					},
					([spans, uuids], c) =>
						Effect.sync(() => {
							const span = f.span(f.bigint, undefined)
							const spanFields = Arr.map(Arr.range(1, spans), (i) => `s${i}`)
							const uuidFields = Arr.map(Arr.range(1, uuids), (i) => `u${i}`)
							const fields = [...spanFields, ...uuidFields]
							const declared = Rec.fromEntries([
								...Arr.map(spanFields, (name) => [name, span] as const),
								...Arr.map(uuidFields, (name) => [name, f.uuid] as const)
							])
							const desc: SchemaDesc = {
								name: "Spans",
								relations: [
									relation("Two", { id: f.uuid, ...declared }, ["id"]),
									relation("Other", { id: f.uuid, ...declared }, ["id"])
								],
								statements: [contained(on("Two", fields), on("Other", fields))],
								extends: undefined
							}
							if (spans > 1) {
								c.note("several span fields")
								refused(theoryResultOf(desc), "UnsupportedLawFamily")
								return
							}
							c.note(spans === 1 ? "one span field" : "no span field")
							succeeded(theoryResultOf(desc))
						})
				)
			)
	)
})

/**
 * A field's identity, as a containment's pairing keeps it in one class: its carrier, a contract's name over its base's
 * identity, a closed id's or a set's roster, a span's endpoint, a vector's dimensions; never a numeric's typmod or a
 * text's refinement.
 */
const identityOf = (desc: FieldDesc): string => {
	switch (desc.kind) {
		case "pg":
			return desc.type
		case "numeric":
		case "bytes":
		case "uuid":
		case "text":
			return desc.kind
		case "contract":
			return `contract ${desc.name} over ${identityOf(desc.base)}`
		case "closedId":
		case "bits":
			return `${desc.kind} of ${desc.roster}`
		case "span":
			return `span over ${identityOf(desc.endpoint)}`
		case "vector":
			return `vector(${desc.dimensions})`
	}
}

/**
 * A drawn type's names, each a side's own: a contract `C<side><depth>` but natural, the builtin, and a roster `R<side>`,
 * so two sides share a contract or a roster exactly when one is the other's twin.
 */
const sided = (sketch: DeclaredSketch, side: string): DeclaredSketch => {
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
			case "pg":
			case "numeric":
			case "bytes":
			case "uuid":
			case "text":
			case "vector":
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

/** Whether a type is a bare date, which no field declares: a date field is the builtin contract over it. */
const bareDate = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "pg":
			return desc.type === "date"
		case "contract":
			return bareDate(desc.base)
		case "span":
			return bareDate(desc.endpoint)
		case "numeric":
		case "bytes":
		case "uuid":
		case "text":
		case "closedId":
		case "bits":
		case "vector":
			return false
	}
}

/** How the contained side's type is drawn against the containing side's. */
type Pairing = "a twin" | "another typmod or refinement" | "another roster" | "drawn apart"

/**
 * The contained side's type: its twin; another typmod or refinement of it; its roster's handles under a roster of its
 * own; or a type drawn apart.
 */
const pairedGen = (a: DeclaredSketch): Gen<readonly [Pairing, DeclaredSketch]> =>
	weighted([
		[1, constant(["a twin", a] as const)],
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
					case "pg":
					case "bytes":
					case "uuid":
					case "contract":
					case "span":
					case "vector":
						return ["a twin", a]
				}
			}
		],
		[
			2,
			map(
				filter(declaredGen, (b) => !bareDate(b.desc), 8),
				(b): readonly [Pairing, DeclaredSketch] => ["drawn apart", sided(b, "b")]
			)
		]
	])

type ClassFeature = "one identity" | Pairing | "another identity"

describe("field-compatibility classes", () => {
	it.effect(
		"admit a pairing of two fields exactly when their identities are one, keeping a typmod and a refinement inside one class",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/field-classes",
						literal: Formatter.format,
						draw: drawn((source) => {
							const a = sided(
								source.draw(filter(declaredGen, (sketch) => !bareDate(sketch.desc), 8)),
								"a"
							)
							return [a, ...source.draw(pairedGen(a))] as const
						}),
						runs: 300,
						shrink: completeShrink,
						coverage: required<ClassFeature>(
							[
								"one identity",
								"another identity",
								"a twin",
								"another typmod or refinement",
								"another roster",
								"drawn apart"
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "a class keeps carrier, contract and roster identity, never a typmod or a refinement"
						}
					},
					([a, pairing, b], c) =>
						Effect.sync(() => {
							c.note(pairing)
							const rosters = { ...a.rosters, ...b.rosters }
							const result = theoryResultOf({
								name: "R",
								relations: [
									...Arr.map(Rec.toEntries(rosters), ([name, handles]) => closed(name, handles)),
									relation("A", { id: f.uuid, x: a.desc }, ["id"]),
									relation("B", { id: f.uuid, y: b.desc }, ["id"])
								],
								statements: [contained(on("A", ["x"]), on("B", ["y"]))],
								extends: undefined
							})
							if (identityOf(a.desc) !== identityOf(b.desc)) {
								c.note("another identity")
								const e = refused(result, "Refused")
								assert.equal(
									e.reason._tag === "Refused" ? e.reason.refusal : undefined,
									"the sides' field types differ"
								)
								return
							}
							c.note("one identity")
							const t = succeeded(result)
							assert.deepEqual(
								Option.map(
									Arr.findFirst(t.classes, (x) => x.fields.includes(FieldId("A", "x"))),
									(x) => Arr.map(x.members, (m) => m.field)
								),
								Option.some([FieldId("A", "x"), FieldId("B", "y")])
							)
						})
				)
			)
	)
})

describe("violation queries mean what their laws say", () => {
	const t = theoryUnder(W.WorkDesc, noImmediate)
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
	 * the alternatives' arms into their handle's tasks and each handle's tasks into its arm; Cents' values below zero.
	 */
	type Facts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
	const factsOf = (facts: Facts, relation: string) => facts[relation] ?? []
	const textOf = (value: unknown): string =>
		typeof value === "bigint" ? `${value}n` : String(value)
	const shared = (relation: string, field: string) => (facts: Facts) =>
		Arr.flatMap(
			Arr.dedupe(Arr.map(factsOf(facts, relation), (fact) => textOf(fact[field]))),
			(value) => {
				const holding = Arr.filter(
					factsOf(facts, relation),
					(fact) => textOf(fact[field]) === value
				)
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
	type LawName =
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
	const model: ReadonlyArray<
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
			alternativeOf(t, "AutomaticTask", "Task"),
			lacking(
				{ relation: "AutomaticTask", field: "task" },
				{ relation: "Task", field: "id" },
				undefined,
				"Automatic"
			)
		],
		[
			"the Manual arm",
			alternativeOf(t, "ManualTask", "Task"),
			lacking(
				{ relation: "ManualTask", field: "task" },
				{ relation: "Task", field: "id" },
				undefined,
				"Manual"
			)
		],
		[
			"Automatic's reverse",
			alternativeOf(t, "Task", "AutomaticTask"),
			lacking(
				{ relation: "Task", field: "id" },
				{ relation: "AutomaticTask", field: "task" },
				"Automatic",
				undefined
			)
		],
		[
			"Manual's reverse",
			alternativeOf(t, "Task", "ManualTask"),
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
	const factsGen: Gen<Facts> = (source) => {
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
	it.effect(
		"every law's violation query names exactly the witnesses its statement's meaning gives, over drawn facts of Work",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/work-violations",
						literal: Formatter.format,
						draw: drawn(factsGen),
						runs: 300,
						shrink: completeShrink,
						coverage: required<LawName | "lawful" | "several at once">(
							[
								"Account's key",
								"Task's key",
								"AutomaticTask's key",
								"ManualTask's key",
								"TaskNote's key",
								"a task's account",
								"a note's task",
								"the Automatic arm",
								"the Manual arm",
								"Automatic's reverse",
								"Manual's reverse",
								"Cents",
								"lawful",
								"several at once"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "each law's witnesses, read from its statement over the host facts"
						}
					},
					(facts, c) =>
						Effect.sync(() => {
							const expected = new Map(
								Arr.flatMap(model, ([name, law, witnesses]) => {
									const rows = witnesses(facts)
									if (rows.length > 0) {
										c.note(name)
									}
									return rows.length > 0 ? [[law, Arr.sort(rows, byText)] as const] : []
								})
							)
							if (expected.size === 0) {
								c.note("lawful")
							}
							if (expected.size > 1) {
								c.note("several at once")
							}
							assert.deepEqual(violatedSorted(t, facts), expected)
						})
				)
			)
	)

	it.effect(
		"a row check's witnesses are exactly the keys of the rows its predicate refuses",
		(ctx) => {
			const Report = relation("Report", { employee: f.uuid, manager: f.uuid }, ["employee"])
			const rt = theoryUnder(
				{
					name: "Org",
					relations: [Report],
					statements: [check("NotOwnManager", "Report", ne(field("employee"), field("manager")))],
					extends: undefined
				},
				noImmediate
			)
			const checkLaw = defined(lawsOf(rt, "check")[0])
			const people = [G.a1, G.a2, G.a3]
			const manager = element<string>(["none", ...people])
			return searched(
				ctx,
				exhaust(
					{
						box: "three employees of a report, each managed by none, by themselves or by another",
						oracle: {
							kind: "specification",
							name: "the row check's meaning: exactly the employees who are their own manager violate it"
						},
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
			const kt = theoryUnder(
				{
					name: "K",
					relations: [Label, Account],
					statements: [key(on("Account", ["name"]))],
					extends: undefined
				},
				noImmediate
			)
			const nameKey = Option.getOrThrow(Arr.findFirst(kt.laws, (l) => l.shape === "key")).id
			const ids = [G.a1, G.a2, G.a3]
			const named = element<"none" | "acme" | "beta">(["none", "acme", "beta"])
			return searched(
				ctx,
				exhaust(
					{
						box: "three accounts, each named none, acme or beta, beside any set of labels",
						oracle: {
							kind: "specification",
							name: "the candidate key's meaning: two accounts sharing a name violate it, witnessed by the name; a pure set's key has nothing to differ on"
						},
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
})

/** The first closed id a relation of a generated schema holds: its relation, its field and its roster. */
const firstClosedId = (
	schema: GenSchema
): Readonly<{ relation: string; field: string; roster: Roster }> | undefined => {
	for (const r of schema.relations) {
		for (const column of r.columns) {
			if (column.type.carrier === "code") {
				return { relation: r.name, field: column.name, roster: column.type.roster }
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
const evidenceSchemaGen: Gen<SchemaDesc> = (source) => {
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
						{ k: { kind: "closedId", roster: coded.roster.closed } },
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

type EvidenceFeature =
	| "a candidate key"
	| "a primary key alone"
	| "a check"
	| "a containment into a closed relation"
	| "a committed-snapshot containment"

describe("evidence and its validity context", () => {
	it.effect(
		"keys and checks are immediate storage facts under ownership's constraint names, a containment into a closed relation holds at every statement and any other in committed snapshots",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/evidence-context",
						literal: Formatter.format,
						draw: drawn(evidenceSchemaGen),
						runs: 150,
						shrink: completeShrink,
						coverage: required<EvidenceFeature>(
							[
								"a candidate key",
								"a primary key alone",
								"a check",
								"a containment into a closed relation",
								"a committed-snapshot containment"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "ownership's keys and the containment's target kind"
						}
					},
					(desc, c) =>
						Effect.sync(() => {
							const owned = ownedFixture(desc).owned
							const t = theoryUnder(desc, noImmediate)
							for (const r of Rec.values(t.relations)) {
								if (r.kind !== "relation") {
									continue
								}
								const keys = Option.match(Rec.get(owned.relations, r.name), {
									onNone: () => [],
									onSome: (o) => o.keys
								})
								c.note(keys.length > 1 ? "a candidate key" : "a primary key alone")
								unorderedEqual(
									Arr.map(
										Arr.filter(t.evidence.keys, (k) => k.relation === r.name),
										(k) => [k.fields, k.primary, k.constraint, k.context] as const
									),
									Arr.map(keys, (k) => [k.fields, k.primary, k.constraint, "immediate"] as const)
								)
							}
							for (const check of t.evidence.checks) {
								c.note("a check")
								assert.equal(check.context, "immediate")
							}
							const immediate = immediateEvidence(t.evidence)
							assert.deepEqual(immediate.keys, t.evidence.keys)
							for (const containment of t.evidence.containments) {
								const intoClosed = t.relations[containment.to.relation]?.kind === "closed"
								c.note(
									intoClosed
										? "a containment into a closed relation"
										: "a committed-snapshot containment"
								)
								assert.equal(containment.context, intoClosed ? "immediate" : "committedSnapshot")
								assert.equal(immediate.containments.includes(containment), intoClosed)
							}
						})
				)
			)
	)

	it.effect(
		"law specialization states which containments are immediate through the immediate set theoryEvidence reads",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/containment-context-option",
						literal: Formatter.format,
						draw: drawn((source) => {
							const desc = source.draw(evidenceSchemaGen)
							const containedLaws = Arr.map(
								Arr.filter(
									theoryUnder(desc, noImmediate).laws,
									(l) => l.source.kind === "contained"
								),
								(l) => l.id
							)
							return [desc, source.draw(subarray(containedLaws))] as const
						}),
						runs: 100,
						shrink: completeShrink,
						coverage: required<"none named" | "some named">(["none named", "some named"], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "theoryEvidence's immediate set, a closed target aside"
						}
					},
					([desc, named], c) =>
						Effect.sync(() => {
							c.note(named.length === 0 ? "none named" : "some named")
							const t = theoryUnder(desc, new Set(named))
							/** A containment into a closed relation is immediate whatever the immediate set says. */
							const intoClosed = (k: (typeof t.evidence.containments)[number]) =>
								t.relations[k.to.relation]?.kind === "closed"
							for (const k of t.evidence.containments) {
								if (k.statement !== "contained" || intoClosed(k)) {
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
										(k) => intoClosed(k) || Arr.some(named, (n) => n === k.law)
									),
									(k) => k.law
								)
							)
						})
				)
			)
	)
})

describe("law identities", () => {
	const base = theoryUnder(W.WorkDesc, noImmediate)
	it.effect(
		"are deterministic, independent of declaration order and of unrelated statements",
		(ctx) => {
			const extra: ReadonlyArray<StatementDesc> = [
				contained(on("Task", ["id"]), on("TaskNote", ["task"]))
			]
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "metamorphic: every law keeps its identity under a permutation of the statements and an unrelated statement inserted"
						},
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
							const moved = theoryUnder({ ...W.WorkDesc, statements }, noImmediate)
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
								const { id, named, loc, ...identity } = law
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

	type DeclaredFeature = "one declaration" | "several declarations" | "the reverse undeclared"
	it.effect(
		"make equivalent declarations one law of one statement, however many times and in whichever order they are stated",
		(ctx) => {
			/**
			 * Each declaration is TaskNote(task) in Task(id), its reverse, or both (mirrors, sugar for its two containments);
			 * Work states the first itself, so it is one law whatever is declared, and its reverse one law exactly when some
			 * declaration states it.
			 */
			const note = on("TaskNote", ["task"])
			const task = on("Task", ["id"])
			const declaration = (source: Source): ReadonlyArray<StatementDesc> => {
				const spelling = source.draw(int(0, 3))
				return spelling === 0
					? [contained(note, task)]
					: spelling === 1
						? [contained(task, note)]
						: spelling === 2
							? mirrors(note, task)
							: mirrors(task, note)
			}
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/logical/law-ids-equivalent",
						generator: array(declaration, { min: 1, max: 3 }),
						literal: Formatter.format,
						limit: 2000,
						box: "one to three declarations, each a containment either way or mirrors in either spelling",
						oracle: {
							kind: "specification",
							name: "a law is its statement's meaning, stated once"
						},
						coverage: requiredInSpace<DeclaredFeature>([
							"one declaration",
							"several declarations",
							"the reverse undeclared"
						]),
						caseHang
					},
					(declared, c) =>
						Effect.sync(() => {
							c.note(declared.length === 1 ? "one declaration" : "several declarations")
							const statements = Arr.flatten(declared)
							const both = theoryUnder(
								{ ...W.WorkDesc, statements: [...W.WorkDesc.statements, ...statements] },
								noImmediate
							)
							const declaredInto = (from: string, to: string) =>
								Arr.filter(
									both.laws,
									(l) =>
										l.shape === "contained" &&
										l.source.kind === "contained" &&
										l.detail.kind === "containment" &&
										l.detail.from.relation === from &&
										l.detail.to.relation === to
								)
							const reverse = Arr.some(
								statements,
								(st) => st.kind === "contained" && st.left.relation === "Task"
							)
							if (!reverse) {
								c.note("the reverse undeclared")
							}
							assert.deepEqual(
								Arr.map(declaredInto("TaskNote", "Task"), (l) => l.statements.length),
								[1],
								"TaskNote(task) in Task(id) is one law of one statement"
							)
							assert.deepEqual(
								Arr.map(declaredInto("Task", "TaskNote"), (l) => l.statements.length),
								reverse ? [1] : [],
								"its reverse is one law of one statement where it is declared"
							)
						})
				)
			)
		}
	)
})
