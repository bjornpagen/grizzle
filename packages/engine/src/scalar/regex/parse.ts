import { catchSignal } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import {
	type CharSet,
	charSet,
	complement,
	digit,
	domain,
	dotU,
	type Interval,
	single,
	surrogateHi,
	surrogateLo,
	union,
	word
} from "#compiler/scalar/regex/charset.ts"
import * as Ir from "#compiler/scalar/regex/ir.ts"

export type RegexFlags = "u" | "su"

export const isRegexFlags = (value: unknown): value is RegexFlags => value === "u" || value === "su"

/** A precise diagnostic: where in the source (a code-point offset), which construct, and why. */
export interface RegexDiagnostic {
	/** Why, as the CompileError it becomes (text/refinement.ts): a malformed pattern, a construct outside the fragment, or past the construct budget. */
	readonly reason: "MalformedDescription" | "UnsupportedOperation" | "ResourceBound"
	/** The code-point offset of the construct in the source. */
	readonly offset: number
	/** The construct as written, for example "(?=" or "\\s". */
	readonly construct: string
	readonly message: string
}

export interface ParseLimits {
	/** Parsed constructs (core/policy.ts regexMaxNodes in production). */
	readonly maxNodes: number
	/** PostgreSQL's explicit repetition limit, core/policy.ts regexMaxRepeat. */
	readonly maxRepeat: number
}

/** The parser's refusal, thrown at the first one and caught by parsePattern. */
class Failure extends Error {
	readonly diagnostic: RegexDiagnostic

	constructor(fields: { readonly diagnostic: RegexDiagnostic }) {
		super()
		this.diagnostic = fields.diagnostic
	}
}

const syntaxCharacters = "^$\\.*+?()[]{}|"

/** The code point of a one-unit ASCII literal of the grammar. */
const cp = (ch: string): number => ch.charCodeAt(0)

const isDecimalDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39

const hexValue = (c: number | undefined): number | undefined => {
	if (c === undefined) {
		return undefined
	}
	if (c >= 0x30 && c <= 0x39) {
		return c - 0x30
	}
	if (c >= 0x41 && c <= 0x46) {
		return c - 0x41 + 10
	}
	if (c >= 0x61 && c <= 0x66) {
		return c - 0x61 + 10
	}
	return undefined
}

const isAsciiLetter = (c: number | undefined): boolean =>
	c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))

const isSurrogate = (c: number): boolean => c >= surrogateLo && c <= surrogateHi
const isLeadSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isTrailSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** A class atom: one code point, or a class escape that denotes a set and cannot be a range endpoint. */
type ClassAtom =
	| { readonly kind: "char"; readonly cp: number }
	| { readonly kind: "set"; readonly set: CharSet }

/** A backreference, checked against the whole pattern once it is parsed: a group number or a group name. */
interface Reference {
	readonly at: number
	readonly construct: string
	readonly group: number | string
}

/** Where a construct sits: for each enclosing disjunction, outermost first, its id and the arm the construct is in. */
type ArmPath = ReadonlyArray<readonly [number, number]>

/**
 * Two named groups might both participate in a match unless some common disjunction holds them in different arms
 * (ECMA-262 MightBothParticipate); only then is a repeated name a syntax error.
 */
const mightBothParticipate = (a: ArmPath, b: ArmPath): boolean => {
	for (const [i, [da, aa]] of a.entries()) {
		const atB = b[i]
		if (atB === undefined) {
			break
		}
		const [db, ab] = atB
		if (da !== db) {
			return true
		}
		if (aa !== ab) {
			return false
		}
	}
	return true
}

/**
 * A capture group name character (ECMA-262 RegExpIdentifierStart and RegExpIdentifierPart): ASCII exactly; a
 * non-ASCII scalar is read as an identifier character, since the scanner carries no ID_Start or ID_Continue table.
 */
const isNameStart = (c: number): boolean =>
	isAsciiLetter(c) ||
	c === 0x24 ||
	c === 0x5f ||
	(c > 0x7f && !(c >= surrogateLo && c <= surrogateHi))

