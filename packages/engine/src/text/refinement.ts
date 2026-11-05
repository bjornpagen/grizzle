import { everyProperty } from "#compiler/core/canonical.ts"
import {
	CompileError,
	prose,
	type RegexSpaceMeasure,
	resourceBound,
	unsupported
} from "#compiler/core/errors.ts"
import { ownedDigest } from "#compiler/core/fingerprint.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	regexDfaMaxStates,
	regexDfaMaxWork,
	regexMaxAnchors,
	regexMaxAnchorWeight,
	regexMaxClosurePairs,
	regexMaxPositions
} from "#compiler/core/limits.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { codePoints } from "#compiler/core/text.ts"
import { RegexKey, type RegexRef, type TextInfo } from "#compiler/ir/scalar.ts"
import { utf8Width } from "#compiler/scalar/regex/charset.ts"
import {
	canonicalText,
	expandedAssertions,
	expandedSize,
	type LiveNode,
	loopsThroughAnchor,
	type RegexNode
} from "#compiler/scalar/regex/ir.ts"
import { buildNfa, closurePairs, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import {
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "#compiler/scalar/regex/parse.ts"
import type { TextLookup } from "#compiler/scalar/registry.ts"
import type { CreateDomain, Expr } from "#compiler/sql/ast.ts"
import { binary, cUtf8Collation, lit, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { toAre } from "#compiler/text/are.ts"
import { structuralBounds } from "#compiler/text/bounds.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	dfaKey,
	isEmptyLanguage,
	isUniversal,
	longest,
	membersWithin,
	minimalDfa
} from "#compiler/text/dfa.ts"

/**
 * The host's bounds on a pattern's subset construction (core/limits.ts regexDfaMaxStates, regexDfaMaxWork): past
 * either, the analysis knows the language by its structure alone.
 */
const dfaLimits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates.value,
	maxWork: regexDfaMaxWork.value
})

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
			/** At least one: `VALUE IN (...)` has no empty list, and an analyzed language has a member. */
			readonly members: NonEmptyReadonlyArray<string>
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
}

const diagnosticError = (
	diagnostic: RegexDiagnostic,
	loc: SourceLoc,
	source: string,
	flags: string
): CompileError =>
	CompileError.make(
		prose(
			diagnostic.reason,
			childLoc(childLoc(loc, "pattern"), diagnostic.offset),
			`${diagnostic.construct} at offset ${diagnostic.offset} of /${source}/${flags}: ${diagnostic.message}`
		)
	)

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

/** A nontrivial check with the UTF-8 bytes its predicate prints in (predicateBytes). */
interface Measured {
	readonly check: NontrivialCheck
	readonly bytes: number
}

const measured = (check: NontrivialCheck): Measured => ({ check, bytes: predicateBytes(check) })

/**
 * The enforcement of a finite language whose predicate prints in fewer bytes, the IN list where the two print alike.
 * Both recognize exactly the language, so their printed size is all that tells them apart.
 */
const shorter = (inList: Measured, regex: Measured): Measured =>
	inList.bytes <= regex.bytes ? inList : regex

/**
 * The enforcement of a language. From its automaton: a tautology, or whichever of two equivalent forms prints shorter
 * (shorter), its regex with the automaton's bounds or, for a finite language, `VALUE IN (...)` of its members. From its
 * structure alone: a regex with the IR's structural bounds.
 *
 * The regex is measured first, and the members are listed only while they could still print within its bytes: each
 * member's literal prints in at least memberBytes and the member's own UTF-8 bytes, so the IN list of members that
 * weigh more (membersWithin) is longer than the regex, and a large language with a short pattern is never listed.
 */
