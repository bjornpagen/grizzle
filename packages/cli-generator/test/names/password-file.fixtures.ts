/**
 * What the property of password-file.test.ts reads: request bodies whose properties are drawn from the shapes that make
 * a secret-file flag, a base64 file flag, a password-array refusal or a plain flag, each the specification decides by
 * its shape and line; the pipeline's plan and emitted CLI for them (resolve, normalize, the names plan, the CLI
 * emitter, in process); and the specification's answer.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { aimed, type Aimed, constant, element, type Gen, map } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record, String as Str } from "effect"
import { emitCli } from "#emit/cli.ts"
import { decodeAuthorConfig } from "#model/author-config.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { planNames } from "#names/index.ts"
import { normalize } from "#normalize/index.ts"
import { resolve } from "#resolve/index.ts"

type Line = "3.0" | "3.1" | "3.2"

/** The shapes a body property is drawn from, each a class the specification decides by. */
export type Shape =
	| "plain string"
	| "password"
	| "password through a component"
	| "password through an allOf member"
	| "password beside a $ref"
	| "password in an anyOf branch"
	| "password in a oneOf branch"
	| "base64 contentEncoding"
	| "base64url contentEncoding"
	| "format byte"
	| "password array inline"
	| "password array through items $ref"
	| "password array component"
	| "password array through allOf"
	| "plain string array"
	| "format byte array"
	| "object holding a password"
	| "object two deep holding a password"

/** One property: its name, its shape. */
type Property = Readonly<{ name: string; shape: Shape }>

/** One case: the line, the body's properties, and a plain sibling named `<secret>-file` beside a secret, or none. */
export type SecretCase = Readonly<{
	line: Line
	properties: ReadonlyArray<Property>
	collides: boolean
}>

const password: Json = { format: "password", type: "string" }

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })

const schemaOf = (shape: Shape): Json => {
	switch (shape) {
		case "plain string":
			return { type: "string" }
		case "password":
			return password
		case "password through a component":
			return ref("Secret")
		case "password through an allOf member":
			return { allOf: [{ type: "string" }, { format: "password" }] }
		case "password beside a $ref":
			return { $ref: "#/components/schemas/Plain", format: "password" }
		case "password in an anyOf branch":
			return { anyOf: [password, { type: "integer" }] }
		case "password in a oneOf branch":
			return { oneOf: [{ type: "integer" }, ref("Secret")] }
		case "base64 contentEncoding":
			return { contentEncoding: "base64", type: "string" }
		case "base64url contentEncoding":
			return { contentEncoding: "base64url", contentMediaType: "image/png", type: "string" }
		case "format byte":
			return { format: "byte", type: "string" }
		case "password array inline":
			return { items: password, type: "array" }
		case "password array through items $ref":
			return { items: ref("Secret"), type: "array" }
		case "password array component":
			return ref("Secrets")
		case "password array through allOf":
			return { allOf: [{ type: "array" }, { items: password }] }
		case "plain string array":
			return { items: { type: "string" }, type: "array" }
		case "format byte array":
			return { items: { format: "byte", type: "string" }, type: "array" }
		case "object holding a password":
			return { properties: { password }, type: "object" }
		case "object two deep holding a password":
			return { properties: { inner: { properties: { password }, type: "object" } }, type: "object" }
	}
}

const isSecret = (shape: Shape): boolean =>
	Str.startsWith("password")(shape) && !Str.includes("array")(shape)

const isPasswordArray = (shape: Shape): boolean => Str.startsWith("password array")(shape)

const versions: Readonly<Record<Line, string>> = { "3.0": "3.0.4", "3.1": "3.1.1", "3.2": "3.2.0" }

const propertiesOf = (c: SecretCase): ReadonlyArray<readonly [string, Json]> => [
	...Arr.map(c.properties, (p) => [p.name, schemaOf(p.shape)] as const),
	...Arr.flatMap(
		c.collides
			? Arr.take(
					Arr.filter(c.properties, (p) => isSecret(p.shape)),
					1
				)
			: [],
		(p) => [[`${p.name}-file`, { type: "string" }] as const]
	)
]

/** The case's document: one operation whose JSON body holds the drawn properties. */
const documentOf = (c: SecretCase): Json => ({
	components: {
		schemas: {
			Plain: { type: "string" },
			Secret: password,
			Secrets: { items: ref("Secret"), type: "array" }
		}
	},
	info: { title: "Secrets", version: "1.0.0" },
	openapi: versions[c.line],
	paths: {
		"/logins": {
			post: {
				operationId: "logins-create",
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: Record.fromEntries(propertiesOf(c)), type: "object" }
						}
					},
					required: true
				},
				responses: { "204": { description: "Created." } },
				tags: ["logins"]
			}
		}
	}
})

/** A planned body flag as the specification states it: name, kind, repetition and wire pointer. */
type Flag = readonly [name: string, kind: string, repeated: boolean, wire: string]

