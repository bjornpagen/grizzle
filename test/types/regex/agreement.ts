import { floorPopulation, type Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { floorSeed, rotatingSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { regexMaxDepth, typeUnionLimit } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import type { RegexScan } from "#compiler/types/fields/source.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"
import { upTo } from "#test/support/up-to.ts"
import { families, type Flags, jsMatcher, patternOver } from "#test/unit/text/generators.ts"

/**
 * The regex agreement: str.regex calls drawn from the regex generators and from dictionaries of the constructs the
 * grammar check branches on, printed as one TypeScript program the type-test batch checks, where a literal call
 * typechecks exactly when the engine admits its pattern.
 *
 * The engine is the oracle: a flags word other than u and su is MalformedDescription, and an admitted one's source is
 * analyzed as a field's (text/refinement.ts analyzeText), the admission a schema's compilation reaches. A literal call
 * the engine refuses is refused by the types, under a `refused` directive naming why; one it admits typechecks. The
 * declared classes are calls the types and the engine judge apart, each for the one reason it states, from what typed
 * authoring does not read: a construct outside PostgreSQL's regex fragment that ArkRegex parses (outsideFragment,
 * UnsupportedOperation), a source past the typed-authoring scan (beyondScan: MalformedDescription of a malformed one,
 * ResourceBound of one past the depth of PostgreSQL's regex compiler), and a call whose source or flags no literal types
 * (nonLiteral: the types refuse it, the engine admits the value a JavaScript caller holds there).
 *
 * Inference is asserted where it has an oracle: a finite language of literal words, each character spelled plainly or
 * by a hex escape, within the scan infers exactly the union of its members, each of which ECMAScript accepts; a source
 * of no escape past the scan infers string. That every value a pattern accepts inhabits
 * its host type is test/types/text/contained.ts's.
 */

/**
 * The typed-authoring scan's budget in source code units: a longer source widens. The budget is type-level only
 * (types/fields/source.ts RegexScan), so its value here is a constant of that type, which fails to typecheck the
 * moment the engine's budget moves.
 */
const scanBudget: RegexScan["codeUnits"] = 40

/** The characters a literal word is written in, each with its hex escape. */
const hexOf = { a: "\\x61", b: "\\x62", c: "\\x63", x: "\\x78" } as const
type WordChar = keyof typeof hexOf
const wordAlphabet: Arr.NonEmptyReadonlyArray<WordChar> = ["a", "b", "c", "x"]

/** Constructs a malformed source holds: refused by the grammar check wherever they are spliced into a pattern. */
const malformations = ["(", ")", "[", "(?", "\\", "**", "+", "{2,1}"] as const

/** The zero-width assertions: anchors, word boundaries and lookarounds, none of which a quantifier may follow. */
const assertions = ["^", "$", "\\b", "\\B", "(?=a)", "(?!a)", "(?<=a)", "(?<!a)"] as const

/** The quantifiers, greedy and lazy, counted and not. */
const quantifiers = ["*", "+", "?", "{2}", "{1,3}", "{2,}", "*?"] as const

/** Constructs outside PostgreSQL's regex fragment that ArkRegex parses: lookbehind, backreference, property, boundary, lazy. */
const outsideConstructs = ["(?<=a)b", "(a)\\1", "\\p{L}", "\\bab\\b", "a*?"] as const

/** Flags words other than u and su: none, single ECMAScript flags, repetitions and orders the engine refuses. */
const refusedFlags = ["", "g", "i", "m", "y", "d", "v", "s", "us", "uu", "U", "ug", "su "] as const

/** How a nonLiteral call states its arguments: what it declares and its argument list, `v` its prefix. */
interface NonLiteralCall {
	readonly source: string
	readonly flags: Flags
	readonly why: string
	readonly declarations: (v: string) => ReadonlyArray<string>
	readonly args: (v: string) => string
}

const nonLiteralCalls: Arr.NonEmptyReadonlyArray<NonLiteralCall> = [
	{
		source: "^a$",
		flags: "u",
		why: "a source typed string is no literal",
		declarations: (v) => [`declare const ${v}s: string`],
		args: (v) => `${v}s`
	},
	{
		source: "^a$",
		flags: "u",
		why: "a template with a string hole is no literal",
		declarations: (v) => [`declare const ${v}s: string`],
		args: (v) => `\`^\${${v}s}$\``
	},
	{
		source: "^a$",
		flags: "u",
		why: "a union of sources is no single literal",
		declarations: (v) => [`declare const ${v}s: "^a$" | "^b$"`],
		args: (v) => `${v}s`
	},
	{
		source: "^a.c$",
		flags: "su",
		why: 'flags typed "u" | "su" are no literal',
		declarations: (v) => [`declare const ${v}f: "u" | "su"`],
		args: (v) => `"^a.c$", ${v}f`
	}
]

/** What a case draws: a generated pattern, a finite language, or a pattern with one construct planted. */
const regexForms = [
	"generated",
	"finite",
	"long",
	"malformed",
	"longMalformed",
	"reversedBounds",
	"boundAbove",
	"countedBounds",
	"quantifiedAssertion",
	"outside",
	"nul",
	"overDepth",
	"flags",
	"nonLiteral",
	"crossProduct"
] as const
type RegexForm = (typeof regexForms)[number]

/** The engine's verdict on a call: admitted, or the tag of its refusal. */
const refusalTags = [
	"MalformedDescription",
	"UnsupportedOperation",
	"ResourceBound"
] as const satisfies ReadonlyArray<CompileReasonTag>
const admissions = ["admitted", ...refusalTags] as const
type Admission = (typeof admissions)[number]

/** The declared classes: calls the types and the engine judge apart, each for the reason the header states. */
const declaredClasses = ["outsideFragment", "beyondScan", "nonLiteral"] as const
type DeclaredClass = (typeof declaredClasses)[number]

/** What the program asserts of a call's host type: its exact union, string, or nothing. */
type HostClaim =
	| { readonly kind: "exact"; readonly members: Arr.NonEmptyReadonlyArray<string> }
	| { readonly kind: "member"; readonly member: string; readonly outside: string }
	| { readonly kind: "string" }
	| { readonly kind: "none" }

/** The host claims a case asserts. */
const hostClaims = ["exact", "member", "string"] as const

/** The members a host type written out exactly in the program may have; more are asserted by one member and one outside. */
const writtenMembers = 64

/** The characters a cross product's class is drawn from, none of them `z`, which no member holds. */
const classAlphabet = ["a", "b", "c", "d", "e", "f", "g", "h"] as const

/**
 * The members of a class of k characters repeated from m to n times, each length's strings distinct from every
 * other's: the sum of k^j, saturated at TypeScript's union limit, past which it is the limit.
 */
const repeatedMembers = (k: number, m: number, n: number): number =>
	Arr.reduce(
		upTo(n - m + 1, (i) => m + i),
		0,
		(sum, j) =>
			Math.min(
				typeUnionLimit.value,
				sum +
					Arr.reduce(
						upTo(j, (i) => i + 1),
						1,
						(p) => Math.min(typeUnionLimit.value, p * k)
					)
			)
	)

/** Every string of `length` characters over `chars`. */
const stringsOfLength = (chars: ReadonlyArray<string>, length: number): ReadonlyArray<string> =>
	Arr.reduce(
		upTo(length, (i) => i + 1),
		[""],
		(acc: ReadonlyArray<string>) =>
			Arr.flatMap(acc, (prefix) => Arr.map(chars, (c) => `${prefix}${c}`))
	)

/** Where a cross product's count is drawn: written out, below the limit, near it, or at it and past. */
const crossBands = ["small", "mid", "near", "over"] as const

/** What a case reaches: its form, the engine's verdict, a declared class, a host claim, a refusal, and su flags. */
type RegexNote =
	| RegexForm
	| (typeof crossBands)[number]
	| Admission
	| DeclaredClass
	| (typeof hostClaims)[number]
	| "refused"
	| "su"

/** What the program states of a call: that it typechecks, or a refusal under a directive naming why. */
type Stated = { readonly kind: "typechecks" } | { readonly kind: "refused"; readonly why: string }

/** One case: its call as the program writes it, the engine's verdict, what the program states and claims. */
interface RegexCase {
	readonly form: RegexForm
	/** A cross product's band, its count against the union limit. */
	readonly band: (typeof crossBands)[number] | undefined
	readonly declarations: (v: string) => ReadonlyArray<string>
	readonly args: (v: string) => string
	readonly flags: string
	readonly admission: Admission
	readonly stated: Stated
	readonly declared: DeclaredClass | undefined
	readonly host: HostClaim
}

const isAdmittedFlags = (flags: string): flags is Flags => flags === "u" || flags === "su"

/**
 * A string as a TypeScript literal on one line: JSON's spelling, with the two line terminators JSON leaves bare,
 * U+2028 and U+2029, escaped, so a directive stays on the line above its call.
 */
export const literal = (text: string): string =>
	Str.replaceAll("\u2029", "\\u2029")(Str.replaceAll("\u2028", "\\u2028")(jsonText(text)))

/** The engine's verdict: a flags word other than u and su is malformed, an admitted one's source analyzed. */
const admissionOf = (source: string, flags: string): Admission => {
	if (!isAdmittedFlags(flags)) {
		return "MalformedDescription"
	}
	const analyzed = analyzeText([{ source, flags }], SourceLoc("regex agreement", []))
	if (analyzed.ok) {
		return "admitted"
	}
	const tag = analyzed.error.reason._tag
	return Option.getOrThrowWith(
		Arr.findFirst(admissions, (a) => a === tag),
		() => new Error(`the engine refuses /${source}/${flags} for ${tag}, no reason a pattern draws`)
	)
}

/**
 * What the program states of a literal call the engine judged: it typechecks where the engine admits it, or where
 * typed authoring does not read what the engine refuses (a declared class); else the types refuse it.
 */
const judgedOf = (
	form: RegexForm,
	source: string,
	flags: string,
	admission: Admission
): readonly [Stated, DeclaredClass | undefined] => {
	switch (admission) {
		case "admitted":
			return [{ kind: "typechecks" }, undefined]
		case "MalformedDescription":
			return !isAdmittedFlags(flags)
				? [{ kind: "refused", why: "the flags are u or su" }, undefined]
				: source.length > scanBudget
					? [{ kind: "typechecks" }, "beyondScan"]
					: [{ kind: "refused", why: "ArkRegex refuses a malformed source" }, undefined]
		case "UnsupportedOperation":
			return form === "nul"
				? [{ kind: "refused", why: "\\0 is NUL, which no text holds" }, undefined]
				: form === "boundAbove"
					? [{ kind: "refused", why: "a repetition bound above PostgreSQL's" }, undefined]
					: [{ kind: "typechecks" }, "outsideFragment"]
		case "ResourceBound":
			return [{ kind: "typechecks" }, "beyondScan"]
	}
}

/**
 * A literal call over a source and flags: its engine verdict, what the program states of it, and its host claim: a
 * source of no escape past the scan that typechecks infers string, an admitted finite language within it exactly its
 * members. The scan reads an escape as one step, so a source with escapes longer than the budget may still be read.
 */
const literalCase = (
	form: RegexForm,
	source: string,
	flags: string,
	members: Arr.NonEmptyReadonlyArray<string> | undefined
): RegexCase => {
	const admission = admissionOf(source, flags)
	const [stated, declared] = judgedOf(form, source, flags, admission)
	const host: HostClaim =
		stated.kind === "refused"
			? { kind: "none" }
			: source.length > scanBudget
				? Str.includes("\\")(source)
					? { kind: "none" }
					: { kind: "string" }
				: members !== undefined && admission === "admitted"
					? { kind: "exact", members }
					: { kind: "none" }
	return {
		form,
		band: undefined,
		declarations: () => [],
		args: () => `${literal(source)}, ${literal(flags)}`,
		flags,
		admission,
		stated,
		declared,
		host
	}
}

/** A literal word: `length` characters of the word alphabet. */
const wordGen =
	(length: Gen<number>): Gen<ReadonlyArray<WordChar>> =>
	(source) =>
		Arr.map(
			upTo(source.draw(length), (i) => i + 1),
			() => source.draw(element(wordAlphabet))
		)

/**
 * A finite language of `count` literal words of `length` characters, spelled anchored as one alternation, each
 * character plainly or, where `escapes`, by its hex escape as drawn, with its members: ECMAScript accepts each, a
 * defect of the generator otherwise.
 */
const finiteGen =
	(
		count: Gen<number>,
		length: Gen<number>,
		flags: Flags,
		escapes: boolean
	): Gen<readonly [string, Arr.NonEmptyReadonlyArray<string>]> =>
	(source) => {
		const words = Arr.dedupeWith(
			upTo(source.draw(count), () => source.draw(wordGen(length))),
			(a, b) => Arr.join(a, "") === Arr.join(b, "")
		)
		const members = Arr.map(words, (w) => Arr.join(w, ""))
		if (!Arr.isReadonlyArrayNonEmpty(members)) {
			throw new Error("a finite language holds at least one word")
		}
		const spell = (ch: WordChar): string => (escapes ? source.draw(element([ch, hexOf[ch]])) : ch)
		const pattern = `^(?:${Arr.join(
			Arr.map(words, (w) => Arr.join(Arr.map(w, spell), "")),
			"|"
		)})$`
		const ofPattern = jsMatcher(pattern, flags)
		for (const member of members) {
			if (!ofPattern(member)) {
				throw new Error(
					`ECMAScript refuses ${member} of /${pattern}/${flags}, a defect of the generator`
				)
			}
		}
		return [pattern, members]
	}

/** A short literal alternation a malformation is spliced into: within the scan, whatever is spliced. */
const wordsPattern =
	(flags: Flags): Gen<string> =>
	(source) =>
		source.draw(finiteGen(int(1, 2), int(1, 3), flags, false))[0]

/** `construct` spliced into `pattern` at a drawn position. */
const splice =
	(pattern: string, construct: string): Gen<string> =>
	(source) => {
		const at = source.draw(int(0, pattern.length))
		return `${Str.slice(0, at)(pattern)}${construct}${Str.slice(at)(pattern)}`
	}

/** A literal run past the scan's budget, a malformation after it, which the scan never reaches. */
const pastScan: Gen<string> = (source) =>
	`^${Str.repeat(scanBudget + source.draw(int(1, 20)))(source.draw(element(wordAlphabet)))}${source.draw(element(malformations))}`

/** A construct outside PostgreSQL's fragment, alone or beside a literal word. */
const outsidePattern: Gen<string> = (source) => {
	const construct = source.draw(element(outsideConstructs))
	const word = Arr.join(source.draw(wordGen(int(1, 3))), "")
	return source.draw(element([construct, `^${word}${construct}$`, `${construct}${word}`]))
}

const caseGen: Gen<RegexCase> = (source) => {
	const form = source.draw(element(regexForms))
	const flags: Flags = source.draw(element(["u", "su"] as const))
	switch (form) {
		case "generated":
			return literalCase(
				form,
				source.draw(patternOver(source.draw(element(families)).alphabet)),
				flags,
				undefined
			)
		case "finite": {
			const [pattern, members] = source.draw(finiteGen(int(1, 4), int(1, 3), flags, true))
			return literalCase(form, pattern, flags, members)
		}
		case "long": {
			const [pattern, members] = source.draw(finiteGen(int(8, 12), int(4, 4), flags, false))
			return literalCase(form, pattern, flags, members)
		}
		case "malformed":
			return literalCase(
				form,
				source.draw(splice(source.draw(wordsPattern(flags)), source.draw(element(malformations)))),
				flags,
				undefined
			)
		case "longMalformed":
			return literalCase(form, source.draw(pastScan), flags, undefined)
		case "reversedBounds": {
			const lo = source.draw(int(1, 300))
			const hi = source.draw(int(0, lo - 1))
			const word = Arr.join(source.draw(wordGen(int(1, 3))), "")
			return literalCase(form, `^(?:${word}){${lo},${hi}}$`, flags, undefined)
		}
		case "boundAbove": {
			const above = source.draw(int(256, 2000))
			const bounds = source.draw(
				element([`${above}`, `${above},`, `0,${above}`, `${source.draw(int(0, 255))},${above}`])
			)
			const word = Arr.join(source.draw(wordGen(int(1, 2))), "")
			return literalCase(form, `^(?:${word}){${bounds}}$`, flags, undefined)
		}
		case "countedBounds": {
			const lo = source.draw(int(0, 4))
			const hi = lo + source.draw(int(0, 3))
			const zeros = Str.repeat(source.draw(int(0, 2)))("0")
			const word = Arr.join(source.draw(wordGen(int(1, 2))), "")
			const counted = source.draw(element([`{${zeros}${lo}}`, `{${zeros}${lo},${zeros}${hi}}`]))
			const pattern = `^(?:${word})${counted}$`
			const members = Arr.map(
				upTo((Str.includes(",")(counted) ? hi : lo) - lo + 1, (i) => lo + i),
				(n) => Str.repeat(n)(word)
			)
			const ofPattern = jsMatcher(pattern, flags)
			for (const member of members) {
				if (!ofPattern(member)) {
					throw new Error(
						`ECMAScript refuses ${member} of /${pattern}/${flags}, a defect of the generator`
					)
				}
			}
			return literalCase(
				form,
				pattern,
				flags,
				Arr.isReadonlyArrayNonEmpty(members) ? members : undefined
			)
		}
		case "quantifiedAssertion": {
			const quantified = `${source.draw(element(assertions))}${source.draw(element(quantifiers))}`
			const word = Arr.join(source.draw(wordGen(int(1, 3))), "")
			return literalCase(
				form,
				source.draw(element([`${quantified}${word}`, `${word}${quantified}`])),
				flags,
				undefined
			)
		}
		case "outside":
			return literalCase(form, source.draw(outsidePattern), flags, undefined)
		case "nul":
			return literalCase(form, `^a\\0${source.draw(element(wordAlphabet))}$`, flags, undefined)
		case "overDepth": {
			const pair = source.draw(element(["ab", "xc"] as const))
			const repeats = regexMaxDepth.value / 2 + 1 + source.draw(int(0, 3))
			return literalCase(form, `^${Str.repeat(repeats)(pair)}$`, flags, undefined)
		}
		case "flags":
			return literalCase(
				form,
				`^${Arr.join(source.draw(wordGen(int(1, 3))), "")}$`,
				source.draw(element(refusedFlags)),
				undefined
			)
		case "crossProduct": {
			const band = source.draw(element(crossBands))
			const k = source.draw(int(2, classAlphabet.length))
			const chars = Arr.take(classAlphabet, k)
			const lengthFor = (target: number): number =>
				Arr.reduce(Arr.range(1, 40), 1, (m, j) => (repeatedMembers(k, j, j) <= target ? j : m))
			const m =
				band === "small"
					? source.draw(int(1, lengthFor(writtenMembers / 2)))
					: band === "mid"
						? source.draw(int(lengthFor(writtenMembers) + 1, lengthFor(5000)))
						: band === "near"
							? lengthFor(typeUnionLimit.value / 2) + 1
							: lengthFor(typeUnionLimit.value) + source.draw(int(1, 3))
			const n = band === "small" || band === "near" ? m : m + source.draw(int(0, 2))
			const count = repeatedMembers(k, m, n)
			const pattern = `^[${Arr.join(chars, "")}]{${m}${n === m ? "" : `,${n}`}}$`
			const written = (): ReadonlyArray<string> =>
				Arr.flatMap(
					upTo(n - m + 1, (i) => m + i),
					(j) => stringsOfLength(chars, j)
				)
			const host: HostClaim =
				count >= typeUnionLimit.value
					? { kind: "string" }
					: count > writtenMembers
						? {
								kind: "member",
								member: Str.repeat(m)(Arr.headNonEmpty(classAlphabet)),
								outside: Str.repeat(m)("z")
							}
						: Arr.match(written(), {
								onEmpty: (): HostClaim => ({ kind: "none" }),
								onNonEmpty: (members): HostClaim => ({ kind: "exact", members })
							})
			const admission = admissionOf(pattern, flags)
			if (admission !== "admitted") {
				throw new Error(`the engine refuses /${pattern}/${flags}, a defect of the generator`)
			}
			return {
				form,
				band,
				declarations: () => [],
				args: () => `${literal(pattern)}, ${literal(flags)}`,
				flags,
				admission,
				stated: { kind: "typechecks" },
				declared: undefined,
				host
			}
		}
		case "nonLiteral": {
			const call = source.draw(element(nonLiteralCalls))
			const admission = admissionOf(call.source, call.flags)
			if (admission !== "admitted") {
				throw new Error(
					"the engine refuses the value a nonLiteral call holds, a defect of the generator"
				)
			}
			return {
				form,
				band: undefined,
				declarations: call.declarations,
				args: call.args,
				flags: call.flags,
				admission,
				stated: { kind: "refused", why: call.why },
				declared: "nonLiteral",
				host: { kind: "none" }
			}
		}
	}
}

/** What the program asserts of a call's host type. */
const hostLines = (
	claim: HostClaim,
	v: string,
	host: (expected: string) => string
): ReadonlyArray<string> => {
	const inhabits = (name: string, value: string, expected: boolean) =>
		`export type ${v}${name} = Expect<Equals<${literal(value)} extends Infer<typeof ${v}regex> ? true : false, ${expected}>>`
	switch (claim.kind) {
		case "exact":
			return [host(Arr.join(Arr.map(claim.members, literal), " | "))]
		case "member":
			return [inhabits("member", claim.member, true), inhabits("outside", claim.outside, false)]
		case "string":
			return [host("string")]
		case "none":
			return []
	}
}

/** A case's lines in the program, its names under the prefix `v`. */
const linesOf = (c: RegexCase, v: string): ReadonlyArray<string> => {
	const host = (expected: string) =>
		`export type ${v}host = Expect<Equals<Infer<typeof ${v}regex>, ${expected}>>`
	return [
		...c.declarations(v),
		...(c.stated.kind === "refused" ? [`// @ts-expect-error -- refused: ${c.stated.why}`] : []),
		`export const ${v}regex = str.regex(${c.args(v)})`,
		...hostLines(c.host, v, host)
	]
}

/** What a case reaches. */
const notesOf = (c: RegexCase): ReadonlyArray<Reached<RegexNote>> => [
	c.form,
	c.admission,
	...(c.declared === undefined ? [] : [c.declared]),
	...(c.stated.kind === "refused" ? ["refused" as const] : []),
	...(c.host.kind === "none" ? [] : [c.host.kind]),
	...(c.band === undefined ? [] : [c.band]),
	...(c.flags === "su" ? ["su" as const] : [])
]

/** The cases the run's own stream draws, and the floor's. */
const regexCount = 120

/** The label both populations are drawn under. */
const regexLabel = "types/regex agreement"

/** The floor's witnesses: drawn under the label alone, the same on every run. */
export const regexWitnesses = () => floorPopulation(regexLabel, caseGen, regexCount, notesOf)

/** What the floor's witnesses must reach: every form, every verdict, every declared class and host claim, su. */
export const regexRequired: Arr.NonEmptyReadonlyArray<RegexNote> = [
	...regexForms,
	...crossBands,
	...admissions,
	...declaredClasses,
	...hostClaims,
	"refused",
	"su"
]

/** The regex program's prelude (test/support/programs/regex.ts), every repository name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/regex.ts"))

/** The program's prelude as its directory reaches it, `entry` spelling a repository path from there. */
export const regexEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** n's prime factors, smallest first. */
const primeFactors = (n: number, from: number): ReadonlyArray<number> =>
	n === 1
		? []
		: n % from === 0
			? [from, ...primeFactors(n / from, from)]
			: from * from > n
				? [n]
				: primeFactors(n, from + 1)

/** n as factors of at most `cap` each, its prime factors grouped greedily. */
const factorsOf = (n: number, cap: number): ReadonlyArray<number> =>
	Arr.reduce(primeFactors(n, 2), Arr.empty<number>(), (groups, p) => {
		const last = Arr.last(groups)
		return Option.isSome(last) && last.value * p <= cap
			? [...Arr.dropRight(groups, 1), last.value * p]
			: [...groups, p]
	})

/** A template literal type of exactly `members` members, one union of distinct literals per factor. */
const templateOf = (name: string, members: number): ReadonlyArray<string> => {
	const factors = factorsOf(members, 400)
	return [
		...Arr.map(
			factors,
			(f, i) =>
				`type ${name}${i} = ${Arr.join(
					upTo(f, (j) => literal(`${name}${i}_${j}`)),
					" | "
				)}`
		),
		`export type ${name} = \`${Arr.join(
			Arr.map(factors, (_f, i) => `\${${name}${i}}`),
			""
		)}\``
	]
}

/**
 * TypeScript's union limit re-verified: a template of one member fewer than typeUnionLimit typechecks, and one of
 * exactly that many is TS2590, so the inference's threshold is the checker's on every run.
 */
const unionLimitLines = (): ReadonlyArray<string> => {
	const at = templateOf("AtLimit", typeUnionLimit.value)
	return [
		...templateOf("UnderLimit", typeUnionLimit.value - 1),
		...Arr.dropRight(at, 1),
		"// @ts-expect-error -- TS2590: a union of the limit's members is more than TypeScript represents",
		...Arr.takeRight(at, 1)
	]
}

/** The program: the floor's witnesses, then the run's own cases under its seed. */
export const regexModules = (
	entries: PreludeAt,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = [
		...regexWitnesses().values,
		...sample(caseGen, rotatingSeed(seed, floorSeed(regexLabel)), regexCount)
	]
	return [
		{
			file: "index.ts",
			source: preludeProgram(
				"// Generated by test/types/regex/agreement.ts: the regex agreement program.",
				entries,
				Arr.join(
					[
						"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
						"type Expect<T extends true> = T",
						"",
						...unionLimitLines(),
						"",
						...Arr.flatMap(cases, (c, i) => linesOf(c, `c${i}_`)),
						""
					],
					"\n"
				)
			)
		}
	]
}
