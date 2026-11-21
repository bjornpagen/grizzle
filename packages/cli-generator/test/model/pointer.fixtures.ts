/**
 * What the properties of pointer.test.ts read: JSON trees, pointers and fragments drawn into them or off them, and a
 * reference RFC 6901 evaluator written from the RFC (sections 3 to 7), apart from the module's own.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	type Aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	type Space,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Option, Record, Result, String as Str } from "effect"
import { defsKeyOf } from "#model/defs-ref.ts"
import { isSpecificationExtension } from "#model/extension.ts"
import {
	evaluateFragment,
	evaluateFragmentResult,
	evaluatePointer,
	evaluatePointerResult,
	evaluateTokens,
	evaluateTokensResult,
	formatPointer,
	isJsonPointer,
	isPointerWithin,
	PointerIndexOutOfRange,
	PointerMemberNotFound,
	PointerNotContainer,
	parseFragment,
	parseFragmentResult,
	parsePointer,
	parsePointerResult,
	type PointerEvalError,
	PointerSyntaxError,
	unescapeToken,
	unescapeTokenResult
} from "#model/pointer.ts"

/** Member names: empty, blank, RFC 6901's own section 5 names, prototype names, index-like and non-ASCII names. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"foo",
	"",
	" ",
	"a/b",
	"m~n",
	"~1",
	"c%d",
	"e^f",
	"g|h",
	"i\\j",
	'k"l',
	"0",
	"01",
	"-",
	"x-ext",
	"X-a",
	"é",
	"__proto__",
	"constructor"
]

const leafGen: Gen<Json> = oneOf<Json>([
	constant(null),
	boolean,
	int(-5, 5),
	element(["bar", "baz", ""])
])

const treeGen = (depth: number): Gen<Json> =>
	depth === 0
		? leafGen
		: oneOf<Json>([
				leafGen,
				(s) => s.draw(array(treeGen(depth - 1), { min: 0, max: 3 })),
				(s) =>
					Record.fromEntries(
						Arr.map(
							s.draw(uniqueKeys(element(KEYS), { min: 0, max: 4 })),
							(key) => [key, s.draw(treeGen(depth - 1))] as const
						)
					)
			])

/** A step off the tree's members: a name it lacks, a non-canonical index, `-`, an index past the end, a prototype name. */
const strayToken = element([
	"nope",
	"01",
	"-",
	"x",
	"9",
	"constructor",
	"__proto__",
	"toString",
	"1e0",
	" 0"
])

/** A token path into `tree`, each step an existing member while `stays` draws true, else a stray one, then maybe more. */
const pathInto =
	(tree: Json): Gen<ReadonlyArray<string>> =>
	(s) => {
		const tokens: Array<string> = []
		let current: Option.Option<Json> = Option.some(tree)
		let steps = s.draw(int(0, 4))
		while (steps > 0) {
			steps -= 1
			const members: ReadonlyArray<string> = Option.match(current, {
				onNone: () => [],
				onSome: (node) =>
					isItems(node)
						? Arr.map(node, (_item, index) => `${index}`)
						: isMembers(node)
							? Record.keys(node)
							: []
			})
			const token =
				Arr.isReadonlyArrayNonEmpty(members) && s.draw(int(0, 4)) > 0
					? s.draw(element(members))
					: s.draw(strayToken)
			tokens.push(token)
			current = Option.flatMap(current, (node) => referenceStep(node, token))
		}
		return tokens
	}

/** RFC 6901 section 4's step: an array's item by a canonical decimal index, an object's own member, nothing else. */
const referenceStep = (node: Json, token: string): Option.Option<Json> => {
	if (isItems(node)) {
		return canonicalIndex.test(token) ? Arr.get(node, Number(token)) : Option.none()
	}
	return isMembers(node) ? Record.get(node, token) : Option.none()
}

/** Whether a JSON node is an array. */
const isItems = (node: Json): node is ReadonlyArray<Json> => Arr.isArray(node)

