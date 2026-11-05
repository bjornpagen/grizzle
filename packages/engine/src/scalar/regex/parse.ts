import { catchSignal } from "#compiler/core/canonical.ts"
import { regexMaxRepeat } from "#compiler/core/policy.ts"
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
	/** Why, as the CompileError it becomes (text/refinement.ts): a malformed pattern, or a construct outside the fragment. */
	readonly reason: "MalformedDescription" | "UnsupportedOperation"
	/** The code-point offset of the construct in the source. */
	readonly offset: number
	/** The construct as written, for example "(?=" or "\\s". */
	readonly construct: string
	readonly message: string
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

/** What an open group's body becomes once the group closes: an atom, or, for a lookaround, an assertion. */
type Closes = "node" | "assertion"

/**
 * What the scan reads at an atom's position: a node a quantifier may follow; an assertion, which none may follow in
 * Unicode mode (ECMA-262 Term[U]) and whose placeholder is the empty string; or a group's opening, whose body the scan
 * reads next.
 */
type Atom =
	| { readonly kind: "node"; readonly node: Ir.RegexNode }
	| { readonly kind: "assertion" }
	| { readonly kind: "group"; readonly at: number; readonly closes: Closes }

/**
 * A disjunction the scan is reading: the whole pattern's, or the body of an open group, which closes into a term of the
 * disjunction around it (`outer`). The open groups are a chain of these from the innermost out, the scan's explicit
 * stack, so a pattern nested to any depth is read in one loop: its depth costs heap, never the call stack, and needs no
 * bound.
 */
interface Disjunction {
	readonly of:
		| { readonly kind: "pattern" }
		| {
				readonly kind: "group"
				/** The code-point offset of the group's `(`. */
				readonly at: number
				readonly closes: Closes
				readonly outer: Disjunction
		  }
	/** The disjunction's number, in the order the scan opens them, by which an arm path names it. */
	readonly id: number
	/** The alternatives read whole, each the sequence of its terms. */
	readonly arms: Array<Ir.RegexNode>
	/** The terms of the alternative being read. */
	terms: Array<Ir.RegexNode>
}

/** Where the scan stands in `open`: for each disjunction from the outermost in, its id and the arm being read. */
const armPath = (open: Disjunction): ArmPath => {
	const path: Array<readonly [number, number]> = []
	for (
		let d: Disjunction | undefined = open;
		d !== undefined;
		d = d.of.kind === "group" ? d.of.outer : undefined
	) {
		path.push([d.id, d.arms.length])
	}
	return path.toReversed()
}

class Parser {
	readonly #cps: ReadonlyArray<number>
	/** What dot matches: under the s and u flags, every code point. */
	readonly #dot: CharSet
	#pos = 0
	/** The first construct outside the fragment, reported once the whole pattern is known to be valid ECMAScript. */
	#deferred: Failure | undefined
	#captures = 0
	readonly #named: Array<{ readonly name: string; readonly path: ArmPath }> = []
	readonly #references: Array<Reference> = []
	#disjunctions = 0
	/** The builder of the pattern's IR, whose analyses of its nodes last the parse. */
	readonly #ir = new Ir.RegexBuilder()

