import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import {
	canonicalTag,
	isCanonicalizable,
	ownedText,
	withoutSourceLocs
} from "#compiler/core/canonical.ts"
import {
	type ComputeFn,
	type ExprDesc,
	type FieldDesc,
	type GuardDesc,
	type LiteralDesc,
	type SideDesc,
	type SlotsDesc,
	type TermDesc,
	termText
} from "#compiler/ir/desc.ts"
import type { GeneratedLaw } from "#compiler/ir/law.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import { floatText } from "#compiler/scalar/values/float.ts"
import type {
	AboveLaw,
	DeclaredEntry,
	LawEntry,
	OwnLaw,
	RecordedLaw,
	StatedLaw
} from "#compiler/types/changeset/changeset.ts"

/**
 * What a statement's author states of the catalog entry (types/changeset LawEntry) of the laws it states: the entry,
 * `law({ name, source }, statement)`'s, or none, so each law's entry is derived. This module is where a law is named:
 * an author's entry rides beside what the law states (RecordedLaw), and every other law's is derived here, from what
 * the law states, wherever the law is read, lawsOf, a preview's refusal and a Db's refusal naming each by namedLaw, so
 * a recorded law and the law an application reads differ by a derived entry alone, which no artifact holds.
 */
export type StatedEntry = DeclaredEntry | { readonly kind: "derived" }

/** No entry declared: each law the statement states has its derived entry. */
export const derivedStatement: StatedEntry = Object.freeze({ kind: "derived" })

/**
 * The one entry of two statements that are one statement, or that state one law: the entry either declares, where one
 * does or both declare one alike; undefined where they declare two, which the schema refuses, since one law has one
 * name.
 */
export const mergedEntry = (a: StatedEntry, b: StatedEntry): StatedEntry | undefined => {
	if (a.kind === "derived") {
		return b
	}
	return b.kind === "derived" || (a.name === b.name && a.source === b.source) ? a : undefined
}

/** A name as a statement spells it: a JSON string. */
const quoted = (name: string): string => JSON.stringify(name)

/**
 * A literal as an author writes it: a text quoted, a bigint with its n, a float's -0, NaN and infinities by their names,
 * unquoted, a set's handles listed.
 */
const literalSource = (value: LiteralDesc): string => {
	if (typeof value === "string") {
		return quoted(value)
	}
	if (typeof value === "number") {
		return floatText(value)
	}
	if (typeof value === "bigint") {
		return `${value}n`
	}
	if (typeof value === "boolean") {
		return String(value)
	}
	if (isCanonicalizable(value)) {
		return value[canonicalTag]().payload
	}
	if ("handles" in value) {
		return `[${value.handles.map(quoted).join(", ")}]`
	}
	if ("float" in value) {
		return value.float
	}
	if ("sha256" in value) {
		return quoted(value.sha256)
	}
	if ("span" in value) {
		return `{ start: ${String(value.span.start)}, end: ${String(value.span.end)} }`
	}
	return `Text.pattern(${quoted(value.spelling)})`
}

/** A field type as a cast names it: pg's by its name, any other by its canonical text. */
const fieldSource = (field: FieldDesc): string =>
	field.kind !== "pg"
		? ownedText(field, withoutSourceLocs)
		: field.type.includes(" ")
			? `pg[${quoted(field.type)}]`
			: `pg.${field.type}`

/**
 * The search functions, whose public spelling is no builder name of their own: a document's term is the field helper
 * searchDocument's, and a match or a rank is Search's over either query form, which the query term spells.
 */
const searchSpelling = {
	textDocument: "searchDocument",
	websearchMatches: spelling.textMatches,
	plainMatches: spelling.textMatches,
	websearchRank: spelling.textRank,
	plainRank: spelling.textRank,
	websearchRankCd: spelling.textRankCd,
	plainRankCd: spelling.textRankCd
} as const

/** Whether a compute function is a search function (searchSpelling). */
const isSearchFn = (fn: ComputeFn): fn is keyof typeof searchSpelling =>
	Object.hasOwn(searchSpelling, fn)

/** A compute function's public spelling: a search function's (searchSpelling), any other its builder's. */
const computeSpelling = (fn: ComputeFn): string =>
	isSearchFn(fn) ? searchSpelling[fn] : spelling[fn]

