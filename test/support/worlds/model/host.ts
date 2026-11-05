import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	everyFact,
	fieldsEqual,
	type HostLaw,
	type HostRelation,
	type HostSelection,
	isSpan,
	type HostSide,
	isDrawn,
	selected
} from "#test/support/laws/model.ts"
import { textDomain } from "#test/support/worlds/model/text.ts"

import type {
	BaseSpec,
	ClosedSpec,
	Comparison,
	ComparisonOp,
	ContextFacts,
	EntryClass,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	Fill,
	HeadField,
	HostFact,
	HostSchema,
	HostState,
	InstalledNames,
	InstallSpec,
	LawIds,
	LawSpec,
	ModelState,
	Occurrence,
	RelationSpec,
	RowPredicate,
	Rule,
	SideSpec,
	Source,
	Term,
	HostValue
} from "#test/support/worlds/model/types.ts"

/**
 * The worlds model's host semantics, restated from the README and independent of grizzle's source: what a rule set
 * means over reality and a session's facts (evaluateRules), which role relations are writable and how (classifyEntry),
 * which rows a role relation holds (entryRows), whether a fact of a writable entry's target is in the entry (isMember),
 * and a base's laws as the host law model's (hostSchemaOf, test/support/laws/model.ts).
 *
 * Values are as PostgreSQL outputs them: a uuid in lowercase, an integer (a contract's value included) as a number, a
 * handle as its member's name, a span by its endpoints. Values of one kind are equal when they are the same value,
 * spans by their endpoints; values of two kinds are never equal. Values order as the database does: numbers
 * numerically, text and uuid by code point (the builtin C.UTF-8 collation), false before true, a handle by its
 * roster's member order; spans have no order.
 *
 * A closed roster's facts are one per member, the member under `id`, the handle field grizzle gives every closed fact.
 * A derived relation's facts are those of its last refresh, which the caller holds. A context holds the session's one
 * fact, or none.
 */

/** A value the model requires, or the defect of whoever named what is absent. */
const required = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`the worlds model reads ${what}, which is absent`)
	}
	return value
}

/** A record's own member, never one its prototype holds. */
const own = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
	Rec.has(record, key) ? record[key] : undefined

/**
 * Whether two values are one value: of one kind and equal, spans by their endpoints, drawn values by their draw (an
 * identity's draw equals no other value until the real system shows it).
 */
export const equalValues = (a: HostValue, b: HostValue): boolean => {
	if (isSpan(a)) {
		return isSpan(b) && a.start === b.start && a.end === b.end
	}
	if (isDrawn(a)) {
		return isDrawn(b) && a.draw === b.draw
	}
	return a === b
}

type Ordering = -1 | 0 | 1

const sign = (n: number): Ordering => (n < 0 ? -1 : n > 0 ? 1 : 0)

const utf8 = new TextEncoder()

/**
 * Two strings in code point order, as the builtin C.UTF-8 collation orders text, and the order of uuid's bytes: UTF-8
 * orders bytes as their code points.
 */
const byCodePoint = (a: string, b: string): Ordering => {
	const x = Arr.fromIterable(utf8.encode(a))
	const y = Arr.fromIterable(utf8.encode(b))
	return Option.match(
		Arr.findFirst(Arr.zip(x, y), ([p, q]) => p !== q),
		{ onNone: () => sign(x.length - y.length), onSome: ([p, q]) => sign(p - q) }
	)
}

/**
 * How a draw orders against another value (model/draws.ts): past every integer at or below its range's top, which the
 * case holds only as earlier draws of its identity or values below every range, and below every integer past it; a draw
 * of another identity by their ranges. Two draws of one identity have no order the model knows, and no rule or row check
 * the worlds generate orders a term against another, only against a literal, so meeting them is a defect of the case.
 */
const drawnOrder = (a: HostValue, b: HostValue): Ordering | "unordered" => {
	if (isDrawn(a) && isDrawn(b)) {
		if (a.ceiling === b.ceiling) {
			throw new Error(`the worlds model orders draws #${a.draw} and #${b.draw} of one identity`)
		}
		return sign(a.ceiling - b.ceiling)
	}
	if (isDrawn(a)) {
		return typeof b === "number" ? (b > a.ceiling ? -1 : 1) : "unordered"
	}
	if (isDrawn(b)) {
		return typeof a === "number" ? (a > b.ceiling ? 1 : -1) : "unordered"
	}
	return "unordered"
}

/**
 * How two values order in a domain; spans, values of two kinds and a handle outside its roster are unordered, and a
 * draw orders by its range (drawnOrder).
 */
const valueOrder = (
	domain: FieldDomain | undefined,
	a: HostValue,
	b: HostValue
): Ordering | "unordered" => {
	if (isDrawn(a) || isDrawn(b)) {
		return drawnOrder(a, b)
	}
	if (domain?.kind === "handle" && typeof a === "string" && typeof b === "string") {
		const ra = Arr.findFirstIndex(domain.members, (m) => m === a)
		const rb = Arr.findFirstIndex(domain.members, (m) => m === b)
		return Option.isNone(ra) || Option.isNone(rb) ? "unordered" : sign(ra.value - rb.value)
	}
	if (typeof a === "number" && typeof b === "number") {
		return sign(a - b)
	}
	if (typeof a === "string" && typeof b === "string") {
		return byCodePoint(a, b)
	}
	if (typeof a === "boolean" && typeof b === "boolean") {
		return sign(Number(a) - Number(b))
	}
	return "unordered"
}

const orderIn = (ordering: Ordering | "unordered", accepted: ReadonlyArray<Ordering>): boolean =>
	ordering !== "unordered" && Arr.contains(accepted, ordering)

/** Whether `a op b` holds between two values of a domain. */
const comparisonHolds = (
	op: ComparisonOp,
	domain: FieldDomain | undefined,
	a: HostValue,
	b: HostValue
): boolean => {
	switch (op) {
		case "=":
			return equalValues(a, b)
		case "<>":
			return !equalValues(a, b)
		case "<":
			return orderIn(valueOrder(domain, a, b), [-1])
		case "<=":
			return orderIn(valueOrder(domain, a, b), [-1, 0])
		case ">=":
			return orderIn(valueOrder(domain, a, b), [0, 1])
		case ">":
			return orderIn(valueOrder(domain, a, b), [1])
	}
}

/** A value's identity text: its kind and its spelling, so values of two kinds never share one. */
const valueKey = (v: HostValue): string => {
	if (isSpan(v)) {
		return `r${v.start},${v.end}`
	}
	if (isDrawn(v)) {
		return `d${v.draw}`
	}
	if (typeof v === "string") {
		return `s${v}`
	}
	return typeof v === "number" ? `n${v}` : `b${String(v)}`
}

const framed = (text: string): string => `${text.length}:${text}`

/** A fact's identity: every field and its value, the fields in one order, each part length-framed. */
export const factKey = (fact: HostFact): string => {
	let key = ""
	for (const field of Arr.sort(Rec.keys(fact), Order.String)) {
		const value = own(fact, field)
		if (value === undefined) {
			throw new Error(`the worlds model reads the field ${field}, which is absent`)
		}
		key += `${framed(field)}${framed(valueKey(value))}`
	}
	return key
}

