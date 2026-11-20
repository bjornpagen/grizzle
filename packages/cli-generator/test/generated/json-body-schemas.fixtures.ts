import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
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
	weighted
} from "@bjornpagen/testing/gen"
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Duration, Effect, Option, Record as Rec, String as Str } from "effect"
import type { Json } from "#model/pointer.ts"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** What the JSON body schemas property (json-body-schemas.test.ts) draws and its fixture: the box's bodies. */

/** An operation of the box, named by its path. */
type Operation = "ref-siblings" | "closed" | "open" | "closed-patterned" | "nested"

const OPERATIONS: Arr.NonEmptyReadonlyArray<Operation> = [
	"ref-siblings",
	"closed",
	"open",
	"closed-patterned",
	"nested"
]

/** Each operation's pointer. */
const POINTERS: Readonly<Record<Operation, string>> = {
	"ref-siblings": "/paths/~1ref-siblings/post",
	closed: "/paths/~1closed/post",
	open: "/paths/~1open/post",
	"closed-patterned": "/paths/~1closed-patterned/post",
	nested: "/paths/~1nested/post"
}

/** The operations whose body is an object. */
const OBJECT_OPERATIONS: Arr.NonEmptyReadonlyArray<Operation> = [
	"closed",
	"open",
	"closed-patterned",
	"nested"
]

const STRING = { type: "string" } as const

const INTEGER = { type: "integer" } as const

/** Each operation's body schema. */
const SCHEMAS: Readonly<Record<Operation, Json>> = {
	"ref-siblings": { $ref: "#/components/schemas/Count", maximum: 5 },
	closed: {
		type: "object",
		additionalProperties: false,
		properties: {
			a: STRING,
			inner: { type: "object", additionalProperties: false, properties: { b: INTEGER } }
		}
	},
	open: {
		type: "object",
		properties: { name: STRING },
		patternProperties: { "^x-": STRING }
	},
	"closed-patterned": {
		type: "object",
		additionalProperties: false,
		properties: { name: STRING },
		patternProperties: { "^x-": INTEGER }
	},
	nested: {
		type: "object",
		properties: {
			meta: {
				type: "object",
				additionalProperties: false,
				patternProperties: { "^[a-z]+$": { type: "number" } }
			},
			name: STRING
		}
	}
}

