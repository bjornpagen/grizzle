/**
 * A generated CLI takes an object-schema parameter as JSON, from its path positional or its flag, and sends the
 * object's members, in their order, by its style's RFC 6570 expansion. Path and query text is RFC 3986
 * percent-encoded (everything outside unreserved); header text is never encoded:
 *
 * - Path `simple` is `k1,v1,k2,v2`, exploded `k1=v1,k2=v2`; `label` is `.k1,v1,k2,v2`, exploded `.k1=v1.k2=v2`;
 *   `matrix` is `;o=k1,v1,k2,v2`, exploded `;k1=v1;k2=v2`, a member whose text is empty as `;k1`.
 * - Query `form` is `k1=v1&k2=v2`, unexploded `qn=k1,v1,k2,v2`; `deepObject` is `deep[k1]=v1&deep[k2]=v2`, the brackets
 *   encoded. An empty object sends nothing.
 * - Header `simple` is `k1,v1,k2,v2`, exploded `k1=v1,k2=v2`. An empty object sends no header.
 *
 * A number is sent as its JSON digits, past 2^53 included; a boolean as `true` or `false`. Each refusal is exit 2
 * before any connection: a null or nested member anywhere; an empty object in the path, which is required; a `.` in an
 * exploded label, which `.` would leave ambiguous; a `[` or `]` in a `deepObject` member name; a header part with an
 * edge space or a code point past U+00FF, which no header line carries unchanged; a `,` in a header part, or `=` in an
 * exploded header member name, which the expansion would leave ambiguous; and text that is not JSON for an object
 * parameter or a JSON body field.
 *
 * One package; a check that every object positional and flag, and the JSON body field flag, shows `json` as its value
 * in `--help`; properties per location (the six path styles, the three query parameters, the two headers), each oracle
 * the expansion above computed from the drawn object and compared byte for byte with what reached the capture server;
 * and an exhaustion of text that is not JSON for every kind of JSON input.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { type Case as SearchCase, drawn, exhaust, explore } from "@bjornpagen/testing/explore"
import { required, type RequiredCoverage, requiredInSpace } from "@bjornpagen/testing/features"
import {
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { metavarOf } from "#test/support/help.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** A path parameter style. */
type PathStyle = "simple" | "label" | "matrix"

/** What a sent or refused object reached, whatever its location. */
type MemberFeature =
	| "a null member"
	| "a nested member"
	| "a number past 2^53"
	| "a boolean member"
	| "text needing encoding"

/** A situation a path case reaches. */
type PathFeature =
	| MemberFeature
	| "simple sent"
	| "simple exploded sent"
	| "label sent"
	| "label exploded sent"
	| "matrix sent"
	| "matrix exploded sent"
	| "a dot in an exploded label"
	| "an empty path object"
	| "an empty value in an exploded matrix"

/** A situation a query case reaches. */
type QueryFeature =
	| Exclude<MemberFeature, "a boolean member">
	| "form sent"
	| "unexploded form sent"
	| "deepObject sent"
	| "a bracket in a deepObject key"
	| "every query parameter at once"
	| "an empty object left out"

/** A situation a header case reaches. */
type HeaderFeature =
	| "a null member"
	| "a nested member"
	| "a number past 2^53"
	| "simple header sent"
	| "exploded header sent"
	| "an unsafe header text"
	| "a comma in a header"
	| "an equals in an exploded header key"
	| "text past ASCII in a header"
	| "an empty object left out"

/** An operation with one object-schema path parameter `o`: its style, whether exploded, and its feature once sent. */
type PathTarget = Readonly<{
	operation: string
	style: PathStyle
	explode: boolean
	sent: PathFeature
}>

const SIMPLE: PathTarget = {
	operation: "simple",
	style: "simple",
	explode: false,
	sent: "simple sent"
}

const SIMPLE_EXPLODED: PathTarget = {
	operation: "simple-x",
	style: "simple",
	explode: true,
	sent: "simple exploded sent"
}

const LABEL: PathTarget = { operation: "label", style: "label", explode: false, sent: "label sent" }

const LABEL_EXPLODED: PathTarget = {
	operation: "label-x",
	style: "label",
	explode: true,
	sent: "label exploded sent"
}

const MATRIX: PathTarget = {
	operation: "matrix",
	style: "matrix",
	explode: false,
	sent: "matrix sent"
}

const MATRIX_EXPLODED: PathTarget = {
	operation: "matrix-x",
	style: "matrix",
	explode: true,
	sent: "matrix exploded sent"
}

const PATH_TARGETS: Arr.NonEmptyReadonlyArray<PathTarget> = [
	SIMPLE,
	SIMPLE_EXPLODED,
	LABEL,
	LABEL_EXPLODED,
	MATRIX,
	MATRIX_EXPLODED
]

const OBJECT = { type: "object" } as const

const DONE = { "204": { description: "Done." } } as const

/** One GET per path style; a GET with three object query parameters; a GET with two object headers; a JSON body. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Object parameters", version: "1.0.0" },
	paths: {
		...Rec.fromEntries(
			Arr.map(PATH_TARGETS, (target): readonly [string, Schema.Json] => [
				`/${target.operation}/{o}`,
				{
					get: {
						operationId: target.operation,
						parameters: [
							{
								in: "path",
								name: "o",
								required: true,
								style: target.style,
								explode: target.explode,
								schema: OBJECT
							}
						],
						responses: DONE
					}
				}
			])
		),
		"/query": {
			get: {
				operationId: "query",
				parameters: [
					{ in: "query", name: "qf", style: "form", explode: true, schema: OBJECT },
					{ in: "query", name: "qn", style: "form", explode: false, schema: OBJECT },
					{ in: "query", name: "deep", style: "deepObject", explode: true, schema: OBJECT }
				],
				responses: DONE
			}
		},
		"/headers": {
			get: {
				operationId: "headers",
				parameters: [
					{ in: "header", name: "X-O", schema: OBJECT },
					{ in: "header", name: "X-Ox", explode: true, schema: OBJECT }
				],
				responses: DONE
			}
		},
		"/emails": {
			post: {
				operationId: "emails",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									to: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }
								}
							}
						}
					}
				},
				responses: DONE
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "object-parameters", version: "1.0.0" },
		binName: "objects",
		envPrefix: "OBJECTS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** Each operation's pointer, by its operation id. */