/** What a Logic.when's guard tests of its subject, as the author writes the test. */
const guardSource = (guard: GuardDesc, subject: string): string => {
	switch (guard.kind) {
		case "nonzero":
			return `${spelling.nonzero}(${subject})`
		case "nonnegative":
			return `${spelling.nonnegative}(${subject})`
		case "positive":
			return `${spelling.positive}(${subject})`
		case "finite":
			return `${spelling.isFinite}(${subject})`
		case "within":
			return `${spelling.within}(${subject}, ${literalSource(guard.low)}, ${literalSource(guard.high)})`
		case "matches":
			return `${spelling.matches}(${subject}, ${spelling.pattern}(${quoted(guard.pattern.spelling)}))`
	}
}

/**
 * A row predicate as its author writes it, each field read as `field` spells it: each scalar builder by its public
 * spelling (scalar/compute/spelling.ts), each closed read as its relation's method, each literal as written. A
 * Logic.when branch's parameter prints as the subject it stands in for. A node no row predicate an author writes holds
 * (a rule's existence, a variable, a parent column, a parameter, a span relation, which only a query states) keeps its
 * canonical text.
 */
const predicateSource = (e: ExprDesc, field: (name: string) => string): string => {
	const go = (x: ExprDesc): string => predicateSource(x, field)
	const call = (name: string, args: ReadonlyArray<string>): string => `${name}(${args.join(", ")})`
	switch (e.kind) {
		case "field":
			return field(e.field)
		case "literal":
			return literalSource(e.value)
		case "compute":
			return call(computeSpelling(e.fn), [
				...e.args.map(go),
				...("scale" in e && e.scale !== undefined ? [String(e.scale)] : [])
			])
		case "cast":
			return call(spelling.cast, [go(e.arg), fieldSource(e.to)])
		case "base":
			return call(spelling.base, [go(e.arg)])
		case "guarded":
			return go(e.arg)
		case "cond":
			return call(spelling.cond, [go(e.pred), go(e.onTrue), go(e.onFalse)])
		case "when":
			return call(spelling.when, [
				guardSource(e.guard, go(e.subject)),
				go(e.proved),
				go(e.otherwise)
			])
		case "compare":
			return call(spelling[e.op], [go(e.left), go(e.right)])
		case "between":
			return call(spelling.between, [go(e.arg), go(e.low), go(e.high)])
		case "in":
			return call(spelling.in, [go(e.arg), `[${e.values.map(literalSource).join(", ")}]`])
		case "and":
			return call(spelling.and, e.args.map(go))
		case "or":
			return call(spelling.or, e.args.map(go))
		case "not":
			return call(spelling.not, [go(e.arg)])
		case "call":
			return call(spelling.call, [
				e.function,
				`{ ${Object.entries(e.args)
					.map(([name, arg]) => `${name}: ${go(arg)}`)
					.join(", ")} }`
			])
		case "closedAt":
			return `${e.relation}.at(${[quoted(e.field), ...e.args.map(go)].join(", ")})`
		case "closedRow":
			return `${e.relation}.row(${e.args.map(go).join(", ")})`
		case "closedHas":
			return `${e.relation}.has(${e.args.map(go).join(", ")})`
		case "absent":
		case "exists":
		case "allen":
		case "pointIn":
		case "var":
		case "parent":
		case "value":
		case "param":
			return ownedText(e, withoutSourceLocs)
	}
}

/** A side's selection's conjuncts as the law's name reads them: each its author's predicate over the bare fields. */
const conjunctNames = (side: SideDesc): ReadonlyArray<string> =>
	side.selection.conjuncts.map((c) => predicateSource(c, (f) => f))

/** A side's selection as select(R, …) takes it: one predicate of the row `r`, its conjuncts' Logic.and of several. */
const selectionSource = (side: SideDesc): string => {
	const conjuncts = side.selection.conjuncts.map((c) => predicateSource(c, (f) => `r.${f}`))
	return `(r) => ${conjuncts.length === 1 ? conjuncts.join("") : `${spelling.and}(${conjuncts.join(", ")})`}`
}

/** A side as a law's name spells it: R(t…), and `where` each conjunct of its selection as its author writes it. */
const sideName = (side: SideDesc): string => {
	const texts = conjunctNames(side)
	return `${side.relation}(${side.terms.map(termText).join(", ")})${texts.length === 0 ? "" : ` where ${texts.join(" and ")}`}`
}

/** A term as on(...) takes it: a field's name, or pred of one. */
const termSource = (term: TermDesc): string =>
	term.kind === "field" ? quoted(term.field) : `pred(${quoted(term.field)})`

