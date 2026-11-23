/** What the properties of host.test.ts read: its spaces, models and helpers. */

import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, pipe, Record as Rec, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { literalDescShape } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading, RelNode, RootedDag } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, type FixtureSchema, testCompile } from "#test/support/compile.ts"
import { sameIdentity } from "#test/support/kernel/identity.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { isSpan } from "#test/support/laws/model.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import {
	type Bindings,
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"

import type { Uuid } from "#compiler/public/fields.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import {
	literalOf,
	type Row,
	type Value as ReferenceValue
} from "#test/support/oracle/reference/values.ts"
import { textAnswer } from "#test/support/oracle/reference/world.ts"
import { buildBase, sourcesOf } from "#test/support/worlds/execute/build.ts"
import { knownNonEmpty, pool } from "#test/support/worlds/generate/domain.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { classifyEntry, evaluateRules, factKey } from "#test/support/worlds/model/host.ts"
import { installedRoles } from "#test/support/worlds/model/session/writes.ts"
import type {
	Comparison,
	ComparisonOp,
	ContextFacts,
	FieldSpec,
	HostFact,
	HostState,
	InstallSpec,
	ModelState,
	Occurrence,
	Rule,
	Source,
	Term,
	HostValue
} from "#test/support/worlds/model/types.ts"

type Kind = "org" | "doc" | "sub" | "plan" | "int" | "no" | "tier"

const token = (prefix: string, n: number): Uuid =>
	`${prefix}${pipe(n.toString(16), Str.padStart(4, "0"))}-7c3e-4a1b-9d2f-0e5c7a9b3d1f`

const pools: Readonly<Record<Kind, Arr.NonEmptyReadonlyArray<HostValue>>> = {
	org: [token("0a1e", 1), token("0a1e", 2), token("0a1e", 3)],
	doc: [token("0d0c", 1), token("0d0c", 2), token("0d0c", 3), token("0d0c", 4)],
	sub: ["u_ann", "u_bob", "u_cat"],
	plan: [0, 1, 2, 3, 4],
	int: [0, 1, 2, 3, 4],
	no: [1, 2, 3, 4],
	tier: ["Free", "Pro"]
}

/** The kind of each field of each source a rule reads: which pool its values come from. */
const kinds: Readonly<Record<string, Readonly<Record<string, Kind>>>> = {
	Org: { id: "org", plan: "plan" },
	Doc: { id: "doc", org: "org", owner: "sub", words: "int" },
	Share: { doc: "doc", user: "sub" },
	Note: { no: "no", doc: "doc", author: "sub" },
	Visit: { no: "no", seq: "no" },
	Tier: { id: "tier" },
	Session: { sub: "sub" },
	Tenant: { org: "org" }
}

const sources: Arr.NonEmptyReadonlyArray<Source> = [
	{ kind: "ordinary", name: "Org" },
	{ kind: "ordinary", name: "Doc" },
	{ kind: "ordinary", name: "Share" },
	{ kind: "ordinary", name: "Note" },
	{ kind: "closed", name: "Tier" },
	{ kind: "context", name: "Session" },
	{ kind: "context", name: "Tenant" }
]

/** The fields of a relation or context, each with its kind: none for a name the model gives no fields. */
const kindsOf = (name: string): Readonly<Record<string, Kind>> => kinds[name] ?? {}

const fieldKinds = (source: Source): ReadonlyArray<readonly [string, Kind]> =>
	Rec.toEntries(kindsOf(source.name))

/** The context field a field of a kind may be equated to. */
const claimOf = (kind: Kind): Term | undefined => {
	if (kind === "sub") {
		return { kind: "context", context: "Session", field: "sub" }
	}
	return kind === "org" ? { kind: "context", context: "Tenant", field: "org" } : undefined
}

/** A literal of a kind, from its pool. */
const literal = (kind: Kind): Gen<Term> =>
	map(element(pools[kind]), (value): Term => ({ kind: "literal", value }))

/** Between one and `max` items, the first always there. */
const nonEmpty =
	<A>(item: Gen<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		const first = source.draw(item)
		return [first, ...source.draw(array(item, { min: 0, max: max - 1 }))]
	}