const isNamePart = (c: number): boolean =>
	isNameStart(c) || isDecimalDigit(c) || c === 0x200c || c === 0x200d

const isPropertyNameChar = (c: number | undefined): boolean => isAsciiLetter(c) || c === 0x5f
const isPropertyValueChar = (c: number | undefined): boolean =>
	isPropertyNameChar(c) || isDecimalDigit(c)

/**
 * A placeholder for a construct already refused as unsupported: the parse goes on only to find a later syntax error,
 * and its IR is discarded.
 */
const refusedSet = domain

class Parser {
	readonly #cps: ReadonlyArray<number>
	/** What dot matches: under the s and u flags, every code point. */
	readonly #dot: CharSet
	readonly #limits: ParseLimits
	#pos = 0
	#nodes = 0
	/** The first construct outside the fragment, reported once the whole pattern is known to be valid ECMAScript. */
	#deferred: Failure | undefined
	/** Set by an assertion atom (\b, \B, a lookaround), which ECMAScript's Unicode mode does not let a quantifier follow. */
	#assertion = false
	#captures = 0
	readonly #named: Array<{ readonly name: string; readonly path: ArmPath }> = []
	readonly #references: Array<Reference> = []
	readonly #path: Array<readonly [number, number]> = []
	#disjunctions = 0
	/** The builder of the pattern's IR, whose analyses of its nodes last the parse. */
	readonly #ir = new Ir.RegexBuilder()

	constructor(cps: ReadonlyArray<number>, flags: RegexFlags, limits: ParseLimits) {
		this.#cps = cps
		this.#dot = flags === "su" ? domain : dotU
		this.#limits = limits
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

	#fail(
		reason: RegexDiagnostic["reason"],
		offset: number,
		construct: string,
		message: string
	): Failure {
		return new Failure({ diagnostic: { reason, offset, construct, message } })
	}

