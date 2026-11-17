import { boolean, constant, element, type Gen, oneOf, type Space } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	JsonPointer,
	Option,
	Order,
	Path,
	Predicate,
	Record,
	Schema,
	Stream,
	String as Str
} from "effect"
import { generate } from "#generate.ts"
import { DocumentUri } from "#model/brands.ts"
import { configGen, configOf, documentGen, documentOf, textOf } from "#test/support/openapi-gen.ts"
import type { ConfigSketch, DocumentSketch, Line } from "#test/support/openapi-gen.ts"

/** The constructs a case plants into a generated document, one a case. */
export type Family =
	| "a deepObject over an object or a scalar"
	| "a deepObject over objects alone"
	| "a discriminator with no composition"
	| "a discriminator over a composition"
	| "a schema-driven XML part"
	| "a JSON object part"
	| "an opaque XML body"
	| "a default outside its type"
	| "a read-only body property"
	| "a password property"
	| "a password or binary part"
	| "a byte or base64 property"
	| "a numeric property"
	| "an undeclared requirement name"
	| "a tag folding to a fixed api module"

/** The variants of a family a case notes beside it, each one family's alone. */
export type Variant =
	| "a required deepObject refused with its operation"
	| "a deepObject the scalar switch admits"
	| "a required XML part refused with its operation"
	| "a 3.0 default refused"
	| "a nonconforming default kept as an annotation"
	| "a 3.0 read-only property left out"
	| "a read-only property through a reference"
	| "a described password"
	| "a binary part"
	| "a 3.0 byte property"
	| "a base64 contentEncoding"
	| "an int64 property"
	| "an undeclared name beside a declared one"
	| "a 3.2 undeclared name"

export type Feature = Family | Variant

/** A diagnostic as the plant's row states it: its code, its scope and the pointer it names. */
export type Fact = Readonly<{ code: string; scope: string; pointer: string }>

/**
 * A text the planted operation's emitted modules (its group's cli and api modules, `planted`) hold or lack, compared
 * with every white space and every comma before a closing parenthesis taken out, since the printer breaks lines and
 * adds trailing commas where it fits.
 */
export type Emitted = Readonly<{ kind: "holds" | "lacks"; text: string }>

/**
 * One planted operation: its path and method, its Operation Object (tagged `planted`, so its command lands in the
 * `planted` group's modules alone), the component schemas and security schemes it adds, the family and the variants it
 * belongs to, and what its row says generation does with it: the refusals and notices it names at the plant's pointers,
 * whether the operation keeps its command, and what the emitted modules hold.
 */
export type Plant = Readonly<{
	path: string
	method: "get" | "post"
	operation: Schema.JsonObject
	schemas: ReadonlyArray<readonly [string, Schema.Json]>
	schemes: ReadonlyArray<readonly [string, Schema.Json]>
	family: Family
	variants: ReadonlyArray<Variant>
	facts: ReadonlyArray<Fact>
	commanded: boolean
	emitted: ReadonlyArray<Emitted>
}>

/** A generated document, an author config that fits it, and the operation planted into it. */
export type ConstructCase = Readonly<{
	document: DocumentSketch
	config: ConfigSketch
	plant: Plant
}>

const ok: Schema.Json = { "204": { description: "Done." } }

/** The pointer of `method` on `path`. */
const operationPointer = (path: string, method: string): string =>
	`/paths/${JsonPointer.escapeToken(path)}/${method}`

/** The pointer of a request body's media type. */
const mediaPointer = (path: string, method: string, mediaType: string): string =>
	`${operationPointer(path, method)}/requestBody/content/${JsonPointer.escapeToken(mediaType)}`

/**
 * A `format` other than binary and byte is not asserted, so the schema copy removes it with a notice at the keyword:
 * S30-26 on 3.0, SCH-54 on 3.1 and 3.2.
 */
const formatNotice = (line: Line, pointer: string): Fact => ({
	code: `${line === "3.0" ? "S30-26" : "SCH-54"}/not-asserted`,
	scope: "element",
	pointer: `${pointer}/format`
})

/** `variant` when `holds`, else none. */
const when = (holds: boolean, variant: Variant): ReadonlyArray<Variant> => (holds ? [variant] : [])

/** An operation tagged `planted`, with its id and what else it holds. */
const plantedOperation = (
	operationId: string,
	members: Readonly<Record<string, Schema.Json>>
): Schema.JsonObject => ({ operationId, tags: ["planted"], responses: ok, ...members })

/** A required JSON body over `schema`. */
const jsonBody = (schema: Schema.Json): Schema.Json => ({
	required: true,
	content: { "application/json": { schema } }
})

/** A required JSON body over an object of `properties`. */
const objectBody = (properties: Readonly<Record<string, Schema.Json>>): Schema.Json =>
	jsonBody({ type: "object", properties })

