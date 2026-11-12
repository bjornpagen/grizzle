/**
 * A generated CLI sends a `deepObject` value as its schema and the author config's two switches say, and has no way to
 * send one they leave undefined. A form body's Encoding entries and a query's parameters share the rules:
 *
 * - An object of scalars is the standard case, `name[key]=value`, under every config.
 * - A nested object or an array goes in brackets, `name[a][b]=value` with an array item by its index, only under
 *   `nonStandard.deepObjectBrackets`.
 * - A scalar of a schema that also admits objects is one `name=value` pair only under `nonStandard.deepObjectScalars`;
 *   a schema with both a scalar branch and a nested one needs both switches.
 * - A schema with a branch no switch covers, such as `null`, is refused under every config.
 *
 * A refused field has no flag, is named on its command's REFUSED help line and in `--describe`'s `refusedFields`, and
 * `--body` holding it is a usage error that names the field and never shows its value. A refused parameter has no flag
 * and is named on REFUSED. An operation whose required field is refused has no command.
 *
 * One package per config: neither switch, each alone, and both. Per config:
 *
 * - A check of `--describe` and help against the rules: the commands, the field and parameter flags, the refused fields
 *   and the REFUSED lines.
 * - A property over three kinds of run, one per case. An update gives each field the config admits or not, by its flags
 *   or in `--body`, with text past ASCII and text needing encoding, numbers past 2^53 and empty objects. A list gives
 *   each query parameter or not. A planted fault is a refused field in `--body`, a refused element's flag, or a value
 *   outside its field's schema. Oracles: the pairs the rules give, in property and member order, read back off the
 *   wire by each wire's own rules (a form body as the WHATWG URL Standard reads it, where `+` is a space; a query as
 *   RFC 3986 percent-encoding, where `+` is a plus); and exit 2 with no connection for each fault.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { type Case as SearchCase, drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	subarray,
	weighted
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	Order,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { Description } from "#runtime-src/runtime/describe.ts"
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
import { formPairs, type Pair, queryPairs } from "#test/support/form.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** An author config switch for `deepObject`. */
type Switch = "brackets" | "scalars"

/** A config the suite builds a package under: its switches, and how its tests name it. */
type Mode = Readonly<{ label: string; switches: ReadonlyArray<Switch> }>

/** Every config: neither switch, each alone, and both. */
const MODES: Arr.NonEmptyReadonlyArray<Mode> = [
	{ label: "neither switch", switches: [] },
	{ label: "the bracket switch", switches: ["brackets"] },
	{ label: "the scalar switch", switches: ["scalars"] },
	{ label: "both switches", switches: ["brackets", "scalars"] }
]

/** Whether a config sets a switch. */
const sets = (mode: Mode, wanted: Switch): boolean => Arr.contains(mode.switches, wanted)

/** A property of the update's form body. */
type Field = "name" | "filters" | "metadata" | "active_from" | "period" | "labels" | "closed_at"

/** The update's form body properties in document order. */
const FIELDS: ReadonlyArray<Field> = [
	"name",
	"filters",
	"metadata",
	"active_from",
	"period",
	"labels",
	"closed_at"
]

/** A query parameter of the list. */
type Parameter = "created" | "tree"

/** The list's query parameters in document order. */
const PARAMETERS: ReadonlyArray<Parameter> = ["created", "tree"]

/**
 * The switches each field and parameter needs before it is sent, none for one no switch admits, by its schema's shape:
 * `name` has no `deepObject` Encoding; `filters` is an object of scalars; `metadata` and `tree` nest an object;
 * `active_from` is a number or the string `now`; `period` and `created` are an object of scalars or a number; `labels`
 * is a nested object or the empty string; and `closed_at` is an object or `null`.
 */
const NEEDS: Readonly<Record<Field | Parameter, Option.Option<ReadonlyArray<Switch>>>> = {
	name: Option.some([]),
	filters: Option.some([]),
	metadata: Option.some(["brackets"]),
	active_from: Option.some(["scalars"]),
	period: Option.some(["scalars"]),
	labels: Option.some(["brackets", "scalars"]),
	closed_at: Option.none(),
	created: Option.some(["scalars"]),
	tree: Option.some(["brackets"])
}

/** Whether a config admits a field or a parameter: it sets every switch the element needs. */
const admits = (mode: Mode, at: Field | Parameter): boolean =>
	Option.exists(NEEDS[at], (needed) => Arr.every(needed, (wanted) => sets(mode, wanted)))

const FORM = "application/x-www-form-urlencoded"

/** A `deepObject` Encoding entry or parameter style. */
const DEEP = { style: "deepObject", explode: true }

const NUMBER = { type: "number" }

const STRING = { type: "string" }

/** An object schema with these properties. */
const objectSchema = (properties: Readonly<Record<string, Schema.Json>>): Schema.Json => ({
	type: "object",
	properties
})

const ACTIVE_FROM: Schema.Json = { anyOf: [NUMBER, { type: "string", enum: ["now"] }] }