const headKinds: Arr.NonEmptyReadonlyArray<Kind> = [
	"org",
	"doc",
	"sub",
	"plan",
	"int",
	"no",
	"tier"
]

/** How a drawn occurrence binds a field. */
type Use = "unnamed" | "var" | "other" | "literal" | "claim"

/** How often each binding is drawn: most often a shared variable, then a literal, rarely another variable. */
const useGen: Gen<Use> = weighted<Use>([
	[1, constant("unnamed")],
	[3, constant("var")],
	[1, constant("other")],
	[2, constant("literal")],
	[1, constant("claim")]
])

/**
 * A field's term: unnamed; the variable of its kind every scope shares; another variable (a second one of the kind in
 * the rule, one of the negation's own inside a negation); a literal from its pool; or the context field of its kind.
 */
const fieldTerm = (use: Use, kind: Kind, negated: boolean): Gen<Term | undefined> => {
	switch (use) {
		case "unnamed":
			return constant(undefined)
		case "var":
			return constant({ kind: "var", name: `${kind}0` })
		case "other":
			return constant({ kind: "var", name: negated ? `local_${kind}` : `${kind}1` })
		case "literal":
			return literal(kind)
		case "claim": {
			const claim = claimOf(kind)
			return claim === undefined ? literal(kind) : constant(claim)
		}
	}
}

const occurrenceGen =
	(negated: boolean): Gen<Occurrence> =>
	(source) => {
		const drawnSource = source.draw(element(sources))
		return {
			source: drawnSource,
			fields: Rec.fromEntries(
				Arr.flatMap(fieldKinds(drawnSource), ([field, kind]) => {
					const term = source.draw(fieldTerm(source.draw(useGen), kind, negated))
					return term === undefined ? [] : [[field, term] as const]
				})
			)
		}
	}

/** Each variable the positive matches bind, with its kind. */
const boundKinds = (matches: ReadonlyArray<Occurrence>): ReadonlyMap<string, Kind> =>
	new Map(
		Arr.flatMap(matches, (o) =>
			Arr.flatMap(fieldKinds(o.source), ([field, kind]) => {
				const term = o.fields[field]
				return term?.kind === "var" ? [[term.name, kind] as const] : []
			})
		)
	)

const ops: Arr.NonEmptyReadonlyArray<ComparisonOp> = ["=", "<>", "<", "<=", ">", ">="]

/** A term of a kind: a bound variable of the kind, each twice as often as a literal or the kind's context field. */
const termOfKind = (bound: ReadonlyMap<string, Kind>, kind: Kind): Gen<Term> => {
	const variables = Arr.flatMap([...bound], ([name, k]): ReadonlyArray<Weighted<Term>> =>
		k === kind ? [[2, constant({ kind: "var", name })]] : []
	)
	const claim = claimOf(kind)
	return weighted(
		Arr.appendAll(
			Arr.append(variables, [1, literal(kind)] as const),
			claim === undefined ? [] : [[1, constant(claim)] as const]
		)
	)
}

/** A comparison of one of the bound variables with a term of its kind. */
const comparisonOf =
	(
		bound: ReadonlyMap<string, Kind>,
		variables: Arr.NonEmptyReadonlyArray<string>
	): Gen<Comparison> =>
	(source) => {
		const name = source.draw(element(variables))
		const kind = bound.get(name) ?? "int"
		return {
			left: { kind: "var", name },
			op: source.draw(element(ops)),
			right: source.draw(termOfKind(bound, kind))
		}
	}

const ruleGen =
	(head: Arr.NonEmptyReadonlyArray<Kind>): Gen<Rule> =>
	(source) => {
		const matches = source.draw(nonEmpty(occurrenceGen(false), 3))
		const negations = source.draw(array(nonEmpty(occurrenceGen(true), 2), { min: 0, max: 2 }))
		const bound = boundKinds(matches)
		const [variable, ...variables] = [...bound.keys()]
		return {
			matches,
			negations,
			comparisons:
				variable === undefined
					? []
					: source.draw(array(comparisonOf(bound, [variable, ...variables]), { min: 0, max: 2 })),
			head: Rec.fromEntries(
				Arr.map(head, (kind, i) => [`h${i}`, source.draw(termOfKind(bound, kind))] as const)
			)
		}
	}

