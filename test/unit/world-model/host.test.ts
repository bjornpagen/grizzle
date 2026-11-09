import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Order,
	pipe,
	Predicate,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { getEligibility } from "#adapter/reader/eligibility.ts"
import { identity } from "#compiler/core/identity.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { literalDescShape } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading, RelNode, RootedDag } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { queryOver as queryBuilt, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { sameIdentity } from "#test/support/kernel/identity.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { isDrawn, isSpan } from "#test/support/laws/model.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import {
	type Bindings,
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"

import type { Uuid } from "#compiler/public/fields.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	literalOf,
	type Row,
	type Value as ReferenceValue
} from "#test/support/oracle/reference/values.ts"
import { textAnswer } from "#test/support/oracle/reference/world.ts"
import { buildBase, buildInstall, sourcesOf } from "#test/support/worlds/execute/build.ts"
import { definitionOf } from "#test/support/worlds/execute/describe.ts"
import { carrierOf } from "#test/support/worlds/execute/host.ts"
import { knownNonEmpty, pooled } from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import {
	classifyEntry,
	entryRows,
	evaluateRules,
	factKey,
	isMember,
	ruleFaults
} from "#test/support/worlds/model/host.ts"
import { entryKeyed } from "#test/support/worlds/model/session/keys.ts"
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

/**
 * evaluateRules, the worlds model's meaning of a rule set, over rules drawn over the documents base: the reference
 * evaluator, run on the checked DAG of the same rules built as an application builds them (execute/describe.ts
 * definitionOf, the executor's own translation), gives the same rows over the same reality, derived facts and session. The host is the oracle
 * of the worlds suites; the reference is a second opinion that reads grizzle's own checked form, so a disagreement is
 * a defect of one of the two, never resolved by the other's word.
 *
 * The rules join on shared variables, negate conjunctions of one or two occurrences (correlated, with variables of
 * their own, reading a context), compare variables with literals, other variables and context fields by every
 * operator, read ordinary relations, the closed roster Tier, the derived relation OrgDocs and the contexts Session and
 * Tenant, and union two rules; the session holds each context's fact or none. Values come from small pools, so facts
 * meet each other and the claims.
 *
 * A writable entry's rows are exactly the head projections of its target's facts that isMember holds in it: over the
 * documents worlds' writable entries and drawn realities and sessions, entryRows and isMember agree.
 */

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
	OrgDocs: { org: "org", doc: "doc" },
	Session: { sub: "sub" },
	Tenant: { org: "org" }
}