/** Five POSTs, each with a required JSON body of its schema. */
const spec = jsonText({
	openapi: "3.1.0",
	info: { title: "JSON body schemas", version: "1.0.0" },
	components: { schemas: { Count: { type: "integer", minimum: 1 } } },
	paths: Rec.fromEntries(
		Arr.map(OPERATIONS, (operation): readonly [string, Json] => [
			`/${operation}`,
			{
				post: {
					operationId: operation,
					requestBody: {
						required: true,
						content: { "application/json": { schema: SCHEMAS[operation] } }
					},
					responses: { "204": { description: "Done." } }
				}
			}
		])
	)
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonText({
		package: { name: "json-body-schemas", version: "1.0.0" },
		binName: "bodies",
		envPrefix: "BODIES",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** A JSON value as the operator writes it. */
type Value =
	| { readonly kind: "string"; readonly text: string }
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "decimal"; readonly text: string }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "null" }
	| { readonly kind: "object"; readonly members: ReadonlyArray<readonly [string, Value]> }
	| { readonly kind: "array"; readonly items: ReadonlyArray<Value> }

const stringOf = (text: string): Value => ({ kind: "string", text })

const integerOf = (value: number): Value => ({ kind: "integer", value })

const objectOf = (members: ReadonlyArray<readonly [string, Value]>): Value => ({
	kind: "object",
	members
})

/** A value's JSON text: compact, or with a space after each `,` and `:`. */
export const jsonOf = (value: Value, spaced: boolean): string => {
	const comma = spaced ? ", " : ","
	switch (value.kind) {
		case "string":
			return jsonText(value.text)
		case "integer":
			return String(value.value)
		case "decimal":
			return value.text
		case "boolean":
			return String(value.value)
		case "null":
			return "null"
		case "object":
			return `{${Arr.join(
				Arr.map(
					value.members,
					([key, member]) => `${jsonText(key)}${spaced ? ": " : ":"}${jsonOf(member, spaced)}`
				),
				comma
			)}}`
		case "array":
			return `[${Arr.join(
				Arr.map(value.items, (item) => jsonOf(item, spaced)),
				comma
			)}]`
	}
}

/** A member of an object value, none for another value or a missing member. */
const memberOf = (value: Value, key: string): Option.Option<Value> =>
	value.kind === "object"
		? Option.map(
				Arr.findFirst(value.members, ([name]) => name === key),
				([, member]) => member
			)
		: Option.none()

const keysOf = (value: Value): ReadonlyArray<string> =>
	value.kind === "object" ? Arr.map(value.members, ([key]) => key) : []

const isString = (value: Value): boolean => value.kind === "string"

const isInteger = (value: Value): boolean => value.kind === "integer"

const isObject = (value: Value): boolean => value.kind === "object"

/** Whether an object's member `key`, when present, holds. */
const whenPresent = (value: Value, key: string, holds: (member: Value) => boolean): boolean =>
	Option.match(memberOf(value, key), { onNone: () => true, onSome: holds })

/** Whether every key of an object is one of `declared`. */
const onlyDeclared = (value: Value, declared: ReadonlyArray<string>): boolean =>
	Arr.every(keysOf(value), (key) => Arr.contains(declared, key))

/** Whether a body passes its operation's schema by the rules the header states. */
const passes = (operation: Operation, body: Value): boolean => {
	switch (operation) {
		case "ref-siblings":
			return body.kind === "integer" && body.value >= 1 && body.value <= 5
		case "closed":
			return (
				isObject(body) &&
				onlyDeclared(body, ["a", "inner"]) &&
				whenPresent(body, "a", isString) &&
				whenPresent(
					body,
					"inner",
					(inner) =>
						isObject(inner) && onlyDeclared(inner, ["b"]) && whenPresent(inner, "b", isInteger)
				)
			)
		case "open":
		case "closed-patterned":
			return isObject(body) && whenPresent(body, "name", isString)
		case "nested":
			return (
				isObject(body) && whenPresent(body, "meta", isObject) && whenPresent(body, "name", isString)
			)
	}
}

/** One run: an operation, the body given, and whether it is written spaced. */
type Case = Readonly<{ operation: Operation; body: Value; spaced: boolean }>

/** A request as the oracle compares it: its target, its media type essence and its body's text. */
type Received = Readonly<{ target: string; contentType: Option.Option<string>; body: string }>

/** What the oracle compares of a run. */
export type Outcome = Readonly<{
	exitCode: number
	connections: number
	requests: ReadonlyArray<Received>
}>

export const receivedOf = (request: WireRequest): Received => ({
	target: request.target,
	contentType: Option.map(Arr.head(valuesOf(request.headers, "content-type")), (contentType) =>
		Str.trim(Arr.headNonEmpty(Str.split(";")(contentType)))
	),
	body: Buffer.from(request.body).toString("utf8")
})

/** The run the rules give: the text given, arrived as one JSON request, or exit 2 with no connection. */
export const expectedOf = (c: Case): Outcome =>
	passes(c.operation, c.body)
		? {
				exitCode: 0,
				connections: 1,
				requests: [
					{
						target: `/${c.operation}`,
						contentType: Option.some("application/json"),
						body: jsonOf(c.body, c.spaced)
					}
				]
			}
		: { exitCode: 2, connections: 0, requests: [] }

/** A situation a case reaches. */
export type Feature =
	| "a ref value within both bounds"
	| "a ref value above the sibling maximum"
	| "a ref value below the target minimum"
	| "a ref value that is not an integer"
	| "a closed body sent"
	| "an undeclared top key"
	| "an undeclared nested key"
	| "a declared property of another type"
	| "a pattern-matched key sent"
	| "a pattern value of another type sent"
	| "a key no pattern matches in a closed patterned object"
	| "a nested patterned object sent"
	| "a body that is not an object"
	| "a spaced body sent as given"

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"a ref value within both bounds",
	"a ref value above the sibling maximum",
	"a ref value below the target minimum",
	"a ref value that is not an integer",
	"a closed body sent",
	"an undeclared top key",
	"an undeclared nested key",
	"a declared property of another type",
	"a pattern-matched key sent",
	"a pattern value of another type sent",
	"a key no pattern matches in a closed patterned object",
	"a nested patterned object sent",
	"a body that is not an object",
	"a spaced body sent as given"
]

/** A feature when it holds, none otherwise. */
const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> => (holds ? [feature] : [])

/** Whether a key matches the patterned objects' `^x-`. */
const isPatterned = Str.startsWith("x-")

/** The type each patterned operation's `^x-` values declare, which is never asserted. */
const PATTERN_TYPE: Readonly<Record<"open" | "closed-patterned", (value: Value) => boolean>> = {
	open: isString,
	"closed-patterned": isInteger
}

/** Whether a declared property of the body has a value of another type than it declares. */
const mistyped = (operation: Operation, body: Value): boolean => {
	switch (operation) {
		case "ref-siblings":
			return false
		case "closed":
			return (
				!whenPresent(body, "a", isString) ||
				!whenPresent(body, "inner", isObject) ||
				Option.exists(memberOf(body, "inner"), (inner) => !whenPresent(inner, "b", isInteger))
			)
		case "open":
		case "closed-patterned":
			return !whenPresent(body, "name", isString)
		case "nested":
			return !whenPresent(body, "name", isString) || !whenPresent(body, "meta", isObject)
	}
}

/** The features a case reaches. */
export const caseFeatures = (c: Case): ReadonlyArray<Feature> => {
	const sent = passes(c.operation, c.body)
	const { operation, body } = c
	const patternedKeys = Arr.filter(keysOf(body), isPatterned)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
		operation === "ref-siblings"
			? Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
					when(sent, "a ref value within both bounds"),
					when(body.kind === "integer" && body.value > 5, "a ref value above the sibling maximum"),
					when(body.kind === "integer" && body.value < 1, "a ref value below the target minimum"),
					when(body.kind !== "integer", "a ref value that is not an integer")
				])
			: when(!isObject(body), "a body that is not an object"),
		when(operation === "closed" && sent, "a closed body sent"),
		when(
			operation === "closed" && isObject(body) && !onlyDeclared(body, ["a", "inner"]),
			"an undeclared top key"
		),
		when(
			operation === "closed" &&
				Option.exists(
					memberOf(body, "inner"),
					(inner) => isObject(inner) && !onlyDeclared(inner, ["b"])
				),
			"an undeclared nested key"
		),
		when(isObject(body) && mistyped(operation, body), "a declared property of another type"),
		when(
			sent &&
				(operation === "open" || operation === "closed-patterned") &&
				patternedKeys.length > 0,
			"a pattern-matched key sent"
		),
		when(
			sent &&
				(operation === "open" || operation === "closed-patterned") &&
				Arr.some(patternedKeys, (key) =>
					Option.exists(memberOf(body, key), (value) => !PATTERN_TYPE[operation](value))
				),
			"a pattern value of another type sent"
		),
		when(
			sent &&
				operation === "closed-patterned" &&
				Arr.some(keysOf(body), (key) => key !== "name" && !isPatterned(key)),
			"a key no pattern matches in a closed patterned object"
		),
		when(
			sent &&
				operation === "nested" &&
				Option.exists(memberOf(body, "meta"), (meta) => keysOf(meta).length > 0),
			"a nested patterned object sent"
		),
		when(sent && c.spaced && isObject(body), "a spaced body sent as given")
	])
}

