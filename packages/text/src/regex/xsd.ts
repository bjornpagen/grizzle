import { codePoints, codePointsText, isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import { defined } from "#text/base/invariant.ts"
import * as Result from "#text/base/result.ts"
import { categoryRuns, generalCategories } from "#text/regex/categories.generated.ts"
import {
	type CharSet,
	charSet,
	complement,
	type Interval,
	intersection,
	single,
	union
} from "#text/regex/charset.ts"
import * as Ir from "#text/regex/ir.ts"
import type { RegexDiagnostic } from "#text/regex/parse.ts"
import { nameChar, nameStart, xmlChar, xmlSchemaBlocks } from "#text/regex/xml.ts"

/**
 * XML Schema 1.0's regular expressions (Part 2, Appendix F), read into the regex IR (ir.ts) as the one front end of
 * every pattern facet's dialect, beside the parser of grizzle's own grammar (parse.ts): the same IR, so a facet's
 * language is printed in any dialect (are.ts, ecma.ts, source.ts), matched (match.ts) and compared (inclusion.ts) as a
 * declared pattern is, and no reader of XML Schema's syntax lives anywhere else.
 *
 * An expression is anchored at both ends, as XML Schema's are ("implicitly anchored at the head and tail", F.1), so its
 * IR is `^(...)$`, and `^` and `$` are ordinary characters. Its alphabet is XML's Char (xml.ts xmlChar): a normal
 * character is "any XML character that is not a metacharacter", and a complement, a negative group and the wildcard
 * `.` ("any character except the newline or carriage return") range over XML's characters alone.
 *
 * The escapes keep XML Schema's meanings: the single-character escapes `\n`, `\r`, `\t` and a backslash before a
 * metacharacter; `\s` the four XML space characters; `\i` and `\c` XML 1.0 Second Edition's initial name characters
 * and name characters (xml.ts nameStart, nameChar); `\d` the decimal digits (`\p{Nd}`); `\w` every character but the
 * punctuation, separators and others (`[#x0000-#x10FFFF]-[\p{P}\p{Z}\p{C}]`); each with its complement in capitals.
 * A category escape `\p{…}` names a General_Category of the Unicode the running Node ships (categories.generated.ts),
 * as Appendix F invites, and a block escape `\p{IsName}` a block of the Recommendation's own table (xml.ts
 * xmlSchemaBlocks); `\P{…}` is the complement. A class subtraction `[a-z-[aeiou]]` is the first group less the second.
 *
 * Anything outside the grammar is refused with its code-point offset, never approximated, as parse.ts refuses: a
 * back-reference, a lazy or possessive quantifier, a `(?…)` group, an unbalanced bracket or parenthesis, an escape
 * Appendix F does not define, a category or block the tables do not name, and a `{` or `}` that opens or closes no
 * repetition count (a metacharacter, as Appendix F's definition of one and XML Schema 1.1 say, though production [10]
 * omits them). A repetition count may be any whole number, as Appendix F sets no bound: PostgreSQL's RE_DUP_MAX of 255
 * binds only the ARE printed for it, which spells a count past it as pieces of counts within it (print.ts quantified),
 * and the host's automaton counts a repetition rather than copying its body (nfa.ts), so no count costs it states.
 *
 * The reader is one loop over the pattern's code points: its open groups and classes are frames on the heap, so a
 * pattern nested to any depth costs no call stack. It constructs no RegExp.
 *
 * @see {@link https://www.w3.org/TR/2004/REC-xmlschema-2-20041028/#regexs | XML Schema 1.0 Part 2, Appendix F}
 */

/** The reader's refusal, thrown at the first one and caught by xsdPattern. */
class Failure extends Error {
	readonly diagnostic: RegexDiagnostic

	constructor(diagnostic: RegexDiagnostic) {
		super()
		this.diagnostic = diagnostic
	}
}

/** The code point of a one-unit ASCII character of the grammar. */
const cp = (ch: string): number => ch.charCodeAt(0)

/** A set within XML's characters: the alphabet's part of `s`. */
const withinXml = (s: CharSet): CharSet => intersection(xmlChar, s)

/** The complement of `s` within XML's characters. */
const xmlComplement = (s: CharSet): CharSet => intersection(xmlChar, complement(s))

/** XML's four space characters, `\s`: space, tab, line feed and carriage return. */
const spaces: CharSet = charSet([
	[0x9, 0xa],
	[0xd, 0xd],
	[0x20, 0x20]
])

/** The wildcard `.`: every XML character but a line feed or a carriage return. */
const wildcard: CharSet = xmlComplement(
	charSet([
		[0xa, 0xa],
		[0xd, 0xd]
	])
)

/**
 * Each General_Category's code points, read once from the generated runs (categories.generated.ts): every two-letter
 * value's, and each one-letter value's as the union of the two-letter values it heads.
 */
const categories = ((): ReadonlyMap<string, CharSet> => {
	const intervals = new Map<string, Array<Interval>>(generalCategories.map((g) => [g, []]))
	let at = 0
	for (const run of categoryRuns.split(",")) {
		const letter = run.charCodeAt(0)
		const index = letter >= 0x61 ? letter - 0x61 : letter - 0x41 + 26
		const length = Number.parseInt(run.slice(1), 36)
		const named = defined(generalCategories[index], `the category letter of the run ${run}`)
		defined(intervals.get(named), `the runs of ${named}`).push([at, at + length - 1])
		at += length
	}
	const out = new Map<string, CharSet>()
	for (const [g, list] of intervals) {
		out.set(g, charSet(list))
	}
	for (const head of ["L", "M", "N", "P", "S", "Z", "C"]) {
		out.set(
			head,
			union(
				generalCategories.flatMap((g) =>
					g.startsWith(head) ? [defined(out.get(g), `the code points of ${g}`)] : []
				)
			)
		)
	}
	return out
})()

/** The General_Category values a category escape may name (Appendix F, productions [28] to [35]). */
export const xsdCategoryNames: ReadonlySet<string> = new Set([
	"L",
	"Lu",
	"Ll",
	"Lt",
	"Lm",
	"Lo",
	"M",
	"Mn",
	"Mc",
	"Me",
	"N",
	"Nd",
	"Nl",
	"No",
	"P",
	"Pc",
	"Pd",
	"Ps",
	"Pe",
	"Pi",
	"Pf",
	"Po",
	"Z",
	"Zs",
	"Zl",
	"Zp",
	"S",
	"Sm",
	"Sc",
	"Sk",
	"So",
	"C",
	"Cc",
	"Cf",
	"Co",
	"Cn"
])

/** A category's code points within XML's characters. */
const category = (name: string): CharSet =>
	withinXml(defined(categories.get(name), `the code points of the category ${name}`))

/** The characters `\w` excludes: the punctuation, separators and others. */
const nonWord = (): CharSet => union([category("P"), category("Z"), category("C")])

/** The multi-character escapes, by the letter after the backslash (F.1.1, production [37a]). */
const multiCharacterEscapes: ReadonlyMap<number, () => CharSet> = new Map([
	[cp("s"), () => spaces],
	[cp("S"), () => xmlComplement(spaces)],
	[cp("i"), () => nameStart],
	[cp("I"), () => xmlComplement(nameStart)],
	[cp("c"), () => nameChar],
	[cp("C"), () => xmlComplement(nameChar)],
	[cp("d"), () => category("Nd")],
	[cp("D"), () => xmlComplement(category("Nd"))],
	[cp("w"), () => xmlComplement(nonWord())],
	[cp("W"), () => nonWord()]
])

/** The single-character escapes, by the character after the backslash, and the code point each names (F.1.1, [24]). */
const singleCharacterEscapes: ReadonlyMap<number, number> = new Map([
	[cp("n"), 0x0a],
	[cp("r"), 0x0d],
	[cp("t"), 0x09],
	...codePoints("\\|.?*+(){}-[]^").map((c): readonly [number, number] => [c, c])
])

/** What an escape names: one character, which can end a range, or a class, which cannot. */
type Escape =
	| { readonly kind: "character"; readonly point: number }
	| { readonly kind: "class"; readonly set: CharSet }

/** A disjunction being read: the pattern's, or an open group's, its arms read whole and the terms of the one being read. */
interface Group {
	/** The group's `(` offset, or the pattern's start. */
	readonly at: number
	readonly arms: Array<Ir.RegexNode>
	terms: Array<Ir.RegexNode>
}

/** A character group being read: its `[` offset, whether it is negative, and its members' sets so far. */
interface CharGroup {
	readonly at: number
	readonly negated: boolean
	readonly members: Array<CharSet>
	/** The group it is the subtrahend of, `-[…]` at that group's end; none for a class an atom opens. */
	readonly of: CharGroup | undefined
}

class Reader {
	readonly #cps: ReadonlyArray<number>
	#pos = 0
	readonly #ir = new Ir.RegexBuilder()

	constructor(cps: ReadonlyArray<number>) {
		this.#cps = cps
	}

	#peek(ahead: number): number | undefined {
		return this.#cps[this.#pos + ahead]
	}

	#is(ch: string, ahead: number): boolean {
		return this.#peek(ahead) === cp(ch)
	}

	#text(from: number, to: number): string {
		return codePointsText(this.#cps.slice(from, to))
	}

	#malformed(offset: number, construct: string, message: string): Failure {
		return new Failure({ reason: "MalformedDescription", offset, construct, message })
	}

	#unsupported(offset: number, construct: string, message: string): Failure {
		return new Failure({ reason: "UnsupportedOperation", offset, construct, message })
	}

	/**
	 * The expression, anchored at both ends: one loop over its code points, `|` ending an arm, `(` opening a group on
	 * the stack and `)` closing it into a term of the group around it, and anything else a piece of the arm being read.
	 */
	read(): Ir.RegexNode {
		const stack: Array<Group> = [{ at: 0, arms: [], terms: [] }]
		for (let c = this.#peek(0); c !== undefined; c = this.#peek(0)) {
			const open = defined(stack.at(-1), "the open group, the pattern's at least")
			if (c === cp("|")) {
				this.#pos += 1
				open.arms.push(Ir.seq(open.terms))
				open.terms = []
			} else if (c === cp("(")) {
				if (this.#is("?", 1)) {
					throw this.#unsupported(
						this.#pos,
						"(?",
						"(? opens a group XML Schema does not have (non-capturing, look-around, named or with flags); write a plain (…) group"
					)
				}
				stack.push({ at: this.#pos, arms: [], terms: [] })
				this.#pos += 1
			} else if (c === cp(")")) {
				if (stack.length === 1) {
					throw this.#malformed(
						this.#pos,
						")",
						"this ) closes no group; remove it, or write \\) to match a parenthesis"
					)
				}
				this.#pos += 1
				stack.pop()
				const outer = defined(stack.at(-1), "the group around a closed one")
				outer.terms.push(this.#quantified(this.#closed(open)))
			} else {
				open.terms.push(this.#quantified(this.#atom()))
			}
		}
		const [pattern, ...unclosed] = stack
		const last = unclosed[unclosed.length - 1]
		if (pattern === undefined || last !== undefined) {
			throw this.#malformed(
				last?.at ?? 0,
				"(",
				"this ( is never closed; close the group with ), or write \\( to match a parenthesis"
			)
		}
		return Ir.seq([Ir.start, this.#closed(pattern), Ir.end])
	}

	/** A group's language: the alternation of its arms, the one being read among them. */
	#closed(group: Group): Ir.RegexNode {
		return this.#ir.alt([...group.arms, Ir.seq(group.terms)])
	}

	/** An atom other than a group: a normal character, an escape, the wildcard or a character class. */
	#atom(): Ir.RegexNode {
		const at = this.#pos
		const c = defined(this.#peek(0), "the atom's first code point, which the loop read")
		if (c === cp("\\")) {
			const escape = this.#escape()
			return Ir.set(escape.kind === "character" ? withinXml(single(escape.point)) : escape.set)
		}
		if (c === cp(".")) {
			this.#pos += 1
			return Ir.set(wildcard)
		}
		if (c === cp("[")) {
			return Ir.set(this.#classExpression())
		}
		if (c === cp("?") || c === cp("*") || c === cp("+") || c === cp("{")) {
			throw this.#malformed(
				at,
				String.fromCodePoint(c),
				`${String.fromCodePoint(c)} repeats what comes before it, and nothing does here; write \\${String.fromCodePoint(c)} to match it`
			)
		}
		if (c === cp("]") || c === cp("}")) {
			throw this.#malformed(
				at,
				String.fromCodePoint(c),
				`${String.fromCodePoint(c)} closes nothing here; write \\${String.fromCodePoint(c)} to match it`
			)
		}
		this.#pos += 1
		return Ir.set(withinXml(single(c)))
	}

	/** An escape whose backslash is the next character: one character, or a class (F.1.1). */
	#escape(): Escape {
		const at = this.#pos
		const letter = this.#peek(1)
		if (letter === undefined) {
			throw this.#malformed(
				at,
				"\\",
				"the pattern ends in a lone \\; write \\\\ to match a backslash"
			)
		}
		const point = singleCharacterEscapes.get(letter)
		if (point !== undefined) {
			this.#pos += 2
			return { kind: "character", point }
		}
		const multi = multiCharacterEscapes.get(letter)
		if (multi !== undefined) {
			this.#pos += 2
			return { kind: "class", set: multi() }
		}
		if (letter === cp("p") || letter === cp("P")) {
			return { kind: "class", set: this.#property(letter === cp("P")) }
		}
		const named = String.fromCodePoint(letter)
		throw this.#unsupported(
			at,
			`\\${named}`,
			letter >= cp("1") && letter <= cp("9")
				? `\\${named} is a back-reference, which XML Schema regular expressions do not have; write out the text it would repeat`
				: `\\${named} is not an escape XML Schema defines; use \\n, \\r, \\t, \\s, \\S, \\i, \\I, \\c, \\C, \\d, \\D, \\w, \\W, \\p{…}, \\P{…}, or a backslash before one of . \\ ? * + { } ( ) [ ] | - ^`
		)
	}

	/** A category or block escape, `\p{…}` or `\P{…}`, whose backslash is the next character (F.1.1, [26] to [36]). */
	#property(negated: boolean): CharSet {
		const at = this.#pos
		const letter = negated ? "P" : "p"
		if (!this.#is("{", 2)) {
			throw this.#malformed(
				at,
				`\\${letter}`,
				`\\${letter} takes a category in braces, such as \\${letter}{Lu}`
			)
		}
		const close = this.#cps.indexOf(cp("}"), this.#pos + 3)
		if (close < 0) {
			throw this.#malformed(
				at,
				`\\${letter}{`,
				`\\${letter}{ is never closed; end the category with }`
			)
		}
		const name = this.#text(this.#pos + 3, close)
		const block = name.startsWith("Is") ? xmlSchemaBlocks.get(name.slice(2)) : undefined
		const named = xsdCategoryNames.has(name)
			? category(name)
			: block === undefined
				? undefined
				: withinXml(block)
		if (named === undefined) {
			throw this.#unsupported(
				at,
				this.#text(at, close + 1),
				name.startsWith("Is")
					? `${name} names no block in XML Schema's block table; use a block name the table lists, such as IsBasicLatin or IsGreek`
					: `${JSON.stringify(name)} is not a category XML Schema names; use one of ${[...xsdCategoryNames].join(", ")}`
			)
		}
		this.#pos = close + 1
		return negated ? xmlComplement(named) : named
	}

	/**
	 * A character class expression `[…]` whose `[` is the next character, its subtractions read on the heap: a
	 * subtraction `-[…]` opens a group whose set the group before it loses, and which closes that group's `]` at once.
	 */
	#classExpression(): CharSet {
		let group: CharGroup = this.#openGroup(undefined)
		for (;;) {
			const at = this.#pos
			const c = this.#peek(0)
			if (c === undefined) {
				throw this.#malformed(
					group.at,
					"[",
					"this [ is never closed; end the class with ], or write \\[ to match a bracket"
				)
			}
			if (c === cp("]")) {
				if (group.members.length === 0) {
					throw this.#malformed(
						at,
						"]",
						"a class holds at least one character, range or escape; write \\[ and \\] to match the brackets themselves"
					)
				}
				this.#pos += 1
				let set = this.#groupSet(group)
				for (let of = group.of; of !== undefined; of = group.of) {
					if (!this.#is("]", 0)) {
						throw this.#malformed(
							this.#pos,
							this.#text(this.#pos, this.#pos + 1),
							"a subtraction -[…] ends its class; close the class with ] straight after it"
						)
					}
					this.#pos += 1
					set = intersection(this.#groupSet(of), complement(set))
					group = of
				}
				return set
			}
			if (c === cp("[")) {
				throw this.#malformed(
					at,
					"[",
					"a [ inside a class is written \\[; a subtraction is written -[…] at the end of the class"
				)
			}
			if (c === cp("-") && this.#is("[", 1)) {
				if (group.members.length === 0) {
					throw this.#malformed(
						at,
						"-[",
						"-[…] subtracts a class from the characters before it, and there are none; put characters before the -, or write \\- to match a dash"
					)
				}
				this.#pos += 1
				group = this.#openGroup(group)
				continue
			}
			if (c === cp("-")) {
				if (group.members.length > 0 && !this.#is("]", 1)) {
					throw this.#malformed(
						at,
						"-",
						"a - inside a class starts it, ends it, joins the two ends of a range or begins a subtraction -[…]; write \\- to match a dash"
					)
				}
				this.#pos += 1
				group.members.push(single(c))
				continue
			}
			group.members.push(this.#classMember())
		}
	}

	/** A group whose `[` is the next character, its `^` read where it stands first. */
	#openGroup(of: CharGroup | undefined): CharGroup {
		const at = this.#pos
		this.#pos += 1
		const negated = this.#is("^", 0)
		if (negated) {
			this.#pos += 1
		}
		return { at, negated, members: [], of }
	}

	/** A group's set within XML's characters: its members', or their complement for a negative group. */
	#groupSet(group: CharGroup): CharSet {
		const members = union(group.members)
		return group.negated ? xmlComplement(members) : withinXml(members)
	}

	/** One member of a class: a character, a range `s-e`, or a class escape. */
	#classMember(): CharSet {
		const at = this.#pos
		const first = this.#classCharacter()
		if (first.kind === "class") {
			return first.set
		}
		const end = this.#peek(1)
		if (!this.#is("-", 0) || end === undefined || end === cp("]") || end === cp("[")) {
			return single(first.point)
		}
		if (end === cp("-")) {
			throw this.#malformed(
				this.#pos + 1,
				"-",
				"a range cannot end in an unescaped -; write \\- to end it at a dash"
			)
		}
		this.#pos += 1
		const last = this.#classCharacter()
		if (last.kind === "class") {
			throw this.#malformed(
				at,
				this.#text(at, this.#pos),
				"a range ends in one character, and this escape names a class; end the range in a character, or put the escape outside the range"
			)
		}
		if (last.point < first.point) {
			throw this.#malformed(
				at,
				this.#text(at, this.#pos),
				"this range runs from a higher code point to a lower one; write its lower end first"
			)
		}
		return charSet([[first.point, last.point]])
	}

	/** One character or escape of a class: the start or end of a range, or a class escape. */
	#classCharacter(): Escape {
		const c = defined(
			this.#peek(0),
			"a class member's first code point, which the class's loop read"
		)
		if (c === cp("\\")) {
			return this.#escape()
		}
		this.#pos += 1
		return { kind: "character", point: c }
	}

	/** `node` under the quantifier after it, if one follows: `?`, `*`, `+`, `{n}`, `{n,}` or `{n,m}` (F.1, [4]). */
	#quantified(node: Ir.RegexNode): Ir.RegexNode {
		const c = this.#peek(0)
		const bounds =
			c === cp("?")
				? { min: 0, max: 1 }
				: c === cp("*")
					? { min: 0, max: "unbounded" as const }
					: c === cp("+")
						? { min: 1, max: "unbounded" as const }
						: c === cp("{")
							? this.#counts()
							: undefined
		if (bounds === undefined) {
			return node
		}
		if (c !== cp("{")) {
			this.#pos += 1
		}
		const next = this.#peek(0)
		if (next === cp("?") || next === cp("+")) {
			throw this.#unsupported(
				this.#pos,
				String.fromCodePoint(next),
				`a quantifier followed by ${String.fromCodePoint(next)} is ${next === cp("?") ? "lazy" : "possessive"}, which XML Schema does not have`
			)
		}
		if (next === cp("*") || next === cp("{")) {
			throw this.#malformed(
				this.#pos,
				String.fromCodePoint(next),
				"a quantifier cannot follow another; put the repeated piece in a group, (…), and quantify the group"
			)
		}
		return this.#ir.repeat(node, bounds.min, bounds.max)
	}

	/**
	 * A repetition count `{n}`, `{n,}` or `{n,m}` whose `{` is the next character, read past its `}`: any count, as
	 * Appendix F sets none (countOf). Its order is judged on the numerals themselves, so two counts past any a double
	 * holds exactly are still compared as written.
	 */
	#counts(): { readonly min: number; readonly max: number | "unbounded" } {
		const at = this.#pos
		this.#pos += 1
		const min = this.#numeral()
		if (min === undefined) {
			throw this.#malformed(
				at,
				"{",
				"a { after an atom opens a repetition count; write {n}, {n,} or {n,m} in whole numbers, or \\{ to match a brace"
			)
		}
		let most: Most = { kind: "bounded", numeral: min }
		if (this.#is(",", 0)) {
			this.#pos += 1
			const numeral = this.#numeral()
			most = numeral === undefined ? { kind: "unbounded" } : { kind: "bounded", numeral }
		}
		if (!this.#is("}", 0)) {
			throw this.#malformed(
				at,
				"{",
				"a { after an atom opens a repetition count; write {n}, {n,} or {n,m} in whole numbers, or \\{ to match a brace"
			)
		}
		this.#pos += 1
		if (most.kind === "bounded" && numeralBelow(most.numeral, min)) {
			throw this.#malformed(at, this.#text(at, this.#pos), "numbers out of order in the quantifier")
		}
		return { min: countOf(min), max: most.kind === "bounded" ? countOf(most.numeral) : "unbounded" }
	}

	/** Numeric digits as written, without their leading zeros (a zero is "0"), or none where no digit comes next. */
	#numeral(): string | undefined {
		const from = this.#pos
		let first = from
		for (let c = this.#peek(0); c !== undefined && isAsciiDigit(c); c = this.#peek(0)) {
			if (c === cp("0") && first === this.#pos) {
				first += 1
			}
			this.#pos += 1
		}
		if (this.#pos === from) {
			return undefined
		}
		return first === this.#pos ? "0" : this.#text(first, this.#pos)
	}
}