/** Whether a JSON node is an object: neither null, a scalar nor an array. */
const isMembers = (node: Json): node is Readonly<Record<string, Json>> =>
	typeof node === "object" && node !== null && !Arr.isArray(node)

const canonicalIndex = regex("^(?:0|[1-9][0-9]*)$", "u")

/** RFC 6901 section 3's escape: `~` as `~0` first, then `/` as `~1`. */
const escaped = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

const textOf = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (token) => `/${escaped(token)}`),
		""
	)

/** How a pointer is spelled: as text, or as a URI fragment with some characters percent-encoded; then broken or not. */
type Spelling = Readonly<{
	form: "pointer" | "fragment"
	encode: ReadonlyArray<boolean>
	fault: Option.Option<Fault>
}>

/** A fault in a pointer's spelling. */
type Fault =
	| "no leading slash"
	| "an escape of `~2`"
	| "a bare `~` at the end"
	| "a broken percent escape"
	| "no hash"

/** One case: a tree, a token path into it, how the path is spelled, and a key for the name functions. */
export type PointerCase = Readonly<{
	tree: Json
	tokens: ReadonlyArray<string>
	spelling: Spelling
}>

const faultGen = (form: Spelling["form"]): Gen<Fault> =>
	form === "pointer"
		? element(["no leading slash", "an escape of `~2`", "a bare `~` at the end"])
		: element([
				"no leading slash",
				"an escape of `~2`",
				"a bare `~` at the end",
				"a broken percent escape",
				"no hash"
			])

/** Percent-encodes one character's UTF-8 bytes. */
const percentEncoded = (char: string): string =>
	Arr.join(
		Arr.map(
			Arr.fromIterable(new TextEncoder().encode(char)),
			(byte) => `%${Str.toUpperCase(Str.padStart(2, "0")(byte.toString(16)))}`
		),
		""
	)

const fragmentChar = regex("^[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]$", "u")

/** A fragment character that must be percent-encoded in a URI: anything outside RFC 3986's fragment characters. */
const mustEncode = (char: string): boolean => !fragmentChar.test(char)

/** The text a case spells, its fault planted. */
const spelledOf = (c: PointerCase): string => {
	const text = textOf(c.tokens)
	const fault = Option.getOrUndefined(c.spelling.fault)
	const broken =
		fault === "no leading slash"
			? Str.isEmpty(text)
				? "a"
				: Str.slice(1)(text)
			: fault === "an escape of `~2`"
				? `${text}/a~2`
				: fault === "a bare `~` at the end"
					? `${text}/a~`
					: text
	if (c.spelling.form === "pointer") {
		return broken
	}
	const encoded = Arr.join(
		Arr.map(Arr.fromIterable(broken), (char, index) =>
			mustEncode(char) || Option.getOrElse(Arr.get(c.spelling.encode, index), () => false)
				? percentEncoded(char)
				: char
		),
		""
	)
	return fault === "no hash"
		? encoded
		: fault === "a broken percent escape"
			? `#${encoded}%E0%A4%A`
			: `#${encoded}`
}

/** A failure as the property compares it: its tag, the pointer it names, and its reason or token. */
type Failure = Readonly<{ tag: string; pointer: string; detail: string }>

/** What evaluation and parsing answer: the value, or the failure; the Result form and the Effect form each. */
export type Evaluation = Readonly<{
	parsed: Result.Result<ReadonlyArray<string>, Failure>
	evaluated: Result.Result<Json, Failure>
	effects: Readonly<{
		parsed: Result.Result<ReadonlyArray<string>, Failure>
		evaluated: Result.Result<Json, Failure>
	}>
	branded: boolean
	formatted: Option.Option<string>
	tokens: Readonly<{ result: Result.Result<Json, Failure>; effect: Result.Result<Json, Failure> }>
	unescaped: ReadonlyArray<
		Readonly<{ result: Result.Result<string, Failure>; effect: Result.Result<string, Failure> }>
	>
}>

