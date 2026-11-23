import {
	canonicalTag,
	isCanonicalizable,
	ownedText,
	withoutSourceLocs
} from "#compiler/core/canonical.ts"
import type { ComputeFn, ExprDesc, FieldDesc, GuardDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { PatternValue } from "#compiler/ir/pattern.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import { floatText } from "#compiler/scalar/values/float.ts"

/** A text as a statement writes it: a JSON string. */
const quoted = (text: string): string => JSON.stringify(text)

/** How a printing writes a pattern: Text.pattern of something that names its language. */
export type PatternPrinting = (pattern: PatternValue) => string

/** A pattern as its author spelled it: what a law's name, which no artifact holds, reads. */
export const spelledPattern: PatternPrinting = (pattern) =>
	`Text.pattern(${quoted(pattern.spelling)})`

/**
 * A pattern by its language alone, whatever spelling states it: what an installed object's comment reads, since a
 * spelling is no part of any identity and an installation keeps one spelling of each language (ir/pattern.ts
 * installedSpellings), so two spellings of one language comment one object alike and a re-spelling drafts nothing.
 */
export const languagePattern: PatternPrinting = (pattern) =>
	`Text.pattern(<language ${pattern.pattern}>)`

/**
 * A literal as an author writes it: a text quoted, a bigint with its n, a float's -0, NaN and infinities by their names,
 * unquoted, a set's handles listed.
 */
const literalSource = (value: LiteralDesc, pattern: PatternPrinting): string => {
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
	return pattern(value)
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
const guardSource = (guard: GuardDesc, subject: string, pattern: PatternPrinting): string => {
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
			return `${spelling.within}(${subject}, ${literalSource(guard.low, pattern)}, ${literalSource(guard.high, pattern)})`
		case "matches":
			return `${spelling.matches}(${subject}, ${pattern(guard.pattern)})`
	}
}

/**
 * A row predicate as its author writes it, each field read as `field` spells it: each scalar builder by its public
 * spelling (scalar/compute/spelling.ts), each closed read as its relation's method, each literal as written. A
 * Logic.when branch's parameter prints as the subject it stands in for. A node no row predicate an author writes holds
 * (a rule's existence, a variable, a parent column, a parameter, a span relation, which only a query states) keeps its
 * canonical text.
 */
export const predicateSource = (
	e: ExprDesc,
	field: (name: string) => string,
	pattern: PatternPrinting
): string => {
	const go = (x: ExprDesc): string => predicateSource(x, field, pattern)
	const call = (name: string, args: ReadonlyArray<string>): string => `${name}(${args.join(", ")})`
	switch (e.kind) {
		case "field":
			return field(e.field)
		case "literal":
			return literalSource(e.value, pattern)
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
		case "retype":
			return go(e.arg)
		case "cond":
			return call(spelling.cond, [go(e.pred), go(e.onTrue), go(e.onFalse)])
		case "when":
			return call(spelling.when, [
				guardSource(e.guard, go(e.subject), pattern),
				go(e.proved),
				go(e.otherwise)
			])
		case "compare":
			return call(spelling[e.op], [go(e.left), go(e.right)])
		case "between":
			return call(spelling.between, [go(e.arg), go(e.low), go(e.high)])
		case "in":
			return call(spelling.in, [
				go(e.arg),
				`[${e.values.map((v) => literalSource(v, pattern)).join(", ")}]`
			])
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