/** The facts, each once, in the order they first appear. */
const distinct = (facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> => [
	...new Map(Arr.map(facts, (f) => [factKey(f), f] as const)).values()
]

/** A closed roster's facts: one per member, the member under `id`. */
const rosterFacts = (closed: ClosedSpec): ReadonlyArray<HostFact> =>
	Arr.map(closed.members, (id): HostFact => ({ id }))

/** The item named `name`: a relation, roster, derived relation or context of a base, a field, or a role. */
const named = <A extends { readonly name: string }>(
	items: ReadonlyArray<A>,
	name: string
): A | undefined => Option.getOrUndefined(Arr.findFirst(items, (item) => item.name === name))

/** Whether an item is named `name`. */
const holdsNamed = (items: ReadonlyArray<{ readonly name: string }>, name: string): boolean =>
	Arr.some(items, (item) => item.name === name)

/** The domain of a field of a relation or context, none when either is absent. */
const domainIn = (
	item: { readonly fields: ReadonlyArray<FieldSpec> } | undefined,
	field: string
): FieldDomain | undefined => (item === undefined ? undefined : named(item.fields, field)?.domain)

/** The ordinary relation an ordinary source names. */
const ordinaryOf = (base: BaseSpec, source: Source): RelationSpec | undefined =>
	source.kind === "ordinary" ? named(base.relations, source.name) : undefined

/** What a rule is read over: the base, reality, each derived relation's facts as of its last refresh, the session's. */
interface Reading {
	readonly base: BaseSpec
	readonly reality: HostState
	readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
	readonly facts: ContextFacts
}

/** The source of the base a whole entry names by its relation's name. */
const sourceNamed = (base: BaseSpec, name: string): Source => {
	if (holdsNamed(base.closed, name)) {
		return { kind: "closed", name }
	}
	return holdsNamed(base.derived, name) ? { kind: "derived", name } : { kind: "ordinary", name }
}

/**
 * The facts a source holds: an ordinary relation's in reality, a roster's members, a derived relation's as of its last
 * refresh, a context's one fact or none.
 */
const sourceFacts = (reading: Reading, source: Source): ReadonlyArray<HostFact> => {
	switch (source.kind) {
		case "ordinary":
			return reading.reality.get(source.name) ?? []
		case "closed": {
			const closed = named(reading.base.closed, source.name)
			return closed === undefined ? [] : rosterFacts(closed)
		}
		case "derived":
			return own(reading.derived, source.name) ?? []
		case "context": {
			const fact = own(reading.facts, source.name)
			return fact === undefined ? [] : [fact]
		}
	}
}

/** The domain of each variable a rule's positive matches bind: the domain of the first field binding it. */
type Typing = ReadonlyMap<string, FieldDomain>

/** A derived relation's field's domain: its head field's over its rules (headFieldDomain). */
const derivedFieldDomain = (
	base: BaseSpec,
	name: string,
	field: string
): FieldDomain | undefined => {
	const derived = named(base.derived, name)
	return derived === undefined ? undefined : headFieldDomain(base, derived.rules, field)
}

/** Text of any value: the type grizzle gives a string head literal no term types. */
const anyText: FieldDomain = textDomain("^.*$", "su")

/**
 * The type grizzle gives a head literal no term types, by its JavaScript value (README "Queries"): a string is text, a
 * safe integer an integer, a boolean a boolean; a span has none.
 */
export const literalDefault = (value: HostValue): FieldDomain | undefined => {
	if (typeof value === "string") {
		return anyText
	}
	if (typeof value === "number") {
		return Number.isSafeInteger(value) ? { kind: "integer", bits: 32 } : undefined
	}
	return typeof value === "boolean" ? { kind: "boolean" } : undefined
}

/**
 * A head field's domain from its rule set's arms that deliver it by a term: the one the first such arm in rule order
 * gives it, which every literal of the field takes; none for a field only literals fill.
 */
export const termHeadDomain = (
	base: BaseSpec,
	rules: ReadonlyArray<Rule>,
	field: string
): FieldDomain | undefined => {
	for (const rule of rules) {
		const term = own(rule.head, field)
		const domain = term === undefined ? undefined : termDomain(base, typingOf(base, rule), term)
		if (domain !== undefined) {
			return domain
		}
	}
	return undefined
}

/**
 * A head field's domain over a rule set's arms: the one a term of some arm gives it (termHeadDomain); else its first
 * literal's JavaScript default (literalDefault). A literal's type is carried by its value, never guessed from what its
 * rule matches.
 */
export const headFieldDomain = (
	base: BaseSpec,
	rules: ReadonlyArray<Rule>,
	field: string
): FieldDomain | undefined => {
	const typed = termHeadDomain(base, rules, field)
	if (typed !== undefined) {
		return typed
	}
	for (const rule of rules) {
		const term = own(rule.head, field)
		if (term?.kind === "literal") {
			return literalDefault(term.value)
		}
	}
	return undefined
}

/**
 * The domain of a field of a source, as the base declares it; none for a field the source lacks. A roster's one field
 * is `id`, a handle of its members.
 */
export const fieldDomain = (
	base: BaseSpec,
	source: Source,
	field: string
): FieldDomain | undefined => {
	switch (source.kind) {
		case "ordinary":
			return domainIn(named(base.relations, source.name), field)
		case "closed": {
			const closed = named(base.closed, source.name)
			return closed === undefined || field !== "id"
				? undefined
				: { kind: "handle", closed: closed.name, members: closed.members }
		}
		case "derived":
			return derivedFieldDomain(base, source.name, field)
		case "context":
			return domainIn(named(base.contexts, source.name), field)
	}
}

/** The domain of a term: a variable's, a context field's, a typed handle's roster; a literal has none of its own. */
const termDomain = (base: BaseSpec, typing: Typing, term: Term): FieldDomain | undefined => {
	switch (term.kind) {
		case "var":
			return typing.get(term.name)
		case "literal":
			return undefined
		case "context":
			return fieldDomain(base, { kind: "context", name: term.context }, term.field)
		case "handle":
			return fieldDomain(base, { kind: "closed", name: term.closed }, "id")
	}
}

/** Each variable an occurrence binds, with the domain of the field binding it. */
const bindingDomains = (
	base: BaseSpec,
	occurrences: ReadonlyArray<Occurrence>
): ReadonlyArray<readonly [string, FieldDomain]> =>
	Arr.flatMap(occurrences, (o) =>
		Arr.flatMap(Rec.toEntries(o.fields), ([field, term]) => {
			const domain = fieldDomain(base, o.source, field)
			return term.kind === "var" && domain !== undefined ? [[term.name, domain] as const] : []
		})
	)

const typingOf = (base: BaseSpec, rule: Rule): Typing =>
	new Map(Arr.reverse(bindingDomains(base, rule.matches)))

/** One assignment of a rule's variables. */
type Assignment = ReadonlyMap<string, HostValue>

/** The facts the occurrence at an index of a rule's positive matches reads. */
type FactsAt = (occurrence: Occurrence, index: number) => ReadonlyArray<HostFact>

const factOf = (fact: HostFact, field: string): HostValue | undefined => own(fact, field)

/**
 * A term's value under an assignment: a bound variable's, a literal, a typed handle's member, a present context's
 * field; otherwise none.
 */
const termValue = (reading: Reading, term: Term, at: Assignment): HostValue | undefined => {
	switch (term.kind) {
		case "var":
			return at.get(term.name)
		case "literal":
			return term.value
		case "handle":
			return term.member
		case "context": {
			const fact = own(reading.facts, term.context)
			return fact === undefined ? undefined : factOf(fact, term.field)
		}
	}
}

/** The assignment under which `term` takes `value`: `at`, `at` with a variable bound, or none. */
const bindTerm = (
	reading: Reading,
	term: Term,
	value: HostValue | undefined,
	at: Assignment
): Assignment | undefined => {
	if (value === undefined) {
		return undefined
	}
	if (term.kind !== "var") {
		const constant = termValue(reading, term, at)
		return constant !== undefined && equalValues(constant, value) ? at : undefined
	}
	const bound = at.get(term.name)
	if (bound === undefined) {
		return new Map(at).set(term.name, value)
	}
	return equalValues(bound, value) ? at : undefined
}

/** The assignment extending `at` under which `fact` meets every named field of `occurrence`, or none. */
const unify = (
	reading: Reading,
	occurrence: Occurrence,
	fact: HostFact,
	at: Assignment
): Assignment | undefined =>
	Arr.reduce<readonly [string, Term], Assignment | undefined>(
		Rec.toEntries(occurrence.fields),
		at,
		(env, [field, term]) =>
			env === undefined ? undefined : bindTerm(reading, term, factOf(fact, field), env)
	)

/** Every assignment extending one of `from` under which each occurrence meets a fact of its source, in order. */
const extend = (
	reading: Reading,
	occurrences: ReadonlyArray<Occurrence>,
	factsAt: FactsAt,
	from: ReadonlyArray<Assignment>
): ReadonlyArray<Assignment> =>
	Arr.reduce<Occurrence, ReadonlyArray<Assignment>>(occurrences, from, (envs, occurrence, index) =>
		Arr.flatMap(envs, (env) =>
			Arr.flatMap(factsAt(occurrence, index), (fact) => {
				const next = unify(reading, occurrence, fact, env)
				return next === undefined ? [] : [next]
			})
		)
	)

const readsSources =
	(reading: Reading): FactsAt =>
	(occurrence) =>
		sourceFacts(reading, occurrence.source)

/** Whether a comparison holds under an assignment: both terms have values and they compare as it says. */
const holdsUnder = (reading: Reading, typing: Typing, c: Comparison, at: Assignment): boolean => {
	const left = termValue(reading, c.left, at)
	const right = termValue(reading, c.right, at)
	if (left === undefined || right === undefined) {
		return false
	}
	const domain =
		termDomain(reading.base, typing, c.left) ?? termDomain(reading.base, typing, c.right)
	return comparisonHolds(c.op, domain, left, right)
}

/** The head's row under an assignment, or none when a head term has no value there. */
const project = (
	reading: Reading,
	head: Readonly<Record<string, Term>>,
	at: Assignment
): HostFact | undefined => {
	const values = Arr.map(
		Rec.toEntries(head),
		([field, term]) => [field, termValue(reading, term, at)] as const
	)
	return Arr.every(values, (entry): entry is readonly [string, HostValue] => entry[1] !== undefined)
		? Rec.fromEntries(values)
		: undefined
}

/**
 * One rule's rows: every assignment under which each positive match meets a fact of its source (the one at an index
 * reading what `factsAt` gives), each comparison holds, and no negated conjunction meets facts of its sources under any
 * extension; the head's row under each. A term with no value (an unbound variable, an absent context's field) meets no
 * fact, holds no comparison and projects no row, so a context term needs its context's fact in the conjunction it is
 * in: the rule's positive part, or the one negation holding it.
 */
const ruleRows = (reading: Reading, rule: Rule, factsAt: FactsAt): ReadonlyArray<HostFact> => {
	const typing = typingOf(reading.base, rule)
	const extended = extend(reading, rule.matches, factsAt, [new Map()])
	const compared = Arr.filter(extended, (at) =>
		Arr.every(rule.comparisons, (c) => holdsUnder(reading, typing, c, at))
	)
	const unnegated = Arr.filter(compared, (at) =>
		Arr.every(rule.negations, (n) => extend(reading, n, readsSources(reading), [at]).length === 0)
	)
	return Arr.flatMap(unnegated, (at) => {
		const row = project(reading, rule.head, at)
		return row === undefined ? [] : [row]
	})
}

/**
 * The meaning of a rule set over reality, the derived relations' facts and the session's: the union of its rules'
 * rows, each row once. Pure and total; a rule ruleFaults refuses has the meaning the clauses above give it.
 */
export const evaluateRules = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>,
	reality: HostState,
	derived: Readonly<Record<string, ReadonlyArray<HostFact>>>,
	facts: ContextFacts
): ReadonlyArray<HostFact> => {
	const reading: Reading = { base, reality, derived, facts }
	return distinct(Arr.flatMap(rules, (rule) => ruleRows(reading, rule, readsSources(reading))))
}