/** A multipart/form-data body over an object of `properties`, with `encoding`. */
const multipartBody = (
	required: boolean,
	properties: Readonly<Record<string, Schema.Json>>,
	encoding: Readonly<Record<string, Schema.Json>>
): Schema.Json => ({
	required,
	content: { "multipart/form-data": { schema: { type: "object", properties }, encoding } }
})

const holds = (text: string): Emitted => ({ kind: "holds", text })

const lacks = (text: string): Emitted => ({ kind: "lacks", text })

/** An object of four bounds, the object member every deepObject plant's union holds. */
const RANGE: Schema.Json = {
	type: "object",
	properties: {
		gt: { type: "integer" },
		gte: { type: "integer" },
		lt: { type: "integer" },
		lte: { type: "integer" }
	}
}

const DEEP_NAMES: Arr.NonEmptyReadonlyArray<string> = ["created", "window", "span"]

/** A query parameter by deepObject, exploded, over `schema`. */
const deepParameter = (name: string, schema: Schema.Json, required: boolean): Schema.Json => ({
	in: "query",
	name,
	required,
	style: "deepObject",
	explode: true,
	schema
})

/**
 * deepObject is defined for an object alone, so a union that admits a scalar is refused at element scope (PRM-27), and
 * the operation with it when the parameter is required (OPR-08); the scalar switch instead admits it as one JSON value,
 * noticed. Either bracket switch leaves this as it is.
 */
const deepScalarPlant =
	(config: ConfigSketch, requiredGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const name = s.draw(element(DEEP_NAMES))
		const required = s.draw(requiredGen)
		const scalar = s.draw(element(["integer", "string", "number", "boolean"]))
		const keyword = s.draw(element(["anyOf", "oneOf"]))
		const path = "/planted-deep"
		const operation = operationPointer(path, "get")
		const parameter = `${operation}/parameters/0`
		const scalars = Option.contains(config.scalars, true)
		return {
			path,
			method: "get",
			operation: plantedOperation("deep-list", {
				parameters: [deepParameter(name, { [keyword]: [RANGE, { type: scalar }] }, required)]
			}),
			schemas: [],
			schemes: [],
			family: "a deepObject over an object or a scalar",
			variants: [
				...when(required && !scalars, "a required deepObject refused with its operation"),
				...when(scalars, "a deepObject the scalar switch admits")
			],
			facts: scalars
				? [{ code: "PRM-27/scalar-author-choice", scope: "element", pointer: parameter }]
				: [
						{ code: "PRM-27/non-object-schema", scope: "element", pointer: parameter },
						...(required
							? [
									{
										code: "OPR-08/required-parameter-refused",
										scope: "operation",
										pointer: operation
									}
								]
							: [])
					],
			commanded: scalars || !required,
			emitted: scalars
				? [holds(`Input.jsonFlag("${name}")`), holds(`Serialize.deepObject("${name}"`)]
				: [lacks(`Input.jsonFlag("${name}")`), lacks(`Serialize.deepObject("${name}"`)]
		}
	}

/** A union of objects alone is object-valued, so it takes JSON as a `type: object` schema does, and nothing is refused. */
const deepObjectsPlant: Gen<Plant> = (s) => {
	const name = s.draw(element(DEEP_NAMES))
	const required = s.draw(boolean)
	const keyword = s.draw(element(["anyOf", "oneOf"]))
	return {
		path: "/planted-deep",
		method: "get",
		operation: plantedOperation("deep-list", {
			parameters: [
				deepParameter(
					name,
					{ [keyword]: [RANGE, { properties: { at: { type: "string" } } }] },
					required
				)
			]
		}),
		schemas: [],
		schemes: [],
		family: "a deepObject over objects alone",
		variants: [],
		facts: [],
		commanded: true,
		emitted: [
			holds(`Input.jsonFlag("${name}")`),
			lacks(`Flag.String("${name}")`),
			holds(`Serialize.deepObject("${name}"`)
		]
	}
}

/** A pet with a `kind` it is told apart by, and `properties` beside it. */
const pet = (properties: Readonly<Record<string, Schema.Json>>): Schema.JsonObject => ({
	type: "object",
	required: ["kind"],
	properties: { kind: { type: "string" }, ...properties }
})

/** A pet with no other property that names `discriminator` for the schemas composed with it. */
const discriminatedPet = (discriminator: Schema.Json): Schema.JsonObject => ({
	type: "object",
	required: ["kind"],
	properties: { kind: { type: "string" } },
	discriminator
})

const PLANTED_CAT: readonly [string, Schema.Json] = [
	"PlantedCat",
	pet({ meow: { type: "boolean" } })
]

