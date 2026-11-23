import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { GeneratedRule } from "#compiler/core/causes.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { type ExprDesc, exprChildren, exprFieldReads } from "#compiler/ir/desc.ts"
import type { Volatility } from "#compiler/ir/expr.ts"
import {
	entersColumn,
	type ScalarType,
	type TextInfo,
	textInfoBounds,
	textOf,
	textPatterns,
	typeLabel
} from "#compiler/ir/scalar.ts"
import { bytesWithin } from "#compiler/scalar/regex/inclusion.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { analyzeText } from "#compiler/text/refinement.ts"

/**
 * A generated field's rule: a STORED generated column's expression reads its own row's written fields, literals and
 * closed relations, and nothing else, and its value is of the column's declared type (PostgreSQL: "The generation
 * expression can only use immutable functions and cannot use subqueries or reference anything other than the current
 * row in any way", "A generation expression cannot reference another generated column",
 * https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/ddl.sgml#L406-L413).
 *
 * analysis/schema.ts applies it to every generated field of a checked schema, in field order, as the one place the rule
 * lives: the builder's row is typed by the written fields alone, so a JavaScript caller never meets it, and a decoded
 * Description meets it here.
 */

/** An input beyond a generation expression's own row: the ExprDesc kinds a row-local expression never holds. */
type ForeignKind = Extract<GeneratedRule, { readonly kind: "notRowLocal" }>["input"]

/** The kind of `e` when it is an input beyond the row, or undefined for a row-local node. */
const foreignKind = (e: ExprDesc): ForeignKind | undefined => {
	switch (e.kind) {
		case "var":
		case "param":
		case "parent":
		case "value":
		case "absent":
		case "exists":
		case "call":
			return e.kind
		case "field":
		case "literal":
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "cast":
		case "guarded":
		case "base":
		case "retype":
		case "not":
		case "in":
		case "cond":
		case "when":
		case "compare":
		case "allen":
		case "between":
		case "pointIn":
			return undefined
	}
}