const POINTERS: Readonly<Record<string, string>> = {
	...Rec.fromEntries(
		Arr.map(PATH_TARGETS, (target): readonly [string, string] => [
			target.operation,
			`/paths/~1${target.operation}~1{o}/get`
		])
	),
	query: "/paths/~1query/get",
	headers: "/paths/~1headers/get",
	emails: "/paths/~1emails/post"
}

/** A member's value as the operator writes it in JSON. */
type MemberValue =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "number"; digits: string }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "null" }>
	| Readonly<{ kind: "nested"; json: string }>

/** A member: its name and its value. */
type Member = readonly [name: string, value: MemberValue]

/** An object's members in the order the operator writes them. */
type Members = ReadonlyArray<Member>

const textValue = (text: string): MemberValue => ({ kind: "text", text })

const numberValue = (digits: string): MemberValue => ({ kind: "number", digits })

/** A member value's JSON text. */
const memberJson = (value: MemberValue): string => {
	switch (value.kind) {
		case "text":
			return jsonTextOf(value.text)
		case "number":
			return value.digits
		case "boolean":
			return String(value.value)
		case "null":
			return "null"
		case "nested":
			return value.json
	}
}

/** An object's JSON text, its members in their order. */
const objectJson = (members: Members): string =>
	`{${Arr.join(
		Arr.map(members, ([name, value]) => `${jsonTextOf(name)}:${memberJson(value)}`),
		","
	)}}`

/** A member value's text, none for a null or nested one, which every style refuses. */
const scalarText = (value: MemberValue): Option.Option<string> => {
	switch (value.kind) {
		case "text":
			return Option.some(value.text)
		case "number":
			return Option.some(value.digits)
		case "boolean":
			return Option.some(String(value.value))
		case "null":
		case "nested":
			return Option.none()
	}
}

/** An object's name and value texts, none when a member is null or nested. */
const textsOf = (members: Members): Option.Option<ReadonlyArray<readonly [string, string]>> =>
	Option.all(
		Arr.map(members, ([name, value]) =>
			Option.map(scalarText(value), (text): readonly [string, string] => [name, text])
		)
	)

const UNRESERVED = regex("^[A-Za-z0-9._~-]$", "u")

/** RFC 3986 percent-encoding of everything outside unreserved: each UTF-8 byte as an upper-case triplet. */
const percentEncoded = (text: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(text), (character) =>
			UNRESERVED.test(character)
				? character
				: Arr.join(
						Arr.map(
							Arr.fromIterable(Buffer.from(character, "utf8")),
							(byte) => `%${Str.padStart(2, "0")(Str.toUpperCase(byte.toString(16)))}`
						),
						""
					)
		),
		""
	)