/**
 * Why a rule set is no query grizzle builds: a source or field the base does not declare, a head or comparison variable
 * no positive match binds, a variable or term met in fields of two domains, a literal outside its field's domain, an
 * order comparison of spans (spans have no order), or rules whose heads name different fields.
 */
export type RuleFault =
	| { readonly kind: "unknown-source"; readonly source: Source }
	| { readonly kind: "unknown-field"; readonly source: Source; readonly field: string }
	| { readonly kind: "unbound-variable"; readonly variable: string }
	| { readonly kind: "domain-mismatch"; readonly term: Term }
	| {
			readonly kind: "literal-outside-domain"
			readonly value: HostValue
			readonly domain: FieldDomain
	  }
	| { readonly kind: "span-order"; readonly op: ComparisonOp }
	| { readonly kind: "heads-differ" }

/**
 * The type a domain's column has: a variable's columns share one, as grizzle requires. An integer and a serial of one
 * width are one type, a contract is its own, a text pattern its own, a handle its roster's.
 */
const domainClass = (domain: FieldDomain): string => {
	switch (domain.kind) {
		case "integer":
		case "serial":
			return `integer ${domain.bits}`
		case "contract":
			return `contract ${domain.name}`
		case "text":
			return `text ${framed(domain.flags)}${framed(domain.pattern)}`
		case "handle":
			return `handle ${domain.closed}`
		case "span":
			return `span ${domain.bits}`
		case "uuid":
		case "boolean":
			return domain.kind
	}
}

const sameClass = (a: FieldDomain | undefined, b: FieldDomain | undefined): boolean =>
	a === undefined || b === undefined || domainClass(a) === domainClass(b)