/** A list with two deepObject query parameters, a create whose required field is a scalar union, and an update. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Deep objects", version: "1.0.0" },
	paths: {
		"/charges": {
			get: {
				operationId: "charges-list",
				parameters: [
					{
						in: "query",
						name: "created",
						...DEEP,
						schema: { anyOf: [objectSchema({ gt: NUMBER, lt: NUMBER }), NUMBER] }
					},
					{
						in: "query",
						name: "tree",
						...DEEP,
						schema: objectSchema({ a: objectSchema({ b: STRING }) })
					}
				],
				responses: { "204": { description: "Listed." } }
			},
			post: {
				operationId: "charges-create",
				requestBody: {
					required: true,
					content: {
						[FORM]: {
							schema: {
								type: "object",
								properties: { active_from: ACTIVE_FROM, note: STRING },
								required: ["active_from"]
							},
							encoding: { active_from: DEEP }
						}
					}
				},
				responses: { "204": { description: "Created." } }
			}
		},
		"/charges/{id}": {
			post: {
				operationId: "charges-update",
				parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
				requestBody: {
					required: false,
					content: {
						[FORM]: {
							schema: objectSchema({
								name: STRING,
								filters: objectSchema({ limit: NUMBER, status: STRING }),
								metadata: objectSchema({
									owner: objectSchema({ id: STRING, tags: { type: "array", items: STRING } })
								}),
								active_from: ACTIVE_FROM,
								period: { anyOf: [objectSchema({ gt: NUMBER }), NUMBER] },
								labels: {
									anyOf: [
										objectSchema({ a: objectSchema({ b: STRING }) }),
										{ type: "string", enum: [""] }
									]
								},
								closed_at: { anyOf: [objectSchema({ before: STRING }), { type: "null" }] }
							}),
							encoding: {
								filters: DEEP,
								metadata: DEEP,
								active_from: DEEP,
								period: DEEP,
								labels: DEEP,
								closed_at: DEEP
							}
						}
					}
				},
				responses: { "204": { description: "Updated." } }
			}
		}
	}
})

/** The author config under a mode, binding the capture server's origin. */
const configOf = (bound: string, mode: Mode): string =>
	jsonTextOf({
		package: { name: "deep-objects", version: "1.0.0" },
		binName: "charges",
		envPrefix: "CHARGES",
		acceptedOrigins: [bound],
		allowInsecure: true,
		nonStandard: {
			deepObjectBrackets: sets(mode, "brackets"),
			deepObjectScalars: sets(mode, "scalars")
		}
	})

const LIST = "/paths/~1charges/get"

const CREATE = "/paths/~1charges/post"

const UPDATE = "/paths/~1charges~1{id}/post"

/** A command a case runs. */
type Command = "update" | "list"

const POINTERS: Readonly<Record<Command, string>> = { update: UPDATE, list: LIST }

/** A value an operator gives: text, a number by its digits, an object's members in order, or an array's items. */
type Value =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "number"; readonly digits: string }
	| { readonly kind: "object"; readonly members: ReadonlyArray<readonly [string, Value]> }
	| { readonly kind: "array"; readonly items: ReadonlyArray<Value> }

const textOf = (text: string): Value => ({ kind: "text", text })

const numberOf = (digits: string): Value => ({ kind: "number", digits })

const objectOf = (members: ReadonlyArray<readonly [string, Value]>): Value => ({
	kind: "object",
	members
})

/** A value's JSON text, a number as its digits. */
const jsonOf = (value: Value): string => {
	switch (value.kind) {
		case "text":
			return jsonTextOf(value.text)
		case "number":
			return value.digits
		case "object":
			return `{${Arr.join(
				Arr.map(value.members, ([key, member]) => `${jsonTextOf(key)}:${jsonOf(member)}`),
				","
			)}}`
		case "array":
			return `[${Arr.join(Arr.map(value.items, jsonOf), ",")}]`
	}
}

/** A value's text as a flag takes it: text as written, a number as its digits, an object or array as its JSON. */
const flagTextOf = (value: Value): string => {
	switch (value.kind) {
		case "text":
			return value.text
		case "number":
			return value.digits
		case "object":
		case "array":
			return jsonOf(value)
	}
}

/** A leaf of a value: the member names and item indexes on its path, and its text. */
type Leaf = readonly [path: ReadonlyArray<string>, text: string]

/** A value's leaves in document order: members in their order, items by index. */
const leavesOf = (value: Value, path: ReadonlyArray<string>): ReadonlyArray<Leaf> => {
	switch (value.kind) {
		case "text":
			return [[path, value.text]]
		case "number":
			return [[path, value.digits]]
		case "object":
			return Arr.flatMap(value.members, ([key, member]) => leavesOf(member, Arr.append(path, key)))
		case "array":
			return Arr.flatMap(value.items, (item, index) =>
				leavesOf(item, Arr.append(path, String(index)))
			)
	}
}

/** The pairs the rules send for a value under its name: each leaf as `name[k1]…[kn]=text`, a scalar as `name=text`. */
const pairsOf = (name: string, value: Value): ReadonlyArray<Pair> =>
	Arr.map(leavesOf(value, []), ([path, text]): Pair => [
		`${name}${Arr.join(
			Arr.map(path, (key) => `[${key}]`),
			""
		)}`,
		text
	])

/** Whether some node of a value, the value itself included, holds. */
const someNode = (value: Value, holds: (node: Value) => boolean): boolean => {
	if (holds(value)) {
		return true
	}
	switch (value.kind) {
		case "object":
			return Arr.some(value.members, ([, member]) => someNode(member, holds))
		case "array":
			return Arr.some(value.items, (item) => someNode(item, holds))
		case "text":
		case "number":
			return false
	}
}

const isScalar = (value: Value): boolean => value.kind === "text" || value.kind === "number"

const isEmptyObject = (value: Value): boolean =>
	value.kind === "object" && Arr.isReadonlyArrayEmpty(value.members)