const PLANTED_DOG: readonly [string, Schema.Json] = [
	"PlantedDog",
	pet({ bark: { type: "boolean" } })
]

const reference = (name: string): Schema.Json => ({ $ref: `#/components/schemas/${name}` })

/** A discriminator on a schema with no allOf, anyOf or oneOf has nothing to select among: refused at it (DSC-05). */
const loneDiscriminatorPlant: Gen<Plant> = () => ({
	path: "/planted-lone",
	method: "post",
	operation: plantedOperation("lone-create", {
		requestBody: jsonBody(reference("PlantedLone"))
	}),
	schemas: [["PlantedLone", discriminatedPet({ propertyName: "kind" })]],
	schemes: [],
	family: "a discriminator with no composition",
	variants: [],
	facts: [
		{
			code: "DSC-05/no-composition",
			scope: "element",
			pointer: "/components/schemas/PlantedLone/discriminator"
		}
	],
	commanded: true,
	emitted: []
})

/**
 * A discriminator over a composition is valid on every line, whatever its mapping leaves out: an allOf child of a base
 * the discriminator sits on, a oneOf whose mapping names one branch of two, and a oneOf with an inline branch no
 * mapping can name. Nothing is refused.
 */
const composedDiscriminatorPlant: Gen<Plant> = oneOf<Plant>([
	() => ({
		path: "/planted-composed",
		method: "post",
		operation: plantedOperation("composed-create", {
			requestBody: jsonBody(reference("PlantedChild"))
		}),
		schemas: [
			["PlantedBase", discriminatedPet({ propertyName: "kind", mapping: { cat: "PlantedCat" } })],
			PLANTED_CAT,
			["PlantedChild", { allOf: [reference("PlantedBase"), { type: "object" }] }]
		],
		schemes: [],
		family: "a discriminator over a composition",
		variants: [],
		facts: [],
		commanded: true,
		emitted: []
	}),
	() => ({
		path: "/planted-composed",
		method: "post",
		operation: plantedOperation("composed-create", {
			requestBody: jsonBody({
				oneOf: [reference("PlantedCat"), reference("PlantedDog")],
				discriminator: { propertyName: "kind", mapping: { cat: "PlantedCat" } }
			})
		}),
		schemas: [PLANTED_CAT, PLANTED_DOG],
		schemes: [],
		family: "a discriminator over a composition",
		variants: [],
		facts: [],
		commanded: true,
		emitted: []
	}),
	() => ({
		path: "/planted-composed",
		method: "post",
		operation: plantedOperation("composed-create", {
			requestBody: jsonBody({
				oneOf: [reference("PlantedCat"), pet({ purr: { type: "boolean" } })],
				discriminator: {
					propertyName: "kind",
					mapping: { cat: "#/components/schemas/PlantedCat" }
				}
			})
		}),
		schemas: [PLANTED_CAT],
		schemes: [],
		family: "a discriminator over a composition",
		variants: [],
		facts: [],
		commanded: true,
		emitted: []
	})
])

/** A multipart object part `doc` sent as `contentType`, beside a plain `name`. */
const docPart = (required: boolean, contentType: string): Schema.Json =>
	multipartBody(
		required,
		{
			doc: { type: "object", properties: { id: { type: "integer", xml: { attribute: true } } } },
			name: { type: "string" }
		},
		{ doc: { contentType } }
	)

/**
 * A multipart part typed as XML over an object schema is schema-driven XML, which the emitter cannot write: refused at
 * the media type, naming the part's content type (XML-01), and the operation with it when the body is required
 * (OPR-09). The emitter never builds it as a JSON part.
 */
const xmlPartPlant =
	(requiredGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const required = s.draw(requiredGen)
		const contentType = s.draw(element(["application/xml", "text/xml"]))
		const path = "/planted-parts"
		const operation = operationPointer(path, "post")
		return {
			path,
			method: "post",
			operation: plantedOperation("parts-create", { requestBody: docPart(required, contentType) }),
			schemas: [],
			schemes: [],
			family: "a schema-driven XML part",
			variants: when(required, "a required XML part refused with its operation"),
			facts: [
				{
					code: "XML-01/schema-driven",
					scope: "element",
					pointer: mediaPointer(path, "post", "multipart/form-data")
				},
				...(required
					? [{ code: "OPR-09/required-body-refused", scope: "operation", pointer: operation }]
					: [])
			],
			commanded: !required,
			emitted: [lacks("Serialize.jsonPart"), lacks(`Input.jsonFlag("doc")`)]
		}
	}

/** A multipart object part sent as JSON is a JSON part, which the emitter writes as one. */
const jsonPartPlant: Gen<Plant> = (s) => {
	const required = s.draw(boolean)
	return {
		path: "/planted-parts",
		method: "post",
		operation: plantedOperation("parts-create", {
			requestBody: docPart(required, "application/json")
		}),
		schemas: [],
		schemes: [],
		family: "a JSON object part",
		variants: [],
		facts: [],
		commanded: true,
		emitted: [holds("Serialize.jsonPart")]
	}
}