/** The error class a failure is an instance of, by its class, never by its tag. */
const classOf = (error: PointerSyntaxError | PointerEvalError): string =>
	error instanceof PointerSyntaxError
		? "PointerSyntaxError"
		: error instanceof PointerMemberNotFound
			? "PointerMemberNotFound"
			: error instanceof PointerIndexOutOfRange
				? "PointerIndexOutOfRange"
				: error instanceof PointerNotContainer
					? "PointerNotContainer"
					: "an instance of no pointer error class"

const failureOf = (error: PointerSyntaxError | PointerEvalError): Failure => ({
	tag: classOf(error),
	pointer: error.pointer,
	detail: error._tag === "PointerSyntaxError" ? error.reason : error.token
})

const defect: Failure = { tag: "defect", pointer: "", detail: "" }

const resultOfExit = <A>(
	exit: Exit.Exit<A, PointerSyntaxError | PointerEvalError>
): Result.Result<A, Failure> =>
	Exit.isSuccess(exit)
		? Result.succeed(exit.value)
		: Result.fail(
				Option.getOrElse(
					Arr.findFirst(exit.cause.reasons, (reason) =>
						reason._tag === "Fail" ? Option.some(failureOf(reason.error)) : Option.none()
					),
					() => defect
				)
			)

/** What the module answers for a case. */
export const actualOf = (c: PointerCase): Effect.Effect<Evaluation> =>
	Effect.gen(function* () {
		const text = spelledOf(c)
		const fragment = c.spelling.form === "fragment"
		const parsedExit = yield* Effect.exit(fragment ? parseFragment(text) : parsePointer(text))
		const evaluatedExit = yield* Effect.exit(
			fragment ? evaluateFragment(c.tree, text) : evaluatePointer(c.tree, text)
		)
		const parsed = fragment ? parseFragmentResult(text) : parsePointerResult(text)
		const evaluated = fragment
			? evaluateFragmentResult(c.tree, text)
			: evaluatePointerResult(c.tree, text)
		const tokensExit = yield* Effect.exit(evaluateTokens(c.tree, c.tokens))
		const unescapedTokens = yield* Effect.forEach(rawTokensOf(text), (token) =>
			Effect.map(Effect.exit(unescapeToken(token)), (exit) => ({
				result: Result.mapError(unescapeTokenResult(token), failureOf),
				effect: resultOfExit(exit)
			}))
		)
		return {
			parsed: Result.mapError(parsed, failureOf),
			evaluated: Result.mapError(evaluated, failureOf),
			effects: { parsed: resultOfExit(parsedExit), evaluated: resultOfExit(evaluatedExit) },
			branded: isJsonPointer(text),
			formatted: Result.isSuccess(parsed)
				? Option.some(formatPointer(parsed.success))
				: Option.none(),
			tokens: {
				result: Result.mapError(evaluateTokensResult(c.tree, c.tokens), failureOf),
				effect: resultOfExit(tokensExit)
			},
			unescaped: unescapedTokens
		}
	})

const badEscape = regex("~(?![01])", "u")

/** RFC 6901 section 3's unescape of a token; a `~` not before `0` or `1` is no token. */
const unescaped = (token: string): Option.Option<string> =>
	badEscape.test(token)
		? Option.none()
		: Option.some(Str.replaceAll("~0", "~")(Str.replaceAll("~1", "/")(token)))

/** The tokens of a spelled pointer as written, before unescaping: what follows each `/`, none without a leading one. */
const rawTokensOf = (text: string): ReadonlyArray<string> =>
	Str.startsWith("/")(text) ? Arr.drop(Str.split("/")(text), 1) : []