const isFilledArray = (value: Value): boolean =>
	value.kind === "array" && Arr.isReadonlyArrayNonEmpty(value.items)

/** A character the form and query encoders percent-encode or write as `+`. */
const ENCODED = regex("[^A-Za-z0-9*._-]", "u")

const needsEncoding = (value: Value): boolean => value.kind === "text" && ENCODED.test(value.text)

/** A number with more digits than any integer below 2^53. */
const isPast2To53 = (value: Value): boolean => value.kind === "number" && value.digits.length > 16

/** Whether a value has a leaf below a member of a member: the bracket convention's case. */
const isNested = (value: Value): boolean =>
	Arr.some(leavesOf(value, []), ([path]) => path.length > 1)

/** Characters of text: plain ones and every one a form or query encodes. */
const TEXT_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	"0",
	" ",
	"&",
	"=",
	"+",
	"%",
	"é",
	"[",
	"/"
]

const ENCODED_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = [" ", "&", "=", "+", "%", "é", "["]

const DIGITS: Arr.NonEmptyReadonlyArray<string> = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

/** Text no flag parser could read as a flag: it never starts with `-`. */
const plainText: Gen<string> = string(characterOf(TEXT_CHARACTERS), { min: 0, max: 5 })

const text: Gen<Value> = map(plainText, textOf)

/** Text with at least one character a form encodes. */
const encodedText: Gen<Value> = (source) =>
	textOf(`${plainText(source)}${element(ENCODED_CHARACTERS)(source)}${plainText(source)}`)

/** A non-negative whole number of 17 to 19 digits, past 2^53, which a JavaScript number cannot hold exactly. */
const past2To53: Gen<Value> = map(string(characterOf(DIGITS), { min: 16, max: 18 }), (rest) =>
	numberOf(`9${rest}`)
)

/** A non-negative whole number: mostly small, sometimes past 2^53. */
const number: Gen<Value> = weighted([
	[3, map(int(0, 9999), (whole) => numberOf(String(whole)))],
	[1, past2To53]
])

/** An object with some of `members`, in their order, each drawn by its generator. */
const someOf =
	(members: ReadonlyArray<readonly [string, Gen<Value>]>): Gen<Value> =>
	(source) =>
		objectOf(
			Arr.map(subarray(members)(source), ([key, member]): readonly [string, Value] => [
				key,
				member(source)
			])
		)

/** An object with every one of `members`, each drawn by its generator. */
const allOf =
	(members: ReadonlyArray<readonly [string, Gen<Value>]>): Gen<Value> =>
	(source) =>
		objectOf(Arr.map(members, ([key, member]): readonly [string, Value] => [key, member(source)]))

const arrayOf =
	(items: Gen<ReadonlyArray<Value>>): Gen<Value> =>
	(source) => ({ kind: "array", items: items(source) })

const owner: Gen<Value> = someOf([
	["id", text],
	["tags", arrayOf(array(text, { min: 0, max: 2 }))]
])

/** Each field's and parameter's values, all within its schema. */
const VALUES: Readonly<Record<Field | Parameter, Gen<Value>>> = {
	name: text,
	filters: someOf([
		["limit", number],
		["status", text]
	]),
	metadata: someOf([["owner", owner]]),
	active_from: oneOf([number, constant(textOf("now"))]),
	period: oneOf([someOf([["gt", number]]), number]),
	labels: oneOf([someOf([["a", someOf([["b", text]])]]), constant(textOf(""))]),
	closed_at: someOf([["before", text]]),
	created: oneOf([
		someOf([
			["gt", number],
			["lt", number]
		]),
		number
	]),
	tree: someOf([["a", someOf([["b", text]])]])
}

/**
 * How a field's flags take its value: one text flag, one JSON flag, or a dotted flag per member of its object, each
 * taking the member's text or JSON.
 */
type FlagForm =
	| Readonly<{ kind: "text" }>
	| Readonly<{ kind: "json" }>
	| Readonly<{ kind: "members"; members: Arr.NonEmptyReadonlyArray<string> }>

const FLAG_FORMS: Readonly<Record<Field, FlagForm>> = {
	name: { kind: "text" },
	filters: { kind: "members", members: ["limit", "status"] },
	metadata: { kind: "members", members: ["owner"] },
	active_from: { kind: "json" },
	period: { kind: "json" },
	labels: { kind: "json" },
	closed_at: { kind: "json" }
}

/** A field's or parameter's flag name: its wire name in kebab case. */
const flagNameOf = (name: string): string => Str.replaceAll("_", "-")(name)

/** The flag names a field has when its config admits it. */
const flagNamesOf = (field: Field): ReadonlyArray<string> => {
	const form = FLAG_FORMS[field]
	return form.kind === "members"
		? Arr.map(form.members, (member) => `${flagNameOf(field)}.${member}`)
		: [flagNameOf(field)]
}

/** The arguments that give a field's value by its flags: none for an object with no member. */
const flagArgsOf = (field: Field, value: Value): ReadonlyArray<string> => {
	const form = FLAG_FORMS[field]
	switch (form.kind) {
		case "text":
			return [`--${flagNameOf(field)}`, flagTextOf(value)]
		case "json":
			return [`--${flagNameOf(field)}`, jsonOf(value)]
		case "members":
			return value.kind === "object"
				? Arr.flatMap(value.members, ([key, member]) => [
						`--${flagNameOf(field)}.${key}`,
						flagTextOf(member)
					])
				: [`--${flagNameOf(field)}`, jsonOf(value)]
	}
}