/** An entry's rules: one to three head fields, each of a kind, and one or two rules with that head. */
const rulesGen: Gen<Arr.NonEmptyReadonlyArray<Rule>> = (source) =>
	source.draw(nonEmpty(ruleGen(source.draw(nonEmpty(element(headKinds), 3))), 2))

/** Every fact of a relation, each field at each value of its pool. */
const allFactsOf = (relation: string): Arr.NonEmptyReadonlyArray<HostFact> =>
	Arr.reduce(
		Rec.toEntries(kindsOf(relation)),
		[{}],
		(facts: Arr.NonEmptyReadonlyArray<HostFact>, [field, kind]) =>
			Arr.flatMap(facts, (fact) =>
				Arr.map(pools[kind], (value): HostFact => ({ ...fact, [field]: value }))
			)
	)

/** A relation's facts drawn from its fields' pools, up to four, each fact once. */
const factsGen = (relation: string): Gen<ReadonlyArray<HostFact>> =>
	shuffled(allFactsOf(relation), { min: 0, max: 4 })

const realityGen: Gen<HostState> = (source) =>
	new Map(Arr.map(docsBase.relations, (r) => [r.name, source.draw(factsGen(r.name))] as const))

/** A session: each context's fact from its pool (a tenant's seats its pick), or none. */
const sessionGen: Gen<ContextFacts> = (source) => {
	const session = source.draw(int(0, 3))
	const tenant = source.draw(int(0, 3))
	const sub = pools.sub[session - 1]
	const org = pools.org[tenant - 1]
	return {
		...(sub === undefined ? {} : { Session: { sub } }),
		...(org === undefined ? {} : { Tenant: { org, seats: tenant } })
	}
}

/** A host value as a reference literal of a column's type: a 64-bit integer as a bigint, a span by its endpoints. */
const referenceLiteral = (
	value: HostValue | undefined,
	type: ScalarType,
	what: string
): TypedLiteral => {
	const carried =
		value === undefined
			? value
			: isSpan(value)
				? { span: value }
				: typeof value === "number" && baseOf(type).carrier === "int8"
					? BigInt(value)
					: value
	const decoded = succeeded(S.decodeWith(literalDescShape, carried, what), `${what} is a literal`)
	return succeeded(irLiteral(decoded, type), `${what} is a literal of its type`)
}

const referenceText = (v: ReferenceValue | undefined, at: string): string => {
	if (
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "bigint" ||
		typeof v === "boolean"
	) {
		return String(v)
	}
	throw new Error(`the reference gives ${at} a value no documents field holds`)
}

/** A fact's value at a field it holds by construction. */
export const fieldValue = (fact: HostFact, field: string): HostValue => {
	const value = fact[field]
	if (value === undefined) {
		throw new Error(`a drawn fact without its field ${field}`)
	}
	return value
}

const hostText = (v: HostValue): string => (isSpan(v) ? `[${v.start},${v.end})` : String(v))

/** The session's facts as the reference reads them: each context holding a fact, its value at each field. */
type SessionFacts = Readonly<Record<string, Readonly<Record<string, ReferenceValue>>>>

/** The reference over reality and a session: a Context node is the session's fact of its context, or no row. */
class SessionReference extends Reference {
	readonly session: SessionFacts

	protected constructor(dag: RootedDag, input: ReferenceInput, session: SessionFacts) {
		super(dag, input)
		this.session = session
	}

	static over(dag: RootedDag, input: ReferenceInput, session: SessionFacts): SessionReference {
		return new SessionReference(dag, input, session).settle()
	}

	override rows(node: RelNode, scope: Bindings): ReadonlyArray<Row> {
		if (node.kind !== "Context") {
			return super.rows(node, scope)
		}
		const fact = this.session[node.context]
		return fact === undefined
			? []
			: [
					Arr.map(node.heading, (c) => {
						const value = fact[c.name]
						if (value === undefined) {
							throw new Error(`the session's ${node.context} fact without ${c.name}`)
						}
						return value
					})
				]
	}
}