/** RFC 6901 section 3: empty, or `/`-led tokens. */
const referenceParse = (text: string): Result.Result<ReadonlyArray<string>, Failure> => {
	if (text === "") {
		return Result.succeed([])
	}
	if (!Str.startsWith("/")(text)) {
		return Result.fail({
			tag: "PointerSyntaxError",
			pointer: text,
			detail: "missing-leading-slash"
		})
	}
	const tokens = Arr.map(Arr.drop(Str.split("/")(text), 1), unescaped)
	return Arr.every(tokens, Option.isSome)
		? Result.succeed(Arr.getSomes(tokens))
		: Result.fail({ tag: "PointerSyntaxError", pointer: text, detail: "invalid-escape" })
}

/** RFC 6901 section 6: `#`, then the percent-decoded pointer text. */
const referenceParseFragment = (text: string): Result.Result<ReadonlyArray<string>, Failure> => {
	if (!Str.startsWith("#")(text)) {
		return Result.fail({ tag: "PointerSyntaxError", pointer: text, detail: "missing-hash" })
	}
	const decoded = Result.try({
		try: () => decodeURIComponent(Str.slice(1)(text)),
		catch: () => text
	})
	return Result.isFailure(decoded)
		? Result.fail({ tag: "PointerSyntaxError", pointer: text, detail: "invalid-percent-escape" })
		: Result.mapError(referenceParse(decoded.success), (failure) => ({ ...failure, pointer: text }))
}

/** RFC 6901 section 4's evaluation, each failure naming the pointer through the token that failed. */
const referenceEvaluate = (
	tree: Json,
	tokens: ReadonlyArray<string>
): Result.Result<Json, Failure> => {
	let node: Json = tree
	for (const [index, token] of tokens.entries()) {
		const pointer = textOf(Arr.take(tokens, index + 1))
		const next = referenceStep(node, token)
		if (Option.isNone(next)) {
			const tag = isItems(node)
				? "PointerIndexOutOfRange"
				: isMembers(node)
					? "PointerMemberNotFound"
					: "PointerNotContainer"
			return Result.fail({ tag, pointer, detail: token })
		}
		node = next.value
	}
	return Result.succeed(node)
}

/** The reference's answer: its parse and evaluation, both forms alike, the brand admitting exactly what parses. */
export const expectedOf = (c: PointerCase): Evaluation => {
	const text = spelledOf(c)
	const parsed =
		c.spelling.form === "fragment" ? referenceParseFragment(text) : referenceParse(text)
	const evaluated = Result.flatMap(parsed, (tokens) => referenceEvaluate(c.tree, tokens))
	const tokens = referenceEvaluate(c.tree, c.tokens)
	return {
		parsed,
		evaluated,
		effects: { parsed, evaluated },
		branded: Result.isSuccess(referenceParse(text)),
		formatted: Result.isSuccess(parsed) ? Option.some(textOf(parsed.success)) : Option.none(),
		tokens: { result: tokens, effect: tokens },
		unescaped: Arr.map(rawTokensOf(text), (token) => {
			const one = Result.fromOption(unescaped(token), (): Failure => ({
				tag: "PointerSyntaxError",
				pointer: token,
				detail: "invalid-escape"
			}))
			return { result: one, effect: one }
		})
	}
}

export type PointerFeature =
	| "a value reached"
	| "the root by the empty pointer"
	| "a member missing"
	| "an index out of range"
	| "a non-canonical index"
	| "a scalar descended into"
	| "a prototype name"
	| "an escaped token"
	| "a fragment percent-encoded"
	| `${Fault} refused`

