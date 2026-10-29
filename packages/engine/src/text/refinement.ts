import { everyProperty } from "#compiler/core/canonical.ts"
import { CompileError, prose, resourceBound, unsupported } from "#compiler/core/errors.ts"
import { ownedDigest } from "#compiler/core/fingerprint.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { regexMaxNodes, regexMaxRepeat } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { codePoints } from "#compiler/core/text.ts"
import { RegexKey, type RegexRef, type TextInfo } from "#compiler/ir/scalar.ts"
import { noRosters, type ScalarEnv, type TextLookup } from "#compiler/scalar/registry.ts"
import type { CreateDomain, Expr } from "#compiler/sql/ast.ts"
import { binary, cUtf8Collation, lit, types } from "#compiler/sql/build.ts"
import { toAre } from "#compiler/text/are.ts"
import { structuralBounds } from "#compiler/text/bounds.ts"
import { utf8Width } from "#compiler/text/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	dfaKey,
	enumerate,
	isEmptyLanguage,
	isUniversal,
	longest,
	minimalDfa
} from "#compiler/text/dfa.ts"

import {
	expandedAssertions,
	expandedSize,
	type LiveNode,
	loopsThroughAnchor,
	type RegexNode
} from "#compiler/text/ir.ts"
import { buildNfa, closurePairs, matches, type Nfa } from "#compiler/text/nfa.ts"
import {
	type ParseLimits,
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "#compiler/text/parse.ts"

/**
 * The fixed analysis bounds, all derived from the regex node bound (core/policy.ts regexMaxNodes in production).
 *
 * The compile-space bounds keep every admitted pattern well inside what PostgreSQL 19's regex compiler accepts, and
 * quick to compile on a cold backend. A written-out position count alone does not: PostgreSQL's
 * cost also grows with nullable chains, which its empty-arc removal makes quadratic (`(?:(?:a?){255}){8}b`, 2,041
 * positions, is too complex for it), and with assertions, which it eliminates by cloning the states they cross
 * (`(?:(?:a|$){1,3}){12}(?:^)?b`, 75 positions, is too complex; `(?:\Z|a|){8}(?:\A|a|){8}b` takes seconds). Every
 * measure reads the normalized IR, which spells a construct one way whatever the source wrote, so the bounds judge the
 * ARE PostgreSQL compiles. The bounds were set by measurement: on 19rc1 the longest admitted chain of optional copies,
 * `(?:a?){255}(?:b?){100}c`, compiles in tens of milliseconds on a cold backend, and test/pg/text plants a pattern at
 * every bound and draws thousands near them.
 */
interface TextLimits extends ParseLimits {
	/** NFA positions once counted repetitions are written out, every node counting at least one. */
	readonly maxExpanded: number
	/** Pairs of NFA states joined by empty and assertion edges (nfa.ts closurePairs). */
	readonly maxClosure: number
	/** Assertion positions once counted repetitions are written out, and that count times the written-out positions. */
	readonly maxAssertions: number
	readonly maxAssertionWeight: number
	readonly dfa: DfaLimits
	/** The most members a finite language may have and still become `VALUE IN (...)`. */
	readonly finiteMembers: number
}

export const textLimits = (maxNodes: number): TextLimits => ({
	maxNodes,
	maxRepeat: regexMaxRepeat,
	maxExpanded: maxNodes * 8,
	maxClosure: maxNodes * 128,
	maxAssertions: Math.floor(maxNodes / 64),
	maxAssertionWeight: maxNodes * 16,
	dfa: { maxStates: maxNodes * 4, maxWork: maxNodes * 4096 },
	finiteMembers: 64
})

/** The analysis bounds of every compilation. */
const productionLimits = textLimits(regexMaxNodes)

/** Proved bounds on every member of a language, in code points and UTF-8 bytes. */
interface TextBounds {
	readonly length: number
	readonly bytes: number
}

/** How PostgreSQL enforces the refinement, with the bounds each enforcement proves on every member. */
type TextCheck =
	| { readonly kind: "tautology" }
	| {
			readonly kind: "finite"
			readonly members: ReadonlyArray<string>
			readonly bounds: TextBounds
	  }
	| { readonly kind: "regex"; readonly pattern: string; readonly bounds: TextBounds | undefined }

/** The enforcement of a language that some admitted value is not a member of: a membership test. */
export type NontrivialCheck = Exclude<TextCheck, { readonly kind: "tautology" }>

/** A refinement some admitted value is no member of: what the pattern of a RegexRef analyzes to. */
export type NontrivialRefinement = TextRefinement & { readonly check: NontrivialCheck }

export interface TextRefinement {
	readonly source: string
	readonly flags: RegexFlags
	/** The normalized IR; the flags are folded into it. */
	readonly ir: RegexNode
	/** The ARE translation of the IR, whatever the check (the differential tests run it for every pattern). */
	readonly are: string
	readonly check: TextCheck
	/**
	 * The canonical pattern key: the minimal DFA's canonical text ("dfa:...") when the bounded construction succeeds,
	 * otherwise the normalized IR ("ir:..."). Equal keys recognize the same values; the converse holds for two "dfa:"
	 * keys.
	 */
	readonly key: string
	/** SHA-256 of the key, the domain identity the snapshot records. */
	readonly digest: string
	/** The host matcher over the IR, for the compiler's constants only. */
	readonly nfa: Nfa
}

const diagnosticError = (
	diagnostic: RegexDiagnostic,
	loc: SourceLoc,
	source: string,
	flags: string
): CompileError => {
	const at = childLoc(childLoc(loc, "pattern"), diagnostic.offset)
	return diagnostic.reason === "ResourceBound"
		? resourceBound(at, { kind: "regexConstructs", limit: productionLimits.maxNodes })
		: CompileError.make(
				prose(
					diagnostic.reason,
					at,
					`${diagnostic.construct} at offset ${diagnostic.offset} of /${source}/${flags}: ${diagnostic.message}`
				)
			)
}

const keyDigest = (key: string): string => ownedDigest("regex-language", key, everyProperty)

/** The bounds a refinement proves on every member, where it proves them. */
export const refinementBounds = (refinement: TextRefinement): TextBounds | undefined =>
	refinement.check.kind === "tautology" ? undefined : refinement.check.bounds

const boundsOfMembers = (members: ReadonlyArray<string>): TextBounds => {
	let length = 0
	let bytes = 0
	for (const m of members) {
		const cps = codePoints(m)
		length = Math.max(length, cps.length)
		bytes = Math.max(
			bytes,
			cps.reduce((n, c) => n + utf8Width(c), 0)
		)
	}
	return { length, bytes }
}

/**
 * A non-empty language as the analysis knows it: by its canonical automaton when the DFA bounds reach one, and
 * otherwise by its normalized IR alone.
 */
type Known =
	| { readonly kind: "automaton"; readonly dfa: CanonicalDfa }
	| { readonly kind: "structure" }

/**
 * The enforcement of a language: from its automaton, a tautology, a finite language or a regex with the automaton's
 * bounds; from its structure alone, a regex with the IR's structural bounds.
 */
const choose = (ir: RegexNode, known: Known, are: string, limits: TextLimits): TextCheck => {
	switch (known.kind) {
		case "automaton": {
			const { dfa } = known
			if (isUniversal(dfa)) {
				return { kind: "tautology" }
			}
			const members = enumerate(dfa, limits.finiteMembers)
			if (members !== undefined) {
				return { kind: "finite", members, bounds: boundsOfMembers(members) }
			}
			return { kind: "regex", pattern: are, bounds: longest(dfa) }
		}
		case "structure":
			return { kind: "regex", pattern: are, bounds: structuralBounds(ir) }
	}
}

/**
 * The canonical pattern key of a language: its minimal DFA's canonical text, or its normalized IR above the DFA bound.
 */
const keyOf = (ir: RegexNode, known: Known): string => {
	switch (known.kind) {
		case "automaton":
			return `dfa:${dfaKey(known.dfa)}`
		case "structure":
			return `ir:${JSON.stringify(ir)}`
	}
}

/**
 * A pattern's language: empty (no admitted text value matches it), or not, as the analysis knows it.
 * A nonempty one holds its IR as a node of a language with a member.
 */
type Language =
	| { readonly kind: "empty" }
	| { readonly kind: "nonEmpty"; readonly ir: LiveNode; readonly known: Known }

const languageOf = (ir: RegexNode, nfa: Nfa, limits: TextLimits): Language => {
	if (ir.kind === "never") {
		return { kind: "empty" }
	}
	const dfa = minimalDfa(nfa, limits.dfa)
	if (dfa === undefined) {
		return { kind: "nonEmpty", ir, known: { kind: "structure" } }
	}
	return isEmptyLanguage(dfa)
		? { kind: "empty" }
		: { kind: "nonEmpty", ir, known: { kind: "automaton", dfa } }
}

/**
 * The language of a parsed pattern (parse.ts parsePattern under the same limits), classified as analyzeText classifies
 * it: an empty language is the refusal "matches no admitted text value".
 */
export const analyzeLanguage = (ir: RegexNode, limits: TextLimits): Language =>
	languageOf(ir, buildNfa(ir), limits)

/**
 * Text refinements: a declared pattern, checked, analyzed and lowered.
 *
 * `analyzeText` is what schema compilation calls for every `str.regex` descriptor. It parses the admitted grammar
 * (parse.ts) with source-located diagnostics, then proves what it can within fixed bounds and chooses the PostgreSQL
 * enforcement:
 *
 * - a tautology over admitted text erases: no CHECK, no domain, the column is plain text;
 * - a proved finite language of at most `finiteMembers` values becomes `VALUE IN (...)`, which recognizes exactly the
 *   same values;
 * - anything else is `VALUE ~ '<ARE>'` with the translated pattern (are.ts).
 *
 * It also derives the canonical pattern key that domain sharing uses (core/identity.ts textDomain), and the proved length
 * and byte bounds that the key representability check consumes. Nothing here validates application data:
 * the host matcher `accepts` serves only the compiler's own constants.
 *
 * Checks, analyzes and lowers a declared pattern, whose source and flags the description's boundary admitted
 * (field.ts admitRegex, the description decoder). `loc` is the descriptor's source location; diagnostics point one
 * level deeper, at the pattern offset of the construct (`... .pattern[3]`). The analysis reads only the source and the
 * flags; `loc` places a refusal alone.
 */
export const analyzeText = (
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): Result.Result<TextRefinement, CompileError> => {
	return analyze(source, flags, loc)
}

const analyze = (
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): Result.Result<TextRefinement, CompileError> => {
	const parsed = parsePattern(source, flags, productionLimits)
	if (!parsed.ok) {
		return Result.err(diagnosticError(parsed.error, loc, source, flags))
	}
	const ir = parsed.value
	const tooComplex = (measure: string): Result.Result<never, CompileError> =>
		Result.err(
			resourceBound(childLoc(loc, "pattern"), {
				kind: "regexCompileSpace",
				pattern: `/${source}/${flags}`,
				measure
			})
		)
	if (loopsThroughAnchor(ir)) {
		return tooComplex(
			"repeats without bound a body that can match zero-width through an anchor, too large to write as a loop of consuming matches"
		)
	}
	const expanded = expandedSize(ir)
	if (expanded > productionLimits.maxExpanded) {
		return tooComplex(
			`writes out to ${expanded} positions; the budget is ${productionLimits.maxExpanded}`
		)
	}
	const assertions = expandedAssertions(ir)
	if (assertions > productionLimits.maxAssertions) {
		return tooComplex(
			`writes out ${assertions} anchors; the budget is ${productionLimits.maxAssertions}`
		)
	}
	if (assertions * expanded > productionLimits.maxAssertionWeight) {
		return tooComplex(
			`writes out ${assertions} anchors over ${expanded} positions; the budget for their product is ${productionLimits.maxAssertionWeight}`
		)
	}
	const nfa = buildNfa(ir)
	const closure = closurePairs(nfa, productionLimits.maxClosure)
	if (closure > productionLimits.maxClosure) {
		return tooComplex(
			`joins more than ${productionLimits.maxClosure} pairs of positions by empty paths`
		)
	}
	const language = languageOf(ir, nfa, productionLimits)
	if (language.kind === "empty") {
		return Result.err(
			unsupported(
				childLoc(loc, "pattern"),
				`/${source}/${flags} matches no admitted text value, so no fact could ever hold the field`
			)
		)
	}
	const are = toAre(language.ir)
	const check = choose(ir, language.known, are, productionLimits)
	const key = keyOf(ir, language.known)
	return Result.ok(
		Object.freeze({ source, flags, ir, are, check, key, digest: keyDigest(key), nfa })
	)
}

/**
 * The canonical wildcard every compiler-created text value carries unless a stronger pattern is proved: every representable value, empty and multiline included.
 */
export const wildcardSource = "^.*$"
export const wildcardFlags: RegexFlags = "su"

/**
 * Whether an admitted text value matches the refinement. For the compiler's own constants only:
 * PostgreSQL alone validates application data.
 */
export const accepts = (refinement: TextRefinement, value: string): boolean =>
	matches(refinement.nfa, value)

/**
 * The analysis of a RegexRef's pattern: its automaton and its membership check. The one site of the fact that the
 * analysis succeeds and proves no tautology. textInfo mints a RegexRef only from such an analysis of its source and
 * flags, and a snapshot records only one it minted. The analysis is a pure function of the source and flags, but the
 * ScalarType keeps the pattern, which its digest reads, never the analysis, so no type carries the admission.
 */
export const refinementOf = (regex: RegexRef): NontrivialRefinement => {
	const pattern = `/${regex.source}/${regex.flags}`
	const analyzed = analyzeText(regex.source, regex.flags, SourceLoc(pattern, []))
	if (analyzed.ok && analyzed.value.check.kind !== "tautology") {
		return { ...analyzed.value, check: analyzed.value.check }
	}
	throw defect(
		`the pattern of a RegexRef, which its text analysis admitted as no tautology: ${pattern}`
	)
}

/** Whether a text constant is a member of a regex refinement: the NFA of its pattern's analysis (refinementOf). */
export const regexMember = (regex: RegexRef, value: string): boolean =>
	accepts(refinementOf(regex), value)

/**
 * The text metadata of the refinement's ScalarType (ir/scalar.ts): a proved tautology is the canonical wildcard, which
 * is unbounded; any other pattern keeps its source and flags as the declaration wrote them, with its language's key
 * and its proved bounds.
 */
export const textInfo = (refinement: TextRefinement): TextInfo => {
	const check = refinement.check
	if (check.kind === "tautology") {
		return Object.freeze({ regex: "wildcard", lengthBound: undefined, byteBound: undefined })
	}
	const regex = Object.freeze({
		source: refinement.source,
		flags: refinement.flags,
		key: RegexKey(refinement.digest)
	})
	const bounds = check.bounds
	return Object.freeze(
		bounds === undefined
			? { regex, lengthBound: undefined, byteBound: undefined }
			: { regex, lengthBound: bounds.length, byteBound: bounds.bytes }
	)
}

/**
 * The text metadata of a pattern, a refusal located at the pattern: what every ScalarEnv resolves a text descriptor by
 * (scalar/registry.ts TextLookup), a builder's outside any compilation (a str.regex descriptor, a query's headings)
 * included.
 */
export const textLookup: TextLookup = (source, flags) =>
	Result.map(analyzeText(source, flags, SourceLoc(`/${source}/${flags}`, [])), textInfo)

/** The builder environment of a field outside any schema: no closed relation, and every pattern read by textLookup. */
export const builderEnv: ScalarEnv = Object.freeze({
	kind: "builder",
	roster: noRosters,
	text: textLookup
})

/** A domain CHECK's VALUE. */
export const domainValue: Expr = Object.freeze({ kind: "domainValue" })

/**
 * The membership predicate over `value` (domainValue inside a domain CHECK), without the IS TRUE wrapper, which the
 * printer adds to every CHECK.
 */
export const membership = (check: NontrivialCheck, value: Expr): Expr => {
	switch (check.kind) {
		case "finite":
			return {
				kind: "inList",
				expr: value,
				list: check.members.map((m) => lit.text(m, types.text)),
				not: false
			}
		case "regex":
			return binary("~", value, lit.text(check.pattern, types.text))
	}
}

/** The membership predicate of a check, or none for a tautology. */
export const checkPredicate = (check: TextCheck, value: Expr): Expr | undefined =>
	check.kind === "tautology" ? undefined : membership(check, value)

/**
 * The compiler-owned structural domain of a nontrivial refinement:
 * `CREATE DOMAIN <schema>.__text_<slug> AS text COLLATE pg_catalog.pg_c_utf8 CONSTRAINT __text_<slug>__check
 * CHECK ((...) IS TRUE)`, with no NOT NULL.
 */
export const textDomainDdl = (
	check: NontrivialCheck,
	target: { readonly schema: string; readonly name: string; readonly constraint: string }
): CreateDomain => ({
	kind: "createDomain",
	name: { schema: target.schema, name: target.name },
	base: types.text,
	collation: cUtf8Collation,
	constraints: [{ name: target.constraint, predicate: membership(check, domainValue) }]
})