const choose = (ir: RegexNode, known: Known, are: string): TextCheck => {
	switch (known.kind) {
		case "automaton": {
			const { dfa } = known
			if (isUniversal(dfa)) {
				return { kind: "tautology" }
			}
			const regex = measured({ kind: "regex", pattern: are, bounds: longest(dfa) })
			const members = membersWithin(dfa, memberBytes, regex.bytes)
			if (members === undefined || !isNonEmpty(members)) {
				return regex.check
			}
			const inList = measured({ kind: "finite", members, bounds: boundsOfMembers(members) })
			return shorter(inList, regex).check
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
			return `ir:${canonicalText(ir)}`
	}
}

/**
 * A pattern's language: empty (no admitted text value matches it), or not, as the analysis knows it.
 * A nonempty one holds its IR as a node of a language with a member.
 */
type Language =
	| { readonly kind: "empty" }
	| { readonly kind: "nonEmpty"; readonly ir: LiveNode; readonly known: Known }

/** The language of a pattern's IR from its NFA: what analyzeText classifies an admitted pattern by. */
export const languageOf = (ir: RegexNode, nfa: Nfa): Language => {
	if (ir.kind === "never") {
		return { kind: "empty" }
	}
	const outcome = minimalDfa(nfa, dfaLimits)
	switch (outcome.kind) {
		case "bounded":
			return { kind: "nonEmpty", ir, known: { kind: "structure" } }
		case "minimal":
			return isEmptyLanguage(outcome.dfa)
				? { kind: "empty" }
				: { kind: "nonEmpty", ir, known: { kind: "automaton", dfa: outcome.dfa } }
	}
}

/**
 * Text refinements: a declared pattern, checked, analyzed and lowered.
 *
 * `analyzeText` is what schema compilation calls for every `str.regex` descriptor. It parses the admitted grammar
 * (scalar/regex/parse.ts) with source-located diagnostics, at any length and nesting depth; refuses a pattern past a
 * measure of PostgreSQL's regex compile space (core/limits.ts regexMaxPositions, regexMaxAnchors, regexMaxAnchorWeight,
 * regexMaxClosurePairs) as ResourceBound, the one limit on a pattern's size, which is PostgreSQL's own; then proves
 * what it can within the host's bounds and chooses the PostgreSQL enforcement:
 *
 * - a tautology over admitted text erases: no CHECK, no domain, the column is plain text;
 * - a proved finite language becomes `VALUE IN (...)`, which recognizes exactly the same values, where that predicate
 *   prints in no more bytes than the regex's (choose);
 * - anything else is `VALUE ~ '<ARE>'` with the translated pattern (are.ts).
 *
 * It also derives the canonical pattern key that domain sharing uses (core/identity.ts textDomain), and the proved length
 * and byte bounds that the key representability check consumes. Nothing here validates application data.
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
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		return Result.err(diagnosticError(parsed.error, loc, source, flags))
	}
	const ir = parsed.value
	const tooComplex = (measure: RegexSpaceMeasure): Result.Result<never, CompileError> =>
		Result.err(
			resourceBound(childLoc(loc, "pattern"), {
				kind: "regexCompileSpace",
				pattern: `/${source}/${flags}`,
				measure
			})
		)
	if (loopsThroughAnchor(ir)) {
		return tooComplex({ kind: "anchorLoop" })
	}
	const positions = expandedSize(ir)
	if (positions > regexMaxPositions.value) {
		return tooComplex({ kind: "positions", limit: regexMaxPositions.value, needed: positions })
	}
	const anchors = expandedAssertions(ir)
	if (anchors > regexMaxAnchors.value) {
		return tooComplex({ kind: "anchors", limit: regexMaxAnchors.value, needed: anchors })
	}
	if (anchors * positions > regexMaxAnchorWeight.value) {
		return tooComplex({
			kind: "anchorWeight",
			limit: regexMaxAnchorWeight.value,
			anchors,
			positions
		})
	}
	const nfa = buildNfa(ir)
	if (closurePairs(nfa, regexMaxClosurePairs.value) > regexMaxClosurePairs.value) {
		return tooComplex({ kind: "closurePairs", limit: regexMaxClosurePairs.value })
	}
	const language = languageOf(ir, nfa)
	if (language.kind === "empty") {
		return Result.err(
			unsupported(
				childLoc(loc, "pattern"),
				`/${source}/${flags} matches no admitted text value, so no fact could ever hold the field`
			)
		)
	}
	const are = toAre(language.ir)
	const check = choose(ir, language.known, are)
	const key = keyOf(ir, language.known)
	return Result.ok(Object.freeze({ source, flags, ir, are, check, key, digest: keyDigest(key) }))
}

/**
 * The canonical wildcard every compiler-created text value carries unless a stronger pattern is proved: every representable value, empty and multiline included.
 */
export const wildcardSource = "^.*$"
export const wildcardFlags: RegexFlags = "su"

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

/** A domain CHECK's VALUE. */
export const domainValue: Expr = Object.freeze({ kind: "domainValue" })

/** A member of `VALUE IN (...)`: the text literal its list holds. */
const memberLiteral = (member: string): Expr => lit.text(member, types.text)

/**
 * The fewest UTF-8 bytes a member adds to `VALUE IN (...)`, the empty text's literal: any member's literal is that one
 * with the member's UTF-8 bytes inside its quotes, and more where a quote is doubled.
 */
const memberBytes = utf8Length(printExpr(memberLiteral("")))

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
				list: mapNonEmpty(check.members, memberLiteral),
				not: false
			}
		case "regex":
			return binary("~", value, lit.text(check.pattern, types.text))
	}
}

/**
 * The UTF-8 bytes a check's predicate over VALUE prints in, what choose compares two equivalent checks by. Every CHECK
 * prints its predicate in one place whatever its form, alone inside `CHECK ((...) IS TRUE)` or as a term of a
 * contract's conjunction, so the predicates' bytes order the statements as the statements' own bytes do.
 */
const predicateBytes = (check: NontrivialCheck): number =>
	utf8Length(printExpr(membership(check, domainValue)))

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