/** The checked DAG of a query over a schema, as the runtime compiles it. */
export const checkedDag = (query: unknown, over: FixtureSchema | undefined): RootedDag =>
	succeeded(compileTemplate(query, over, testCompile), "the query compiles").programs.checked.dag

/**
 * The reference's rows of a checked DAG over reality and the session: each stored relation a Base reads, under its Base
 * heading, its facts as typed literals; each context a Context node reads, the session's fact or none.
 */
export const referenceRows = (
	dag: RootedDag,
	reality: HostState,
	session: ContextFacts
): ReadonlyArray<Readonly<Record<string, string>>> => {
	const nodes = topoOrder(dag)
	const stored = new Map(
		Arr.flatMap(nodes, (n) =>
			n.kind === "Base" && n.relationKind !== "world" ? [[n.relation, n.heading] as const] : []
		)
	)
	const contexts = new Map(
		Arr.flatMap(nodes, (n) => (n.kind === "Context" ? [[n.context, n.heading] as const] : []))
	)
	const factsOf = (name: string): ReadonlyArray<HostFact> => reality.get(name) ?? []
	/** A fact of a relation as the reference's row under a heading: each column's value a typed literal. */
	const referenceRow = (name: string, heading: Heading, fact: HostFact) =>
		Arr.map(heading, (c) => referenceLiteral(fact[c.name], c.type, `${name}.${c.name}`))
	const input: ReferenceInput = {
		schema: {
			name: docsBase.name,
			relations: Arr.map([...stored], ([name, heading]) => ({
				name,
				columns: Arr.map(heading, (c) => ({ name: c.name, type: c.type })),
				primaryKey: [],
				keys: [],
				mutable: false
			})),
			closed: [],
			containments: []
		},
		facts: canonicalFacts(
			Rec.fromEntries(
				Arr.map(
					[...stored],
					([name, heading]) =>
						[name, Arr.map(factsOf(name), (f) => referenceRow(name, heading, f))] as const
				)
			)
		),
		params: {},
		functions: noFunctions,
		observer: unobserved
	}
	const contextFacts: SessionFacts = Rec.fromEntries(
		Arr.flatMap([...contexts], ([name, heading]) => {
			const fact = session[name]
			return fact === undefined
				? []
				: [
						[
							name,
							Rec.fromEntries(
								Arr.map(
									heading,
									(c) =>
										[
											c.name,
											literalOf(referenceLiteral(fact[c.name], c.type, `${name}.${c.name}`), c.type)
										] as const
								)
							)
						] as const
					]
		})
	)
	const answer = SessionReference.over(dag, input, contextFacts).eval(dag.roots[0], noBindings)
	return Arr.map(answer.rows, (r) =>
		Rec.fromEntries(
			Arr.map(answer.heading, (c, i) => [c.name, referenceText(r[i], c.name)] as const)
		)
	)
}

/** Rows as one answer over the head's fields: each row's texts in field order, sorted, each once. */
export const answerOf = (
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<Readonly<Record<string, string>>>
) =>
	textAnswer(
		columns,
		Arr.map(rows, (r) => Arr.map(columns, (c) => r[c] ?? ""))
	)

export const hostRows = (
	rows: ReadonlyArray<HostFact>
): ReadonlyArray<Readonly<Record<string, string>>> =>
	Arr.map(rows, (r) =>
		Rec.fromEntries(Arr.map(Rec.toEntries(r), ([field, v]) => [field, hostText(v)] as const))
	)

/** What a host case reaches, each judged by the host's own answer. */
export type HostFeature =
	| "an ordinary source"
	| "the closed source"
	| "a context source"
	| "a join"
	| "a negation that filters"
	| "a negated conjunction"
	| "a negation reading a context"
	| "a comparison that filters"
	| "an order comparison that filters"
	| "a context read with its fact"
	| "a context read without its fact"
	| "a union both rules feed"
	| "rows"
	| "no rows"

