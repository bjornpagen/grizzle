import { Array as Arr, type Effect, Option, Predicate, Record as Rec } from "effect"
import type { AnySchema } from "#compiler/public/schema.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore, handleTerm } from "#compiler/scalar/compute/builders.ts"
import { admittedClosedId, closedIdOf } from "#compiler/schema/relation.ts"
import { carrierOf } from "#test/support/worlds/execute/host.ts"
import { attempt, type RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { fieldDomain, headFieldDomain } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	Comparison,
	FieldDomain,
	Occurrence,
	Rule,
	Term,
	HostValue
} from "#test/support/worlds/model/types.ts"

/**
 * A rule of the worlds model as an application writes it, with grizzle's typed builder, query(S).rule(...): its
 * occurrences matched in order, its comparisons and negations as filters, its head found. Built so, a query entry's
 * and a derived relation's heading carries each field's column, and the role relation reads and writes as an
 * application's does; a query rebuilt from its Description alone carries none, and delivers no rows.
 *
 * A variable of a rule is one term, minted (varsOver) from the first occurrence that binds it. A context term is a
 * variable minted from its context and bound by a match of that context in the innermost conjunction holding it: the
 * rule's, or a negation's. A negation of one relation occurrence holding no context term and no variable of its own
 * (every variable it reads is the rule's) is a `not` of that relation; any other negation is a `not` of a one-rule
 * query over its occurrences, which mints its own variables where its matches bind them (grizzle refuses a `not` of a
 * relation reading a variable no match binds), and whose head is the variables it shares with the rule around it. A
 * literal is the JavaScript value its field's carrier takes: a 64-bit integer's a bigint. A handle is its roster's
 * typed constant, `X.handle(member)` (handleTerm), in every position.
 */
/** A literal as the carrier of the domain it meets takes it; one that meets no domain is its value. */
const literalOf = (value: HostValue, domain: Option.Option<FieldDomain>): unknown =>
	Option.isSome(domain) ? carrierOf(domain.value, value) : value

/**
 * Where the domains of a rule's fields come from: the base's relations, closed rosters, derived relations and contexts,
 * as the worlds model types them (model/host.ts fieldDomain), the one reading of a field's domain.
 */
interface Domains {
	readonly field: (source: Occurrence["source"], field: string) => Option.Option<FieldDomain>
	readonly context: (context: string, field: string) => Option.Option<FieldDomain>
}

const domainsOf = (base: BaseSpec): Domains => ({
	field: (source, field) => Option.fromUndefinedOr(fieldDomain(base, source, field)),
	context: (context, field) =>
		Option.fromUndefinedOr(fieldDomain(base, { kind: "context", name: context }, field))
})

/**
 * The domain of each head field of a rule set: what a fact written through, or read from, the entry carries, as the
 * worlds model types it (model/host.ts headFieldDomain): a term of some arm, else a literal's JavaScript default.
 */
export const headDomains = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): Readonly<Record<string, Option.Option<FieldDomain>>> =>
	Rec.fromEntries(
		Arr.map(
			Rec.keys(rules[0].head),
			(field) => [field, Option.fromUndefinedOr(headFieldDomain(base, rules, field))] as const
		)
	)

/** The values a rule's occurrences match: the base's relations, closed rosters and derived relations, and its contexts. */
export interface RuleSources {
	readonly relations: Readonly<Record<string, unknown>>
	readonly contexts: Readonly<Record<string, unknown>>
}

const sourceValue = (sources: RuleSources, source: Occurrence["source"]): unknown => {
	const values = source.kind === "context" ? sources.contexts : sources.relations
	const value = values[source.name]
	if (value === undefined) {
		throw new Error(`a rule matches ${source.kind} ${source.name}, which the base does not declare`)
	}
	return value
}

/** One field's term among a source's fresh variables, minted in the scope `scope`, the one variable it names. */
const variableOf = (source: unknown, field: string, scope: string): unknown => {
	const vars = varsOver(source, scope)
	const term = vars[field]
	if (term === undefined) {
		throw new Error(`a rule binds the field ${field}, which its source's heading does not hold`)
	}
	return term
}

/**
 * The terms of one rule, minted inside the rule callback that holds it (a rule's, or a negation's own): each variable
 * from the first occurrence binding it, each context term from its context, matched once per context.
 */