/** An XML body whose schema carries no XML keyword is opaque: generated, refused nowhere. */
const opaqueXmlPlant: Gen<Plant> = () => ({
	path: "/planted-xml",
	method: "post",
	operation: plantedOperation("xml-create", {
		requestBody: {
			required: true,
			content: {
				"application/xml": { schema: { type: "object", properties: { id: { type: "integer" } } } }
			}
		}
	}),
	schemas: [],
	schemes: [],
	family: "an opaque XML body",
	variants: [],
	facts: [],
	commanded: true,
	emitted: []
})

/** The JSON text of a default as help prints it after `default: `. */
const shownDefault = (value: Schema.Json): string =>
	Predicate.isString(value) ? value : textOf(value)

/**
 * A 3.0 `default` that does not conform to its schema's type is refused at element scope (S30-27) and help omits it;
 * the operation keeps its body. A conforming default is shown, and 3.1 and 3.2 keep a nonconforming one as an
 * annotation, shown too.
 */
const defaultPlant =
	(line: Line, conformingGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const conforming = s.draw(conformingGen)
		const value: Schema.Json = conforming
			? s.draw(element([0, 10, -3]))
			: s.draw(element<Schema.Json>(["x", true, "10"]))
		const path = "/planted-default"
		const shown = conforming || line !== "3.0"
		return {
			path,
			method: "post",
			operation: plantedOperation("default-create", {
				requestBody: objectBody({ size: { type: "integer", default: value } })
			}),
			schemas: [],
			schemes: [],
			family: "a default outside its type",
			variants: [
				...when(!conforming && line === "3.0", "a 3.0 default refused"),
				...when(!conforming && line !== "3.0", "a nonconforming default kept as an annotation")
			],
			facts:
				line === "3.0" && !conforming
					? [
							{
								code: "S30-27/nonconforming-default",
								scope: "element",
								pointer: `${mediaPointer(path, "post", "application/json")}/schema/properties/size`
							}
						]
					: [],
			commanded: true,
			emitted: [
				holds(`flags: { size: "body /size${shown ? `; default: ${shownDefault(value)}` : ""}" }`)
			]
		}
	}

/**
 * A 3.0 read-only body property, written directly or through one `$ref`, is never sent, so it is not offered as a flag;
 * 3.1 and 3.2 keep the flag (SCH-51).
 */
const readOnlyPlant =
	(line: Line, referencedGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const referenced = s.draw(referencedGen)
		const name = s.draw(element(["owner", "id", "createdBy"]))
		const flag = name === "createdBy" ? "created-by" : name
		return {
			path: "/planted-read-only",
			method: "post",
			operation: plantedOperation("read-only-create", {
				requestBody: objectBody({
					label: { type: "string" },
					[name]: referenced ? reference("PlantedOwner") : { type: "string", readOnly: true }
				})
			}),
			schemas: referenced ? [["PlantedOwner", { type: "string", readOnly: true }]] : [],
			schemes: [],
			family: "a read-only body property",
			variants: [
				...when(line === "3.0", "a 3.0 read-only property left out"),
				...when(referenced, "a read-only property through a reference")
			],
			facts: [],
			commanded: true,
			emitted: [
				holds(`Flag.String("label")`),
				line === "3.0" ? lacks(`Flag.String("${flag}")`) : holds(`Flag.String("${flag}")`)
			]
		}
	}

const DESCRIPTIONS: Arr.NonEmptyReadonlyArray<string> = [
	"The account password.",
	"Read from the vault.",
	"Rotated each month"
]

/** The emitted description argument of a secret flag: none, or the description as a string literal. */
const describedBy = (description: Option.Option<string>): string =>
	Option.match(description, {
		onNone: () => "Option.none()",
		onSome: (text) => `Option.some(${textOf(text)})`
	})

/**
 * A `format: password` string property of a JSON body is a secret-file flag, `--<name>-file`, through
 * Input.secretFileFlag with its description, its value wrapped as an Input.SecretField at the property's pointer and
 * never a plain `--<name>`; an array of password strings has no flag.
 */