/**
 * The JSON values a field's input holds: the whole value in `--body` or by a JSON flag, and each object or array
 * member by a dotted flag.
 */
const jsonInputsOf = (given: Given): ReadonlyArray<Value> => {
	if (given.route === "body") {
		return [given.value]
	}
	const form = FLAG_FORMS[given.field]
	switch (form.kind) {
		case "text":
			return []
		case "json":
			return [given.value]
		case "members":
			return given.value.kind === "object"
				? Arr.filter(
						Arr.map(given.value.members, ([, member]) => member),
						(member) => !isScalar(member)
					)
				: [given.value]
	}
}

/** Where an operator gives a field: by its flags, or in `--body`. */
type Route = "flag" | "body"

/** A field an update gives: its value and its route. */
type Given = Readonly<{ field: Field; value: Value; route: Route }>

/** A fault planted in a run. */
type Fault = "a refused field in --body" | "a refused flag" | "a value outside its schema"

/** A planted fault's stderr check: the refused field it must name and the marker value it must never show. */
type Guarded = Readonly<{ field: Field; marker: string }>

/** One run: an update, a list, or a planted fault with its command and arguments. */
type Case =
	| Readonly<{ kind: "update"; id: string; given: ReadonlyArray<Given> }>
	| Readonly<{ kind: "list"; sent: ReadonlyArray<readonly [Parameter, Value]> }>
	| Readonly<{
			kind: "fault"
			fault: Fault
			command: Command
			args: ReadonlyArray<string>
			guard: Option.Option<Guarded>
	  }>

/** The `--body` an update gives: the fields routed there, in document order, or none. */
const bodyArgsOf = (given: ReadonlyArray<Given>): ReadonlyArray<string> =>
	Arr.match(
		Arr.filter(given, (one) => one.route === "body"),
		{
			onEmpty: () => [],
			onNonEmpty: (inBody) => [
				"--body",
				jsonOf(objectOf(Arr.map(inBody, (one): readonly [string, Value] => [one.field, one.value])))
			]
		}
	)

/** Every body input an update gives: its `--body` and its fields' flags. */
const bodyInputsOf = (given: ReadonlyArray<Given>): ReadonlyArray<string> => {
	const byFlag = Arr.filter(given, (one) => one.route === "flag")
	return Arr.appendAll(
		bodyArgsOf(given),
		Arr.flatMap(byFlag, (one) => flagArgsOf(one.field, one.value))
	)
}

/** The command a case runs and its arguments after the command. */
const invocationOf = (c: Case): Readonly<{ command: Command; args: ReadonlyArray<string> }> => {
	switch (c.kind) {
		case "update":
			return { command: "update", args: Arr.prepend(bodyInputsOf(c.given), c.id) }
		case "list":
			return {
				command: "list",
				args: Arr.flatMap(c.sent, ([parameter, value]) => [`--${parameter}`, jsonOf(value)])
			}
		case "fault":
			return { command: c.command, args: c.args }
	}
}

/** A request as the oracle compares it: method, path, media type essence, and the query's and the form's pairs. */
type Received = Readonly<{
	method: string
	path: string
	contentType: Option.Option<string>
	query: ReadonlyArray<Pair>
	form: ReadonlyArray<Pair>
}>

/** What a fault's stderr says: whether it names the refused field, and whether it shows the marker value. */
type Guard = Readonly<{ namesField: boolean; showsValue: boolean }>

/** What the oracle compares of a run. */
type Outcome = Readonly<{
	exitCode: number
	connections: number
	requests: ReadonlyArray<Received>
	guard: Option.Option<Guard>
}>

/** A content type's essence: the media type before any parameter. */
const essenceOf = (contentType: string): string =>
	Str.trim(Arr.headNonEmpty(Str.split(";")(contentType)))

/** A recorded request as the oracle compares it. */
const receivedOf = (request: WireRequest): Received => ({
	method: request.method,
	path: Arr.headNonEmpty(Str.split("?")(request.target)),
	contentType: Option.map(Arr.head(valuesOf(request.headers, "content-type")), essenceOf),
	query: queryPairs(request.target),
	form: formPairs(request.body)
})

/**
 * The run the rules give: an update sends one POST whose form holds each given field's pairs, with the form's media type
 * exactly when some body input was given; a list sends one GET whose query holds each given parameter's pairs; a fault
 * exits 2 with no connection, a refused field in `--body` named and its value never shown.
 */
const expectedOf = (c: Case): Outcome => {
	switch (c.kind) {
		case "update":
			return {
				exitCode: 0,
				connections: 1,
				requests: [
					{
						method: "POST",
						path: `/charges/${c.id}`,
						contentType: Arr.isReadonlyArrayEmpty(bodyInputsOf(c.given))
							? Option.none()
							: Option.some(FORM),
						query: [],
						form: Arr.flatMap(c.given, (one) => pairsOf(one.field, one.value))
					}
				],
				guard: Option.none()
			}
		case "list":
			return {
				exitCode: 0,
				connections: 1,
				requests: [
					{
						method: "GET",
						path: "/charges",
						contentType: Option.none(),
						query: Arr.flatMap(c.sent, ([parameter, value]) => pairsOf(parameter, value)),
						form: []
					}
				],
				guard: Option.none()
			}
		case "fault":
			return {
				exitCode: 2,
				connections: 0,
				requests: [],
				guard: Option.map(c.guard, (): Guard => ({ namesField: true, showsValue: false }))
			}
	}
}