	constructor(cps: ReadonlyArray<number>, flags: RegexFlags) {
		this.#cps = cps
		this.#dot = flags === "su" ? domain : dotU
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
	 * The pattern, read in one loop over its code points: `|` ends an alternative, a group's opening opens a disjunction
	 * on the chain of open ones and `)` closes it into a term of the one around it, and anything else is a term of the
	 * alternative being read.
	 */
	parse(): Ir.RegexNode {
		let open = this.#open({ kind: "pattern" })
		for (let c = this.#peek(0); c !== undefined; c = this.#peek(0)) {
			if (c === cp("|")) {
				this.#pos += 1
				open.arms.push(Ir.seq(open.terms))
				open.terms = []
			} else if (c === cp(")")) {
				const group = open.of
				if (group.kind === "pattern") {
					throw this.#malformed(this.#pos, ")", "unmatched ')'")
				}
				this.#pos += 1
				const body = this.#closed(open)
				open = group.outer
				open.terms.push(
					this.#term(group.closes === "node" ? { kind: "node", node: body } : { kind: "assertion" })
				)
			} else if (c === cp("^") || c === cp("$")) {
				open.terms.push(this.#anchor(c))
			} else {
				const atom = this.#atom(c, open)
				if (atom.kind === "group") {
					open = this.#open({ kind: "group", at: atom.at, closes: atom.closes, outer: open })
				} else {
					open.terms.push(this.#term(atom))
				}
			}
		}
		if (open.of.kind === "group") {
			throw this.#malformed(open.of.at, "(", "unterminated group")
		}
		const node = this.#closed(open)
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

	/** A disjunction opened at the cursor, numbered in the order the scan opens them. */
	#open(of: Disjunction["of"]): Disjunction {
		this.#disjunctions += 1
		return { of, id: this.#disjunctions, arms: [], terms: [] }
	}

	/** The alternation of a disjunction's arms, the alternative being read the last of them. */
	#closed(d: Disjunction): Ir.RegexNode {
		return this.#ir.alt([...d.arms, Ir.seq(d.terms)])
	}

	/** `^` or `$` at the cursor: an assertion, which is not quantifiable in Unicode mode. */
	#anchor(c: number): Ir.RegexNode {
		this.#pos += 1
		if (this.#quantifierAhead()) {
			throw this.#malformed(this.#pos, this.#text(this.#pos, this.#pos + 1), "nothing to repeat")
		}
		return c === cp("^") ? Ir.start : Ir.end
	}

	/** The term an atom makes: a node with the quantifier that follows it, or an assertion, which none may follow. */
	#term(atom: Exclude<Atom, { readonly kind: "group" }>): Ir.RegexNode {
		switch (atom.kind) {
			case "assertion":
				if (this.#quantifierAhead()) {
					throw this.#malformed(
						this.#pos,
						this.#text(this.#pos, this.#pos + 1),
						"nothing to repeat: an assertion is not quantifiable in Unicode mode"
					)
				}
				return Ir.empty
			case "node":
				return this.#quantified(atom.node)
		}
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
		if (min.value > regexMaxRepeat || (max !== "unbounded" && max > regexMaxRepeat)) {
			this.#unsupported(
				at,
				construct,
				`a repetition bound above ${regexMaxRepeat}, PostgreSQL's limit; bound the length with Compute.charLength in a contract predicate`
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

	/** The atom at the current position, whose code point `c` is, in the disjunction `open`. */
	#atom(c: number, open: Disjunction): Atom {
		const at = this.#pos
		switch (c) {
			case cp("."):
				this.#pos += 1
				return { kind: "node", node: Ir.set(this.#dot) }
			case cp("("):
				return this.#group(open)
			case cp("["):
				return { kind: "node", node: this.#class() }
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
				return { kind: "node", node: Ir.set(single(this.#literal(c, at, this.#text(at, at + 1)))) }
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

	/**
	 * A group's opening at the cursor, in the disjunction `open`, consumed through its `(`, `(?:`, lookaround, name or
	 * modifiers: the scan reads its body next, as a disjunction of its own.
	 */
	#group(open: Disjunction): Extract<Atom, { readonly kind: "group" }> {
		const at = this.#pos
		this.#pos += 1
		if (!this.#is("?", 0)) {
			this.#captures += 1
			return { kind: "group", at, closes: "node" }
		}
		if (this.#is(":", 1)) {
			this.#pos += 2
			return { kind: "group", at, closes: "node" }
		}
		if (this.#is("=", 1) || this.#is("!", 1)) {
			this.#unsupported(at, this.#text(at, at + 3), "lookahead assertions are not admitted")
			this.#pos += 2
			return { kind: "group", at, closes: "assertion" }
		}
		if (this.#is("<", 1) && (this.#is("=", 2) || this.#is("!", 2))) {
			this.#unsupported(at, this.#text(at, at + 4), "lookbehind assertions are not admitted")
			this.#pos += 3
			return { kind: "group", at, closes: "assertion" }
		}
		if (this.#is("<", 1)) {
			this.#unsupported(
				at,
				"(?<",
				"named capture groups are not admitted; use (?:...), captures are not outputs"
			)
			this.#pos += 1
			const name = this.#groupName(at)
			const path = armPath(open)
			if (this.#named.some((g) => g.name === name && mightBothParticipate(g.path, path))) {
				throw this.#malformed(at, this.#text(at, this.#pos), `duplicate capture group name ${name}`)
			}
			this.#named.push({ name, path })
			this.#captures += 1
			return { kind: "group", at, closes: "node" }
		}
		this.#modifiers(at)
		return { kind: "group", at, closes: "node" }
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

	/** An escape at the cursor outside a class: a set, a character, an assertion (\b, \B) or a reference. */
	#escape(): Atom {
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
				return { kind: "node", node: Ir.set(this.#shorthand(name)) }
			}
			case "b":
			case "B":
				this.#unsupported(at, `\\${name}`, "word-boundary assertions are not admitted")
				this.#pos += 2
				return { kind: "assertion" }
			case "k": {
				this.#pos += 2
				if (!this.#is("<", 0)) {
					throw this.#malformed(at, "\\k", "invalid named reference in Unicode mode")
				}
				const group = this.#groupName(at)
				this.#references.push({ at, construct: this.#text(at, this.#pos), group })
				this.#unsupported(at, "\\k", "named backreferences are not admitted")
				return { kind: "node", node: Ir.empty }
			}
			case "s":
			case "S":
			case "p":
			case "P":
				this.#refusedClassEscape(at, name)
				return { kind: "node", node: Ir.set(refusedSet) }
			default: {
				if (next >= cp("1") && next <= cp("9")) {
					this.#pos += 1
					const group = this.#decimalFrom(next).value
					this.#references.push({ at, construct: this.#text(at, this.#pos), group })
					this.#unsupported(at, this.#text(at, this.#pos), "backreferences are not admitted")
					return { kind: "node", node: Ir.empty }
				}
				return { kind: "node", node: Ir.set(single(this.#characterEscape(at, next, false))) }
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
 * groups, modifiers, \s \S, \p \P, lazy quantifiers, bounds above 255, NUL, lone surrogates) is UnsupportedOperation.
 * Only the documented spellings are admitted: the table is not permission to forward unknown syntax. The grammar sets
 * no bound on a pattern's length or nesting, and neither does PostgreSQL's (its regex documentation: "No particular
 * limit is imposed on the length of REs in this implementation"); what PostgreSQL bounds is the automaton the pattern
 * compiles to, which text/refinement.ts measures once the pattern is parsed.
 *
 * Precedence follows ECMAScript: a pattern that is a syntax error anywhere is MalformedDescription, even when a
 * construct outside the fragment comes first, so an unsupported construct is recorded and the scan goes on to the end
 * of the pattern. References are checked against the whole pattern, as ECMA-262's early errors are: a `\N` past the
 * number of capture groups or a `\k<name>` naming no group is a syntax error, while a reference to an existing group
 * is a well-formed backreference outside the fragment. Of several non-syntax refusals the first in source order is
 * reported.
 *
 * Two ECMAScript checks need Unicode tables this scanner does not carry: the property names of \p{...} and the
 * ID_Start and ID_Continue sets of a non-ASCII capture group name. Their shape is checked; a well-shaped but unknown
 * property name, or a non-ASCII name character, is read as valid and refused as UnsupportedOperation with the rest of
 * those constructs.
 *
 * The parser is a plain scanner over code points, one loop whose open groups are a chain of Disjunction frames on the
 * heap, so a group nested to any depth costs no call stack. It constructs no RegExp and never evaluates the pattern.
 *
 * Parses an admitted source pattern into normalized IR, or reports why it is refused: a syntax error anywhere in the
 * pattern, else its first construct outside the fragment. The parser throws its Failure at the first
 * refusal; anything else it throws is a defect and propagates.
 */
export const parsePattern = (
	source: string,
	flags: RegexFlags
): Result.Result<Ir.RegexNode, RegexDiagnostic> =>
	Result.mapError(
		catchSignal(Failure, () => new Parser(codePoints(source), flags).parse()),
		(failure) => failure.diagnostic
	)