/** Whether a literal is a value of a domain. */
const inDomain = (value: HostValue, domain: FieldDomain): boolean => {
	switch (domain.kind) {
		case "uuid":
		case "text":
			return typeof value === "string"
		case "integer":
		case "serial":
			return typeof value === "number" && Number.isSafeInteger(value)
		case "contract":
			return (
				typeof value === "number" &&
				Number.isSafeInteger(value) &&
				domain.min <= value &&
				value <= domain.max
			)
		case "boolean":
			return typeof value === "boolean"
		case "handle":
			return typeof value === "string" && Arr.contains(domain.members, value)
		case "span":
			return isSpan(value) && value.start < value.end
	}
}

const sourceKnown = (base: BaseSpec, source: Source): boolean => {
	switch (source.kind) {
		case "ordinary":
			return holdsNamed(base.relations, source.name)
		case "closed":
			return holdsNamed(base.closed, source.name)
		case "derived":
			return holdsNamed(base.derived, source.name)
		case "context":
			return holdsNamed(base.contexts, source.name)
	}
}

/**
 * The faults of one term met where a field of `domain` is: an unknown context field or roster, a domain apart, a
 * literal or a handle outside.
 */
const termFaults = (
	base: BaseSpec,
	typing: Typing,
	term: Term,
	domain: FieldDomain | undefined
): ReadonlyArray<RuleFault> => {
	if (term.kind === "handle") {
		const roster = named(base.closed, term.closed)
		if (roster === undefined) {
			return [{ kind: "unknown-source", source: { kind: "closed", name: term.closed } }]
		}
		const own: FieldDomain = { kind: "handle", closed: roster.name, members: roster.members }
		if (!Arr.contains(roster.members, term.member)) {
			return [{ kind: "literal-outside-domain", value: term.member, domain: own }]
		}
		return sameClass(own, domain) ? [] : [{ kind: "domain-mismatch", term }]
	}
	if (term.kind === "context") {
		const declared = fieldDomain(base, { kind: "context", name: term.context }, term.field)
		if (declared === undefined) {
			return [
				{
					kind: "unknown-field",
					source: { kind: "context", name: term.context },
					field: term.field
				}
			]
		}
		return sameClass(declared, domain) ? [] : [{ kind: "domain-mismatch", term }]
	}
	if (term.kind === "literal") {
		return domain === undefined || inDomain(term.value, domain)
			? []
			: [{ kind: "literal-outside-domain", value: term.value, domain }]
	}
	return sameClass(typing.get(term.name), domain) ? [] : [{ kind: "domain-mismatch", term }]
}

/** The faults of a conjunction of occurrences under a typing of the variables in scope. */
const occurrenceFaults = (
	base: BaseSpec,
	typing: Typing,
	occurrences: ReadonlyArray<Occurrence>
): ReadonlyArray<RuleFault> =>
	Arr.flatMap(occurrences, (o): ReadonlyArray<RuleFault> => {
		if (!sourceKnown(base, o.source)) {
			return [{ kind: "unknown-source", source: o.source }]
		}
		return Arr.flatMap(Rec.toEntries(o.fields), ([field, term]): ReadonlyArray<RuleFault> => {
			const domain = fieldDomain(base, o.source, field)
			return domain === undefined
				? [{ kind: "unknown-field", source: o.source, field }]
				: termFaults(base, typing, term, domain)
		})
	})

/** The variables a term reads. */
const termVariables = (term: Term): ReadonlyArray<string> =>
	term.kind === "var" ? [term.name] : []

const oneRuleFaults = (base: BaseSpec, rule: Rule): ReadonlyArray<RuleFault> => {
	const typing = typingOf(base, rule)
	const unbound = Arr.filter(
		[
			...Arr.flatMap(Rec.values(rule.head), termVariables),
			...Arr.flatMap(rule.comparisons, (c) => [...termVariables(c.left), ...termVariables(c.right)])
		],
		(x) => !typing.has(x)
	)
	const negated = Arr.flatMap(rule.negations, (n) =>
		occurrenceFaults(
			base,
			new Map([...typing, ...Arr.filter(bindingDomains(base, n), ([x]) => !typing.has(x))]),
			n
		)
	)
	const compared = Arr.flatMap(rule.comparisons, (c): ReadonlyArray<RuleFault> => {
		const left = termDomain(base, typing, c.left)
		const right = termDomain(base, typing, c.right)
		const domain = left ?? right
		const spanOrder: ReadonlyArray<RuleFault> =
			domain?.kind === "span" && c.op !== "=" && c.op !== "<>"
				? [{ kind: "span-order", op: c.op }]
				: []
		return [
			...spanOrder,
			...termFaults(base, typing, c.left, domain),
			...termFaults(base, typing, c.right, domain)
		]
	})
	return [
		...occurrenceFaults(base, typing, rule.matches),
		...negated,
		...compared,
		...Arr.flatMap(Rec.values(rule.head), (term) => termFaults(base, typing, term, undefined)),
		...Arr.map([...new Set(unbound)], (variable): RuleFault => ({
			kind: "unbound-variable",
			variable
		}))
	]
}

const headFields = (rule: Rule): string =>
	Arr.join(Arr.map(Arr.sort(Rec.keys(rule.head), Order.String), framed), "")

/**
 * What makes a rule set no query grizzle builds, none when it is one: what a generator of rules checks at
 * construction, so every rule it hands on has the meaning evaluateRules gives.
 */
export const ruleFaults = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): ReadonlyArray<RuleFault> => {
	const [first] = rules
	const heads: ReadonlyArray<RuleFault> = Arr.every(
		rules,
		(r) => headFields(r) === headFields(first)
	)
		? []
		: [{ kind: "heads-differ" }]
	return [...Arr.flatMap(rules, (rule) => oneRuleFaults(base, rule)), ...heads]
}

/** The occurrence of an ordinary relation T that supplies a query entry, at its index among the rule's matches. */
interface Supplier {
	readonly at: number
	readonly occurrence: Occurrence
	readonly relation: RelationSpec
}

type Writable = Extract<EntryClass, { readonly kind: "writable" }>
type ReadOnly = Extract<EntryClass, { readonly kind: "read-only" }>

/** A query entry's class, with the rule and the supplying occurrence of a writable one. */
type Writability =
	| {
			readonly kind: "writable"
			readonly class: Writable
			readonly rule: Rule
			readonly supplier: number
	  }
	| ReadOnly

const readOnly = (reason: ReadOnly["reason"]): ReadOnly => ({ kind: "read-only", reason })

/** A record's entries by key, in the order grizzle's analysis reads fields in. */
const sortedEntries = <A>(
	record: Readonly<Record<string, A>>
): ReadonlyArray<readonly [string, A]> =>
	Arr.sort(
		Rec.toEntries(record),
		Order.mapInput(Order.String, ([key]: readonly [string, A]) => key)
	)

/**
 * A term's variable as the writable-entry rule reads it: a variable by its name; a context term as the variable its
 * context's match binds, one per context field, as grizzle states a context field; a literal or a typed handle names
 * none.
 */