const passwordPlant =
	(line: Line, describedGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const name = s.draw(element(["password", "secret", "passphrase"]))
		const description = s.draw(describedGen)
			? Option.some(s.draw(element(DESCRIPTIONS)))
			: Option.none<string>()
		const properties = `${mediaPointer("/planted-password", "post", "application/json")}/schema/properties`
		return {
			path: "/planted-password",
			method: "post",
			operation: plantedOperation("password-create", {
				requestBody: objectBody({
					label: { type: "string" },
					[name]: {
						type: "string",
						format: "password",
						...Option.match(description, {
							onNone: () => ({}),
							onSome: (text) => ({ description: text })
						})
					},
					hashes: { type: "array", items: { type: "string", format: "password" } }
				})
			}),
			schemas: [],
			schemes: [],
			family: "a password property",
			variants: when(Option.isSome(description), "a described password"),
			facts: [
				formatNotice(line, `${properties}/${name}`),
				formatNotice(line, `${properties}/hashes/items`),
				{ code: "FMT-05/password-array", scope: "element", pointer: `${properties}/hashes` }
			],
			commanded: true,
			emitted: [
				holds(`Input.secretFileFlag("${name}-file", ${describedBy(description)})`),
				holds(`new Input.SecretField({ flag: "${name}-file", path: path })`),
				lacks(`Flag.String("${name}")`),
				lacks(`"/hashes"`),
				holds(`Flag.String("label")`)
			]
		}
	}

/**
 * A `format: password` multipart part is a secret part flag through Input.secretPartFlag with its description, not a
 * bare path flag; a `format: binary` part keeps its plain path flag.
 */
const passwordPartPlant =
	(line: Line, passwordGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const name = s.draw(element(["secret", "token"]))
		const password = s.draw(passwordGen)
		const description = s.draw(boolean)
			? Option.some(s.draw(element(DESCRIPTIONS)))
			: Option.none<string>()
		return {
			path: "/planted-secret-part",
			method: "post",
			operation: plantedOperation("secret-part-create", {
				requestBody: multipartBody(
					true,
					{
						label: { type: "string" },
						[name]: {
							type: "string",
							format: password ? "password" : "binary",
							...Option.match(description, {
								onNone: () => ({}),
								onSome: (text) => ({ description: text })
							})
						}
					},
					{}
				)
			}),
			schemas: [],
			schemes: [],
			family: "a password or binary part",
			variants: when(!password, "a binary part"),
			facts: password
				? [
						formatNotice(
							line,
							`${mediaPointer("/planted-secret-part", "post", "multipart/form-data")}/schema/properties/${name}`
						)
					]
				: [],
			commanded: true,
			emitted: password
				? [
						holds(`Input.secretPartFlag("${name}", ${describedBy(description)})`),
						lacks(`Flag.String("${name}")`)
					]
				: [holds(`Flag.String("${name}")`), lacks("Input.secretPartFlag")]
		}
	}

/**
 * A 3.0 `format: byte` string is a file read as base64, an Input.FileField; on 3.1 and 3.2 it is a plain string flag sent
 * as given (FMT-10). A `contentEncoding: base64` string is a base64 FileField on every line.
 */
const bytePlant =
	(line: Line, encodedGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const encoded = s.draw(encodedGen)
		const name = s.draw(element(["blob", "encoded"]))
		const asFile = encoded || line === "3.0"
		return {
			path: "/planted-bytes",
			method: "post",
			operation: plantedOperation("bytes-create", {
				requestBody: objectBody({
					[name]: encoded
						? { type: "string", contentEncoding: "base64" }
						: { type: "string", format: "byte" }
				})
			}),
			schemas: [],
			schemes: [],
			family: "a byte or base64 property",
			variants: [
				...when(!encoded && line === "3.0", "a 3.0 byte property"),
				...when(encoded, "a base64 contentEncoding")
			],
			facts: [],
			commanded: true,
			emitted: asFile
				? [holds(`new Input.FileField({ encoding: "base64", flag: "${name}"`)]
				: [
						holds(`Flag.String("${name}")`),
						holds(`"/${name}": flags.${name}`),
						lacks(`flag: "${name}"`)
					]
		}
	}

/**
 * A number and a safe integer field are Input.numericFlag of their kind, carried as a JsonNumber, never Flag.Int or
 * Flag.Finite; an int64 field stays Input.int64Flag (FMT-04), noticed as past a number's exact range (FMT-02) with its
 * format not asserted.
 */
type NumericKind = "integer" | "number" | "int64"

const numericPlant =
	(line: Line, kindGen: Gen<NumericKind>): Gen<Plant> =>
	(s) => {
		const kind = s.draw(kindGen)
		const name = s.draw(element(["count", "ratio", "total"]))
		const schema: Schema.Json =
			kind === "int64" ? { type: "integer", format: "int64" } : { type: kind }
		const asJsonNumber = "Flag.map((text) => new Input.JsonNumber(text))"
		const property = `${mediaPointer("/planted-numbers", "post", "application/json")}/schema/properties/${name}`
		return {
			path: "/planted-numbers",
			method: "post",
			operation: plantedOperation("numbers-create", {
				requestBody: objectBody({ [name]: schema })
			}),
			schemas: [],
			schemes: [],
			family: "a numeric property",
			variants: when(kind === "int64", "an int64 property"),
			facts:
				kind === "int64"
					? [
							{ code: "FMT-02/int64-range", scope: "element", pointer: property },
							formatNotice(line, property)
						]
					: [],
			commanded: true,
			emitted: [
				kind === "int64"
					? holds(`${name}: Input.int64Flag("${name}").pipe(Flag.optional)`)
					: holds(
							`${name}: Input.numericFlag("${name}", "${kind}").pipe(${asJsonNumber}, Flag.optional)`
						),
				lacks("Flag.Int("),
				lacks("Flag.Finite(")
			]
		}
	}