export const pointerFeaturesOf = (c: PointerCase): ReadonlyArray<PointerFeature> => {
	const expected = expectedOf(c)
	const when = (holds: boolean, feature: PointerFeature): ReadonlyArray<PointerFeature> =>
		holds ? [feature] : []
	const failure = Result.isFailure(expected.evaluated)
		? Option.some(expected.evaluated.failure)
		: Option.none()
	return [
		...Option.match(c.spelling.fault, {
			onNone: () => [],
			onSome: (fault): ReadonlyArray<PointerFeature> => [`${fault} refused`]
		}),
		...when(Result.isSuccess(expected.evaluated), "a value reached"),
		...when(
			Result.isSuccess(expected.evaluated) &&
				Arr.isReadonlyArrayEmpty(c.tokens) &&
				c.spelling.form === "pointer",
			"the root by the empty pointer"
		),
		...when(
			Option.exists(failure, (f) => f.tag === "PointerMemberNotFound"),
			"a member missing"
		),
		...when(
			Option.exists(
				failure,
				(f) => f.tag === "PointerIndexOutOfRange" && canonicalIndex.test(f.detail)
			),
			"an index out of range"
		),
		...when(
			Option.exists(
				failure,
				(f) => f.tag === "PointerIndexOutOfRange" && !canonicalIndex.test(f.detail)
			),
			"a non-canonical index"
		),
		...when(
			Option.exists(failure, (f) => f.tag === "PointerNotContainer"),
			"a scalar descended into"
		),
		...when(
			Arr.some(c.tokens, (token) => token === "__proto__" || token === "constructor"),
			"a prototype name"
		),
		...when(
			Arr.some(c.tokens, (token) => escaped(token) !== token),
			"an escaped token"
		),
		...when(
			c.spelling.form === "fragment" && Str.includes("%")(spelledOf(c)),
			"a fragment percent-encoded"
		)
	]
}

const spellingGen =
	(
		form: Gen<Spelling["form"]>,
		fault: (form: Spelling["form"]) => Gen<Option.Option<Fault>>
	): Gen<Spelling> =>
	(s) => {
		const drawn = s.draw(form)
		return {
			form: drawn,
			encode: s.draw(array(boolean, { min: 0, max: 12 })),
			fault: s.draw(fault(drawn))
		}
	}

const rarelyFaulty = (form: Spelling["form"]): Gen<Option.Option<Fault>> =>
	weighted<Option.Option<Fault>>([
		[3, constant(Option.none())],
		[1, map(faultGen(form), Option.some)]
	])

const caseGen =
	(spelling: Gen<Spelling>): Gen<PointerCase> =>
	(s) => {
		const tree = s.draw(treeGen(3))
		return { tree, tokens: s.draw(pathInto(tree)), spelling: s.draw(spelling) }
	}

const anyForm = element<Spelling["form"]>(["pointer", "fragment"])

const plain = spellingGen(anyForm, () => constant(Option.none()))

/** The first of eight cases drawn that reaches `feature`, else the last: an aim that an unlucky draw only delays. */
const reaching =
	(feature: PointerFeature, gen: Gen<PointerCase>): Space<PointerCase> =>
	(s) => {
		const drawn = s.draw(array(gen, { min: 8, max: 8 }))
		return Option.getOrElse(
			Arr.findFirst(drawn, (c) => Arr.contains(pointerFeaturesOf(c), feature)),
			() => Arr.lastNonEmpty([s.draw(gen), ...drawn])
		)
	}

const faulted = (fault: Fault): Gen<PointerCase> =>
	caseGen(
		spellingGen(
			constant(fault === "a broken percent escape" || fault === "no hash" ? "fragment" : "pointer"),
			() => constant(Option.some(fault))
		)
	)

const RFC_DOCUMENT: Json = Record.fromEntries(
	Arr.map(
		["", " ", "a/b", "c%d", "e^f", "g|h", "i\\j", 'k"l', "m~n"],
		(key, index) => [key, index] as const
	)
)