const ruleVariable = (term: Term): string | undefined => {
	switch (term.kind) {
		case "var":
			return namedVariable(term.name)
		case "context":
			return contextVariable(term.context, term.field)
		case "literal":
		case "handle":
			return undefined
	}
}

const namedVariable = (name: string): string => `var ${framed(name)}`
const contextVariable = (context: string, field: string): string =>
	`context ${framed(context)}${framed(field)}`

/** Each head variable and the head field naming it, when every head term is a bare variable named once. */
const headVariables = (rule: Rule): ReadonlyMap<string, string> | undefined => {
	const named = Rec.toEntries(rule.head)
	const variables = Arr.flatMap(named, ([field, term]) => {
		const variable = ruleVariable(term)
		return variable === undefined ? [] : [[variable, field] as const]
	})
	const distinctVariables = new Map(variables)
	return variables.length === named.length && distinctVariables.size === named.length
		? distinctVariables
		: undefined
}

/** The positive occurrences of ordinary relations that bind every head variable to a declared field of their own. */
const suppliersOf = (
	base: BaseSpec,
	rule: Rule,
	head: ReadonlyMap<string, string>
): ReadonlyArray<Supplier> =>
	Arr.flatMap(rule.matches, (occurrence, at): ReadonlyArray<Supplier> => {
		const relation = ordinaryOf(base, occurrence.source)
		if (relation === undefined) {
			return []
		}
		const bound = new Set(
			Arr.flatMap(relation.fields, (f) => {
				const term = own(occurrence.fields, f.name)
				const variable = term === undefined ? undefined : ruleVariable(term)
				return variable === undefined ? [] : [variable]
			})
		)
		return Arr.every([...head.keys()], (x) => bound.has(x)) ? [{ at, occurrence, relation }] : []
	})

/**
 * The fills the other positive matches give: each variable a context occurrence binds, with the context field binding
 * it, the first in match order and, within a match, in the order grizzle's analysis reads fields in.
 */
const contextFills = (rule: Rule, supplier: number): ReadonlyMap<string, Fill> =>
	new Map(
		Arr.reverse(
			Arr.flatMap(rule.matches, (o, at) => {
				const source = o.source
				return at === supplier || source.kind !== "context"
					? []
					: Arr.flatMap(sortedEntries(o.fields), ([field, term]) =>
							term.kind === "var"
								? [
										[
											namedVariable(term.name),
											{ kind: "context", context: source.name, field }
										] as const
									]
								: []
						)
			})
		)
	)

/** How a field of T is used by its supplying occurrence: written by a head variable, fixed by a fill, or free. */
type Use =
	| { readonly kind: "head"; readonly variable: string }
	| { readonly kind: "fixed"; readonly fill: Fill }
	| { readonly kind: "free" }

const useOf = (
	term: Term | undefined,
	head: ReadonlyMap<string, string>,
	fills: ReadonlyMap<string, Fill>
): Use => {
	if (term === undefined) {
		return { kind: "free" }
	}
	switch (term.kind) {
		case "literal":
			return { kind: "fixed", fill: { kind: "literal", value: term.value } }
		case "handle":
			return { kind: "fixed", fill: { kind: "literal", value: term.member } }
		case "context": {
			const variable = contextVariable(term.context, term.field)
			return head.has(variable)
				? { kind: "head", variable }
				: { kind: "fixed", fill: { kind: "context", context: term.context, field: term.field } }
		}
		case "var": {
			const variable = namedVariable(term.name)
			const fill = fills.get(variable)
			if (head.has(variable)) {
				return { kind: "head", variable }
			}
			return fill === undefined ? { kind: "free" } : { kind: "fixed", fill }
		}
	}
}

/**
 * The head variables a positive context match binds: each head context term's, the variable its context's match binds,
 * and each variable a context occurrence binds (contextFills).
 */
const claimBound = (rule: Rule, fills: ReadonlyMap<string, Fill>): ReadonlySet<string> =>
	new Set([
		...fills.keys(),
		...Arr.flatMap(Rec.values(rule.head), (term) =>
			term.kind === "context" ? [contextVariable(term.context, term.field)] : []
		)
	])

/** The fields of a relation's declared keys: its primary key, and every key and span key a law states on it. */
const keyFields = (base: BaseSpec, relation: string): ReadonlySet<string> =>
	new Set(Arr.flatten(declaredKeys(base, relation)))

/**
 * A head field's standing (HeadField): keyed when its field is in a key of T, which wins; claim-fixed when a positive
 * context match binds its variable; free otherwise.
 */
const headFieldOf = (field: string, keyed: ReadonlySet<string>, claimed: boolean): HeadField => ({
	field,
	kind: keyed.has(field) ? "keyed" : claimed ? "claimFixed" : "free"
})

/**
 * The clauses over T's fields, given its supplying occurrence: each head variable binds one field of T, every field of
 * T outside the head and its primary key is fixed (a literal, a context term, or a variable a context match binds;
 * several fields may share one), and every primary-key field is in the head or fixed.
 */
const targetClauses = (
	base: BaseSpec,
	head: ReadonlyMap<string, string>,
	rule: Rule,
	supplier: Supplier
): Writability => {
	const fills = contextFills(rule, supplier.at)
	const uses = Arr.map(supplier.relation.fields, (f) => ({
		field: f.name,
		use: useOf(own(supplier.occurrence.fields, f.name), head, fills)
	}))
	const written = Arr.flatMap(uses, (u) =>
		u.use.kind === "head" ? [[u.use.variable, u.field] as const] : []
	)
	if (new Set(Arr.map(written, ([x]) => x)).size !== written.length) {
		return readOnly("head-term-not-own-field")
	}
	const free = Arr.map(
		Arr.filter(uses, (u) => u.use.kind === "free"),
		(u) => u.field
	)
	if (Arr.some(free, (f) => !Arr.contains(supplier.relation.key, f))) {
		return readOnly("field-not-fixed")
	}
	if (free.length > 0) {
		return readOnly("key-not-determined")
	}
	const keyed = keyFields(base, supplier.relation.name)
	const claimed = claimBound(rule, fills)
	return {
		kind: "writable",
		class: {
			kind: "writable",
			target: supplier.relation.name,
			head: Rec.fromEntries(
				Arr.map(
					written,
					([x, field]) =>
						[
							required(head.get(x), `the head field of ${x}`),
							headFieldOf(field, keyed, claimed.has(x))
						] as const
				)
			),
			fills: Rec.fromEntries(
				Arr.flatMap(uses, (u) => (u.use.kind === "fixed" ? [[u.field, u.use.fill] as const] : []))
			)
		},
		rule,
		supplier: supplier.at
	}
}

/**
 * README's writable-entry rule over a query entry, clause by clause in its order, the first failing clause the
 * refusal: one rule (several-rules); every head term a bare variable, a context term being the variable its
 * context's match binds, no variable naming two head fields (head-term-not-own-field); exactly one positive
 * occurrence of an ordinary relation T binding every head variable to a field of its own (no-supplier); each head variable binding one field of T (head-term-not-own-field); every field of
 * T outside the head and its primary key fixed (field-not-fixed); every primary-key field in the head or fixed
 * (key-not-determined). Every other match, negation and comparison then only filters.
 */