/** Name-value texts, each percent-encoded. */
const encodedTexts = (
	texts: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<readonly [string, string]> =>
	Arr.map(texts, ([name, text]): readonly [string, string] => [
		percentEncoded(name),
		percentEncoded(text)
	])

/** Every name and value text in member order. */
const partsOf = (texts: ReadonlyArray<readonly [string, string]>): ReadonlyArray<string> =>
	Arr.flatten(texts)

/** `name=value` for each member, joined. */
const assigned = (texts: ReadonlyArray<readonly [string, string]>, joiner: string): string =>
	Arr.join(
		Arr.map(texts, ([name, text]) => `${name}=${text}`),
		joiner
	)

/** The path segment a style expands an object to, none for a refusal. */
const pathSegment = (target: PathTarget, members: Members): Option.Option<string> =>
	Option.flatMap(textsOf(members), (texts) => {
		if (Arr.isReadonlyArrayEmpty(texts)) {
			return Option.none()
		}
		if (target.style === "label" && target.explode && Arr.some(partsOf(texts), Str.includes("."))) {
			return Option.none()
		}
		const encoded = encodedTexts(texts)
		const flat = Arr.join(partsOf(encoded), ",")
		switch (target.style) {
			case "simple":
				return Option.some(target.explode ? assigned(encoded, ",") : flat)
			case "label":
				return Option.some(target.explode ? `.${assigned(encoded, ".")}` : `.${flat}`)
			case "matrix":
				return Option.some(
					target.explode
						? Arr.join(
								Arr.map(encoded, ([name, text]) => (text === "" ? `;${name}` : `;${name}=${text}`)),
								""
							)
						: `;o=${flat}`
				)
		}
	})

/** What one parameter's expansion gives: a refusal, nothing for an empty object, or its text. */
type Expansion =
	| Readonly<{ kind: "refused" }>
	| Readonly<{ kind: "nothing" }>
	| Readonly<{ kind: "sent"; text: string }>

const REFUSED: Expansion = { kind: "refused" }

const NOTHING: Expansion = { kind: "nothing" }

/** An optional parameter's expansion: `expand` decides an object with members; an empty one sends nothing. */
const optionalExpansion = (
	members: Members,
	expand: (texts: Arr.NonEmptyReadonlyArray<readonly [string, string]>) => Expansion
): Expansion =>
	Option.match(textsOf(members), {
		onNone: () => REFUSED,
		onSome: (texts) =>
			Arr.match(texts, {
				onEmpty: () => NOTHING,
				onNonEmpty: expand
			})
	})

/** A query parameter of the box. */
type QueryParameter = "qf" | "qn" | "deep"

const QUERY_PARAMETERS: ReadonlyArray<QueryParameter> = ["qf", "qn", "deep"]

const BRACKET = regex("[[\\]]", "u")

/** A query parameter's expansion of an object. */
const queryExpansion = (parameter: QueryParameter, members: Members): Expansion =>
	optionalExpansion(members, (texts) => {
		switch (parameter) {
			case "qf":
				return { kind: "sent", text: assigned(encodedTexts(texts), "&") }
			case "qn":
				return { kind: "sent", text: `qn=${Arr.join(partsOf(encodedTexts(texts)), ",")}` }
			case "deep":
				return Option.isSome(Arr.findFirst(texts, ([name]) => BRACKET.test(name)))
					? REFUSED
					: {
							kind: "sent",
							text: Arr.join(
								Arr.map(
									texts,
									([name, text]) => `${percentEncoded(`deep[${name}]`)}=${percentEncoded(text)}`
								),
								"&"
							)
						}
		}
	})

/** A header of the box: `X-O` unexploded, `X-Ox` exploded. */
type HeaderParameter = "plain" | "exploded"

/** A part no header line carries unchanged: an edge space or tab, a line break or NUL, or a code point past U+00FF. */
const UNSAFE_HEADER_TEXT = regex("^[\\t ]|[\\t ]$|[\\r\\n\\u0000]|[\\u{100}-\\u{10FFFF}]", "u")

/** A header's expansion of an object, never encoded. */
const headerExpansion = (parameter: HeaderParameter, members: Members): Expansion =>
	optionalExpansion(members, (texts) => {
		const exploded = parameter === "exploded"
		if (
			Arr.some(
				partsOf(texts),
				(part) => UNSAFE_HEADER_TEXT.test(part) || Str.includes(",")(part)
			) ||
			(exploded && Arr.some(texts, ([name]) => Str.includes("=")(name)))
		) {
			return REFUSED
		}
		return {
			kind: "sent",
			text: exploded ? assigned(texts, ",") : Arr.join(partsOf(texts), ",")
		}
	})

/** A request as the oracle compares it: its target, and the values of the two object headers. */
type Seen = Readonly<{
	target: string
	plain: ReadonlyArray<string>
	exploded: ReadonlyArray<string>
}>

/** What the oracle compares of a run. */
type Outcome = Readonly<{ exitCode: number; connections: number; requests: ReadonlyArray<Seen> }>

const seenOf = (request: WireRequest): Seen => ({
	target: request.target,
	plain: valuesOf(request.headers, "x-o"),
	exploded: valuesOf(request.headers, "x-ox")
})

/** A refused run: exit 2 and no connection. */
const REFUSED_RUN: Outcome = { exitCode: 2, connections: 0, requests: [] }

/** One request to `target`, carrying these object headers. */
const sentTo = (
	target: string,
	plain: ReadonlyArray<string>,
	exploded: ReadonlyArray<string>
): Outcome => ({ exitCode: 0, connections: 1, requests: [{ target, plain, exploded }] })

/** The text an expansion sends, none for nothing; a refused one sends nothing either, and fails the run. */
const sentText = (expansion: Expansion): ReadonlyArray<string> =>
	expansion.kind === "sent" ? [expansion.text] : []

const isRefused = (expansion: Expansion): boolean => expansion.kind === "refused"

/** A path case: a target style and the object its positional gives. */
type PathCase = Readonly<{ target: PathTarget; members: Members }>

/** A query case: each query parameter's object, or none. */
type QueryCase = Readonly<Record<QueryParameter, Option.Option<Members>>>

/** A header case: each header's object, or none. */
type HeaderCase = Readonly<Record<HeaderParameter, Option.Option<Members>>>

const HEADER_PARAMETERS: ReadonlyArray<HeaderParameter> = ["plain", "exploded"]

/** Each query parameter's expansion in declaration order, for those the case gives. */
const queryExpansions = (c: QueryCase): ReadonlyArray<Expansion> =>
	Arr.flatMap(QUERY_PARAMETERS, (parameter) =>
		Option.toArray(Option.map(c[parameter], (members) => queryExpansion(parameter, members)))
	)

/** Each header's expansion, none for one the case leaves out. */
const headerExpansions = (
	c: HeaderCase
): Readonly<Record<HeaderParameter, Option.Option<Expansion>>> => ({
	plain: Option.map(c.plain, (members) => headerExpansion("plain", members)),
	exploded: Option.map(c.exploded, (members) => headerExpansion("exploded", members))
})

const pathExpected = (c: PathCase): Outcome =>
	Option.match(pathSegment(c.target, c.members), {
		onNone: () => REFUSED_RUN,
		onSome: (segment) => sentTo(`/${c.target.operation}/${segment}`, [], [])
	})

const queryExpected = (c: QueryCase): Outcome => {
	const expansions = queryExpansions(c)
	if (Arr.some(expansions, isRefused)) {
		return REFUSED_RUN
	}
	return sentTo(
		Arr.match(Arr.flatMap(expansions, sentText), {
			onEmpty: () => "/query",
			onNonEmpty: (pieces) => `/query?${Arr.join(pieces, "&")}`
		}),
		[],
		[]
	)
}

const headerExpected = (c: HeaderCase): Outcome => {
	const expansions = headerExpansions(c)
	if (Arr.some(Arr.getSomes(Rec.values(expansions)), isRefused)) {
		return REFUSED_RUN
	}
	return sentTo(
		"/headers",
		Arr.flatMap(Option.toArray(expansions.plain), sentText),
		Arr.flatMap(Option.toArray(expansions.exploded), sentText)
	)
}

const pathArgs = (c: PathCase): ReadonlyArray<string> => [objectJson(c.members)]

const queryArgs = (c: QueryCase): ReadonlyArray<string> =>
	Arr.flatMap(QUERY_PARAMETERS, (parameter) =>
		Option.match(c[parameter], {
			onNone: () => [],
			onSome: (members) => [`--${parameter}`, objectJson(members)]
		})
	)

const HEADER_FLAGS: Readonly<Record<HeaderParameter, string>> = {
	plain: "--x-o",
	exploded: "--x-ox"
}

const headerArgs = (c: HeaderCase): ReadonlyArray<string> =>
	Arr.flatMap(HEADER_PARAMETERS, (parameter) =>
		Option.match(c[parameter], {
			onNone: () => [],
			onSome: (members) => [HEADER_FLAGS[parameter], objectJson(members)]
		})
	)

/** Characters every location carries plainly: RFC 3986 unreserved but `.`. */
const SAFE_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = ["a", "Z", "0", "-", "_", "~"]

/** Characters some style encodes, delimits or refuses. */
const SPECIAL_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = [
	".",
	" ",
	",",
	"=",
	";",
	"&",
	"%",
	"+",
	"[",
	"é",
	"ł"
]

/** Characters a path or query encodes, `.` aside, which an exploded label refuses. */
const ENCODED_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = [
	" ",
	",",
	"=",
	";",
	"&",
	"%",
	"+",
	"[",
	"é",
	"ł"
]

const DIGITS: Arr.NonEmptyReadonlyArray<string> = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

/** Mostly plain characters, sometimes a special one. */
const CHARACTER: Gen<string> = weighted([
	[5, characterOf(SAFE_CHARACTERS)],
	[1, characterOf(SPECIAL_CHARACTERS)]
])

const SAFE_CHARACTER: Gen<string> = characterOf(SAFE_CHARACTERS)

/** A member name: a letter, so no name is an array index JavaScript would move to the front, then up to two more. */
const nameOf =
	(rest: Gen<string>): Gen<string> =>
	(source) =>
		`${element(["a", "Z", "q"])(source)}${string(rest, { min: 0, max: 2 })(source)}`

const NAME = nameOf(CHARACTER)

const SAFE_NAME = nameOf(SAFE_CHARACTER)

const TEXT: Gen<MemberValue> = map(string(CHARACTER, { min: 0, max: 4 }), textValue)

const SAFE_STRING: Gen<string> = string(SAFE_CHARACTER, { min: 0, max: 4 })

const SAFE_TEXT: Gen<MemberValue> = map(SAFE_STRING, textValue)

/** Text around one character drawn from `characters`. */
const textAround =
	(characters: Arr.NonEmptyReadonlyArray<string>): Gen<MemberValue> =>
	(source) =>
		textValue(`${SAFE_STRING(source)}${element(characters)(source)}${SAFE_STRING(source)}`)

const SMALL: Gen<MemberValue> = map(int(0, 9999), (whole) => numberValue(String(whole)))

/** A whole number of 17 to 19 digits, past 2^53, which a JavaScript number cannot hold exactly. */
const PAST_2_TO_53: Gen<MemberValue> = map(
	string(characterOf(DIGITS), { min: 16, max: 18 }),
	(rest) => numberValue(`9${rest}`)
)

const DECIMAL: Gen<MemberValue> = (source) =>
	numberValue(`${String(int(0, 99)(source))}.${String(int(1, 9)(source))}`)

const BOOLEAN: Gen<MemberValue> = map(boolean, (value) => ({ kind: "boolean", value }))

const NULL: Gen<MemberValue> = constant({ kind: "null" })

const NESTED: Gen<MemberValue> = oneOf([
	map(int(0, 9), (whole) => ({ kind: "nested", json: `{"x":${String(whole)}}` })),
	map(int(0, 9), (whole) => ({ kind: "nested", json: `[${String(whole)}]` }))
])

const MEMBER: Gen<MemberValue> = weighted([
	[8, TEXT],
	[3, SMALL],
	[1, PAST_2_TO_53],
	[1, DECIMAL],
	[2, BOOLEAN],
	[1, NULL],
	[1, NESTED]
])

const SAFE_MEMBER: Gen<MemberValue> = weighted([
	[3, SAFE_TEXT],
	[2, SMALL],
	[1, BOOLEAN]
])

/** Up to three members of distinct names. */
const MEMBERS: Gen<Members> = uniqueArray(
	NAME,
	(name) => map(MEMBER, (value): Member => [name, value]),
	{
		min: 0,
		max: 3
	}
)

/** One to three members no style refuses or encodes. */
const SAFE_MEMBERS: Gen<Members> = uniqueArray(
	SAFE_NAME,
	(name) => map(SAFE_MEMBER, (value): Member => [name, value]),
	{ min: 1, max: 3 }
)

/** Plain members, then one more under `name`, which no plain name equals since it starts with `F`. */
const plus =
	(name: string, value: Gen<MemberValue>): Gen<Members> =>
	(source) =>
		Arr.append(SAFE_MEMBERS(source), [name, value(source)])

const EMPTY: Gen<Members> = constant([])

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** What the objects of a run hold: a null or nested member, a number past 2^53, a boolean, text needing encoding. */
type MemberFacts = Readonly<{
	nullMember: boolean
	nestedMember: boolean
	past2To53: boolean
	booleanMember: boolean
	encoded: boolean
}>

const memberFacts = (members: ReadonlyArray<Members>): MemberFacts => {
	const values = Arr.flatMap(members, (object) => Arr.map(object, ([, value]) => value))
	const parts = Arr.flatMap(members, (object) =>
		Arr.flatMap(object, ([name, value]) => Arr.prepend(Option.toArray(scalarText(value)), name))
	)
	return {
		nullMember: Arr.some(values, (value) => value.kind === "null"),
		nestedMember: Arr.some(values, (value) => value.kind === "nested"),
		past2To53: Arr.some(values, (value) => value.kind === "number" && value.digits.length > 16),
		booleanMember: Arr.some(values, (value) => value.kind === "boolean"),
		encoded: Arr.some(parts, (part) => percentEncoded(part) !== part)
	}
}

const PATH_FEATURES: Arr.NonEmptyReadonlyArray<PathFeature> = [
	"simple sent",
	"simple exploded sent",
	"label sent",
	"label exploded sent",
	"matrix sent",
	"matrix exploded sent",
	"a dot in an exploded label",
	"an empty path object",
	"an empty value in an exploded matrix",
	"a null member",
	"a nested member",
	"a number past 2^53",
	"a boolean member",
	"text needing encoding"
]

const pathFeatures = (c: PathCase): ReadonlyArray<PathFeature> => {
	const sent = Option.isSome(pathSegment(c.target, c.members))
	const texts = Option.getOrElse(textsOf(c.members), () => [])
	const facts = memberFacts([c.members])
	return Arr.flatten<ReadonlyArray<ReadonlyArray<PathFeature>>>([
		when(sent, c.target.sent),
		when(
			c.target === LABEL_EXPLODED &&
				Option.isSome(textsOf(c.members)) &&
				Arr.some(partsOf(texts), Str.includes(".")),
			"a dot in an exploded label"
		),
		when(Arr.isReadonlyArrayEmpty(c.members), "an empty path object"),
		when(
			sent && c.target === MATRIX_EXPLODED && Arr.some(texts, ([, text]) => text === ""),
			"an empty value in an exploded matrix"
		),
		when(facts.nullMember, "a null member"),
		when(facts.nestedMember, "a nested member"),
		when(sent && facts.past2To53, "a number past 2^53"),
		when(sent && facts.booleanMember, "a boolean member"),
		when(sent && facts.encoded, "text needing encoding")
	])
}

const pathCaseOf =
	(target: Gen<PathTarget>, members: Gen<Members>): Gen<PathCase> =>
	(source) => ({ target: target(source), members: members(source) })

const ANY_TARGET: Gen<PathTarget> = element(PATH_TARGETS)

/** A path case made to reach `focus`, every other choice drawn; with no focus, every choice drawn. */
const pathCaseFor = (focus: Option.Option<PathFeature>): Gen<PathCase> => {
	if (Option.isNone(focus)) {
		return pathCaseOf(ANY_TARGET, MEMBERS)
	}
	switch (focus.value) {
		case "simple sent":
			return pathCaseOf(constant(SIMPLE), SAFE_MEMBERS)
		case "simple exploded sent":
			return pathCaseOf(constant(SIMPLE_EXPLODED), SAFE_MEMBERS)
		case "label sent":
			return pathCaseOf(constant(LABEL), SAFE_MEMBERS)
		case "label exploded sent":
			return pathCaseOf(constant(LABEL_EXPLODED), SAFE_MEMBERS)
		case "matrix sent":
			return pathCaseOf(constant(MATRIX), SAFE_MEMBERS)
		case "matrix exploded sent":
			return pathCaseOf(constant(MATRIX_EXPLODED), SAFE_MEMBERS)
		case "a dot in an exploded label":
			return pathCaseOf(constant(LABEL_EXPLODED), plus("Fk", textAround(["."])))
		case "an empty path object":
			return pathCaseOf(ANY_TARGET, EMPTY)
		case "an empty value in an exploded matrix":
			return pathCaseOf(constant(MATRIX_EXPLODED), plus("Fk", constant(textValue(""))))
		case "a null member":
			return pathCaseOf(ANY_TARGET, plus("Fk", NULL))
		case "a nested member":
			return pathCaseOf(ANY_TARGET, plus("Fk", NESTED))
		case "a number past 2^53":
			return pathCaseOf(ANY_TARGET, plus("Fk", PAST_2_TO_53))
		case "a boolean member":
			return pathCaseOf(ANY_TARGET, plus("Fk", BOOLEAN))
		case "text needing encoding":
			return pathCaseOf(ANY_TARGET, plus("Fk", textAround(ENCODED_CHARACTERS)))
	}
}

const QUERY_FEATURES: Arr.NonEmptyReadonlyArray<QueryFeature> = [
	"form sent",
	"unexploded form sent",
	"deepObject sent",
	"a bracket in a deepObject key",
	"an empty object left out",
	"every query parameter at once",
	"a null member",
	"a nested member",
	"a number past 2^53",
	"text needing encoding"
]

/** The feature each query parameter reaches once its members are sent. */
const QUERY_SENT: Readonly<Record<QueryParameter, QueryFeature>> = {
	qf: "form sent",
	qn: "unexploded form sent",
	deep: "deepObject sent"
}

const queryFeatures = (c: QueryCase): ReadonlyArray<QueryFeature> => {
	const sent = !Arr.some(queryExpansions(c), isRefused)
	const given = Arr.flatMap(QUERY_PARAMETERS, (parameter) => Option.toArray(c[parameter]))
	const filled = (parameter: QueryParameter) =>
		Option.exists(c[parameter], Arr.isReadonlyArrayNonEmpty)
	const facts = memberFacts(given)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<QueryFeature>>>([
		Arr.flatMap(QUERY_PARAMETERS, (parameter) =>
			when(sent && filled(parameter), QUERY_SENT[parameter])
		),
		when(
			Option.exists(c.deep, (members) => Arr.some(members, ([name]) => BRACKET.test(name))),
			"a bracket in a deepObject key"
		),
		when(sent && Arr.some(given, Arr.isReadonlyArrayEmpty), "an empty object left out"),
		when(sent && Arr.every(QUERY_PARAMETERS, filled), "every query parameter at once"),
		when(facts.nullMember, "a null member"),
		when(facts.nestedMember, "a nested member"),
		when(sent && facts.past2To53, "a number past 2^53"),
		when(sent && facts.encoded, "text needing encoding")
	])
}

const SOME_SAFE: Gen<Option.Option<Members>> = option(SAFE_MEMBERS)

const NONE: Gen<Option.Option<Members>> = constant(Option.none())

const given = (members: Gen<Members>): Gen<Option.Option<Members>> => map(members, Option.some)

const queryCaseOf =
	(
		qf: Gen<Option.Option<Members>>,
		qn: Gen<Option.Option<Members>>,
		deep: Gen<Option.Option<Members>>
	): Gen<QueryCase> =>
	(source) => ({ qf: qf(source), qn: qn(source), deep: deep(source) })

/** A query case made to reach `focus`, every other choice drawn; with no focus, every choice drawn. */
const queryCaseFor = (focus: Option.Option<QueryFeature>): Gen<QueryCase> => {
	if (Option.isNone(focus)) {
		return queryCaseOf(option(MEMBERS), option(MEMBERS), option(MEMBERS))
	}
	switch (focus.value) {
		case "form sent":
			return queryCaseOf(given(SAFE_MEMBERS), SOME_SAFE, SOME_SAFE)
		case "unexploded form sent":
			return queryCaseOf(SOME_SAFE, given(SAFE_MEMBERS), SOME_SAFE)
		case "deepObject sent":
			return queryCaseOf(SOME_SAFE, SOME_SAFE, given(SAFE_MEMBERS))
		case "a bracket in a deepObject key":
			return queryCaseOf(NONE, NONE, given(plus("F[", SAFE_TEXT)))
		case "an empty object left out":
			return queryCaseOf(given(EMPTY), given(SAFE_MEMBERS), SOME_SAFE)
		case "every query parameter at once":
			return queryCaseOf(given(SAFE_MEMBERS), given(SAFE_MEMBERS), given(SAFE_MEMBERS))
		case "a null member":
			return queryCaseOf(given(plus("Fk", NULL)), NONE, NONE)
		case "a nested member":
			return queryCaseOf(NONE, given(plus("Fk", NESTED)), NONE)
		case "a number past 2^53":
			return queryCaseOf(given(plus("Fk", PAST_2_TO_53)), NONE, SOME_SAFE)
		case "text needing encoding":
			return queryCaseOf(NONE, given(plus("Fk", textAround(ENCODED_CHARACTERS))), SOME_SAFE)
	}
}

const HEADER_FEATURES: Arr.NonEmptyReadonlyArray<HeaderFeature> = [
	"simple header sent",
	"exploded header sent",
	"an unsafe header text",
	"a comma in a header",
	"an equals in an exploded header key",
	"text past ASCII in a header",
	"an empty object left out",
	"a null member",
	"a nested member",
	"a number past 2^53"
]

const HEADER_SENT: Readonly<Record<HeaderParameter, HeaderFeature>> = {
	plain: "simple header sent",
	exploded: "exploded header sent"
}

const headerFeatures = (c: HeaderCase): ReadonlyArray<HeaderFeature> => {
	const sent = !Arr.some(Arr.getSomes(Rec.values(headerExpansions(c))), isRefused)
	const given = Arr.flatMap(HEADER_PARAMETERS, (parameter) => Option.toArray(c[parameter]))
	const parts = Arr.flatMap(given, (members) =>
		partsOf(Option.getOrElse(textsOf(members), () => []))
	)
	const facts = memberFacts(given)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<HeaderFeature>>>([
		Arr.flatMap(HEADER_PARAMETERS, (parameter) =>
			when(sent && Option.exists(c[parameter], Arr.isReadonlyArrayNonEmpty), HEADER_SENT[parameter])
		),
		when(
			Arr.some(parts, (part) => UNSAFE_HEADER_TEXT.test(part)),
			"an unsafe header text"
		),
		when(Arr.some(parts, Str.includes(",")), "a comma in a header"),
		when(
			Option.exists(c.exploded, (members) =>
				Arr.some(members, ([name]) => Str.includes("=")(name))
			),
			"an equals in an exploded header key"
		),
		when(sent && Arr.some(parts, Str.includes("é")), "text past ASCII in a header"),
		when(sent && Arr.some(given, Arr.isReadonlyArrayEmpty), "an empty object left out"),
		when(facts.nullMember, "a null member"),
		when(facts.nestedMember, "a nested member"),
		when(sent && facts.past2To53, "a number past 2^53")
	])
}

const headerCaseOf =
	(plain: Gen<Option.Option<Members>>, exploded: Gen<Option.Option<Members>>): Gen<HeaderCase> =>
	(source) => ({ plain: plain(source), exploded: exploded(source) })

/** Text no header line carries unchanged: a leading space, or a code point past U+00FF. */
const UNSAFE_IN_A_HEADER: Gen<MemberValue> = oneOf([
	map(SAFE_STRING, (rest) => textValue(` ${rest}`)),
	textAround(["ł"])
])

/** A header case made to reach `focus`, every other choice drawn; with no focus, every choice drawn. */
const headerCaseFor = (focus: Option.Option<HeaderFeature>): Gen<HeaderCase> => {
	if (Option.isNone(focus)) {
		return headerCaseOf(option(MEMBERS), option(MEMBERS))
	}
	switch (focus.value) {
		case "simple header sent":
			return headerCaseOf(given(SAFE_MEMBERS), SOME_SAFE)
		case "exploded header sent":
			return headerCaseOf(SOME_SAFE, given(SAFE_MEMBERS))
		case "an unsafe header text":
			return headerCaseOf(given(plus("Fk", UNSAFE_IN_A_HEADER)), NONE)
		case "a comma in a header":
			return headerCaseOf(given(plus("Fk", textAround([","]))), NONE)
		case "an equals in an exploded header key":
			return headerCaseOf(NONE, given(plus("F=", SAFE_TEXT)))
		case "text past ASCII in a header":
			return headerCaseOf(
				given(plus("Fk", (source) => textValue(`a${SAFE_STRING(source)}é`))),
				NONE
			)
		case "an empty object left out":
			return headerCaseOf(given(EMPTY), given(SAFE_MEMBERS))
		case "a null member":
			return headerCaseOf(given(plus("Fk", NULL)), NONE)
		case "a nested member":
			return headerCaseOf(NONE, given(plus("Fk", NESTED)))
		case "a number past 2^53":
			return headerCaseOf(NONE, given(plus("Fk", PAST_2_TO_53)))
	}
}

/**
 * A focus a case runs: while `features` are still pending, one of those; otherwise the drawn one, which is no focus
 * as often as some feature.
 */
const aimedFocus = <F extends string>(
	features: ReadonlyArray<F>,
	drawnFocus: Option.Option<F>,
	k: SearchCase<F>
): Option.Option<F> =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.match(
				Arr.filter(features, (feature) => pending.names(feature)),
				{
					onEmpty: () => Option.none(),
					onNonEmpty: (pendingFeatures) => Option.some(pendingFeatures)
				}
			)
		),
		{
			onNone: () => drawnFocus,
			onSome: (pendingFeatures) => Option.some(k.draw(element(pendingFeatures)))
		}
	)