const sources: Arr.NonEmptyReadonlyArray<Source> = [
	{ kind: "ordinary", name: "Org" },
	{ kind: "ordinary", name: "Doc" },
	{ kind: "ordinary", name: "Share" },
	{ kind: "ordinary", name: "Note" },
	{ kind: "closed", name: "Tier" },
	{ kind: "derived", name: "OrgDocs" },
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

/** How a drawn occurrence binds a field: most often a shared variable, then a literal, rarely another variable. */
const uses = ["unnamed", "var", "var", "var", "other", "literal", "literal", "claim"] as const

/**
 * A field's term: unnamed; the variable of its kind every scope shares; another variable (a second one of the kind in
 * the rule, one of the negation's own inside a negation); a literal from its pool; or the context field of its kind.
 */
const fieldTerm = (
	use: (typeof uses)[number],
	kind: Kind,
	negated: boolean
): Gen<Term | undefined> => {
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
					const term = source.draw(fieldTerm(source.draw(element(uses)), kind, negated))
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

/** A term of a kind: a bound variable of the kind (most often), a literal, or the kind's context field. */
const termOfKind = (bound: ReadonlyMap<string, Kind>, kind: Kind): Gen<Term> => {
	const variables = Arr.flatMap([...bound], ([name, k]): ReadonlyArray<Gen<Term>> =>
		k === kind ? [constant({ kind: "var", name })] : []
	)
	const claim = claimOf(kind)
	return oneOf(
		Arr.appendAll(
			Arr.append([...variables, ...variables], literal(kind)),
			claim === undefined ? [] : [constant(claim)]
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

const derivedGen: Gen<Readonly<Record<string, ReadonlyArray<HostFact>>>> = map(
	factsGen("OrgDocs"),
	(facts) => ({ OrgDocs: facts })
)

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
	return succeeded(irLiteral(decoded, type), `${what} is a literal of its type`).literal
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
const fieldValue = (fact: HostFact, field: string): HostValue => {
	const value = fact[field]
	if (value === undefined) {
		throw new Error(`a drawn fact without its field ${field}`)
	}
	return value
}

const hostText = (v: HostValue): string =>
	isSpan(v) ? `[${v.start},${v.end})` : isDrawn(v) ? `draw ${String(v.draw)}` : String(v)

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
const checkedDag = (query: unknown, over: unknown): RootedDag =>
	succeeded(compileTemplate(query, over, testCompile), "the query compiles").programs.checked.dag

/**
 * The reference's rows of a checked DAG over reality, the derived facts and the session: each stored and derived
 * relation a Base reads, under its Base heading, its facts as typed literals; each context a Context node reads, the
 * session's fact or none.
 */
const referenceRows = (
	dag: RootedDag,
	reality: HostState,
	derived: Readonly<Record<string, ReadonlyArray<HostFact>>>,
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
	const factsOf = (name: string): ReadonlyArray<HostFact> =>
		reality.get(name) ?? derived[name] ?? []
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
const answerOf = (
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<Readonly<Record<string, string>>>
) =>
	textAnswer(
		columns,
		Arr.map(rows, (r) => Arr.map(columns, (c) => r[c] ?? ""))
	)

const hostRows = (rows: ReadonlyArray<HostFact>): ReadonlyArray<Readonly<Record<string, string>>> =>
	Arr.map(rows, (r) =>
		Rec.fromEntries(Arr.map(Rec.toEntries(r), ([field, v]) => [field, hostText(v)] as const))
	)

type HostFeature =
	| "an ordinary source"
	| "the closed source"
	| "the derived source"
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

const situations: Arr.NonEmptyReadonlyArray<HostFeature> = [
	"an ordinary source",
	"the closed source",
	"the derived source",
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
const featuresOf = (
	rules: Arr.NonEmptyReadonlyArray<Rule>,
	reality: HostState,
	derived: Readonly<Record<string, ReadonlyArray<HostFact>>>,
	session: ContextFacts,
	rows: number
): ReadonlyArray<HostFeature> => {
	const count = (rs: Arr.NonEmptyReadonlyArray<Rule>): number =>
		evaluateRules(docsBase, rs, reality, derived, session).length
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
		...(Arr.some(positive, (o) => sourceNameOf(o) === "OrgDocs")
			? ["the derived source" as const]
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

const rulesOfShape = (shape: Shape): Arr.NonEmptyReadonlyArray<Rule> =>
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

/** A host case: the rules' shape, a reality holding what the shape selects, a derived relation's facts and a session. */
interface HostCase {
	readonly shape: Shape
	readonly reality: HostState
	readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
	readonly session: ContextFacts
}

const caseGen: Gen<HostCase> = (source) => {
	const shape = source.draw(
		oneOf([map(rulesGen, (rules): Shape => ({ kind: "drawn", rules })), unionShape])
	)
	return {
		shape,
		reality: withShape(source.draw(realityGen), shape),
		derived: source.draw(derivedGen),
		session: source.draw(sessionGen)
	}
}

/** What the membership property draws: a reality, a derived relation's facts and a session. */
const worldGen: Gen<Omit<HostCase, "shape">> = (source) => ({
	reality: source.draw(realityGen),
	derived: source.draw(derivedGen),
	session: source.draw(sessionGen)
})

/** The documents base built as an application builds it, and the values its rules match. */
const docsBuilt = Effect.runSync(Effect.orDie(buildBase(docsBase, "docs")))

const docsSources = sourcesOf(docsBuilt)

const schema = docsBuilt.base

const described = (x: unknown): string => Formatter.format(x)

/** A model state over the documents worlds holding `reality` and `derived`; nothing else of it is read here. */
const stateOf = (
	reality: HostState,
	derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
): ModelState => ({
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
		rosterConstants: {},
		codes: {},
		keys: {},
		roles: {},
		logins: {}
	},
	host: { relations: [], laws: [] },
	reality,
	derived,
	sessions: [],
	connections: [],
	tampered: [],
	version: 0,
	loginsCreated: Rec.fromEntries(Arr.map(docsInstall.logins, (l) => [l.name, 0] as const)),
	migrations: { kind: "applied" }
})

/** Each writable query entry of the documents worlds: its role, its name, and its target's name. */
const writableEntries = Arr.flatMap(docsInstall.roles, (role) =>
	Arr.flatMap(Rec.toEntries(role.entries), ([name, entry]) => {
		const c = classifyEntry(docsBase, entry)
		return entry.kind === "query" && c.kind === "writable"
			? [{ role: role.name, name, target: c.target, head: c.head }]
			: []
	})
)

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

/**
 * A role's union of two Doc arms told apart by words: one keeps every Doc's id, org and owner where words is 0, the
 * other one row per org where words is 1, its id and owner fixed. Each arm's own key misses the other arm, so only the
 * whole heading's minimization keys the union by (id, org, words).
 */
const unionAcrossArms: InstallSpec = {
	base: docsBase,
	roles: [
		{
			name: "alpha",
			entries: {
				View0: {
					kind: "query",
					rules: [
						{
							matches: [docScan],
							negations: [],
							comparisons: [],
							head: {
								id: { kind: "var", name: "v_id" },
								org: { kind: "var", name: "v_org" },
								owner: { kind: "var", name: "v_owner" },
								words: { kind: "literal", value: 0 }
							}
						},
						{
							matches: [docScan],
							negations: [],
							comparisons: [],
							head: {
								id: { kind: "literal", value: "5eeda101-7c3e-4a1b-9d2f-0e5c7a9b3d1f" },
								org: { kind: "var", name: "v_org" },
								owner: { kind: "literal", value: "u_nxyob" },
								words: { kind: "literal", value: 1 }
							}
						}
					]
				}
			},
			write: [],
			refresh: []
		}
	],
	logins: [{ name: "web", roles: ["alpha"] }]
}

/** The shared budget of the host properties: one at a time, unsteered, shrunk until no pass helps. */
const budget = {
	literal: Formatter.format,
	kept: [],
	shrink: { kind: "complete" },
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

describe("the worlds model's host semantics", () => {
	it.effect(
		"evaluates every drawn rule set as the reference evaluates the query an application builds from it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						...budget,
						suite: "unit/world-model/host",
						draw: drawn(caseGen),
						coverage: required(situations, { cases: 200, sense: notesOnly }),
						runs: 200
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const rules = rulesOfShape(drawnCase.shape)
							const what = described(rules)
							assert.deepEqual(
								ruleFaults(docsBase, rules),
								[],
								`the drawn rules are well formed: ${what}`
							)
							const built = yield* Effect.result(
								definitionOf(docsBase, docsSources, rules, schema, what)
							)
							if (Result.isFailure(built)) {
								return assert.fail(
									`the builder refuses the rules, ${built.failure.message}: ${what}`
								)
							}
							const query = built.success
							const { reality, derived, session } = drawnCase
							const rows = evaluateRules(docsBase, rules, reality, derived, session)
							const columns = Arr.sort(Rec.keys(rules[0].head), Order.String)
							assert.deepEqual(
								answerOf(columns, hostRows(rows)),
								answerOf(
									columns,
									referenceRows(checkedDag(query, schema), reality, derived, session)
								),
								`the host and the reference agree: ${what}`
							)
							c.noteAll(featuresOf(rules, reality, derived, session, rows.length))
						})
				)
			)
	)

	it.effect(
		"holds in a writable entry exactly the target facts whose head projections are its rows",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						...budget,
						suite: "unit/world-model/host membership",
						draw: drawn(worldGen),
						coverage: required<"a member" | "a non-member">(["a member", "a non-member"], {
							cases: 100,
							sense: notesOnly
						}),
						runs: 100
					},
					({ reality, derived, session }, c) =>
						Effect.sync(() => {
							const state = stateOf(reality, derived)
							for (const entry of writableEntries) {
								const facts = reality.get(entry.target) ?? []
								const members = Arr.filter(facts, (f) =>
									isMember(state, entry.role, entry.name, session, f)
								)
								const projected = Arr.map(members, (f) =>
									Rec.fromEntries(
										Arr.map(
											Rec.toEntries(entry.head),
											([h, { field }]) => [h, fieldValue(f, field)] as const
										)
									)
								)
								const columns = Arr.sort(Rec.keys(entry.head), Order.String)
								assert.deepEqual(
									answerOf(columns, hostRows(projected)),
									answerOf(columns, hostRows(entryRows(state, entry.role, entry.name, session))),
									`${entry.role}.${entry.name} holds the projections of its members`
								)
								c.noteAll([
									...(members.length > 0 ? ["a member" as const] : []),
									...(members.length < facts.length ? ["a non-member" as const] : [])
								])
							}
						})
				)
			)
	)

	it.effect(
		"proves a role relation's field set a get key exactly where grizzle's get eligibility does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						...budget,
						suite: "unit/world-model/host get keys",
						draw: drawn(installGen(docsBase)),
						coverage: required<"a key" | "no key">(["a key", "no key"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [
							{
								note: "a union keyed by Doc's id where words is 0 and by its org where words is 1: (id, org, words) is a key though no one arm's key beside the separator is",
								sketch: unionAcrossArms,
								draws: "",
								reaches: ["a key", "no key"]
							}
						],
						runs: 60
					},
					(install, c) =>
						Effect.gen(function* () {
							const built = yield* Effect.result(buildInstall(install, "worlds_keys"))
							if (Result.isFailure(built)) {
								return
							}
							for (const role of install.roles) {
								const roleValue = built.success.roles[role.name]
								if (roleValue === undefined) {
									continue
								}
								for (const [name, spec] of Rec.toEntries(role.entries)) {
									const heading = headingOf(install.base, spec)
									for (const fields of fieldSets(heading)) {
										const keyed = entryKeyed(
											install.base,
											spec,
											Arr.map(fields, (f) => f.name)
										)
										const value: unknown = Predicate.hasProperty(roleValue.relations, name)
											? roleValue.relations[name]
											: undefined
										const query = queryBuilt(roleValue).rule((r: RuleValue): FinishedValue => {
											const vars = varsOver(value, "value")
											return Arr.reduce(fields, r.match(value, vars), (matched, f) =>
												matched.where(r.eq(vars[f.name], carrierOf(f.domain, pooled(f.domain, 0))))
											).find(vars)
										})
										/** A get the builder refuses before its eligibility (a literal it will not type) is the read's own refusal. */
										const compiled = compileTemplate(query, roleValue, testCompile)
										if (!compiled.ok) {
											continue
										}
										assert.equal(
											Result.isSuccess(getEligibility(compiled.value)),
											keyed,
											`get of ${role.name}.${name} by ${Arr.join(
												Arr.map(fields, (f) => f.name),
												", "
											)}: the model says ${keyed ? "a key" : "no key"}`
										)
										c.note(keyed ? "a key" : "no key")
									}
								}
							}
						})
				)
			)
	)
})

/** Every nonempty set of a heading's fields, the heading cut to its first five. */
const fieldSets = (heading: ReadonlyArray<FieldSpec>): ReadonlyArray<ReadonlyArray<FieldSpec>> => {
	const none: ReadonlyArray<ReadonlyArray<FieldSpec>> = [[]]
	return Arr.filter(
		Arr.reduce(heading.slice(0, 5), none, (sets, f) => [
			...sets,
			...Arr.map(sets, (set) => [...set, f])
		]),
		(set) => set.length > 0
	)
}