const writabilityOf = (base: BaseSpec, rules: Arr.NonEmptyReadonlyArray<Rule>): Writability => {
	const [rule, ...more] = rules
	if (more.length > 0) {
		return readOnly("several-rules")
	}
	const head = headVariables(rule)
	if (head === undefined) {
		return readOnly("head-term-not-own-field")
	}
	const [supplier, ...rivals] = suppliersOf(base, rule, head)
	if (supplier === undefined || rivals.length > 0) {
		return readOnly("no-supplier")
	}
	return targetClauses(base, head, rule, supplier)
}

/**
 * A writable query entry's one rule and the index of its supplying occurrence (the one occurrence of its target that
 * binds every head variable); undefined for an entry the writable-entry rule refuses.
 */
export const writableSupplier = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): { readonly rule: Rule; readonly supplier: number } | undefined => {
	const w = writabilityOf(base, rules)
	return w.kind === "writable" ? { rule: w.rule, supplier: w.supplier } : undefined
}

/**
 * Whether and how a role relation is writable. A whole entry over an ordinary relation is writable over it, every
 * field its own, keyed or free as its keys say (no context binds one); a whole entry over a closed or derived relation
 * has no ordinary relation to supply it (no-supplier). A query entry is judged by README's writable-entry rule
 * (writability).
 */
export const classifyEntry = (base: BaseSpec, entry: EntrySpec): EntryClass => {
	switch (entry.kind) {
		case "whole": {
			const relation = named(base.relations, entry.relation)
			if (relation === undefined) {
				return readOnly("no-supplier")
			}
			const keyed = keyFields(base, relation.name)
			return {
				kind: "writable",
				target: relation.name,
				head: Rec.fromEntries(
					Arr.map(relation.fields, (f) => [f.name, headFieldOf(f.name, keyed, false)] as const)
				),
				fills: {}
			}
		}
		case "query": {
			const w = writabilityOf(base, entry.rules)
			return w.kind === "writable" ? w.class : w
		}
	}
}

const entryOf = (install: InstallSpec, role: string, relation: string): EntrySpec => {
	const spec = required(named(install.roles, role), `the role ${role}`)
	return required(own(spec.entries, relation), `the relation ${relation} of the role ${role}`)
}

const readingOf = (state: ModelState, facts: ContextFacts): Reading => ({
	base: state.install.base,
	reality: state.reality,
	derived: state.derived,
	facts
})

/**
 * A role relation's rows under a session's facts: a whole entry's relation (an ordinary relation's facts in reality, a
 * roster's members, a derived relation's as of its last refresh), a query entry's rules evaluated over them.
 */
export const entryRows = (
	state: ModelState,
	role: string,
	relation: string,
	facts: ContextFacts
): ReadonlyArray<HostFact> => {
	const entry = entryOf(state.install, role, relation)
	const reading = readingOf(state, facts)
	switch (entry.kind) {
		case "whole":
			return sourceFacts(reading, sourceNamed(reading.base, entry.relation))
		case "query":
			return evaluateRules(reading.base, entry.rules, reading.reality, reading.derived, facts)
	}
}

/** The variables a term is, none for a constant term. */
const termVars = (term: Term): ReadonlyArray<string> => (term.kind === "var" ? [term.name] : [])

/**
 * The rule a fact that leaves fields of its target out is checked against (README "Writing through a role": an insert
 * may leave out the entry's serial columns, and a row is checked against the query before its identity is drawn): the
 * rule with the supplier's match and the head without those fields, where each is a variable the rule reads nowhere
 * else; none where the rule reads one anywhere else, a constant there or a filter, join or comparison over it, since a
 * serial column the query filters on is one every inserted row carries.
 */
const leftOutRule = (rule: Rule, supplier: number, fact: HostFact): Rule | undefined => {
	const occurrence = rule.matches[supplier]
	if (occurrence === undefined) {
		return undefined
	}
	const leftOut = Arr.filter(Rec.keys(occurrence.fields), (field) => own(fact, field) === undefined)
	if (leftOut.length === 0) {
		return rule
	}
	const read = [
		...Arr.flatMap(rule.matches, (m, i) =>
			Arr.flatMap(Rec.toEntries(m.fields), ([field, term]) =>
				i === supplier && Arr.contains(leftOut, field) ? [] : termVars(term)
			)
		),
		...Arr.flatMap(rule.negations, (n) =>
			Arr.flatMap(n, (m) => Arr.flatMap(Rec.values(m.fields), termVars))
		),
		...Arr.flatMap(rule.comparisons, (c) => [...termVars(c.left), ...termVars(c.right)])
	]
	const dropped = Arr.map(leftOut, (field) => own(occurrence.fields, field))
	if (!Arr.every(dropped, (term) => term?.kind === "var" && !Arr.contains(read, term.name))) {
		return undefined
	}
	const names = new Set(Arr.flatMap(dropped, (term) => (term === undefined ? [] : termVars(term))))
	const supplied: Occurrence = {
		...occurrence,
		fields: Rec.filter(occurrence.fields, (_, field) => !Arr.contains(leftOut, field))
	}
	return {
		...rule,
		matches: Arr.map(rule.matches, (m, i) => (i === supplier ? supplied : m)),
		head: Rec.filter(rule.head, (term) => !Arr.some(termVars(term), (v) => names.has(v)))
	}
}

/**
 * Whether a fact of a writable entry's target T is in the entry under a session's facts: a whole entry over an
 * ordinary relation holds every fact of it; a writable query entry holds the fact when its rule holds with T's
 * supplying occurrence reading that fact alone, every other match reading reality, the fields the fact leaves out
 * unread where the rule reads them nowhere else (leftOutRule). A read-only entry has no target, and holds no fact of
 * one.
 */
export const isMember = (
	state: ModelState,
	role: string,
	relation: string,
	facts: ContextFacts,
	fact: HostFact
): boolean => {
	const entry = entryOf(state.install, role, relation)
	const base = state.install.base
	switch (entry.kind) {
		case "whole":
			return holdsNamed(base.relations, entry.relation)
		case "query": {
			const w = writabilityOf(base, entry.rules)
			if (w.kind !== "writable") {
				return false
			}
			const rule = leftOutRule(w.rule, w.supplier, fact)
			if (rule === undefined) {
				return false
			}
			const reading = readingOf(state, facts)
			const factsAt: FactsAt = (occurrence, index) =>
				index === w.supplier ? [fact] : sourceFacts(reading, occurrence.source)
			return ruleRows(reading, rule, factsAt).length > 0
		}
	}
}

const relationNamed = (base: BaseSpec, name: string): RelationSpec =>
	required(named(base.relations, name), `the relation ${name}`)