export const situations: Arr.NonEmptyReadonlyArray<HostFeature> = [
	"an ordinary source",
	"the closed source",
	"a context source",
	"a join",
	"a negation that filters",
	"a negated conjunction",
	"a negation reading a context",
	"a comparison that filters",
	"an order comparison that filters",
	"a context read with its fact",
	"a context read without its fact",
	"a union both rules feed",
	"rows",
	"no rows"
]

const contextsRead = (rules: ReadonlyArray<Rule>): ReadonlySet<string> => {
	const terms = Arr.flatMap(rules, (r) => [
		...Arr.flatMap([...r.matches, ...Arr.flatten(r.negations)], (o) => Rec.values(o.fields)),
		...Rec.values(r.head),
		...Arr.flatMap(r.comparisons, (c) => [c.left, c.right])
	])
	const occurrences = Arr.flatMap(rules, (r) => [...r.matches, ...Arr.flatten(r.negations)])
	return new Set([
		...Arr.flatMap(terms, (t) => (t.kind === "context" ? [t.context] : [])),
		...Arr.flatMap(occurrences, (o) => (o.source.kind === "context" ? [o.source.name] : []))
	])
}

const readsContext = (occurrences: ReadonlyArray<Occurrence>): boolean =>
	Arr.some(
		occurrences,
		(o) =>
			o.source.kind === "context" || Arr.some(Rec.values(o.fields), (t) => t.kind === "context")
	)

/** What a case reached, each judged by the host's own answer with a part of the rules taken away. */
export const featuresOf = (
	rules: Arr.NonEmptyReadonlyArray<Rule>,
	reality: HostState,
	session: ContextFacts,
	rows: number
): ReadonlyArray<HostFeature> => {
	const count = (rs: Arr.NonEmptyReadonlyArray<Rule>): number =>
		evaluateRules(docsBase, rs, reality, session).length
	const without = (part: (r: Rule) => Rule): number => {
		const [first, ...rest] = rules
		return count([part(first), ...Arr.map(rest, part)])
	}
	/** A rule with only its equality and inequality comparisons. */
	const equalitiesOf = (r: Rule): Rule => ({
		...r,
		comparisons: Arr.filter(r.comparisons, (c) => c.op === "=" || c.op === "<>")
	})
	/** An occurrence's source's name. */
	const sourceNameOf = (o: Occurrence): string => o.source.name
	const positive = Arr.flatMap(rules, (r) => r.matches)
	const joined = Arr.some(positive, (o, i) =>
		Arr.some(
			Rec.values(o.fields),
			(t) =>
				t.kind === "var" &&
				Arr.some(
					positive,
					(p, j) =>
						j !== i && Arr.some(Rec.values(p.fields), (u) => u.kind === "var" && u.name === t.name)
				)
		)
	)
	const [first, second] = rules
	const fedByBoth = second !== undefined && count([first]) < rows && count([second]) < rows
	const read = contextsRead(rules)
	const out: Array<HostFeature> = [
		...(Arr.some(positive, (o) => o.source.kind === "ordinary")
			? ["an ordinary source" as const]
			: []),
		...(Arr.some(positive, (o) => sourceNameOf(o) === "Tier")
			? ["the closed source" as const]
			: []),
		...(Arr.some(positive, (o) => o.source.kind === "context")
			? ["a context source" as const]
			: []),
		...(joined ? ["a join" as const] : []),
		...(Arr.some(rules, (r) => Arr.some(r.negations, (n) => n.length > 1))
			? ["a negated conjunction" as const]
			: []),
		...(Arr.some(rules, (r) => Arr.some(r.negations, readsContext))
			? ["a negation reading a context" as const]
			: []),
		...(Arr.some([...read], (c) => session[c] !== undefined)
			? ["a context read with its fact" as const]
			: []),
		...(Arr.some([...read], (c) => session[c] === undefined)
			? ["a context read without its fact" as const]
			: []),
		...(fedByBoth ? ["a union both rules feed" as const] : []),
		...(rows > 0 ? ["rows" as const] : ["no rows" as const])
	]
	if (without((r) => ({ ...r, negations: [] })) > rows) {
		out.push("a negation that filters")
	}
	if (without((r) => ({ ...r, comparisons: [] })) > rows) {
		out.push("a comparison that filters")
	}
	if (without(equalitiesOf) > rows) {
		out.push("an order comparison that filters")
	}
	return out
}