/** Text with characters JSON escapes and characters past ASCII. */
const TEXT: Gen<string> = string(characterOf(["a", "Z", "0", " ", "é", '"', "\\"]), {
	min: 0,
	max: 4
})

const STRING_VALUE: Gen<Value> = map(TEXT, stringOf)

const INTEGER_VALUE: Gen<Value> = map(int(0, 99), integerOf)

const DECIMAL_VALUE: Gen<Value> = (source) => ({
	kind: "decimal",
	text: `${String(int(0, 9)(source))}.${String(int(1, 9)(source))}`
})

const BOOLEAN_VALUE: Gen<Value> = map(boolean, (value) => ({ kind: "boolean", value }))

const NULL_VALUE: Gen<Value> = constant({ kind: "null" })

/** A scalar of any JSON type. */
const SCALAR: Gen<Value> = oneOf([
	STRING_VALUE,
	INTEGER_VALUE,
	DECIMAL_VALUE,
	BOOLEAN_VALUE,
	NULL_VALUE
])

/** Any JSON value: mostly a scalar, sometimes an array or a one-member object of scalars. */
const ANY: Gen<Value> = weighted([
	[4, SCALAR],
	[1, (source) => ({ kind: "array", items: array(SCALAR, { min: 0, max: 2 })(source) })],
	[1, (source) => objectOf([["k", SCALAR(source)]])]
])