/** A side as a statement spells it: on(R, t…), its source select(R, …) where it selects. */
const sideSource = (side: SideDesc): string => {
	const source =
		side.selection.conjuncts.length === 0
			? side.relation
			: `select(${side.relation}, ${selectionSource(side)})`
	return `on(${[source, ...side.terms.map(termSource)].join(", ")})`
}

/** A family's slots as a statement spells them: fin(O, n). */
const slotsSource = (slots: SlotsDesc): string => `fin(${slots.owner}, ${quoted(slots.count)})`

/** Fields as a statement lists them. */
const fieldList = (fields: ReadonlyArray<string>): string => `[${fields.map(quoted).join(", ")}]`

/** A derived entry. */
const derived = (name: string, source: string): LawEntry =>
	Object.freeze({ kind: "derived", name, source })

/**
 * The entry grizzle derives for a law whose schema's author declares none (LawEntry `derived`), from what it states: its
 * name as the naming door displays the law, but a check's and a contract's, which are their declared names, and its
 * source the statement that states it, as grizzle spells it. A primary key is its relation's, a pattern law its field's
 * text refinement and a generated law its generated field's, which no statement states.
 */
export const derivedEntry = (law: StatedLaw): LawEntry => {
	switch (law.kind) {
		case "primaryKey":
			return derived(
				`primary key ${law.relation}(${law.fields.join(", ")})`,
				`relation(${quoted(law.relation)}, …, ${fieldList(law.fields)})`
			)
		case "key":
			return derived(`key ${sideName(law.side)}`, `key(${sideSource(law.side)})`)
		case "check":
			return derived(law.name, `check(${quoted(law.name)}, ${law.relation}, …)`)
		case "contained":
			return derived(
				`${sideName(law.from)} in ${sideName(law.to)}`,
				`contained(${sideSource(law.from)}, ${sideSource(law.to)})`
			)
		case "coverage":
			return derived(
				`${sideName(law.from)} covered by ${sideName(law.to)}`,
				`contained(${sideSource(law.from)}, ${sideSource(law.to)})`
			)
		case "family":
			return derived(
				`${law.order} ${sideName(law.member)} in ${slotsSource(law.slots)}`,
				`${law.order}(${sideSource(law.member)}, ${slotsSource(law.slots)})`
			)
		case "tree":
			return derived(
				`tree ${law.member.relation}(${[...law.root, ...law.member.terms.map(termText)].join(", ")}) in ${slotsSource(law.slots)}`,
				`tree(${sideSource(law.member)}, ${slotsSource(law.slots)}, { root: ${fieldList(law.root)} })`
			)
		case "fold":
			return derived(
				`${law.monoid} fold over ${slotsSource(law.family)} of ${sideName(law.step)} into ${sideName(law.end)}`,
				`fold(${slotsSource(law.family)}, Monoid.${law.monoid}, ${sideSource(law.step)}, ${sideSource(law.end)})`
			)
		case "contract":
			return derived(law.contract, `contract(${quoted(law.contract)}, …)`)
		case "pattern":
			return derived(
				`pattern of ${law.relation}.${law.field}`,
				`${law.relation}.${law.field}: ${patternsSource(law.patterns)}`
			)
		case "generated":
			return derived(
				`generated ${law.relation}.${law.field}`,
				`relation.generated(${quoted(law.relation)}, …) field ${quoted(law.field)}`
			)
	}
}

/** A field's patterns as its type declares them: str.regex of one, str.and of several, each a regular expression. */
const patternsSource = (patterns: Patterns): string => {
	const spelled = patterns.map((p) => `/${p.source}/${p.flags}`)
	return spelled.length === 1 ? `str.regex(${spelled.join("")})` : `str.and(${spelled.join(", ")})`
}

/**
 * A law as grizzle's artifacts record it (types/changeset RecordedLaw): what it states, with `entry` beside it where its
 * statements' author declares one, and nothing beside it otherwise, so a schema whose author declares no entry records
 * its laws as they state themselves and its artifacts are what they were before entries existed.
 */
export const recordedLaw = (law: StatedLaw, entry: StatedEntry): RecordedLaw =>
	entry.kind === "declared" ? Object.freeze({ ...law, entry }) : law

/** A law with the entry grizzle derives for it, as an application reads a law no author's entry names. */
export const derivedLaw = (law: StatedLaw): OwnLaw =>
	Object.freeze({ ...law, entry: derivedEntry(law) })