/** Pointers into trees, aimed at every outcome, every fault and RFC 6901 section 5's own document. */
export const pointerSpace: Aimed<PointerCase, PointerFeature> = aimed(
	caseGen(spellingGen(anyForm, rarelyFaulty)),
	[
		["a value reached", reaching("a value reached", caseGen(plain))],
		[
			"the root by the empty pointer",
			(s) => ({
				tree: s.draw(treeGen(2)),
				tokens: [],
				spelling: { form: "pointer", encode: [], fault: Option.none() }
			})
		],
		["a member missing", reaching("a member missing", caseGen(plain))],
		[
			"an index out of range",
			(s) => ({
				tree: [s.draw(leafGen)],
				tokens: [s.draw(element(["1", "9"]))],
				spelling: s.draw(plain)
			})
		],
		[
			"a non-canonical index",
			(s) => ({
				tree: [s.draw(leafGen), s.draw(leafGen)],
				tokens: [s.draw(element(["01", "-", "x", " 0"]))],
				spelling: s.draw(plain)
			})
		],
		[
			"a scalar descended into",
			(s) => ({
				tree: { foo: [s.draw(element(["bar", "baz"]))] },
				tokens: ["foo", "0", "x"],
				spelling: s.draw(plain)
			})
		],
		[
			"a prototype name",
			(s) => ({
				tree: { a: 1 },
				tokens: [s.draw(element(["__proto__", "constructor"]))],
				spelling: s.draw(plain)
			})
		],
		[
			"an escaped token",
			(s) => ({
				tree: RFC_DOCUMENT,
				tokens: [s.draw(element(["a/b", "m~n"]))],
				spelling: s.draw(plain)
			})
		],
		[
			"a fragment percent-encoded",
			(s) => ({
				tree: RFC_DOCUMENT,
				tokens: [s.draw(element(["c%d", "e^f", "g|h", "i\\j", 'k"l', " "]))],
				spelling: {
					form: "fragment",
					encode: s.draw(array(boolean, { min: 0, max: 6 })),
					fault: Option.none()
				}
			})
		],
		...Arr.map(
			[
				"no leading slash",
				"an escape of `~2`",
				"a bare `~` at the end",
				"a broken percent escape",
				"no hash"
			] as const,
			(fault) => [`${fault} refused`, faulted(fault)] as const
		)
	]
)

/** A pair of pointers for isPointerWithin, and member names for the `$defs` key and extension readers. */
export type NameCase = Readonly<{
	ancestor: ReadonlyArray<string>
	pointer: ReadonlyArray<string>
	key: string
	prefixed: boolean
}>

export type NameFeature =
	| "a pointer within itself"
	| "a pointer below its ancestor"
	| "a sibling sharing a text prefix"
	| "a pointer above"
	| "the empty ancestor"
	| "an extension name"
	| "an extension in another case"
	| "a $defs key with escapes"
	| "a reference outside $defs"

const tokenGen = element(["a", "ab", "b", "", "x-1", "a/b", "~"])

const nameCaseGen =
	(relation: Gen<"same" | "below" | "sibling" | "above" | "any">): Gen<NameCase> =>
	(s) => {
		const ancestor = s.draw(array(tokenGen, { min: 0, max: 3 }))
		const kind = s.draw(relation)
		const pointer =
			kind === "same"
				? ancestor
				: kind === "below"
					? [...ancestor, ...s.draw(array(tokenGen, { min: 1, max: 2 }))]
					: kind === "sibling"
						? [
								...Arr.dropRight(ancestor, 1),
								`${Option.getOrElse(Arr.last(ancestor), () => "a")}${s.draw(element(["b", "x", "~0"]))}`
							]
						: kind === "above"
							? Arr.dropRight(ancestor, 1)
							: s.draw(array(tokenGen, { min: 0, max: 3 }))
		return {
			ancestor,
			pointer,
			key: s.draw(element(["x-a", "x-", "X-a", "-x", "", "a~1b", "a/b~c", "a%20b", "a~2", "y"])),
			prefixed: s.draw(
				weighted([
					[2, constant(true)],
					[1, constant(false)]
				])
			)
		}
	}

const DEFS = "#/$defs/"