const PLANTED_KEY: Schema.Json = { type: "apiKey", in: "header", name: "X-Planted-Key" }

/**
 * A requirement naming a scheme no document declares is reported once, at the name, by check (SEC-09 on 3.0 and 3.1,
 * SEC-10 on 3.2), and its alternative is dropped: beside a declared name in one alternative, the whole alternative
 * goes. While another alternative remains the refusal is the element's and the operation keeps its command; when none
 * remains the refusal is the operation's, which has no satisfiable alternative (SEC-06) and loses its command.
 */
const undeclaredPlant =
	(line: Line, besideGen: Gen<boolean>): Gen<Plant> =>
	(s) => {
		const beside = s.draw(besideGen)
		const path = "/planted-secured"
		const operation = operationPointer(path, "get")
		const security: Schema.Json = beside
			? [{ plantedKey: [], plantedMissing: [] }]
			: [{ plantedMissing: [] }, { plantedKey: [] }]
		const unresolved = line === "3.2" ? "SEC-10/unresolved-scheme" : "SEC-09/unresolved-scheme"
		return {
			path,
			method: "get",
			operation: plantedOperation("secured-list", { security }),
			schemas: [],
			schemes: [["plantedKey", PLANTED_KEY]],
			family: "an undeclared requirement name",
			variants: [
				...when(beside, "an undeclared name beside a declared one"),
				...when(line === "3.2", "a 3.2 undeclared name")
			],
			facts: [
				{
					code: unresolved,
					scope: beside ? "operation" : "element",
					pointer: `${operation}/security/0/plantedMissing`
				},
				...(beside
					? [{ code: "SEC-06/no-satisfiable-alternative", scope: "operation", pointer: operation }]
					: [])
			],
			commanded: !beside,
			emitted: []
		}
	}

/**
 * A group whose tag folds to a file segment a fixed api module holds (api/root.ts, api/security.ts, api/servers.ts) is
 * refused by the names plan at the tag (TAG-02), and its operation has no command.
 */
const reservedTagPlant: Gen<Plant> = (s) => {
	const tag = s.draw(element(["servers", "security", "root", "Servers"]))
	const path = "/planted-reserved"
	const operation = operationPointer(path, "get")
	return {
		path,
		method: "get",
		operation: { operationId: "reserved-list", tags: [tag], responses: ok },
		schemas: [],
		schemes: [],
		family: "a tag folding to a fixed api module",
		variants: [],
		facts: [
			{ code: "TAG-02/reserved-segment", scope: "operation", pointer: `${operation}/tags/0` }
		],
		commanded: false,
		emitted: []
	}
}

const NUMERIC_KINDS: Gen<NumericKind> = element<NumericKind>(["integer", "number", "int64"])

/** One family's plant, every variant drawn, for a document's line and a config's switches. */
const familyPlant = (family: Family, line: Line, config: ConfigSketch): Gen<Plant> => {
	switch (family) {
		case "a deepObject over an object or a scalar":
			return deepScalarPlant(config, boolean)
		case "a deepObject over objects alone":
			return deepObjectsPlant
		case "a discriminator with no composition":
			return loneDiscriminatorPlant
		case "a discriminator over a composition":
			return composedDiscriminatorPlant
		case "a schema-driven XML part":
			return xmlPartPlant(boolean)
		case "a JSON object part":
			return jsonPartPlant
		case "an opaque XML body":
			return opaqueXmlPlant
		case "a default outside its type":
			return defaultPlant(line, boolean)
		case "a read-only body property":
			return readOnlyPlant(line, boolean)
		case "a password property":
			return passwordPlant(line, boolean)
		case "a password or binary part":
			return passwordPartPlant(line, boolean)
		case "a byte or base64 property":
			return bytePlant(line, boolean)
		case "a numeric property":
			return numericPlant(line, NUMERIC_KINDS)
		case "an undeclared requirement name":
			return undeclaredPlant(line, boolean)
		case "a tag folding to a fixed api module":
			return reservedTagPlant
	}
}