/** A focus, or none, each half the time. */
const focusOf = <F extends string>(features: Arr.NonEmptyReadonlyArray<F>): Gen<Option.Option<F>> =>
	weighted([
		[1, constant(Option.none())],
		[1, map(element(features), Option.some)]
	])

/** Where text that is not JSON goes: each kind of JSON input. */
type NotJsonTarget = "a path positional" | "a query flag" | "a header flag" | "a body field flag"

const NOT_JSON_TARGETS: Arr.NonEmptyReadonlyArray<NotJsonTarget> = [
	"a path positional",
	"a query flag",
	"a header flag",
	"a body field flag"
]

/** The operation and the arguments that give `text` to a JSON input. */
const notJsonInvocation = (
	target: NotJsonTarget,
	text: string
): Readonly<{ operation: string; args: ReadonlyArray<string> }> => {
	switch (target) {
		case "a path positional":
			return { operation: "simple", args: [text] }
		case "a query flag":
			return { operation: "query", args: ["--qf", text] }
		case "a header flag":
			return { operation: "headers", args: ["--x-o", text] }
		case "a body field flag":
			return { operation: "emails", args: ["--to", text] }
	}
}

/** Text no JSON value starts with: `R`, then nothing, a comma, an equals sign or a digit. */
const NOT_JSON: Gen<string> = map(
	string(characterOf([",", "=", "1"]), { min: 0, max: 1 }),
	(rest) => `R${rest}`
)