	#malformed(offset: number, construct: string, message: string): Failure {
		return this.#fail("MalformedDescription", offset, construct, message)
	}

	/** Records a construct outside the fragment and lets the scan go on, so a later syntax error still wins. */
	#unsupported(offset: number, construct: string, message: string): void {
		this.#deferred ??= this.#fail("UnsupportedOperation", offset, construct, message)
	}

	/**
	 * The budget bounds the scan itself, its depth and its IR included: past it the first refusal found so far is
	 * reported, the recorded unsupported construct if there is one.
	 */
	#count(offset: number): void {
		this.#nodes += 1
		if (this.#nodes > this.#limits.maxNodes) {
			throw (
				this.#deferred ??
				this.#fail(
					"ResourceBound",
					offset,
					this.#text(offset, offset + 1),
					`the pattern exceeds the fixed budget of ${this.#limits.maxNodes} regex constructs`
				)
			)
		}
	}

	parse(): Ir.RegexNode {
		const node = this.#disjunction()
		if (this.#pos < this.#cps.length) {
			throw this.#malformed(this.#pos, ")", "unmatched ')'")
		}
		for (const ref of this.#references) {
			if (typeof ref.group === "number" && ref.group > this.#captures) {
				throw this.#malformed(
					ref.at,
					ref.construct,
					`invalid escape in Unicode mode: a reference to group ${ref.group}, and the pattern has ${this.#captures} capture group${this.#captures === 1 ? "" : "s"}`
				)
			}
			if (typeof ref.group === "string" && !this.#named.some((g) => g.name === ref.group)) {
				throw this.#malformed(
					ref.at,
					ref.construct,
					`invalid named reference: the pattern has no group named ${ref.group}`
				)
			}
		}
		if (this.#deferred !== undefined) {
			throw this.#deferred
		}
		return node
	}

	#disjunction(): Ir.RegexNode {
		this.#disjunctions += 1
		const id = this.#disjunctions
		this.#path.push([id, 0])
		const arms = [this.#alternative()]
		while (this.#is("|", 0)) {
			this.#count(this.#pos)
			this.#pos += 1
			this.#path[this.#path.length - 1] = [id, arms.length]
			arms.push(this.#alternative())
		}
		this.#path.pop()
		return this.#ir.alt(arms)
	}

	#alternative(): Ir.RegexNode {
		const items: Array<Ir.RegexNode> = []
		for (
			let c = this.#peek(0);
			c !== undefined && c !== cp("|") && c !== cp(")");
			c = this.#peek(0)
		) {
			items.push(this.#term(c))
		}
		return Ir.seq(items)
	}

	/** One term: an assertion, which is not quantifiable in Unicode mode (ECMA-262 Term[U]), or a quantified atom. */
	#term(c: number): Ir.RegexNode {
		const at = this.#pos
		if (this.#is("^", 0) || this.#is("$", 0)) {
			this.#count(at)
			const node = this.#is("^", 0) ? Ir.start : Ir.end
			this.#pos += 1
			if (this.#quantifierAhead()) {
				throw this.#malformed(this.#pos, this.#text(this.#pos, this.#pos + 1), "nothing to repeat")
			}
			return node
		}
		const atom = this.#atom(c)
		if (this.#assertion) {
			this.#assertion = false
			if (this.#quantifierAhead()) {
				throw this.#malformed(
					this.#pos,
					this.#text(this.#pos, this.#pos + 1),
					"nothing to repeat: an assertion is not quantifiable in Unicode mode"
				)
			}
			return atom
		}
		return this.#quantified(atom)
	}

	#quantifierAhead(): boolean {
		return this.#is("*", 0) || this.#is("+", 0) || this.#is("?", 0) || this.#is("{", 0)
	}

	/** The bounds the quantifier at the cursor states, consumed; undefined when no quantifier follows. */
	#quantifier(): { readonly min: number; readonly max: number | "unbounded" } | undefined {
		if (this.#is("*", 0)) {
			this.#pos += 1
			return { min: 0, max: "unbounded" }
		}
		if (this.#is("+", 0)) {
			this.#pos += 1
			return { min: 1, max: "unbounded" }
		}
		if (this.#is("?", 0)) {
			this.#pos += 1
			return { min: 0, max: 1 }
		}
		return this.#is("{", 0) ? this.#braces() : undefined
	}

	#quantified(atom: Ir.RegexNode): Ir.RegexNode {
		const at = this.#pos
		const bounds = this.#quantifier()
		if (bounds === undefined) {
			return atom
		}
		const { min, max } = bounds
		this.#count(at)
		if (this.#is("?", 0)) {
			this.#unsupported(
				at,
				this.#text(at, this.#pos + 1),
				"lazy quantifiers are not admitted; membership needs no match preference"
			)
			this.#pos += 1
		}
		return this.#ir.repeat(atom, min, max)
	}

	/** `{m}`, `{m,}` or `{m,n}`; anything else after `{` is a SyntaxError in Unicode mode. */
	#braces(): { readonly min: number; readonly max: number | "unbounded" } {
		const at = this.#pos
		this.#pos += 1
		const min = this.#decimal()
		if (min === undefined) {
			throw this.#malformed(at, "{", "incomplete quantifier")
		}
		let max: number | "unbounded" | undefined = min.value
		if (this.#is(",", 0)) {
			this.#pos += 1
			const upper = this.#decimal()
			max = upper === undefined ? "unbounded" : upper.value
		}
		if (!this.#is("}", 0)) {
			throw this.#malformed(at, "{", "incomplete quantifier")
		}
		this.#pos += 1
		const construct = this.#text(at, this.#pos)
		if (max !== "unbounded" && max < min.value) {
			throw this.#malformed(at, construct, "numbers out of order in the quantifier")
		}
		const limit = this.#limits.maxRepeat
		if (min.value > limit || (max !== "unbounded" && max > limit)) {
			this.#unsupported(
				at,
				construct,
				`a repetition bound above ${limit}, PostgreSQL's limit; bound the length with Compute.charLength in a contract predicate`
			)
		}
		return { min: min.value, max }
	}

	/** Decimal digits, saturating at a value above any admitted bound so a huge literal never loses precision. */
	#decimal(): { readonly value: number } | undefined {
		const first = this.#peek(0)
		return first !== undefined && isDecimalDigit(first) ? this.#decimalFrom(first) : undefined
	}

	/** The decimal digits from the current position, whose code point is `first`, a digit. */
	#decimalFrom(first: number): { readonly value: number } {
		let value = 0
		for (
			let c: number | undefined = first;
			c !== undefined && isDecimalDigit(c);
			c = this.#peek(0)
		) {
			value = Math.min(value * 10 + (c - 0x30), Number.MAX_SAFE_INTEGER)
			this.#pos += 1
		}
		return { value }
	}

	/** The atom at the current position, whose code point `c` is. */
	#atom(c: number): Ir.RegexNode {
		const at = this.#pos
		this.#count(at)
		switch (c) {
			case cp("."):
				this.#pos += 1
				return Ir.set(this.#dot)
			case cp("("):
				return this.#group()
			case cp("["):
				return this.#class()
			case cp("\\"):
				return this.#escape()
			case cp("*"):
			case cp("+"):
			case cp("?"):
				throw this.#malformed(at, this.#text(at, at + 1), "nothing to repeat")
			case cp("{"):
			case cp("}"):
			case cp("]"):
				throw this.#malformed(
					at,
					this.#text(at, at + 1),
					"lone quantifier or class bracket in Unicode mode"
				)
			default:
				this.#pos += 1
				return Ir.set(single(this.#literal(c, at, this.#text(at, at + 1))))
		}
	}

	/** A literal code point: never NUL and never a lone surrogate, which is no Unicode scalar. */
	#literal(c: number, at: number, construct: string): number {
		if (c === 0) {
			this.#unsupported(at, construct, "NUL is not admitted text, so a pattern may not spell it")
		} else if (isSurrogate(c)) {
			this.#unsupported(
				at,
				construct.length === 1 ? `\\u${c.toString(16).toUpperCase().padStart(4, "0")}` : construct,
				"a lone surrogate is not admitted text"
			)
		}
		return c
	}

	#group(): Ir.RegexNode {
		const at = this.#pos
		this.#pos += 1
		let lookaround = false
		if (this.#is("?", 0)) {
			if (this.#is(":", 1)) {
				this.#pos += 2
			} else if (this.#is("=", 1) || this.#is("!", 1)) {
				this.#unsupported(at, this.#text(at, at + 3), "lookahead assertions are not admitted")
				this.#pos += 2
				lookaround = true
			} else if (this.#is("<", 1) && (this.#is("=", 2) || this.#is("!", 2))) {
				this.#unsupported(at, this.#text(at, at + 4), "lookbehind assertions are not admitted")
				this.#pos += 3
				lookaround = true
			} else if (this.#is("<", 1)) {
				this.#unsupported(
					at,
					"(?<",
					"named capture groups are not admitted; use (?:...), captures are not outputs"
				)
				this.#pos += 1
				const name = this.#groupName(at)
				const path: ArmPath = [...this.#path]
				if (this.#named.some((g) => g.name === name && mightBothParticipate(g.path, path))) {
					throw this.#malformed(
						at,
						this.#text(at, this.#pos),
						`duplicate capture group name ${name}`
					)
				}
				this.#named.push({ name, path })
				this.#captures += 1
			} else {
				this.#modifiers(at)
			}
		} else {
			this.#captures += 1
		}
		const body = this.#disjunction()
		if (!this.#is(")", 0)) {
			throw this.#malformed(at, "(", "unterminated group")
		}
		this.#pos += 1
		if (!lookaround) {
			return body
		}
		this.#assertion = true
		return Ir.empty
	}

	/**
	 * `(?ims-ims:`, a modifiers group (valid ECMAScript since ES2025, not admitted), with the cursor on its `?`. Each of
	 * i, m and s appears at most once across both sides, and a `-` needs a flag on one of them; anything else after
	 * `(?` is an invalid group.
	 */
	#modifiers(at: number): void {
		const seen = new Set<number>()
		let dash = false
		let i = 1
		for (;;) {
			const c = this.#peek(i)
			if (c === cp(":")) {
				break
			}
			if (c === cp("-") && !dash) {
				dash = true
			} else if (c === cp("i") || c === cp("m") || c === cp("s")) {
				if (seen.has(c)) {
					throw this.#malformed(
						at,
						this.#text(at, this.#pos + i + 1),
						"a repeated flag in a modifiers group"
					)
				}
				seen.add(c)
			} else {
				throw this.#malformed(at, "(?", "invalid group")
			}
			i += 1
		}
		if (seen.size === 0) {
			throw this.#malformed(at, this.#text(at, this.#pos + i + 1), "an empty modifiers group")
		}
		this.#unsupported(
			at,
			this.#text(at, this.#pos + i + 1),
			"inline modifiers are not admitted; they are refused with the flags, which are only u and su"
		)
		this.#pos += i + 1
	}

	/** A capture group name `<name>`, with the cursor on its `<`; consumes it through the `>`. */
	#groupName(at: number): string {
		this.#pos += 1
		const name: Array<number> = []
		const invalid = (): Failure =>
			this.#malformed(at, this.#text(at, this.#pos + 1), "invalid capture group name")
		for (;;) {
			const c = this.#peek(0)
			if (c === undefined) {
				throw invalid()
			}
			if (c === cp(">")) {
				break
			}
			const escaped = c === cp("\\")
			const value = escaped ? this.#nameEscape(invalid) : c
			if (!(name.length === 0 ? isNameStart(value) : isNamePart(value))) {
				throw invalid()
			}
			if (!escaped) {
				this.#pos += 1
			}
			name.push(value)
		}
		if (name.length === 0) {
			throw invalid()
		}
		this.#pos += 1
		return codePointsText(name)
	}

	/** A `\uHHHH`, `\uHHHH\uHHHH` or `\u{H...}` escape in a group name, with the cursor on its backslash. */
	#nameEscape(invalid: () => Failure): number {
		if (!this.#is("u", 1)) {
			throw invalid()
		}
		if (this.#is("{", 2)) {
			let i = 3
			let value = 0
			for (let h = hexValue(this.#peek(i)); h !== undefined; h = hexValue(this.#peek(i))) {
				value = Math.min(value * 16 + h, 0x110000)
				i += 1
			}
			if (i === 3 || !this.#is("}", i) || value > 0x10ffff) {
				throw invalid()
			}
			this.#pos += i + 1
			return value
		}
		const lead = this.#hex4(2)
		if (lead === undefined) {
			throw invalid()
		}
		if (isLeadSurrogate(lead) && this.#is("\\", 6) && this.#is("u", 7)) {
			const trail = this.#hex4(8)
			if (trail !== undefined && isTrailSurrogate(trail)) {
				this.#pos += 12
				return 0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00)
			}
		}
		this.#pos += 6
		return lead
	}

	/**
	 * `\p{...}` or `\P{...}`, with the cursor on its backslash: a property name, a property value, or name=value, each
	 * of the shape ECMAScript reads. Whether the name is one Unicode defines needs a table this scanner does not carry
	 * (see the header); a well-shaped escape is refused as unsupported.
	 */
	#propertyEscape(at: number, name: string): void {
		const invalid = (): Failure => this.#malformed(at, `\\${name}`, "invalid property name")
		if (!this.#is("{", 2)) {
			throw invalid()
		}
		let i = 3
		let equals: number | undefined
		for (;;) {
			const c = this.#peek(i)
			if (c === undefined) {
				throw invalid()
			}
			if (c === cp("}")) {
				break
			}
			if (c === cp("=") && equals === undefined) {
				equals = i
			} else if (!isPropertyValueChar(c)) {
				throw invalid()
			}
			i += 1
		}
		if (equals === undefined) {
			if (i === 3) {
				throw invalid()
			}
		} else {
			if (equals === 3 || equals === i - 1) {
				throw invalid()
			}
			for (let j = 3; j < equals; j++) {
				if (!isPropertyNameChar(this.#peek(j))) {
					throw invalid()
				}
			}
		}
		this.#unsupported(at, `\\${name}`, "Unicode property escapes are not admitted")
		this.#pos += i + 1
	}

	#escape(): Ir.RegexNode {
		const at = this.#pos
		const next = this.#peek(1)
		if (next === undefined) {
			throw this.#malformed(at, "\\", "\\ at end of pattern")
		}
		const name = String.fromCodePoint(next)
		switch (name) {
			case "d":
			case "D":
			case "w":
			case "W": {
				this.#pos += 2
				return Ir.set(this.#shorthand(name))
			}
			case "b":
			case "B":
				this.#unsupported(at, `\\${name}`, "word-boundary assertions are not admitted")
				this.#pos += 2
				this.#assertion = true
				return Ir.empty
			case "k": {
				this.#pos += 2
				if (!this.#is("<", 0)) {
					throw this.#malformed(at, "\\k", "invalid named reference in Unicode mode")
				}
				const group = this.#groupName(at)
				this.#references.push({ at, construct: this.#text(at, this.#pos), group })
				this.#unsupported(at, "\\k", "named backreferences are not admitted")
				return Ir.empty
			}
			case "s":
			case "S":
			case "p":
			case "P":
				this.#refusedClassEscape(at, name)
				return Ir.set(refusedSet)
			default: {
				if (next >= cp("1") && next <= cp("9")) {
					this.#pos += 1
					const group = this.#decimalFrom(next).value
					this.#references.push({ at, construct: this.#text(at, this.#pos), group })
					this.#unsupported(at, this.#text(at, this.#pos), "backreferences are not admitted")
					return Ir.empty
				}
				return Ir.set(single(this.#characterEscape(at, next, false)))
			}
		}
	}

	/**
	 * \s, \S, \p{...} or \P{...}, with the cursor on its backslash: valid ECMAScript outside the fragment, recorded and
	 * consumed so the scan goes on.
	 */
	#refusedClassEscape(at: number, name: "s" | "S" | "p" | "P"): void {
		if (name === "p" || name === "P") {
			this.#propertyEscape(at, name)
			return
		}
		this.#unsupported(
			at,
			`\\${name}`,
			"the \\s and \\S shorthands are not admitted; spell an explicit class"
		)
		this.#pos += 2
	}

	#shorthand(name: "d" | "D" | "w" | "W"): CharSet {
		switch (name) {
			case "d":
				return digit
			case "D":
				return complement(digit)
			case "w":
				return word
			case "W":
				return complement(word)
		}
	}

	/**
	 * A CharacterEscape (ECMA-262 22.2.1, Unicode mode) at `at`, the backslash; consumes it and returns its code
	 * point. In a class, \b is backspace and \- is a hyphen.
	 */
	#characterEscape(at: number, next: number, inClass: boolean): number {
		const name = String.fromCodePoint(next)
		const escapeText = (): string => this.#text(at, this.#pos)
		switch (name) {
			case "t":
				this.#pos += 2
				return 0x09
			case "n":
				this.#pos += 2
				return 0x0a
			case "v":
				this.#pos += 2
				return 0x0b
			case "f":
				this.#pos += 2
				return 0x0c
			case "r":
				this.#pos += 2
				return 0x0d
			case "c": {
				const letter = this.#peek(2)
				if (letter === undefined || !isAsciiLetter(letter)) {
					throw this.#malformed(at, "\\c", "invalid control escape in Unicode mode")
				}
				this.#pos += 3
				return letter % 32
			}
			case "0": {
				if (isDecimalDigit(this.#peek(2))) {
					throw this.#malformed(
						at,
						this.#text(at, at + 3),
						"invalid decimal escape in Unicode mode"
					)
				}
				this.#pos += 2
				return this.#literal(0, at, "\\0")
			}
			case "x": {
				const h1 = hexValue(this.#peek(2))
				const h2 = hexValue(this.#peek(3))
				if (h1 === undefined || h2 === undefined) {
					throw this.#malformed(at, "\\x", "invalid hexadecimal escape in Unicode mode")
				}
				this.#pos += 4
				return this.#literal(h1 * 16 + h2, at, escapeText())
			}
			case "u":
				return this.#unicodeEscape(at)
			default: {
				if (inClass && name === "b") {
					this.#pos += 2
					return 0x08
				}
				if (inClass && name === "-") {
					this.#pos += 2
					return 0x2d
				}
				if (syntaxCharacters.includes(name) || name === "/") {
					this.#pos += 2
					return next
				}
				if (inClass && isDecimalDigit(next)) {
					throw this.#malformed(at, `\\${name}`, "invalid class escape in Unicode mode")
				}
				throw this.#malformed(at, `\\${name}`, "invalid escape in Unicode mode")
			}
		}
	}

	#hex4(offset: number): number | undefined {
		let value = 0
		for (let i = 0; i < 4; i++) {
			const h = hexValue(this.#peek(offset + i))
			if (h === undefined) {
				return undefined
			}
			value = value * 16 + h
		}
		return value
	}

	/** \uHHHH, a \uHHHH\uHHHH surrogate pair, or \u{H...}. */
	#unicodeEscape(at: number): number {
		if (this.#is("{", 2)) {
			let i = 3
			let value = 0
			let digits = 0
			for (let h = hexValue(this.#peek(i)); h !== undefined; h = hexValue(this.#peek(i))) {
				value = Math.min(value * 16 + h, 0x110000)
				digits += 1
				i += 1
			}
			if (digits === 0 || !this.#is("}", i) || value > 0x10ffff) {
				throw this.#malformed(at, "\\u{", "invalid Unicode escape")
			}
			this.#pos += i + 1
			return this.#literal(value, at, this.#text(at, this.#pos))
		}
		const lead = this.#hex4(2)
		if (lead === undefined) {
			throw this.#malformed(at, "\\u", "invalid Unicode escape")
		}
		if (isLeadSurrogate(lead) && this.#is("\\", 6) && this.#is("u", 7)) {
			const trail = this.#hex4(8)
			if (trail !== undefined && isTrailSurrogate(trail)) {
				this.#pos += 12
				return 0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00)
			}
		}
		this.#pos += 6
		return this.#literal(lead, at, this.#text(at, this.#pos))
	}

	#class(): Ir.RegexNode {
		const at = this.#pos
		this.#pos += 1
		const negated = this.#is("^", 0)
		if (negated) {
			this.#pos += 1
		}
		const parts: Array<CharSet> = []
		const ranges: Array<Interval> = []
		for (let c = this.#peek(0); c !== cp("]"); c = this.#peek(0)) {
			if (c === undefined) {
				throw this.#malformed(at, "[", "unterminated character class")
			}
			const from = this.#pos
			const first = this.#classAtom(c)
			const after = this.#peek(1)
			if (this.#is("-", 0) && after !== undefined && after !== cp("]")) {
				this.#pos += 1
				const second = this.#classAtom(after)
				if (first.kind === "set" || second.kind === "set") {
					throw this.#malformed(
						from,
						this.#text(from, this.#pos),
						"a class escape cannot bound a range in Unicode mode"
					)
				}
				if (first.cp > second.cp) {
					throw this.#malformed(from, this.#text(from, this.#pos), "range out of order in class")
				}
				ranges.push([first.cp, second.cp])
			} else if (first.kind === "set") {
				parts.push(first.set)
			} else {
				ranges.push([first.cp, first.cp])
			}
		}
		this.#pos += 1
		const members = union([charSet(ranges), ...parts])
		return Ir.set(negated ? complement(members) : members)
	}

	/** The class atom at the current position, whose code point `c` is. */
	#classAtom(c: number): ClassAtom {
		const at = this.#pos
		this.#count(at)
		if (c !== cp("\\")) {
			this.#pos += 1
			return { kind: "char", cp: this.#literal(c, at, this.#text(at, at + 1)) }
		}
		const next = this.#peek(1)
		if (next === undefined) {
			throw this.#malformed(at, "\\", "\\ at end of pattern")
		}
		const name = String.fromCodePoint(next)
		if (name === "d" || name === "D" || name === "w" || name === "W") {
			this.#pos += 2
			return { kind: "set", set: this.#shorthand(name) }
		}
		if (name === "s" || name === "S" || name === "p" || name === "P") {
			this.#refusedClassEscape(at, name)
			return { kind: "set", set: refusedSet }
		}
		if (name === "k" || name === "B") {
			throw this.#malformed(at, `\\${name}`, "invalid class escape in Unicode mode")
		}
		return { kind: "char", cp: this.#characterEscape(at, next, true) }
	}
}

/**
 * The admitted source grammar, parsed into the checked regex IR.
 *
 * The grammar is ECMAScript's `u`-mode pattern syntax (ECMA-262 22.2.1 with [+UnicodeMode], no Annex B leniency),
 * restricted to the regular fragment this table admits:
 *
 * | Construct                                   | Here                                                            |
 * | ------------------------------------------- | --------------------------------------------------------------- |
 * | literal scalars, supported literal escapes  | \t \n \v \f \r, \cX, \xHH, \uHHHH, \u{H..}, a \u surrogate pair, |
 * |                                             | `\` before a syntax character or `/`; `\b` and `\-` in a class  |
 * | concatenation, alternation, groups          | `|`, `(...)`, `(?:...)`; captures are not outputs               |
 * | classes                                     | `[...]`, `[^...]`, ranges over code points                      |
 * | \d \D \w \W                                 | ECMAScript's ASCII sets and their complements                   |
 * | dot                                         | u: every admitted scalar but LF, CR, U+2028, U+2029; su: all    |
 * | ^ $                                         | absolute start and end of the value (no `m` flag)               |
 * | ? * + {m} {m,} {m,n}                        | greedy only, bounds 0..255 (PostgreSQL's limit)                 |
 *
 * Everything else fails with its location and reason: a pattern ECMAScript itself refuses is MalformedDescription; a
 * valid ECMAScript construct outside the admitted fragment (backreferences, lookarounds, \b and \B assertions, named
 * groups, modifiers, \s \S, \p \P, lazy quantifiers, bounds above 255, NUL, lone surrogates) is UnsupportedOperation;
 * a pattern beyond the fixed size budget is ResourceBound.
 * Only the documented spellings are admitted: the table is not permission to forward unknown syntax.
 *
 * Precedence follows ECMAScript: a pattern that is a syntax error anywhere is MalformedDescription, even when a
 * construct outside the fragment comes first, so an unsupported construct is recorded and the scan goes on to the end
 * of the pattern. References are checked against the whole pattern, as ECMA-262's early errors are: a `\N` past the
 * number of capture groups or a `\k<name>` naming no group is a syntax error, while a reference to an existing group
 * is a well-formed backreference outside the fragment. Of several non-syntax refusals the first in source order is
 * reported. The construct budget bounds the scan itself: past it the first refusal found so far is reported, the
 * recorded unsupported construct if there is one, so no pattern costs more than the budget to refuse.
 *
 * Two ECMAScript checks need Unicode tables this scanner does not carry: the property names of \p{...} and the
 * ID_Start and ID_Continue sets of a non-ASCII capture group name. Their shape is checked; a well-shaped but unknown
 * property name, or a non-ASCII name character, is read as valid and refused as UnsupportedOperation with the rest of
 * those constructs.
 *
 * The parser is a plain scanner over code points. It constructs no RegExp and never evaluates the pattern.
 *
 * Parses an admitted source pattern into normalized IR, or reports why it is refused: a syntax error anywhere in the
 * pattern, else its first construct outside the fragment or over the budget. The parser throws its Failure at the first
 * refusal; anything else it throws is a defect and propagates.
 */
export const parsePattern = (
	source: string,
	flags: RegexFlags,
	limits: ParseLimits
): Result.Result<Ir.RegexNode, RegexDiagnostic> =>
	Result.mapError(
		catchSignal(Failure, () => new Parser(codePoints(source), flags, limits).parse()),
		(failure) => failure.diagnostic
	)