const FAMILIES: Arr.NonEmptyReadonlyArray<Family> = [
	"a deepObject over an object or a scalar",
	"a deepObject over objects alone",
	"a discriminator with no composition",
	"a discriminator over a composition",
	"a schema-driven XML part",
	"a JSON object part",
	"an opaque XML body",
	"a default outside its type",
	"a read-only body property",
	"a password property",
	"a password or binary part",
	"a byte or base64 property",
	"a numeric property",
	"an undeclared requirement name",
	"a tag folding to a fixed api module"
]

/** The plant a case draws: one family, drawn for the document's line and the config's switches. */
const plantGen =
	(line: Line, config: ConfigSketch): Gen<Plant> =>
	(s) =>
		s.draw(familyPlant(s.draw(element(FAMILIES)), line, config))

/** The construct cases: a generated document, an author config that fits it, and one planted operation. */
export const caseGen: Gen<ConstructCase> = (s) => {
	const document = s.draw(documentGen)
	const config = s.draw(configGen(document))
	return { document, config, plant: s.draw(plantGen(document.line, config)) }
}

/** A document of `line` with nothing in it, which an aimed case plants into: valid on every line. */
const emptyDocument = (line: Line): DocumentSketch => ({
	line,
	title: "Planted",
	description: Option.none(),
	servers: [],
	tags: [],
	components: [],
	schemes: [],
	security: Option.none(),
	operations: [],
	webhooks: []
})

/**
 * A case aimed at one situation: a generated document, or an empty one of `line` when the situation needs a line (a
 * drawn document's line is its own), with a config that fits it, `switched`, and `plant`'s draw.
 */
const aimedAt =
	(
		line: Option.Option<Line>,
		switched: (config: ConfigSketch) => ConfigSketch,
		plant: (line: Line, config: ConfigSketch) => Gen<Plant>
	): Space<ConstructCase> =>
	(s) => {
		const document = Option.match(line, {
			onNone: () => s.draw(documentGen),
			onSome: emptyDocument
		})
		const config = switched(s.draw(configGen(document)))
		return { document, config, plant: s.draw(plant(document.line, config)) }
	}

const unswitched = (config: ConfigSketch): ConfigSketch => ({ ...config, scalars: Option.none() })

const scalarsOn = (config: ConfigSketch): ConfigSketch => ({
	...config,
	scalars: Option.some(true)
})

const asDrawn = (config: ConfigSketch): ConfigSketch => config

const yes: Gen<boolean> = constant(true)

const no: Gen<boolean> = constant(false)

/**
 * The aims of the construct cases: for each family, a drawn document with that family's plant; for each variant, the
 * document's line, the config's switch and the plant's choice that make it.
 */
export const AIMS: ReadonlyArray<readonly [Feature, Space<ConstructCase>]> = [
	...Arr.map(FAMILIES, (family): readonly [Feature, Space<ConstructCase>] => [
		family,
		aimedAt(Option.none(), asDrawn, (line, config) => familyPlant(family, line, config))
	]),
	[
		"a required deepObject refused with its operation",
		aimedAt(Option.none(), unswitched, (_, config) => deepScalarPlant(config, yes))
	],
	[
		"a deepObject the scalar switch admits",
		aimedAt(Option.none(), scalarsOn, (_, config) => deepScalarPlant(config, boolean))
	],
	[
		"a required XML part refused with its operation",
		aimedAt(Option.none(), asDrawn, () => xmlPartPlant(yes))
	],
	["a 3.0 default refused", aimedAt(Option.some("3.0"), asDrawn, (line) => defaultPlant(line, no))],
	[
		"a nonconforming default kept as an annotation",
		aimedAt(Option.some("3.1"), asDrawn, (line) => defaultPlant(line, no))
	],
	[
		"a 3.0 read-only property left out",
		aimedAt(Option.some("3.0"), asDrawn, (line) => readOnlyPlant(line, boolean))
	],
	[
		"a read-only property through a reference",
		aimedAt(Option.none(), asDrawn, (line) => readOnlyPlant(line, yes))
	],
	["a described password", aimedAt(Option.none(), asDrawn, (line) => passwordPlant(line, yes))],
	["a binary part", aimedAt(Option.none(), asDrawn, (line) => passwordPartPlant(line, no))],
	["a 3.0 byte property", aimedAt(Option.some("3.0"), asDrawn, (line) => bytePlant(line, no))],
	["a base64 contentEncoding", aimedAt(Option.none(), asDrawn, (line) => bytePlant(line, yes))],
	[
		"an int64 property",
		aimedAt(Option.none(), asDrawn, (line) => numericPlant(line, constant<NumericKind>("int64")))
	],
	[
		"an undeclared name beside a declared one",
		aimedAt(Option.none(), asDrawn, (line) => undeclaredPlant(line, yes))
	],
	[
		"a 3.2 undeclared name",
		aimedAt(Option.some("3.2"), asDrawn, (line) => undeclaredPlant(line, boolean))
	]
]

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
	Predicate.isObject(value) && !Arr.isArray(value)