/** A value that is not an object: a scalar or an array. */
const NOT_AN_OBJECT: Gen<Value> = oneOf([
	SCALAR,
	(source) => ({ kind: "array", items: array(SCALAR, { min: 0, max: 2 })(source) })
])

/** A value of another type than a string. */
const NOT_A_STRING: Gen<Value> = oneOf([INTEGER_VALUE, DECIMAL_VALUE, BOOLEAN_VALUE, NULL_VALUE])

/** A value of another type than an integer. */
const NOT_AN_INTEGER: Gen<Value> = oneOf([STRING_VALUE, DECIMAL_VALUE, BOOLEAN_VALUE, NULL_VALUE])

/** An object of the members `member` draws for each name, each present or not, in the names' order. */
const someOf =
	(members: ReadonlyArray<readonly [string, Gen<Value>]>): Gen<Value> =>
	(source) =>
		objectOf(
			Arr.flatMap(members, ([key, member]) =>
				Option.toArray(
					Option.map(option(member)(source), (value): readonly [string, Value] => [key, value])
				)
			)
		)

/** An object of every member, each drawn. */
const allOf =
	(members: ReadonlyArray<readonly [string, Gen<Value>]>): Gen<Value> =>
	(source) =>
		objectOf(Arr.map(members, ([key, member]): readonly [string, Value] => [key, member(source)]))

/** A value usually of `typed`, sometimes of another type. */
const mostly = (typed: Gen<Value>, other: Gen<Value>): Gen<Value> =>
	weighted([
		[4, typed],
		[1, other]
	])

/** A closed body, its members sometimes of another type and sometimes undeclared. */
const CLOSED_BODY: Gen<Value> = someOf([
	["a", mostly(STRING_VALUE, NOT_A_STRING)],
	[
		"inner",
		mostly(
			someOf([
				["b", mostly(INTEGER_VALUE, NOT_AN_INTEGER)],
				["c", ANY]
			]),
			NOT_AN_OBJECT
		)
	],
	["z", ANY]
])

/** A patterned body: `name`, a pattern-matched key and an unmatched one, each present or not. */
const PATTERNED_BODY: Gen<Value> = someOf([
	["name", mostly(STRING_VALUE, NOT_A_STRING)],
	["x-a", ANY],
	["y", ANY]
])

/** A body with a patterned member of lower-case keys, sometimes not an object. */
const NESTED_BODY: Gen<Value> = someOf([
	[
		"meta",
		mostly(
			someOf([
				["a", ANY],
				["bb", ANY]
			]),
			NOT_AN_OBJECT
		)
	],
	["name", mostly(STRING_VALUE, NOT_A_STRING)]
])

/** Each operation's drawn bodies, passing or not, and sometimes not an object at all. */
const BODIES: Readonly<Record<Operation, Gen<Value>>> = {
	"ref-siblings": weighted([
		[3, INTEGER_VALUE],
		[1, map(int(1, 5), integerOf)],
		[1, NOT_AN_INTEGER]
	]),
	closed: mostly(CLOSED_BODY, NOT_AN_OBJECT),
	open: mostly(PATTERNED_BODY, NOT_AN_OBJECT),
	"closed-patterned": mostly(PATTERNED_BODY, NOT_AN_OBJECT),
	nested: mostly(NESTED_BODY, NOT_AN_OBJECT)
}

const caseOf =
	(
		operation: Gen<Operation>,
		body: (operation: Operation) => Gen<Value>,
		spaced: Gen<boolean>
	): Gen<Case> =>
	(source) => {
		const drawnOperation = operation(source)
		return { operation: drawnOperation, body: body(drawnOperation)(source), spaced: spaced(source) }
	}

/** A body that passes the closed schema. */
const PASSING_CLOSED: Gen<Value> = someOf([
	["a", STRING_VALUE],
	["inner", someOf([["b", INTEGER_VALUE]])]
])