/**
 * The shape of a case's rules, a stratum of the draw: rules drawn whole, or a union of two rules that each select one
 * of two distinct facts of an ordinary relation the reality holds, so each rule feeds the union a row the other does
 * not: a union both rules feed, reached by construction.
 */
type Shape =
	| { readonly kind: "drawn"; readonly rules: Arr.NonEmptyReadonlyArray<Rule> }
	| {
			readonly kind: "union"
			readonly relation: string
			readonly facts: readonly [HostFact, HostFact]
	  }

const ordinaryNames: Arr.NonEmptyReadonlyArray<string> = ["Org", "Doc", "Share", "Note"]

const unionShape: Gen<Shape> = (source) => {
	const relation = source.draw(element(ordinaryNames))
	const all = allFactsOf(relation)
	const first = source.draw(element(all))
	const others = Arr.filter(all, (f) => !sameIdentity(factKey(f), factKey(first)))
	const second = source.draw(element(knownNonEmpty(others, `a second fact of ${relation}`)))
	return { kind: "union", relation, facts: [first, second] }
}

/** The variable a selecting rule binds a field to. */
const selectingVariable = (field: string): Term => ({ kind: "var", name: `x_${field}` })

/** A rule matching every field of a relation, each equal to a fact's value there: its one row is the fact. */
const selecting = (relation: string, fact: HostFact): Rule => {
	const fields = Rec.keys(kinds[relation] ?? {})
	return {
		matches: [
			{
				source: { kind: "ordinary", name: relation },
				fields: Rec.fromEntries(Arr.map(fields, (f) => [f, selectingVariable(f)] as const))
			}
		],
		negations: [],
		comparisons: Arr.map(fields, (f): Comparison => ({
			left: selectingVariable(f),
			op: "=",
			right: { kind: "literal", value: fieldValue(fact, f) }
		})),
		head: Rec.fromEntries(Arr.map(fields, (f, i) => [`h${i}`, selectingVariable(f)] as const))
	}
}

export const rulesOfShape = (shape: Shape): Arr.NonEmptyReadonlyArray<Rule> =>
	shape.kind === "drawn"
		? shape.rules
		: [selecting(shape.relation, shape.facts[0]), selecting(shape.relation, shape.facts[1])]

/** A reality holding a union shape's two facts besides its own. */
const withShape = (reality: HostState, shape: Shape): HostState => {
	if (shape.kind === "drawn") {
		return reality
	}
	const held = reality.get(shape.relation) ?? []
	const added = Arr.filter(
		shape.facts,
		(f) => !Arr.some(held, (g) => sameIdentity(factKey(g), factKey(f)))
	)
	return new Map([...reality, [shape.relation, [...held, ...added]] as const])
}

/** A host case: the rules' shape, a reality holding what the shape selects, and a session. */
interface HostCase {
	readonly shape: Shape
	readonly reality: HostState
	readonly session: ContextFacts
}

export const caseGen: Gen<HostCase> = (source) => {
	const shape = source.draw(
		oneOf([map(rulesGen, (rules): Shape => ({ kind: "drawn", rules })), unionShape])
	)
	return {
		shape,
		reality: withShape(source.draw(realityGen), shape),
		session: source.draw(sessionGen)
	}
}

/** What the membership property draws: a reality and a session. */
export const worldGen: Gen<Omit<HostCase, "shape">> = (source) => ({
	reality: source.draw(realityGen),
	session: source.draw(sessionGen)
})

/** The documents base built as an application builds it, and the values its rules match. */
const docsBuilt = Effect.runSync(Effect.orDie(buildBase(docsBase, "docs")))

export const docsSources = sourcesOf(docsBuilt)

export const schema = docsBuilt.base

export const described = (x: unknown): string => Formatter.format(x)