/** A relation's declared keys: its primary key, and every key and span key a law states on it. */
const declaredKeys = (base: BaseSpec, relation: string): ReadonlyArray<ReadonlyArray<string>> => [
	relationNamed(base, relation).key,
	...Arr.flatMap(base.laws, (l): ReadonlyArray<ReadonlyArray<string>> => {
		if (l.kind === "key" && l.relation === relation) {
			return [l.fields]
		}
		return l.kind === "spanKey" && l.relation === relation ? [[...l.scalars, l.span]] : []
	})
]

const isSelected = (side: SideSpec): boolean => Rec.keys(side.where).length > 0

/**
 * A spec side's selection as the host law model reads it: every fact, or the facts whose fields hold its selector's
 * values.
 */
export const selectionOf = (side: SideSpec): HostSelection =>
	isSelected(side) ? fieldsEqual(side.where) : everyFact

const hostRelation = (names: InstalledNames, relation: RelationSpec): HostRelation => {
	const columns = required(own(names.columns, relation.name), `the columns of ${relation.name}`)
	return {
		name: relation.name,
		table: required(own(names.tables, relation.name), `the table of ${relation.name}`),
		fields: Arr.map(relation.fields, (f) => ({
			name: f.name,
			column: required(own(columns, f.name), `the column of ${relation.name}.${f.name}`)
		})),
		key: relation.key,
		mutable: relation.mutability === "mutable"
	}
}

/** A relation's primary key law: a span key when one key field is a span, a key otherwise. */
const primaryKeyLaw = (names: InstalledNames, relation: RelationSpec): HostLaw =>
	primaryKeyLawAs(
		required(own(names.primaryKeys, relation.name), `the primary-key law of ${relation.name}`),
		relation
	)

/** A relation's primary key as the host law model reads it, under the law identity `law`. */
const primaryKeyLawAs = (law: LawId, relation: RelationSpec): HostLaw => {
	const spans = Arr.filter(relation.key, (k) =>
		Arr.some(relation.fields, (f) => f.name === k && f.domain.kind === "span")
	)
	const [span, ...more] = spans
	if (more.length > 0) {
		throw new Error(`the primary key of ${relation.name} holds two spans, which no law states`)
	}
	return span === undefined
		? { kind: "key", law, relation: relation.name, fields: relation.key, selection: everyFact }
		: {
				kind: "spanKey",
				law,
				relation: relation.name,
				scalars: Arr.filter(relation.key, (k) => k !== span),
				span
			}
}

/**
 * Whether a row check holds on a fact: each comparison of an integer field with its literal holds, a draw's by its
 * range (drawnOrder).
 */
const predicateHolds = (predicate: RowPredicate, fact: HostFact): boolean => {
	switch (predicate.kind) {
		case "and":
			return Arr.every(predicate.parts, (p) => predicateHolds(p, fact))
		case "compare": {
			const value = factOf(fact, predicate.field)
			return (
				value !== undefined &&
				(typeof value === "number" || isDrawn(value)) &&
				comparisonHolds(predicate.op, undefined, value, predicate.value)
			)
		}
	}
}

/** A side as the host law model reads it. */
const sideOf = (spec: SideSpec): HostSide => ({
	relation: spec.relation,
	fields: spec.fields,
	selection: selectionOf(spec)
})

/** A containment into a closed roster: a row check that each selected source fact's value is a member. */
const rosterCheck = (
	law: LawId,
	closed: ClosedSpec,
	source: SideSpec,
	target: SideSpec
): HostLaw => {
	const [field, ...more] = source.fields
	if (more.length > 0 || target.fields[0] !== "id" || isSelected(target)) {
		throw new Error(
			`a containment into the roster ${closed.name} pairs other than one field with its id`
		)
	}
	return {
		kind: "check",
		law,
		relation: source.relation,
		holds: (fact) => {
			const value = factOf(fact, field)
			return (
				!selected(fact, selectionOf(source)) ||
				(typeof value === "string" && Arr.contains(closed.members, value))
			)
		}
	}
}

/**
 * A containment: a foreign key, MATCH SIMPLE over a selected source's law columns, which are null outside its
 * selection; or a row check into a closed roster.
 */
const containedLaws = (base: BaseSpec, law: LawId, source: SideSpec, target: SideSpec): HostLaw => {
	const closed = named(base.closed, target.relation)
	return closed === undefined
		? {
				kind: "contained",
				law,
				source: sideOf(source),
				target: sideOf(target)
			}
		: rosterCheck(law, closed, source, target)
}

/**
 * An alternatives law over the parent relation: for each armed handle, the arm's foreign key from its primary key into
 * the parent's facts standing at the handle, under the handle's law, and the parent's facts standing at it in the arm,
 * under the handle's reverse law (fin.md §7). The tag's containment in the roster is its closedId field's type, no law.
 */
const alternativesLaws = (
	base: BaseSpec,
	law: Extract<LawSpec, { readonly kind: "alternatives" }>,
	ids: Extract<LawIds, { readonly kind: "alternatives" }>
): ReadonlyArray<HostLaw> => {
	const parent = relationNamed(base, law.relation)
	return Arr.flatMap(Rec.toEntries(law.arms), ([handle, name]): ReadonlyArray<HostLaw> => {
		const arm = relationNamed(base, name)
		const standing: HostSide = {
			relation: parent.name,
			fields: parent.key,
			selection: fieldsEqual({ [law.tag]: handle })
		}
		const armSide: HostSide = { relation: arm.name, fields: arm.key, selection: everyFact }
		return [
			{
				kind: "contained",
				law: required(
					own(ids.arms, handle),
					`the ${handle} arm's law of the alternatives over ${law.relation}`
				),
				source: armSide,
				target: standing
			},
			{
				kind: "contained",
				law: required(
					own(ids.reverse, handle),
					`the ${handle} handle's reverse law of the alternatives over ${law.relation}`
				),
				source: standing,
				target: armSide
			}
		]
	})
}

/** A law of one identity: its identity, when the installation gave the law of `kind` one. */
const singleLaw = (ids: LawIds, kind: LawSpec["kind"]): LawId => {
	if (ids.kind === "alternatives" || ids.kind !== kind) {
		throw new Error(
			`the installation names a ${ids.kind} law where the base declares a ${kind} law`
		)
	}
	return ids.law
}

const alternativesLawIdsOf = (ids: LawIds): Extract<LawIds, { readonly kind: "alternatives" }> => {
	if (ids.kind !== "alternatives") {
		throw new Error(
			`the installation names a ${ids.kind} law where the base declares an alternatives law`
		)
	}
	return ids
}

/** One declared law as the host law model's laws, under the law identities the installation gave it. */
const hostLaws = (base: BaseSpec, law: LawSpec, ids: LawIds): ReadonlyArray<HostLaw> => {
	switch (law.kind) {
		case "key":
			return [
				{
					kind: "key",
					law: singleLaw(ids, law.kind),
					relation: law.relation,
					fields: law.fields,
					selection: everyFact
				}
			]
		case "spanKey":
			return [
				{
					kind: "spanKey",
					law: singleLaw(ids, law.kind),
					relation: law.relation,
					scalars: law.scalars,
					span: law.span
				}
			]
		case "check":
			return [
				{
					kind: "check",
					law: singleLaw(ids, law.kind),
					relation: law.relation,
					holds: (fact) => predicateHolds(law.predicate, fact)
				}
			]
		case "contained":
			return [containedLaws(base, singleLaw(ids, law.kind), law.source, law.target)]
		case "covered":
			return [
				{
					kind: "covered",
					law: singleLaw(ids, law.kind),
					source: sideOf(law.source),
					target: sideOf(law.target),
					span: law.span
				}
			]
		case "alternatives":
			return alternativesLaws(base, law, alternativesLawIdsOf(ids))
	}
}