/** A count's greatest as written: a numeral, or none, `{n,}`. */
type Most = { readonly kind: "bounded"; readonly numeral: string } | { readonly kind: "unbounded" }

/** Whether the numeral `a` names a smaller number than `b`, both without leading zeros: by length, then digit by digit. */
const numeralBelow = (a: string, b: string): boolean =>
	a.length === b.length ? a < b : a.length < b.length

/**
 * The count a numeral reads as in the IR: its value, exactly, up to 2^53, the least integer past which a double holds
 * no longer every integer, and 2^53 past it. That reading holds the language: no text has 2^53 code points (a
 * PostgreSQL value holds at most 1 GB, a V8 string at most 2^29 - 24 code units), an iteration of a body that matches
 * no empty string consumes one at least (an XML Schema pattern has no assertion), so no text meets a least count of
 * 2^53 or more and none passes a greatest one, whichever it is; and a body that matches the empty string repeats as
 * 0 to n consuming iterations whatever its least count (nfa.ts NfaRepeat), fewer than 2^53 of them.
 */
const countOf = (numeral: string): number => Math.min(Number(numeral), Number.MAX_SAFE_INTEGER + 1)
/**
 * The language of an XML Schema 1.0 pattern facet, anchored at both ends, as the IR of every dialect holds it, or why
 * it is refused: a syntax error (MalformedDescription) or a construct outside the grammar the tables read
 * (UnsupportedOperation), at its code-point offset. The reader throws its Failure at the first refusal; anything else
 * it throws is a defect and propagates.
 */
export const xsdPattern = (source: string): Result.Result<Ir.RegexNode, RegexDiagnostic> =>
	Result.mapError(
		Result.catchSignal(Failure, () => new Reader(codePoints(source)).read()),
		(failure) => failure.diagnostic
	)