/** A situation a case reaches. */
type Feature =
	| Fault
	| "nothing given"
	| "a field by its flag"
	| "a field in --body"
	| "text needing encoding"
	| "a number past 2^53"
	| "an empty object"
	| "a list request"
	| "a scalar as one pair"
	| "a query scalar"
	| "a query object"
	| "an object in brackets"
	| "an array in brackets"
	| "a nested query object"
	| "the empty string as one pair"

/** The situations every config's property must reach. */
const COMMON_FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"nothing given",
	"a field by its flag",
	"a field in --body",
	"text needing encoding",
	"a number past 2^53",
	"an empty object",
	"a list request",
	"a refused field in --body",
	"a refused flag",
	"a value outside its schema"
]

/** What a config's property must reach: the situations every config has, and those its switches add. */
const featuresOf = (mode: Mode): Arr.NonEmptyReadonlyArray<Feature> =>
	Arr.appendAll(
		COMMON_FEATURES,
		Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
			sets(mode, "scalars") ? ["a scalar as one pair", "a query scalar", "a query object"] : [],
			sets(mode, "brackets")
				? ["an object in brackets", "an array in brackets", "a nested query object"]
				: [],
			admits(mode, "labels") ? ["the empty string as one pair"] : []
		])
	)

/** A feature when it holds, none otherwise. */
const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> => (holds ? [feature] : [])

/** The fields whose schema admits a scalar beside objects. */
const SCALAR_FIELDS: ReadonlyArray<Field> = ["active_from", "period", "labels"]

/** The features an update reaches. */
const updateFeatures = (given: ReadonlyArray<Given>): ReadonlyArray<Feature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
		when(Arr.isReadonlyArrayEmpty(given), "nothing given"),
		when(
			Arr.some(
				given,
				(one) =>
					one.route === "flag" && Arr.isReadonlyArrayNonEmpty(flagArgsOf(one.field, one.value))
			),
			"a field by its flag"
		),
		when(
			Arr.some(given, (one) => one.route === "body"),
			"a field in --body"
		),
		when(
			Arr.some(given, (one) => someNode(one.value, needsEncoding)),
			"text needing encoding"
		),
		when(
			Arr.some(given, (one) => someNode(one.value, isPast2To53)),
			"a number past 2^53"
		),
		when(
			Arr.some(given, (one) =>
				Arr.some(jsonInputsOf(one), (input) => someNode(input, isEmptyObject))
			),
			"an empty object"
		),
		when(
			Arr.some(given, (one) => Arr.contains(SCALAR_FIELDS, one.field) && isScalar(one.value)),
			"a scalar as one pair"
		),
		when(
			Arr.some(given, (one) => isNested(one.value)),
			"an object in brackets"
		),
		when(
			Arr.some(given, (one) => someNode(one.value, isFilledArray)),
			"an array in brackets"
		),
		when(
			Arr.some(given, (one) => one.field === "labels" && one.value.kind === "text"),
			"the empty string as one pair"
		)
	])

/** The features a list reaches. */
const listFeatures = (sent: ReadonlyArray<readonly [Parameter, Value]>): ReadonlyArray<Feature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
		["a list request"],
		when(
			Arr.some(sent, ([parameter, value]) => parameter === "created" && isScalar(value)),
			"a query scalar"
		),
		when(
			Arr.some(
				sent,
				([parameter, value]) =>
					parameter === "created" && value.kind === "object" && !isEmptyObject(value)
			),
			"a query object"
		),
		when(
			Arr.some(sent, ([parameter, value]) => parameter === "tree" && isNested(value)),
			"a nested query object"
		)
	])

/** The features a case reaches. */
const caseFeatures = (c: Case): ReadonlyArray<Feature> => {
	switch (c.kind) {
		case "update":
			return updateFeatures(c.given)
		case "list":
			return listFeatures(c.sent)
		case "fault":
			return [c.fault]
	}
}

const ID: Gen<string> = string(characterOf(["c", "7", "x"]), { min: 1, max: 3 })

const ROUTE: Gen<Route> = element<Route>(["flag", "body"])

/** `items` in `order`, `one` in place of any item with its key. */
const withOne = <K, A>(
	order: ReadonlyArray<K>,
	items: ReadonlyArray<A>,
	keyOf: (item: A) => K,
	one: A
): ReadonlyArray<A> =>
	Arr.flatMap(order, (key) =>
		key === keyOf(one) ? [one] : Arr.filter(items, (item) => keyOf(item) === key)
	)

/** A field given with a value and a route drawn by these generators. */
const givenOf =
	(field: Field, value: Gen<Value>, route: Gen<Route>): Gen<Given> =>
	(source) => ({ field, value: value(source), route: route(source) })

/** An update: each field the config admits given or not, by a random route, and then the forced one in its place. */
const updateOf =
	(mode: Mode, forced: Option.Option<Gen<Given>>): Gen<Case> =>
	(source) => {
		const id = ID(source)
		const admitted = Arr.filter(FIELDS, (field) => admits(mode, field))
		const drawnGiven = Arr.flatMap(admitted, (field) =>
			Option.toArray(option(givenOf(field, VALUES[field], ROUTE))(source))
		)
		return {
			kind: "update",
			id,
			given: Option.match(forced, {
				onNone: () => drawnGiven,
				onSome: (one) => withOne(FIELDS, drawnGiven, (item) => item.field, one(source))
			})
		}
	}

/** A parameter sent with a value drawn by this generator. */
const sentOf =
	(parameter: Parameter, value: Gen<Value>): Gen<readonly [Parameter, Value]> =>
	(source) => [parameter, value(source)]