/** The patterned operations. */
const PATTERNED: Gen<Operation> = element<Operation>(["open", "closed-patterned"])

/** An object value's members, none for another value. */
const keyedMembers = (value: Value): ReadonlyArray<readonly [string, Value]> =>
	value.kind === "object" ? value.members : []

/** A case made to reach `focus`, every other choice drawn; with no focus, every choice drawn. */
const caseFor = (focus: Option.Option<Feature>): Gen<Case> => {
	if (Option.isNone(focus)) {
		return caseOf(element(OPERATIONS), (operation) => BODIES[operation], boolean)
	}
	switch (focus.value) {
		case "a ref value within both bounds":
			return caseOf(constant("ref-siblings"), () => map(int(1, 5), integerOf), boolean)
		case "a ref value above the sibling maximum":
			return caseOf(constant("ref-siblings"), () => map(int(6, 99), integerOf), boolean)
		case "a ref value below the target minimum":
			return caseOf(constant("ref-siblings"), () => constant(integerOf(0)), boolean)
		case "a ref value that is not an integer":
			return caseOf(constant("ref-siblings"), () => NOT_AN_INTEGER, boolean)
		case "a closed body sent":
			return caseOf(constant("closed"), () => PASSING_CLOSED, boolean)
		case "an undeclared top key":
			return caseOf(
				constant("closed"),
				() => (source) =>
					objectOf(Arr.append(keyedMembers(PASSING_CLOSED(source)), ["z", ANY(source)])),
				boolean
			)
		case "an undeclared nested key":
			return caseOf(
				constant("closed"),
				() =>
					allOf([
						[
							"inner",
							allOf([
								["b", INTEGER_VALUE],
								["c", ANY]
							])
						]
					]),
				boolean
			)
		case "a declared property of another type":
			return caseOf(
				element<Operation>(["closed", "open", "closed-patterned", "nested"]),
				(operation) =>
					operation === "closed" ? allOf([["a", NOT_A_STRING]]) : allOf([["name", NOT_A_STRING]]),
				boolean
			)
		case "a pattern-matched key sent":
			return caseOf(PATTERNED, () => allOf([["x-a", ANY]]), boolean)
		case "a pattern value of another type sent":
			return caseOf(
				PATTERNED,
				(operation) => allOf([["x-a", operation === "open" ? NOT_A_STRING : NOT_AN_INTEGER]]),
				boolean
			)
		case "a key no pattern matches in a closed patterned object":
			return caseOf(constant("closed-patterned"), () => allOf([["y", ANY]]), boolean)
		case "a nested patterned object sent":
			return caseOf(
				constant("nested"),
				() =>
					allOf([
						[
							"meta",
							allOf([
								["a", ANY],
								["bb", ANY]
							])
						]
					]),
				boolean
			)
		case "a body that is not an object":
			return caseOf(element(OBJECT_OPERATIONS), () => NOT_AN_OBJECT, boolean)
		case "a spaced body sent as given":
			return caseOf(
				constant("closed"),
				() =>
					allOf([
						["a", STRING_VALUE],
						["inner", allOf([["b", INTEGER_VALUE]])]
					]),
				constant(true)
			)
	}
}

/** A focus, or none, each half the time. */
const FOCUS: Gen<Option.Option<Feature>> = weighted([
	[1, constant(Option.none())],
	[1, map(element(FEATURES), Option.some)]
])

/** An empty `204`. */
export const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture, once per worker: the capture server, the package built against it, and each operation's command. */
export const jsonFixture = workerFixture(
	"test/generated/json-body-schemas.fixtures.ts jsonFixture",
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
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			commands: Readonly<Record<Operation, ReadonlyArray<string>>>
		}> = { server, built, commands }
		return opened
	})
)

/**
 * The cases a search draws: the floor's and the rotating stream's from FOCUS, a feature's case or any case, each
 * half the time; a case aimed at a required feature still pending, from the case made to reach it (caseFor).
 */
const unsteered: Gen<Case> = (source) => source.draw(caseFor(source.draw(FOCUS)))

export const cases = aimed(
	unsteered,
	Arr.map(FEATURES, (feature) => [feature, caseFor(Option.some(feature))] as const)
)