/** The first input of `e` beyond its row, in the order its description states it, or undefined for none. */
const firstForeign = (e: ExprDesc): ForeignKind | undefined => {
	const own = foreignKind(e)
	if (own !== undefined) {
		return own
	}
	for (const { term } of exprChildren(e)) {
		const found = firstForeign(term)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** Every closed relation `e` reads, by C.at, C.row or C.has, each once, in the order its description states them. */
export const closedReadNames = (e: ExprDesc): ReadonlyArray<string> => {
	const out = new Set<string>()
	const visit = (x: ExprDesc): void => {
		for (const { term } of exprChildren(x)) {
			visit(term)
		}
		if (x.kind === "closedAt" || x.kind === "closedRow" || x.kind === "closedHas") {
			out.add(x.relation)
		}
	}
	visit(e)
	return [...out]
}

/**
 * Why the generation expression `expr` breaks the rule before it is typed, or undefined when it keeps it: the first
 * input beyond its row in description order (notRowLocal), else the least field it reads in code-unit order that
 * `generated` says is generated, itself among them (readsGenerated). So of a relation whose generated fields read one
 * another, a cycle or not, the refusal names the least generated field read. Any other field of its row it may read,
 * one grizzle draws or accumulates among them: its column holds its final value whenever PostgreSQL computes the
 * generation, at the row's INSERT or at an UPDATE that writes it, and the schema's fill order (analysis/theory/fill.ts)
 * evaluates it on the host only once every column it reads is filled.
 */
export const generatedRule = (
	expr: ExprDesc,
	generated: (field: string) => boolean
): GeneratedRule | undefined => {
	const input = firstForeign(expr)
	if (input !== undefined) {
		return { kind: "notRowLocal", input }
	}
	const reads = exprFieldReads(expr).toSorted(compareStrings)
	const read = reads.find(generated)
	return read === undefined ? undefined : { kind: "readsGenerated", read }
}

/** The writings a key generation may not read: every one but its caller's, each a field grizzle writes. */
export type UnwrittenRead = Extract<
	GeneratedRule,
	{ readonly kind: "keyReadsUnwritten" }
>["writing"]

/**
 * Why the generation expression `expr` of a field its relation's primary key holds (law.ts FieldWriting keyGenerated)
 * breaks the key-generation rule, or undefined when it keeps it: the least field it reads in code-unit order that
 * `unwritten` says grizzle or the database writes, drawn, accumulated, place or a stamped instant, with its
 * writing. A key generation reads
 * its row's caller fields alone, so its reads are the heads a put, a delete or a get states the key by (law.ts
 * keyHeads), each a value the caller holds before any row is filled; a generated field it reads is generatedRule's
 * refusal, met first.
 */
export const keyGeneratedRule = (
	expr: ExprDesc,
	unwritten: (field: string) => UnwrittenRead | undefined
): GeneratedRule | undefined => {
	for (const read of exprFieldReads(expr).toSorted(compareStrings)) {
		const writing = unwritten(read)
		if (writing !== undefined) {
			return { kind: "keyReadsUnwritten", read, writing }
		}
	}
	return undefined
}

/**
 * Why a generation expression of volatility `volatility` cannot be stored, or undefined when it can: PostgreSQL stores
 * a column only by an immutable generation (heap.c cookDefault, "generation expression is not immutable",
 * https://github.com/postgres/postgres/blob/REL_19_0/src/backend/catalog/heap.c), and a stable one reads a setting of
 * its session, as a conversion to money reads lc_monetary, so its installation would fail. Refused here, every generated
 * field's expression is immutable: a function of its row's values (ir/keys.ts GeneratedRead).
 */
export const generatedVolatilityRule = (volatility: Volatility): GeneratedRule | undefined =>
	volatility === "stable" ? { kind: "stable" } : undefined

/**
 * Why a generation expression of type `expression` cannot fill a column of type `declared`, or undefined when it can:
 * the two are one type but for a text's pattern and byte bound, which the column's domain enforces, and a closed id's
 * subset, the expression's within the column's (scalar.ts entersColumn). PostgreSQL coerces a generation expression into its column's type, so a text of any pattern or byte
 * bound fills a refined text's column, the domain's CHECK refusing a row whose value lies outside it, as it refuses a
 * caller's value: an outcome on the pattern's rule. That holds where some value of the expression's type is one of the
 * declared type's; where the text analysis proves none is (disjointTexts), every row's value breaks the domain and no row
 * is ever written, so the field is refused. Any other difference is a cast grizzle never makes implicitly: a typmod
 * rounds, and a contract, natural among them, is a type of its own.
 */
export const generatedTypeRule = (
	declared: ScalarType,
	expression: ScalarType,
	patterns: PatternAutomata
): GeneratedRule | undefined => {
	if (!entersColumn(declared, expression)) {
		return { kind: "type", declared: typeLabel(declared), expression: typeLabel(expression) }
	}
	const declaredText = textOf(declared)
	const expressionText = textOf(expression)
	return declaredText !== undefined &&
		expressionText !== undefined &&
		disjointTexts(declaredText, expressionText, patterns)
		? { kind: "disjoint", declared: typeLabel(declared), expression: typeLabel(expression) }
		: undefined
}

/**
 * Whether the text analysis proves that no value is of both texts' types: their patterns' conjunction is the empty
 * language (text/refinement.ts analyzeText, which refuses exactly such a conjunction within the DFA bounds), or no member
 * of it, the empty text among them, takes at most the tighter of their byte bounds (scalar/regex/inclusion.ts
 * bytesWithin). Past the analysis's bounds it proves nothing, and the domain's CHECK stays the judge.
 */
const disjointTexts = (a: TextInfo, b: TextInfo, patterns: PatternAutomata): boolean => {
	const both: Patterns = [...textPatterns(a), ...textPatterns(b)]
	if (!analyzeText(both, SourceLoc("a generated field's two types", [])).ok) {
		return true
	}
	const bounds = [textInfoBounds(a), textInfoBounds(b)].flatMap((t) =>
		t === undefined ? [] : [t.bytes]
	)
	if (!isNonEmpty(bounds)) {
		return false
	}
	const [first, ...rest] = bounds
	const octets = rest.reduce((tightest, n) => Math.min(tightest, n), first)
	if (both.every((p) => patterns.parse(p).matcher.matches(""))) {
		return false
	}
	const within = bytesWithin(both, octets, patterns)
	return within.kind === "within" && within.bytes === 0
}

/**
 * The node a generated field's expression reads its row as: each field it reads is a column of this node, named by the
 * field, which the installation reads as the column of the field's own table.
 */
export const rowNode: NodeId = NodeId("row")