/** The member `key` of `object` when it is an object, else an empty one. */
const objectAt = (object: Schema.JsonObject, key: string): Schema.JsonObject => {
	const value = object[key]
	return isObject(value) ? value : {}
}

/** `entries` added to the object at `key` of `object`. */
const withEntries = (
	object: Schema.JsonObject,
	key: string,
	entries: ReadonlyArray<readonly [string, Schema.Json]>
): Schema.JsonObject =>
	Arr.isReadonlyArrayNonEmpty(entries)
		? Record.set<string, Schema.Json, string, Schema.Json>(
				object,
				key,
				Record.union(objectAt(object, key), Record.fromEntries(entries), (_, added) => added)
			)
		: object

/** The document with the planted operation at its own path and the plant's components beside the drawn ones. */
const plantedDocument = (drawnCase: ConstructCase): Schema.JsonObject => {
	const document = documentOf(drawnCase.document)
	const { plant } = drawnCase
	const components = withEntries(
		withEntries(objectAt(document, "components"), "schemas", plant.schemas),
		"securitySchemes",
		plant.schemes
	)
	const pathed = withEntries(document, "paths", [[plant.path, { [plant.method]: plant.operation }]])
	return isObject(document["components"]) ||
		Arr.isReadonlyArrayNonEmpty(plant.schemas) ||
		Arr.isReadonlyArrayNonEmpty(plant.schemes)
		? Record.set<string, Schema.Json, string, Schema.Json>(pathed, "components", components)
		: pathed
}

/** Whether a diagnostic's pointer names the planted operation or a component the plant added. */
const atPlant =
	(plant: Plant) =>
	(pointer: string): boolean =>
		Str.startsWith(operationPointer(plant.path, plant.method))(pointer) ||
		Arr.some(plant.schemas, ([name]) => Str.startsWith(`/components/schemas/${name}`)(pointer))

const byFact = Order.combine(
	Order.mapInput(Order.String, (fact: Fact) => fact.pointer),
	Order.mapInput(Order.String, (fact: Fact) => fact.code)
)

/** The plant's facts in one order, so two lists of them compare as sets that keep repeats. */
export const sortedFacts = (facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
	Arr.sort(facts, byFact)

const whiteSpace = regex("\\s+", "gu")

/** A text with every white space and every comma before a closing parenthesis or brace taken out. */
const squeezed = (text: string): string =>
	Str.replaceAll(",}", "}")(Str.replaceAll(",)", ")")(Str.replace(whiteSpace, "")(text)))

/** The emitted texts the modules break: each holds the modules lack, each lacks they hold. */
export const brokenEmitted = (
	modules: string,
	emitted: ReadonlyArray<Emitted>
): ReadonlyArray<Emitted> =>
	Arr.filter(
		emitted,
		(want) => Str.includes(squeezed(want.text))(squeezed(modules)) !== (want.kind === "holds")
	)

/**
 * Generates the case into `dir`, the case's own directory: the planted document, the drawn config. Gives the
 * diagnostics at the plant, whether its operation has a command, and the text of the `planted` group's cli and api
 * modules (empty where none was written).
 */
export const generatedAt = (dir: string, drawnCase: ConstructCase) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const configPath = path.join(dir, "author-config.json")
		yield* fs.writeFileString(configPath, textOf(configOf(drawnCase.config)))
		const outDir = path.join(dir, "out")
		const result = yield* generate(
			{
				document: DocumentUri.make("file:///planted/openapi.json"),
				outDir,
				source: {
					_tag: "Stream",
					stream: Stream.make(new TextEncoder().encode(textOf(plantedDocument(drawnCase))))
				},
				strict: false
			},
			{ document: DocumentUri.make("file:///planted/author-config.json"), path: configPath }
		)
		const { plant } = drawnCase
		const modules = yield* Effect.forEach(["src/cli/planted.ts", "src/api/planted.ts"], (file) =>
			Effect.map(Effect.exit(fs.readFileString(path.join(outDir, file))), (read) =>
				Exit.isSuccess(read) ? read.value : ""
			)
		)
		const facts: ReadonlyArray<Fact> = Arr.map(
			Arr.filter(result.diagnostics, (diagnostic) => atPlant(plant)(diagnostic.pointer)),
			(diagnostic) => ({
				code: diagnostic.code,
				scope: diagnostic.scope,
				pointer: diagnostic.pointer
			})
		)
		return {
			facts,
			commanded: Arr.some(
				result.report.commandNames,
				(command) => command.pointer === operationPointer(plant.path, plant.method)
			),
			modules: Arr.join(modules, "\n")
		}
	})