/** What the pipeline plans and emits: the body flags, the refusals (code and pointer), and the file fields the CLI sends. */
export type Planned = Readonly<{
	flags: ReadonlyArray<Flag>
	refusals: ReadonlyArray<readonly [code: string, scope: string, pointer: string]>
	fileFields: ReadonlyArray<string>
}>

const fileField = regex(
	'new Input\\.FileField\\(\\{ encoding: "(?<encoding>[a-z0-9]+)", flag: "(?<flag>[a-z0-9.-]+)"',
	"gu"
)

const blanks = regex("\\s+", "gu")

/** Runs resolve, normalize, the names plan and the CLI emitter on the case's document. */
export const plannedOf = (c: SecretCase) =>
	Effect.gen(function* () {
		const document = fixedDocumentUri("file:///pw/openapi.json")
		const configDocument = fixedDocumentUri("file:///pw/author-config.json")
		const config = yield* decodeAuthorConfig(
			{
				binName: "pw",
				envPrefix: "PW",
				package: { name: "pw-cli", version: "1.0.0" },
				servers: { accepted: ["https://api.example.com"] }
			},
			{ document: configDocument }
		)
		const resolution = yield* resolve({ document, line: c.line, value: documentOf(c) })
		const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument })
		const plan = yield* planNames(api, { config, configDocument, strict: false })
		const output = yield* emitCli({ api, config, plan, validationEdits: [] })
		const commands = Arr.flatMap(plan.groups, (group) => group.commands)
		const flags = Arr.flatMap(commands, (command) =>
			Arr.flatMap(command.flags, (flag): ReadonlyArray<Flag> =>
				flag.source._tag === "Body"
					? [[flag.name, flag.source.kind, flag.source.repeated, flag.source.wireName]]
					: []
			)
		)
		const content = Option.getOrElse(
			Option.map(
				Arr.findFirst(output.files, (file) => file.path === "src/cli/logins.ts"),
				(file) => Str.replaceAll(blanks, " ")(file.content)
			),
			() => ""
		)
		const planned: Planned = {
			flags: Arr.sort(
				flags,
				Order.mapInput(Order.String, (flag: Flag) => flag[0])
			),
			refusals: Arr.map(
				Arr.filter(plan.diagnostics, (d) => d.severity === "refusal"),
				(d) => [d.code, d.scope, d.pointer] as const
			),
			fileFields: Arr.sort(
				Arr.map(
					Arr.fromIterable(Str.matchAll(fileField)(content)),
					(match) => `${match.groups?.["flag"] ?? ""} ${match.groups?.["encoding"] ?? ""}`
				),
				Order.String
			)
		}
		return planned
	})

const bodyPointer = "/paths/~1logins/post/requestBody/content/application~1json/schema"

/** The flag a property gets, by its shape and line (design 4.5, 6.3 Binary, 13.1 R4), or none. */
const flagsOf = (p: Property, line: Line): ReadonlyArray<Flag> => {
	const wire = `/${p.name}`
	const secret: ReadonlyArray<Flag> = [[`${p.name}-file`, "secret-file", false, wire]]
	switch (p.shape) {
		case "password":
		case "password through a component":
		case "password through an allOf member":
		case "password beside a $ref":
		case "password in an anyOf branch":
		case "password in a oneOf branch":
			return secret
		case "password array inline":
		case "password array through items $ref":
		case "password array component":
		case "password array through allOf":
			return []
		case "plain string":
			return [[p.name, "string", false, wire]]
		case "base64 contentEncoding":
		case "base64url contentEncoding":
			return [[p.name, "file", false, wire]]
		case "format byte":
			return [[p.name, line === "3.0" ? "file" : "string", false, wire]]
		case "plain string array":
		case "format byte array":
			return [[p.name, "string", true, wire]]
		case "object holding a password":
			return [[`${p.name}.password-file`, "secret-file", false, `${wire}/password`]]
		case "object two deep holding a password":
			return [[`${p.name}.inner`, "json", false, `${wire}/inner`]]
	}
}

/** The encoding the CLI sends a base64 file flag in. */
const encodingOf = (p: Property, line: Line): Option.Option<string> =>
	p.shape === "base64url contentEncoding"
		? Option.some("base64url")
		: p.shape === "base64 contentEncoding" || (p.shape === "format byte" && line === "3.0")
			? Option.some("base64")
			: Option.none()

/**
 * The specification's answer: a password string a secret-file flag `--<name>-file` (through a component, an allOf
 * member, a `$ref` sibling or any anyOf or oneOf branch, failing closed), a nested one at its dotted name, one inside a
 * JSON-valued flag none; a base64 string a file flag the CLI sends base64 or base64url encoded (3.0's `format: byte`
 * too); an array of password strings no flag and an element refusal FMT-05 at the property; and a secret's sibling named
 * `<secret>-file` the operation's refusal RQB-03, so no flag at all.
 */