/**
 * A base as the host law model reads it, under an installation's names: its ordinary relations with their tables,
 * columns and primary keys; each primary key's law; and each declared law as the law model lowers it, under the law
 * identities of InstalledNames.laws, each of its law's kind. A containment is a foreign key, a selected source's over
 * its law columns, and one into a closed roster a row check (containedLaws); a coverage is a PERIOD foreign key, a
 * selected source's over its range law column; and an alternatives law is two containments per armed handle, the arm in
 * its parent standing at the handle and the parent standing at it in its arm (alternativesLaws, fin.md §7).
 */
export const hostSchemaOf = (base: BaseSpec, names: InstalledNames): HostSchema => ({
	relations: Arr.map(base.relations, (r) => hostRelation(names, r)),
	laws: [
		...Arr.map(base.relations, (r) => primaryKeyLaw(names, r)),
		...Arr.flatMap(base.laws, (law, i) =>
			hostLaws(base, law, required(names.laws[i], `the law identities of law ${i}`))
		)
	]
})

/**
 * A label for a law of a base no installation has named yet, by its place among the base's laws (core/identity.ts
 * law): it tells the base's laws apart, and judgedSchemaOf alone holds it.
 */
const judgedLabel = (place: string): LawId =>
	identifierOf(
		identity.law({
			parts: ["judged", place],
			stem: ["judged"],
			display: `the law at ${place} of a base no installation has named`
		})
	)

/** A declared law's identities as judgedSchemaOf labels them: one, or an alternatives law's per arm. */
const judgedIds = (law: LawSpec, i: number): LawIds => {
	switch (law.kind) {
		case "alternatives":
			return {
				kind: "alternatives",
				arms: Rec.fromEntries(
					Arr.map(
						Rec.keys(law.arms),
						(handle) => [handle, judgedLabel(`${i} arm ${handle}`)] as const
					)
				),
				reverse: Rec.fromEntries(
					Arr.map(
						Rec.keys(law.arms),
						(handle) => [handle, judgedLabel(`${i} reverse ${handle}`)] as const
					)
				)
			}
		case "key":
		case "spanKey":
		case "check":
		case "contained":
		case "covered":
			return { kind: law.kind, law: judgedLabel(String(i)) }
	}
}

/**
 * A base as the host law model reads it before an installation names it: each table and column under its declared
 * name, each law under its place among the base's laws (judgedLabel). Its names and labels stand for nothing outside
 * it, so it judges only whether a state breaks a law and how PostgreSQL meets it: what a migration's run asks of the
 * installation it is about to land, over the data it would carry (session/migrate.ts brokenOnto).
 */
export const judgedSchemaOf = (base: BaseSpec): HostSchema => ({
	relations: Arr.map(base.relations, (r) => ({
		name: r.name,
		table: r.name,
		fields: Arr.map(r.fields, (f) => ({ name: f.name, column: f.name })),
		key: r.key,
		mutable: r.mutability === "mutable"
	})),
	laws: [
		...Arr.map(base.relations, (r) => primaryKeyLawAs(judgedLabel(`primary ${r.name}`), r)),
		...Arr.flatMap(base.laws, (law, i) => hostLaws(base, law, judgedIds(law, i)))
	]
})

/**
 * A foreign key an installation enforces a law with: the relation that references, the one it references, and whether
 * PostgreSQL checks it at COMMIT.
 */
export interface ForeignKeyOf {
	readonly from: string
	readonly to: string
	readonly deferred: boolean
}

/**
 * The foreign keys of one declared law as hostSchemaOf lowers it, with no identity: a containment's, and each
 * alternatives arm's into its parent standing at its handle and the parent standing at it into its arm, into a relation
 * that is no closed roster (a plain foreign key, from a selected source's law columns, or beside a selected target's
 * constant column); and a coverage's (a PERIOD foreign key, from a selected source's range law column).
 */
const lawForeignKeys = (
	base: BaseSpec,
	law: LawSpec
): ReadonlyArray<{
	readonly kind: "containment" | "coverage"
	readonly source: SideSpec
	readonly target: SideSpec
}> => {
	const into = (source: SideSpec, target: SideSpec) =>
		named(base.closed, target.relation) !== undefined
			? []
			: [{ kind: "containment" as const, source, target }]
	switch (law.kind) {
		case "contained":
			return into(law.source, law.target)
		case "covered":
			return [{ kind: "coverage" as const, source: law.source, target: law.target }]
		case "alternatives": {
			const parent = relationNamed(base, law.relation)
			return Arr.flatMap(Rec.toEntries(law.arms), ([handle, name]) => {
				const arm: SideSpec = { relation: name, fields: relationNamed(base, name).key, where: {} }
				const standing: SideSpec = {
					relation: parent.name,
					fields: parent.key,
					where: { [law.tag]: handle }
				}
				return [...into(arm, standing), ...into(standing, arm)]
			})
		}
		case "key":
		case "spanKey":
		case "check":
			return []
	}
}

/**
 * The foreign keys an installation enforces a declared law with (lawForeignKeys), each deferred as PostgreSQL checks it
 * (session/laws.ts meetingOf): a PERIOD one always; a containment's exactly when its target is selected, holds a field
 * outside the referenced ones, or lies on a cycle of the base's containment foreign keys, its target reaching its
 * source.
 */
export const foreignKeysOf = (base: BaseSpec, law: LawSpec): ReadonlyArray<ForeignKeyOf> => {
	const edges = Arr.flatMap(base.laws, (l) =>
		Arr.flatMap(lawForeignKeys(base, l), (fk) =>
			fk.kind === "containment" ? [{ from: fk.source.relation, to: fk.target.relation }] : []
		)
	)
	const reaches = (from: string, to: string): boolean => {
		const seen = new Set<string>([from])
		const frontier = [from]
		for (let at = frontier.pop(); at !== undefined; at = frontier.pop()) {
			if (at === to) {
				return true
			}
			for (const e of edges) {
				if (e.from === at && !seen.has(e.to)) {
					seen.add(e.to)
					frontier.push(e.to)
				}
			}
		}
		return false
	}
	return Arr.map(lawForeignKeys(base, law), (fk) => ({
		from: fk.source.relation,
		to: fk.target.relation,
		deferred:
			fk.kind === "coverage" ||
			isSelected(fk.target) ||
			Arr.some(
				relationNamed(base, fk.target.relation).fields,
				(f) => !fk.target.fields.includes(f.name)
			) ||
			reaches(fk.target.relation, fk.source.relation)
	}))
}