/** A list: each parameter the config admits sent or not, and then the forced one in its place. */
const listOf =
	(mode: Mode, forced: Option.Option<Gen<readonly [Parameter, Value]>>): Gen<Case> =>
	(source) => {
		const admitted = Arr.filter(PARAMETERS, (parameter) => admits(mode, parameter))
		const drawnSent = Arr.flatMap(admitted, (parameter) =>
			Option.toArray(option(sentOf(parameter, VALUES[parameter]))(source))
		)
		return {
			kind: "list",
			sent: Option.match(forced, {
				onNone: () => drawnSent,
				onSome: (one) => withOne(PARAMETERS, drawnSent, ([parameter]) => parameter, one(source))
			})
		}
	}

/** A refused field that holds text: the one its marker goes in. */
type Markable = "closed_at" | "metadata" | "labels"

/** A refused field's value holding the marker as its one text. */
const MARKED: Readonly<Record<Markable, (marker: string) => Value>> = {
	closed_at: (marker) => objectOf([["before", textOf(marker)]]),
	metadata: (marker) => objectOf([["owner", objectOf([["id", textOf(marker)]])]]),
	labels: (marker) => objectOf([["a", objectOf([["b", textOf(marker)]])]])
}

/** The field no switch admits. */
const CLOSED_AT: Markable = "closed_at"

/** The markable fields a switch admits. */
const MARKABLE_BY_SWITCH: ReadonlyArray<Markable> = ["metadata", "labels"]

/** A marker no stderr holds unless it shows the value. */
const MARKER: Gen<string> = map(int(1000, 999_999), (digits) => `zq${digits}`)

/** A field the config refuses, given in `--body` with the marker as its text. */
const refusedInBodyOf =
	(mode: Mode): Gen<Case> =>
	(source) => {
		const field = element(
			Arr.prepend(
				Arr.filter(MARKABLE_BY_SWITCH, (candidate) => !admits(mode, candidate)),
				CLOSED_AT
			)
		)(source)
		const marker = MARKER(source)
		return {
			kind: "fault",
			fault: "a refused field in --body",
			command: "update",
			args: [ID(source), "--body", jsonOf(objectOf([[field, MARKED[field](marker)]]))],
			guard: Option.some({ field, marker })
		}
	}

/** An element the config refuses whose flag a fault gives. */
type Refused =
	| Readonly<{ kind: "field"; field: Field }>
	| Readonly<{ kind: "parameter"; parameter: Parameter }>

/** Values a refused field's flags would carry: an object with a member, so a dotted flag has something to take. */
const FLAGGED: Readonly<Record<Field, Gen<Value>>> = {
	...VALUES,
	metadata: allOf([["owner", owner]])
}

/** The flag of the field no switch admits. */
const CLOSED_AT_FLAG: Refused = { kind: "field", field: "closed_at" }

/** The flag a config refuses given anyway: a refused field's on the update, a refused parameter's on the list. */
const refusedFlagOf =
	(mode: Mode): Gen<Case> =>
	(source) => {
		const target = element(
			Arr.prepend(
				Arr.appendAll(
					Arr.map(
						Arr.filter(FIELDS, (field) => field !== "closed_at" && !admits(mode, field)),
						(field): Refused => ({ kind: "field", field })
					),
					Arr.map(
						Arr.filter(PARAMETERS, (parameter) => !admits(mode, parameter)),
						(parameter): Refused => ({ kind: "parameter", parameter })
					)
				),
				CLOSED_AT_FLAG
			)
		)(source)
		switch (target.kind) {
			case "field":
				return {
					kind: "fault",
					fault: "a refused flag",
					command: "update",
					args: Arr.prepend(flagArgsOf(target.field, FLAGGED[target.field](source)), ID(source)),
					guard: Option.none()
				}
			case "parameter":
				return {
					kind: "fault",
					fault: "a refused flag",
					command: "list",
					args: [`--${target.parameter}`, jsonOf(VALUES[target.parameter](source))],
					guard: Option.none()
				}
		}
	}

/** Text of at least one character: never the empty string `labels` admits, never `now`. */
const filledText: Gen<Value> = map(string(characterOf(TEXT_CHARACTERS), { min: 1, max: 5 }), textOf)

/** Text for `filters`' number, in `--body`. */
const FILTERS_OUTSIDE: Gen<ReadonlyArray<string>> = (source) => [
	"--body",
	jsonOf(objectOf([["filters", objectOf([["limit", text(source)]])]]))
]

/** Text for `active_from`, which admits only numbers and `now`, by its flag. */
const ACTIVE_FROM_OUTSIDE: Gen<ReadonlyArray<string>> = (source) => [
	"--active-from",
	jsonOf(filledText(source))
]

/** Text other than the empty string for `labels`, by its flag. */
const LABELS_OUTSIDE: Gen<ReadonlyArray<string>> = (source) => [
	"--labels",
	jsonOf(filledText(source))
]

/**
 * A value outside its field's schema: text for `filters`' number in `--body`, under every config; text for
 * `active_from`, which admits only numbers and `now`, by its flag where the scalar switch admits it; and text other than
 * the empty string for `labels`, by its flag where both switches admit it.
 */