/**
 * A generated field's law as its artifacts record it: its entry beside it where the field's author declares one
 * (DeclaredEntries `generated`), and nothing beside it otherwise.
 */
export type RecordedGenerated = GeneratedLaw | (GeneratedLaw & { readonly entry: DeclaredEntry })

/** A generated field's law, recorded with the entry `entry` its field's author declares, or none (RecordedGenerated). */
export const recordedGenerated = (
	law: GeneratedLaw,
	entry: DeclaredEntry | undefined
): RecordedGenerated => (entry === undefined ? law : Object.freeze({ ...law, entry }))

/** A generated field's law as an application reads it: its declared entry, or its derived one. */
export const namedGenerated = (
	law: RecordedGenerated
): Extract<OwnLaw, { readonly kind: "generated" }> =>
	"entry" in law ? law : Object.freeze({ ...law, entry: derivedEntry(law) })

/**
 * The catalog entries a schema's authors declare for the laws no statement states, each at the declaration the law
 * comes from (law(...), schema/law-entries.ts): a relation's primary key's, by the relation; a generated field's, by
 * its relation and field; a refined text's pattern law's, by the relation and field its type types, the type's one entry
 * for every field it types; and a contract's, by the contract's name. A law none of these names derives its entry.
 */
export interface DeclaredEntries {
	readonly primaryKeys: ReadonlyMap<string, DeclaredEntry>
	readonly generated: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>
	readonly patterns: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>
	readonly contracts: ReadonlyMap<string, DeclaredEntry>
}

/** No entry declared at any declaration: a schema read from its description, whose values declare none. */
export const noDeclaredEntries: DeclaredEntries = Object.freeze({
	primaryKeys: new Map(),
	generated: new Map(),
	patterns: new Map(),
	contracts: new Map()
})

/** The entry `entries` holds for a field of a relation, by relation and field; none where it holds none. */
export const fieldEntry = (
	entries: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>,
	relation: string,
	field: string
): DeclaredEntry | undefined => entries.get(relation)?.get(field)

/**
 * The declared entries of declarations read together (DeclaredEntries), each key's one entry: where two declarations
 * of one relation, field or contract declare two entries, `conflict` names the key and its refusal is the caller's,
 * since one law has one name.
 */
export const mergedDeclared = (
	all: ReadonlyArray<DeclaredEntries>,
	conflict: (what: string) => never
): DeclaredEntries => {
	const one = (
		into: Map<string, DeclaredEntry>,
		key: string,
		entry: DeclaredEntry,
		what: string
	): void => {
		const known = into.get(key)
		if (known !== undefined && mergedEntry(known, entry) === undefined) {
			conflict(what)
		}
		into.set(key, entry)
	}
	const keyed = (
		pick: (e: DeclaredEntries) => ReadonlyMap<string, DeclaredEntry>,
		what: (key: string) => string
	): ReadonlyMap<string, DeclaredEntry> => {
		const into = new Map<string, DeclaredEntry>()
		for (const e of all) {
			for (const [key, entry] of pick(e)) {
				one(into, key, entry, what(key))
			}
		}
		return into
	}
	const byField = (
		pick: (e: DeclaredEntries) => ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>,
		what: string
	): ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>> => {
		const into = new Map<string, Map<string, DeclaredEntry>>()
		for (const e of all) {
			for (const [relation, fields] of pick(e)) {
				const at = into.get(relation) ?? new Map<string, DeclaredEntry>()
				into.set(relation, at)
				for (const [field, entry] of fields) {
					one(at, field, entry, `the ${what} of ${relation}.${field}`)
				}
			}
		}
		return into
	}
	return Object.freeze({
		primaryKeys: keyed(
			(e) => e.primaryKeys,
			(r) => `the primary key of ${r}`
		),
		generated: byField((e) => e.generated, "generated field"),
		patterns: byField((e) => e.patterns, "pattern"),
		contracts: keyed(
			(e) => e.contracts,
			(c) => `the contract ${c}`
		)
	})
}

/** A recorded law as an application reads it (types/changeset OwnLaw): its declared entry, or its derived one. */
export const namedLaw = (law: RecordedLaw): OwnLaw => ("entry" in law ? law : derivedLaw(law))

/** A recorded law of a level above as an outcome names it: the law with its entry. */
export const namedAbove = (above: AboveLaw<RecordedLaw>): AboveLaw =>
	Object.freeze({ kind: "above", level: above.level, law: namedLaw(above.law) })