/** A model state over the documents worlds holding `reality`; nothing else of it is read here. */
export const stateOf = (reality: HostState): ModelState => ({
	install: docsInstall,
	names: {
		installation: identity.schema(parsedSchemaName("docs")),
		schema: "docs",
		levels: [identity.schema(parsedSchemaName("docs"))],
		tables: {},
		columns: {},
		primaryKeys: {},
		laws: [],
		domains: {},
		patterns: {},
		codes: {},
		keys: {},
		roles: {},
		logins: {}
	},
	host: { relations: [], laws: [] },
	roles: installedRoles(docsInstall),
	reality,
	sessions: [],
	connections: [],
	tampered: [],
	version: 0,
	loginsCreated: Rec.fromEntries(Arr.map(docsInstall.logins, (l) => [l.name, 0] as const)),
	migrations: { kind: "applied" }
})

/** Each writable query entry of the documents worlds: its role, its name, and its target's name. */
export const writableEntries = Object.freeze(
	Arr.flatMap(docsInstall.roles, (role) =>
		Arr.flatMap(Rec.toEntries(role.entries), ([name, entry]) => {
			const c = classifyEntry(docsBase, entry)
			return entry.kind === "query" && c.kind === "writable"
				? [{ role: role.name, name, target: c.target, head: c.head }]
				: []
		})
	)
)

/** Every nonempty set of a heading's fields, the heading cut to its first five. */
export const fieldSets = (
	heading: ReadonlyArray<FieldSpec>
): ReadonlyArray<ReadonlyArray<FieldSpec>> => {
	const none: ReadonlyArray<ReadonlyArray<FieldSpec>> = [[]]
	return Arr.filter(
		Arr.reduce(heading.slice(0, 5), none, (sets, f) => [
			...sets,
			...Arr.map(sets, (set) => [...set, f])
		]),
		(set) => set.length > 0
	)
}

/** One scan of every Doc field, each a variable of its own name. */
const docScan: Rule["matches"][number] = {
	source: { kind: "ordinary", name: "Doc" },
	fields: {
		id: { kind: "var", name: "v_id" },
		org: { kind: "var", name: "v_org" },
		owner: { kind: "var", name: "v_owner" },
		words: { kind: "var", name: "v_words" }
	}
}

/** The documents base's Doc fields but words, the field the union's arms are told apart by. */
const armFields: ReadonlyArray<FieldSpec> = Arr.filter(
	Option.getOrThrowWith(
		Arr.findFirst(docsBase.relations, (r) => r.name === "Doc"),
		() => new Error("the documents base's Doc")
	).fields,
	(f) => f.name !== "words"
)

/** A head term of a Doc field in one arm: the field's scan variable, or a literal of its domain's pool. */
const armTermGen = (field: FieldSpec): Gen<Term> =>
	oneOf<Term>([
		constant({ kind: "var", name: `v_${field.name}` }),
		map(element(pool(field.domain)), (value): Term => ({ kind: "literal", value }))
	])

/** An arm of the union: a scan of Doc, its head every field but words drawn (armTermGen), words the arm's separator. */
const armGen =
	(separator: number): Gen<Rule> =>
	(source) => ({
		matches: [docScan],
		negations: [],
		comparisons: [],
		head: {
			...Rec.fromEntries(Arr.map(armFields, (f) => [f.name, source.draw(armTermGen(f))] as const)),
			words: { kind: "literal", value: separator }
		}
	})

/**
 * An installation whose one role reads Doc through a union of two arms told apart by words, 0 in the first and 1 in
 * the second, every other field of each arm's head its scan variable or a literal: one arm's own key may miss the other
 * arm, so only the whole heading's minimization keys the union, as (id, org, words) keys the union of every Doc by
 * id where words is 0 and one row per org where words is 1, though no one arm's key beside the separator is.
 */
const unionAcrossArmsGen: Gen<InstallSpec> = (source) => ({
	base: docsBase,
	roles: [
		{
			name: "alpha",
			entries: {
				View0: { kind: "query", rules: [source.draw(armGen(0)), source.draw(armGen(1))] }
			},
			write: []
		}
	],
	logins: [{ name: "web", roles: ["alpha"] }]
})

/** A drawn installation of the documents base, or a union of Doc told apart across its arms (unionAcrossArmsGen). */
export const keysSpace: Gen<InstallSpec> = oneOf([installGen(docsBase), unionAcrossArmsGen])