const outsideSchemaOf =
	(mode: Mode): Gen<Case> =>
	(source) => {
		const args = oneOf(
			Arr.prepend(
				Arr.flatten<ReadonlyArray<ReadonlyArray<Gen<ReadonlyArray<string>>>>>([
					admits(mode, "active_from") ? [ACTIVE_FROM_OUTSIDE] : [],
					admits(mode, "labels") ? [LABELS_OUTSIDE] : []
				]),
				FILTERS_OUTSIDE
			)
		)(source)
		return {
			kind: "fault",
			fault: "a value outside its schema",
			command: "update",
			args: Arr.prepend(args, ID(source)),
			guard: Option.none()
		}
	}

/**
 * The case a focus draws: a run made to reach that feature, every other choice drawn at random, so steering reaches each
 * pending feature by naming it.
 */
const caseFor = (mode: Mode, focus: Feature): Gen<Case> => {
	switch (focus) {
		case "nothing given":
			return (source) => ({ kind: "update", id: ID(source), given: [] })
		case "a field by its flag":
			return updateOf(mode, Option.some(givenOf("name", text, constant<Route>("flag"))))
		case "a field in --body":
			return updateOf(mode, Option.some(givenOf("name", text, constant<Route>("body"))))
		case "text needing encoding":
			return updateOf(mode, Option.some(givenOf("name", encodedText, ROUTE)))
		case "a number past 2^53":
			return updateOf(mode, Option.some(givenOf("filters", allOf([["limit", past2To53]]), ROUTE)))
		case "an empty object":
			return updateOf(
				mode,
				Option.some(givenOf("filters", constant(objectOf([])), constant<Route>("body")))
			)
		case "a list request":
			return listOf(mode, Option.none())
		case "a scalar as one pair":
			return updateOf(mode, Option.some(givenOf("active_from", VALUES.active_from, ROUTE)))
		case "a query scalar":
			return listOf(mode, Option.some(sentOf("created", number)))
		case "a query object":
			return listOf(mode, Option.some(sentOf("created", allOf([["gt", number]]))))
		case "an object in brackets":
			return updateOf(
				mode,
				Option.some(givenOf("metadata", allOf([["owner", allOf([["id", text]])]]), ROUTE))
			)
		case "an array in brackets":
			return updateOf(
				mode,
				Option.some(
					givenOf(
						"metadata",
						allOf([["owner", allOf([["tags", arrayOf(array(text, { min: 1, max: 2 }))]])]]),
						ROUTE
					)
				)
			)
		case "a nested query object":
			return listOf(mode, Option.some(sentOf("tree", allOf([["a", allOf([["b", text]])]]))))
		case "the empty string as one pair":
			return updateOf(mode, Option.some(givenOf("labels", constant(textOf("")), ROUTE)))
		case "a refused field in --body":
			return refusedInBodyOf(mode)
		case "a refused flag":
			return refusedFlagOf(mode)
		case "a value outside its schema":
			return outsideSchemaOf(mode)
	}
}

/** A focus a case runs: the drawn one, or, while the config's features are still pending, one of those. */
const aimedFocus = (mode: Mode, drawnFocus: Feature, k: SearchCase<Feature>): Feature =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.match(
				Arr.filter(featuresOf(mode), (feature) => pending.names(feature)),
				{
					onEmpty: () => Option.none(),
					onNonEmpty: (pendingFeatures) => Option.some(pendingFeatures)
				}
			)
		),
		{
			onNone: () => drawnFocus,
			onSome: (pendingFeatures) => k.draw(element(pendingFeatures))
		}
	)

/** An empty `204`. */
const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/**
 * What `--describe` and help say of a package: each run's exit code, the commands, the update's field flags and refused
 * fields, the list's parameter flags, and the names each command's REFUSED line gives, the flag lists sorted.
 */
type Surface = Readonly<{
	exitCodes: ReadonlyArray<number>
	commands: ReadonlyArray<string>
	updateFlags: ReadonlyArray<string>
	refusedFields: ReadonlyArray<Readonly<{ mediaType: string; name: string }>>
	listFlags: ReadonlyArray<string>
	updateRefused: ReadonlyArray<string>
	listRefused: ReadonlyArray<string>
}>

const sorted = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(names, Order.String)

/**
 * What the rules make of a config: the create command exactly when its required field is admitted, a flag for each
 * admitted field and parameter, and each refused one in `refusedFields` in document order and on its REFUSED line.
 */
const expectedSurface = (mode: Mode): Surface => {
	const admittedFields = Arr.filter(FIELDS, (field) => admits(mode, field))
	const refusedFields = Arr.filter(FIELDS, (field) => !admits(mode, field))
	const admittedParameters = Arr.filter(PARAMETERS, (parameter) => admits(mode, parameter))
	const refusedParameters = Arr.filter(PARAMETERS, (parameter) => !admits(mode, parameter))
	return {
		exitCodes: [0, 0, 0],
		commands: sorted(Arr.appendAll([LIST, UPDATE], admits(mode, "active_from") ? [CREATE] : [])),
		updateFlags: sorted(Arr.flatMap(admittedFields, flagNamesOf)),
		refusedFields: Arr.map(refusedFields, (name) => ({ mediaType: FORM, name })),
		listFlags: sorted(admittedParameters),
		updateRefused: sorted(refusedFields),
		listRefused: sorted(refusedParameters)
	}
}

/** One REFUSED entry's wire name: the space-free text before its `: `. */
const REFUSED_ENTRY = regex("^([^\\s:;]+): ", "u")

/**
 * The wire names a help text's REFUSED line gives, none without the line. Entries are `<wire>: <reason>` joined by
 * `; `; a reason may hold `; ` itself, so a piece is an entry only when it opens with a space-free name and `: `.
 */