/** An empty `204`. */
const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture: the capture server, the package built against it, and each operation's command. */
class ObjectFixture extends Context.Service<
	ObjectFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<string, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/object-parameters.test/ObjectFixture") {}

const fixture = Layer.effect(
	ObjectFixture,
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = yield* Effect.all(
			Rec.map(POINTERS, (pointer) =>
				Effect.map(
					Effect.fromOption(
						Arr.findFirst(generated.result.report.commandNames, (name) => name.pointer === pointer)
					),
					(name) => name.path
				)
			)
		)
		return { server, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

/** Runs an operation's command with these arguments against the capture server, and what the oracle compares of it. */
const observedRun = (operation: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { server, built, commands } = yield* ObjectFixture
		const command = yield* Effect.fromOption(Rec.get(commands, operation))
		const observed = yield* server.observe(
			() => done,
			runBin(built, {
				args: Arr.flatten([command, ["--base-url", server.origins["127.0.0.1"]], args]),
				env: {},
				stdin: new Uint8Array(0)
			})
		)
		const outcome: Outcome = {
			exitCode: observed.result.exitCode,
			connections: observed.connections.length,
			requests: Arr.map(observed.requests, seenOf)
		}
		return outcome
	})

/** One location's search: its features and the coverage that requires them, its cases, its invocation and oracle. */
type Location<C, F extends string> = Readonly<{
	suite: string
	features: Arr.NonEmptyReadonlyArray<F>
	coverage: RequiredCoverage<F>
	caseFor: (focus: Option.Option<F>) => Gen<C>
	featuresOf: (c: C) => ReadonlyArray<F>
	invocationOf: (c: C) => Readonly<{ operation: string; args: ReadonlyArray<string> }>
	expectedOf: (c: C) => Outcome
}>

/** The steered phase every location's coverage runs. */
const STEERED = { cases: 24, sense: notesOnly } as const

/** A location's exploration: a focus drawn from its features, aimed at a pending one, each case one run. */
const exploreLocation = <C, F extends string>(location: Location<C, F>) =>
	explore(
		{
			suite: location.suite,
			oracle: {
				kind: "second-implementation",
				name: "each style's RFC 6570 expansion of the drawn object, byte for byte against what reached the server"
			},
			draw: drawn(focusOf(location.features)),
			literal: Formatter.format,
			coverage: location.coverage,
			kept: [],
			runs: 6,
			shrink: { kind: "bounded", candidates: 30 },
			concurrency: 1,
			steerEvery: 1,
			caseHang: Duration.seconds(60)
		},
		(drawnFocus, k) =>
			Effect.gen(function* () {
				const c = k.draw(location.caseFor(aimedFocus(location.features, drawnFocus, k)))
				k.noteAll(location.featuresOf(c))
				const { operation, args } = location.invocationOf(c)
				const outcome = yield* observedRun(operation, args)
				deepStrictEqual<Outcome>(
					outcome,
					location.expectedOf(c),
					"the object is sent by its style's expansion, or refused before any connection"
				)
			})
	)

/** Every JSON input of the box, by its operation and the name its help row begins with. */
const JSON_INPUTS: ReadonlyArray<readonly [operation: string, left: string]> = Arr.appendAll(
	Arr.map(PATH_TARGETS, (target): readonly [string, string] => [target.operation, "o"]),
	[
		["query", "--qf"],
		["query", "--qn"],
		["query", "--deep"],
		["headers", "--x-o"],
		["headers", "--x-ox"],
		["emails", "--to"]
	]
)

/** What a JSON input's help shows: the help run's exit code and the input's value name. */
type Shown = Readonly<{
	operation: string
	left: string
	exitCode: number
	metavar: Option.Option<string>
}>

/** The help of a JSON input's command, and what its row shows. */
const shownOf = (operation: string, left: string) =>
	Effect.gen(function* () {
		const { built, commands } = yield* ObjectFixture
		const command = yield* Effect.fromOption(Rec.get(commands, operation))
		const help = yield* runBin(built, {
			args: Arr.append(command, "--help"),
			env: {},
			stdin: new Uint8Array(0)
		})
		const shown: Shown = {
			operation,
			left,
			exitCode: help.exitCode,
			metavar: metavarOf(Buffer.from(help.stdout).toString("utf8"), left)
		}
		return shown
	})

layer(fixture, { excludeTestServices: true })("a generated CLI's object parameters", (it) => {
	it.effect("show json as the value of every JSON input in --help", () =>
		Effect.gen(function* () {
			const shown = yield* Effect.forEach(JSON_INPUTS, ([operation, left]) =>
				shownOf(operation, left)
			)
			deepStrictEqual<ReadonlyArray<Shown>>(
				shown,
				Arr.map(JSON_INPUTS, ([operation, left]): Shown => ({
					operation,
					left,
					exitCode: 0,
					metavar: Option.some("json")
				})),
				"each object positional and flag, and the JSON body field flag, takes json"
			)
		})
	)

	it.effect("go in the path by their style's expansion, or are refused", (ctx) =>
		searched(
			ctx,
			exploreLocation({
				suite: "object parameters in the path",
				features: PATH_FEATURES,
				coverage: required<PathFeature>(PATH_FEATURES, STEERED),
				caseFor: pathCaseFor,
				featuresOf: pathFeatures,
				invocationOf: (c) => ({ operation: c.target.operation, args: pathArgs(c) }),
				expectedOf: pathExpected
			})
		)
	)

	it.effect("go in the query by their style's expansion, or are refused", (ctx) =>
		searched(
			ctx,
			exploreLocation({
				suite: "object parameters in the query",
				features: QUERY_FEATURES,
				coverage: required<QueryFeature>(QUERY_FEATURES, STEERED),
				caseFor: queryCaseFor,
				featuresOf: queryFeatures,
				invocationOf: (c) => ({ operation: "query", args: queryArgs(c) }),
				expectedOf: queryExpected
			})
		)
	)

	it.effect("go in headers unencoded, or are refused", (ctx) =>
		searched(
			ctx,
			exploreLocation({
				suite: "object parameters in headers",
				features: HEADER_FEATURES,
				coverage: required<HeaderFeature>(HEADER_FEATURES, STEERED),
				caseFor: headerCaseFor,
				featuresOf: headerFeatures,
				invocationOf: (c) => ({ operation: "headers", args: headerArgs(c) }),
				expectedOf: headerExpected
			})
		)
	)

	it.effect("refuse text that is not JSON before any connection", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "object parameters: text that is not JSON",
					oracle: { kind: "specification", name: "exit 2 before any connection" },
					box: "every JSON input kind, given R alone or R and one of , = 1",
					concurrency: 1,
					generator: (source) => ({
						target: element(NOT_JSON_TARGETS)(source),
						text: NOT_JSON(source)
					}),
					literal: Formatter.format,
					coverage: requiredInSpace<NotJsonTarget>(NOT_JSON_TARGETS),
					caseHang: Duration.seconds(60)
				},
				({ target, text }, k) =>
					Effect.gen(function* () {
						k.note(target)
						const { operation, args } = notJsonInvocation(target, text)
						const outcome = yield* observedRun(operation, args)
						deepStrictEqual<Outcome>(
							outcome,
							REFUSED_RUN,
							"text that is not JSON is a usage error before any connection"
						)
					})
			)
		)
	)
})