/** Design 3.7's order for refusals of one document: by pointer, then by code. */
const refusalOrder = Order.combine(
	Order.mapInput(Order.String, (refusal: Planned["refusals"][number]) => refusal[2]),
	Order.mapInput(Order.String, (refusal: Planned["refusals"][number]) => refusal[0])
)

export const expectedOf = (c: SecretCase): Planned => {
	const passwordArrays = Arr.filter(c.properties, (p) => isPasswordArray(p.shape))
	const arrayRefusals = Arr.map(
		passwordArrays,
		(p) => ["FMT-05/password-array", "element", `${bodyPointer}/properties/${p.name}`] as const
	)
	if (c.collides && Arr.some(c.properties, (p) => isSecret(p.shape))) {
		return {
			flags: [],
			refusals: Arr.sort(
				[
					[
						"RQB-03/flag-collision",
						"operation",
						"/paths/~1logins/post/requestBody/content/application~1json"
					] as const,
					...arrayRefusals
				],
				refusalOrder
			),
			fileFields: []
		}
	}
	const whole: ReadonlyArray<Flag> = [
		["body", "body", false, ""],
		["body-file", "body-file", false, ""]
	]
	return {
		flags: Arr.sort(
			[...whole, ...Arr.flatMap(c.properties, (p) => flagsOf(p, c.line))],
			Order.mapInput(Order.String, (flag: Flag) => flag[0])
		),
		refusals: Arr.sort(arrayRefusals, refusalOrder),
		fileFields: Arr.sort(
			Arr.getSomes(
				Arr.map(c.properties, (p) =>
					Option.map(encodingOf(p, c.line), (encoding) => `${p.name} ${encoding}`)
				)
			),
			Order.String
		)
	}
}

const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = [
	"plain string",
	"password",
	"password through a component",
	"password through an allOf member",
	"password beside a $ref",
	"password in an anyOf branch",
	"password in a oneOf branch",
	"base64 contentEncoding",
	"base64url contentEncoding",
	"format byte",
	"password array inline",
	"password array through items $ref",
	"password array component",
	"password array through allOf",
	"plain string array",
	"format byte array",
	"object holding a password",
	"object two deep holding a password"
]

/** Shapes a line holds: `$ref` siblings, contentEncoding and contentMediaType are 3.1 keywords on. */
const onLine = (shape: Shape, line: Line): boolean =>
	line !== "3.0" ||
	(shape !== "password beside a $ref" &&
		shape !== "base64 contentEncoding" &&
		shape !== "base64url contentEncoding")

const NAMES = ["photo", "secret", "pin", "auth", "deep", "tags", "note"] as const

const caseGen =
	(shapes: Gen<Shape>, line: Gen<Line>, collides: Gen<boolean>): Gen<SecretCase> =>
	(s) => {
		const drawnLine = s.draw(line)
		const count = s.draw(element([1, 2, 3]))
		const properties = Arr.flatMap(Arr.take(NAMES, count), (name): ReadonlyArray<Property> => {
			const shape = s.draw(shapes)
			return onLine(shape, drawnLine) ? [{ name, shape }] : []
		})
		return { line: drawnLine, properties, collides: s.draw(collides) }
	}

const anyLine = element<Line>(["3.0", "3.1", "3.2"])

const rarely: Gen<boolean> = map(element([0, 1, 2, 3, 4]), (n) => n === 0)

export type Feature =
	| `a property shaped ${Shape}`
	| "a secret's sibling colliding"
	| "a 3.0 byte field as base64"
	| "a 3.1 byte field as text"

export const featuresOf = (c: SecretCase): ReadonlyArray<Feature> => [
	...Arr.map(c.properties, (p): Feature => `a property shaped ${p.shape}`),
	...(c.collides && Arr.some(c.properties, (p) => isSecret(p.shape))
		? ["a secret's sibling colliding" as const]
		: []),
	...(c.line === "3.0" && Arr.some(c.properties, (p) => p.shape === "format byte")
		? ["a 3.0 byte field as base64" as const]
		: []),
	...(c.line !== "3.0" && Arr.some(c.properties, (p) => p.shape === "format byte")
		? ["a 3.1 byte field as text" as const]
		: [])
]

/** Bodies, aimed at every shape, the sibling collision and byte fields on each side of 3.0. */
export const secretSpace: Aimed<SecretCase, Feature> = aimed(
	caseGen(element(SHAPES), anyLine, rarely),
	[
		...Arr.map(
			SHAPES,
			(shape) =>
				[
					`a property shaped ${shape}`,
					caseGen(constant(shape), element<Line>(["3.1", "3.2"]), constant(false))
				] as const
		),
		["a secret's sibling colliding", caseGen(constant("password"), anyLine, constant(true))],
		[
			"a 3.0 byte field as base64",
			caseGen(constant("format byte"), constant("3.0"), constant(false))
		],
		[
			"a 3.1 byte field as text",
			caseGen(constant("format byte"), element<Line>(["3.1", "3.2"]), constant(false))
		]
	]
)