const refusedNamesOf = (help: string): ReadonlyArray<string> =>
	Option.match(
		Arr.findFirst(Arr.map(Str.split("\n")(help), Str.trimStart), Str.startsWith("REFUSED ")),
		{
			onNone: () => [],
			onSome: (line) =>
				Arr.flatMap(Str.split("; ")(Str.trimStart(Str.slice(7)(line))), (piece) =>
					Option.match(Option.fromNullishOr(REFUSED_ENTRY.exec(piece)), {
						onNone: () => [],
						onSome: ([, name]) => [name]
					})
				)
		}
	)

const decodeDescription = Schema.decodeEffect(Schema.fromJsonString(Description))

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8")

/** The suite's fixture under one config: the capture server, the package built against it, and its commands. */
class DeepObjectFixture extends Context.Service<
	DeepObjectFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<Command, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/deep-objects.test/DeepObjectFixture") {}

const fixtureOf = (mode: Mode) =>
	Layer.effect(
		DeepObjectFixture,
		Effect.gen(function* () {
			const server = yield* captureServer
			const generated = yield* generateFixture({
				spec: { path: "openapi.json", text: spec },
				config: {
					path: "author-config.json",
					text: configOf(server.origins["127.0.0.1"], mode)
				},
				authorFiles: []
			})
			const built = yield* buildPackage(generated)
			const commands = yield* Effect.all(
				Rec.map(POINTERS, (pointer) =>
					Effect.map(
						Effect.fromOption(
							Arr.findFirst(
								generated.result.report.commandNames,
								(name) => name.pointer === pointer
							)
						),
						(name) => name.path
					)
				)
			)
			return { server, built, commands }
		})
	).pipe(Layer.provideMerge(harnessLayer))

Arr.forEach(MODES, (mode) => {
	layer(fixtureOf(mode), { excludeTestServices: true })(
		`a generated CLI's deepObject values under ${mode.label}`,
		(it) => {
			it.effect("are described and refused exactly as the switches say", () =>
				Effect.gen(function* () {
					const { built, commands } = yield* DeepObjectFixture
					const run = (args: ReadonlyArray<string>) =>
						runBin(built, { args, env: {}, stdin: new Uint8Array(0) })
					const described = yield* run(["--describe"])
					const updateHelp = yield* run(Arr.append(commands.update, "--help"))
					const listHelp = yield* run(Arr.append(commands.list, "--help"))
					const description = yield* decodeDescription(utf8(described.stdout))
					const entryOf = (pointer: string) =>
						Arr.findFirst(description.commands, (command) => command.pointer === pointer)
					const flagsAt = (pointer: string, location: string, field: "name" | "wireName") =>
						Option.match(entryOf(pointer), {
							onNone: () => [],
							onSome: (command) =>
								Arr.map(
									Arr.filter(command.flags, (flag) => flag.location === location),
									(flag) => flag[field]
								)
						})
					deepStrictEqual<Surface>(
						{
							exitCodes: [described.exitCode, updateHelp.exitCode, listHelp.exitCode],
							commands: sorted(Arr.map(description.commands, (command) => command.pointer)),
							updateFlags: sorted(flagsAt(UPDATE, "body", "name")),
							refusedFields: Option.match(entryOf(UPDATE), {
								onNone: () => [],
								onSome: (command) => command.refusedFields
							}),
							listFlags: sorted(flagsAt(LIST, "query", "wireName")),
							updateRefused: sorted(refusedNamesOf(utf8(updateHelp.stdout))),
							listRefused: sorted(refusedNamesOf(utf8(listHelp.stdout)))
						},
						expectedSurface(mode),
						"the commands, flags and refusals are those the switches give the schemas"
					)
				})
			)

			it.effect("are sent as the switches say, and nothing for a fault", (ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { server, built, commands } = yield* DeepObjectFixture
						return yield* explore(
							{
								suite: `deepObject values under ${mode.label}`,
								draw: drawn(element(featuresOf(mode))),
								literal: Formatter.format,
								coverage: required<Feature>(featuresOf(mode), { cases: 24, sense: notesOnly }),
								kept: [],
								runs: 6,
								shrink: { kind: "bounded", candidates: 30 },
								concurrency: 1,
								steerEvery: 1,
								caseHang: Duration.seconds(60)
							},
							(drawnFocus, k) =>
								Effect.gen(function* () {
									const c = k.draw(caseFor(mode, aimedFocus(mode, drawnFocus, k)))
									k.noteAll(caseFeatures(c))
									const { command, args } = invocationOf(c)
									const observed = yield* server.observe(
										() => done,
										runBin(built, {
											args: Arr.flatten([
												commands[command],
												["--base-url", server.origins["127.0.0.1"]],
												args
											]),
											env: {},
											stdin: new Uint8Array(0)
										})
									)
									const stderr = utf8(observed.result.stderr)
									deepStrictEqual<Outcome>(
										{
											exitCode: observed.result.exitCode,
											connections: observed.connections.length,
											requests: Arr.map(observed.requests, receivedOf),
											guard:
												c.kind === "fault"
													? Option.map(c.guard, ({ field, marker }) => ({
															namesField: Str.includes(field)(stderr),
															showsValue: Str.includes(marker)(stderr)
														}))
													: Option.none()
										},
										expectedOf(c),
										"each value is sent as its switches say, and a fault sends nothing"
									)
								})
						)
					})
				)
			)
		}
	)
})