class Terms {
	readonly #sources: RuleSources
	readonly #domains: Domains
	readonly #vars = new Map<string, unknown>()
	readonly #contexts = new Map<string, Map<string, unknown>>()

	constructor(sources: RuleSources, domains: Domains) {
		this.#sources = sources
		this.#domains = domains
	}

	/** Mints every variable the occurrences bind, from the first occurrence that binds it. */
	bind(occurrences: ReadonlyArray<Occurrence>): void {
		for (const o of occurrences) {
			for (const [field, t] of Rec.toEntries(o.fields)) {
				if (t.kind === "var" && !this.#vars.has(t.name)) {
					this.#vars.set(t.name, variableOf(sourceValue(this.#sources, o.source), field, t.name))
				}
			}
		}
	}

	/**
	 * A term meeting `domain`: its variable, its context's variable, its roster's typed constant, or its literal as the
	 * domain's carrier takes it.
	 */
	of(term: Term, domain: Option.Option<FieldDomain>): unknown {
		switch (term.kind) {
			case "var": {
				const found = this.#vars.get(term.name)
				if (found === undefined) {
					throw new Error(`a rule reads the variable ${term.name}, which no occurrence binds`)
				}
				return found
			}
			case "context": {
				const fields = this.#contexts.get(term.context) ?? new Map<string, unknown>()
				this.#contexts.set(term.context, fields)
				const known = fields.get(term.field)
				if (known !== undefined) {
					return known
				}
				const minted = variableOf(
					sourceValue(this.#sources, { kind: "context", name: term.context }),
					term.field,
					`context_${term.context}_${term.field}`
				)
				fields.set(term.field, minted)
				return minted
			}
			case "handle": {
				const roster = sourceValue(this.#sources, { kind: "closed", name: term.closed })
				return handleTerm(roster, closedIdOf(roster), term.member)
			}
			case "literal":
				return literalOf(term.value, domain)
		}
	}

	/** An occurrence's bindings: each field's term, a literal as its field's carrier takes it. */
	bindings(o: Occurrence): Readonly<Record<string, unknown>> {
		return Rec.map(o.fields, (t, field) => this.of(t, this.#domains.field(o.source, field)))
	}

	/** The rule matched, after `at`, against each context its context terms read, binding those terms. */
	contextMatches(at: RuleValue): RuleValue {
		return Arr.reduce([...this.#contexts], at, (r, [context, fields]) =>
			r.match(
				sourceValue(this.#sources, { kind: "context", name: context }),
				Rec.fromEntries([...fields])
			)
		)
	}
}

const termsOfOccurrences = (occurrences: ReadonlyArray<Occurrence>): ReadonlyArray<Term> =>
	Arr.flatMap(occurrences, (o) => Rec.values(o.fields))

const varsOf = (terms: ReadonlyArray<Term>): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(terms, (t) => (t.kind === "var" ? [t.name] : [])))

/** The domain a comparison's literal meets: the other side's field's, context field's or roster's. */
const comparisonDomain = (domains: Domains, rule: Rule, term: Term): Option.Option<FieldDomain> => {
	if (term.kind === "context") {
		return domains.context(term.context, term.field)
	}
	if (term.kind === "handle") {
		return domains.field({ kind: "closed", name: term.closed }, "id")
	}
	if (term.kind === "var") {
		for (const o of rule.matches) {
			for (const [field, t] of Rec.toEntries(o.fields)) {
				if (t.kind === "var" && t.name === term.name) {
					return domains.field(o.source, field)
				}
			}
		}
	}
	return Option.none()
}

const compared = (r: RuleValue, op: Comparison["op"], left: unknown, right: unknown): unknown => {
	switch (op) {
		case "<":
			return r.lt(left, right)
		case "<=":
			return r.le(left, right)
		case "=":
			return r.eq(left, right)
		case "<>":
			return r.ne(left, right)
		case ">=":
			return r.ge(left, right)
		case ">":
			return r.gt(left, right)
	}
}

/** What a rule is built in: the values its occurrences match, the domains its literals meet, the schema it is over. */
interface Scope {
	readonly sources: RuleSources
	readonly domains: Domains
	readonly over: AnySchema
}

/** A negated conjunction as one `not`, its shared variables the ones the rule around it also reads. */
const negationOf = (
	scope: Scope,
	r: RuleValue,
	terms: Terms,
	negation: Arr.NonEmptyReadonlyArray<Occurrence>,
	outside: ReadonlySet<string>
): unknown => {
	const [only, ...more] = negation
	const local = termsOfOccurrences(negation)
	const read = varsOf(local)
	const shared = Arr.filter(read, (v) => outside.has(v))
	if (
		more.length === 0 &&
		shared.length === read.length &&
		!Arr.some(local, (t) => t.kind === "context")
	) {
		return r.not(sourceValue(scope.sources, only.source), terms.bindings(only))
	}
	const query = queryOver(scope.over).rule((ri: RuleValue): FinishedValue => {
		const inner = new Terms(scope.sources, scope.domains)
		inner.bind(negation)
		const matched = Arr.reduce(negation, ri, (q, o) =>
			q.match(sourceValue(scope.sources, o.source), inner.bindings(o))
		)
		return inner
			.contextMatches(matched)
			.find(
				Rec.fromEntries(
					Arr.map(shared, (v) => [v, inner.of({ kind: "var", name: v }, Option.none())] as const)
				)
			)
	})
	return r.not(
		query,
		Rec.fromEntries(
			Arr.map(shared, (v) => [v, terms.of({ kind: "var", name: v }, Option.none())] as const)
		)
	)
}

/** A value's own property, undefined when it holds none. */
const propertyOf = (value: unknown, key: string): unknown =>
	Predicate.hasProperty(value, key) ? value[key] : undefined

/** A derived relation's head field's descriptor, read through its first rule; none for a relation the base lacks. */
const derivedDescriptor = (
	base: BaseSpec,
	sources: RuleSources,
	name: string,
	field: string,
	seen: ReadonlySet<string>
): unknown => {
	const derived = Option.getOrUndefined(Arr.findFirst(base.derived, (d) => d.name === name))
	if (derived === undefined) {
		return undefined
	}
	const [rule] = derived.rules
	const term = rule.head[field]
	return term === undefined
		? undefined
		: termDescriptor(base, sources, rule, term, new Set([...seen, name]))
}

/**
 * The field descriptor of a source's field, the one the base declared: a relation's heading's, a closed roster's id
 * (admittedClosedId over the roster) or payload field's, a context's field's, or, for a derived relation, the descriptor its
 * first rule's head term for the field has; undefined
 * for a field no declaration types (a literal, or a derived relation read back through itself).
 */
const sourceDescriptor = (
	base: BaseSpec,
	sources: RuleSources,
	source: Occurrence["source"],
	field: string,
	seen: ReadonlySet<string>
): unknown => {
	switch (source.kind) {
		case "context":
			return propertyOf(propertyOf(sources.contexts[source.name], "fields"), field)
		case "ordinary":
			return propertyOf(propertyOf(sources.relations[source.name], "heading"), field)
		case "closed": {
			const roster = sources.relations[source.name]
			return field === "id"
				? admittedClosedId(roster)
				: propertyOf(propertyOf(roster, "payload"), field)
		}
		case "derived":
			return seen.has(source.name)
				? undefined
				: derivedDescriptor(base, sources, source.name, field, seen)
	}
}

/** The field descriptor of a head term of a rule: its variable's first occurrence's field's, or its context field's. */
const termDescriptor = (
	base: BaseSpec,
	sources: RuleSources,
	rule: Rule,
	term: Term,
	seen: ReadonlySet<string>
): unknown => {
	switch (term.kind) {
		case "literal":
			return undefined
		case "handle":
			return sourceDescriptor(base, sources, { kind: "closed", name: term.closed }, "id", seen)
		case "context":
			return sourceDescriptor(
				base,
				sources,
				{ kind: "context", name: term.context },
				term.field,
				seen
			)
		case "var": {
			for (const o of rule.matches) {
				for (const [field, t] of Rec.toEntries(o.fields)) {
					if (t.kind === "var" && t.name === term.name) {
						return sourceDescriptor(base, sources, o.source, field, seen)
					}
				}
			}
			return undefined
		}
	}
}

/**
 * The type of each field of a query's heading, as the descriptor of the first rule's head term that a declaration
 * types: what a head literal of another rule is typed by (Compute.literal), so every rule delivers the column at one
 * type. A field every rule fills with a literal has none, and its literals are typed by their JavaScript values; so
 * has a roster's, where a literal is its JavaScript value, which the checker types by the arms' enum.
 */
const headingDescriptors = (
	base: BaseSpec,
	sources: RuleSources,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): Readonly<Record<string, unknown>> => {
	const out: Record<string, unknown> = {}
	for (const rule of rules) {
		for (const [field, term] of Rec.toEntries(rule.head)) {
			if (out[field] === undefined) {
				out[field] = termDescriptor(base, sources, rule, term, new Set())
			}
		}
	}
	return out
}

/**
 * A head literal: typed by its heading column's descriptor, or its JavaScript value where no rule types the column or
 * the column is a roster's, whose member's typed constant is a handle term, never Compute.literal.
 */
const headLiteral = (
	descriptor: unknown,
	domain: Option.Option<FieldDomain>,
	value: unknown
): unknown =>
	descriptor === undefined || Option.exists(domain, (d) => d.kind === "handle")
		? value
		: computeCore.literal(descriptor, value)

/**
 * A head term as an application writes it: a literal typed by its heading column or its JavaScript value
 * (headLiteral), any other term, a handle among them, the conjunction's.
 */
const headTerm = (heading: HeadingTypes, terms: Terms, t: Term, field: string): unknown => {
	switch (t.kind) {
		case "literal": {
			const domain = heading.domains[field] ?? Option.none()
			return headLiteral(heading.descriptors[field], domain, literalOf(t.value, domain))
		}
		case "handle":
		case "var":
		case "context":
			return terms.of(t, Option.none())
	}
}

/** A query's heading: each field's domain and descriptor. */
interface HeadingTypes {
	readonly domains: Readonly<Record<string, Option.Option<FieldDomain>>>
	readonly descriptors: Readonly<Record<string, unknown>>
}

/** One rule as an arm of the query: matches, then context matches, then each predicate, then the head. */
const armOf =
	(scope: Scope, heading: HeadingTypes, rule: Rule) =>
	(r: RuleValue): FinishedValue => {
		const terms = new Terms(scope.sources, scope.domains)
		terms.bind(rule.matches)
		const head = Rec.mapEntries(
			rule.head,
			(t, field) => [field, headTerm(heading, terms, t, field)] as const
		)
		const comparisons = Arr.map(rule.comparisons, (c) =>
			compared(
				r,
				c.op,
				terms.of(c.left, comparisonDomain(scope.domains, rule, c.right)),
				terms.of(c.right, comparisonDomain(scope.domains, rule, c.left))
			)
		)
		const matched = Arr.reduce(rule.matches, r, (q, o) =>
			q.match(sourceValue(scope.sources, o.source), terms.bindings(o))
		)
		const own = [
			...termsOfOccurrences(rule.matches),
			...Arr.flatMap(rule.comparisons, (c) => [c.left, c.right]),
			...Rec.values(rule.head)
		]
		const outside = new Set(varsOf(own))
		const negations = Arr.map(rule.negations, (n) => negationOf(scope, r, terms, n, outside))
		return Arr.reduce([...comparisons, ...negations], terms.contextMatches(matched), (q, p) =>
			q.where(p)
		).find(head)
	}

/** The query value of an entry's or a derived relation's rules over `over`, each rule an arm, or the builders' refusal. */
export const definitionOf = (
	base: BaseSpec,
	sources: RuleSources,
	rules: Arr.NonEmptyReadonlyArray<Rule>,
	over: AnySchema,
	what: string
): Effect.Effect<QueryValue, RealizeRefused> =>
	attempt(what, () => {
		const scope: Scope = { sources, domains: domainsOf(base), over }
		const heading: HeadingTypes = {
			domains: headDomains(base, rules),
			descriptors: headingDescriptors(base, sources, rules)
		}
		const [first, ...rest] = rules
		return Arr.reduce(rest, queryOver(over).rule(armOf(scope, heading, first)), (query, rule) =>
			query.rule(armOf(scope, heading, rule))
		)
	})