/** What the name readers answer. */
export type Names = Readonly<{ within: boolean; key: Option.Option<string>; extension: boolean }>

export const namesOf = (c: NameCase): Names => ({
	within: isPointerWithin(formatPointer(c.ancestor), formatPointer(c.pointer)),
	key: Option.fromUndefinedOr(
		defsKeyOf(c.prefixed ? `${DEFS}${c.key}` : `#/components/schemas/${c.key}`)
	),
	extension: isSpecificationExtension(c.key)
})

/**
 * The model: within when the pointer's tokens extend the ancestor's; a `$defs` reference's key is its text unescaped
 * by `~1` and `~0` only, a `~` before any other character kept, no percent-decoding; an extension name begins `x-`.
 */
export const expectedNamesOf = (c: NameCase): Names => ({
	within:
		c.pointer.length >= c.ancestor.length &&
		Arr.every(c.ancestor, (token, index) => Arr.get(c.pointer, index).pipe(Option.contains(token))),
	key: c.prefixed
		? Option.some(Str.replaceAll("~0", "~")(Str.replaceAll("~1", "/")(c.key)))
		: Option.none(),
	extension: Str.startsWith("x-")(c.key)
})

export const nameFeaturesOf = (c: NameCase): ReadonlyArray<NameFeature> => {
	const ancestorText = formatPointer(c.ancestor)
	const pointerText = formatPointer(c.pointer)
	const when = (holds: boolean, feature: NameFeature): ReadonlyArray<NameFeature> =>
		holds ? [feature] : []
	const within = expectedNamesOf(c).within
	return [
		...when(ancestorText === pointerText, "a pointer within itself"),
		...when(within && ancestorText !== pointerText, "a pointer below its ancestor"),
		...when(
			!within && Str.startsWith(ancestorText)(pointerText),
			"a sibling sharing a text prefix"
		),
		...when(c.pointer.length < c.ancestor.length, "a pointer above"),
		...when(
			Arr.isReadonlyArrayEmpty(c.ancestor) && !Arr.isReadonlyArrayEmpty(c.pointer),
			"the empty ancestor"
		),
		...when(Str.startsWith("x-")(c.key), "an extension name"),
		...when(Str.startsWith("X-")(c.key), "an extension in another case"),
		...when(c.prefixed && Str.includes("~")(c.key), "a $defs key with escapes"),
		...when(!c.prefixed, "a reference outside $defs")
	]
}

const anyRelation = element(["same", "below", "sibling", "above", "any"] as const)

const keyed = (key: string, prefixed: boolean): Gen<NameCase> =>
	map(nameCaseGen(anyRelation), (c) => ({ ...c, key, prefixed }))

/** Name cases, aimed at each relation and each kind of key. */
export const nameSpace: Aimed<NameCase, NameFeature> = aimed(nameCaseGen(anyRelation), [
	["a pointer within itself", nameCaseGen(constant("same"))],
	["a pointer below its ancestor", nameCaseGen(constant("below"))],
	[
		"a sibling sharing a text prefix",
		map(nameCaseGen(constant("sibling")), (c) =>
			Arr.isReadonlyArrayEmpty(c.ancestor) ? { ...c, ancestor: ["a"], pointer: ["ab"] } : c
		)
	],
	[
		"a pointer above",
		map(nameCaseGen(constant("above")), (c) =>
			Arr.isReadonlyArrayEmpty(c.ancestor) ? { ...c, ancestor: ["a"], pointer: [] } : c
		)
	],
	["the empty ancestor", map(nameCaseGen(constant("below")), (c) => ({ ...c, ancestor: [] }))],
	["an extension name", keyed("x-a", true)],
	["an extension in another case", keyed("X-a", true)],
	[
		"a $defs key with escapes",
		(s) => s.draw(keyed(s.draw(element(["a~1b", "a~2", "a/b~c"])), true))
	],
	["a reference outside $defs", keyed("a", false)]
])
