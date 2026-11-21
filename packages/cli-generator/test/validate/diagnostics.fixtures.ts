/**
 * What the properties of diagnostics.test.ts read: documents of each line holding constructs planted in places of their
 * own, the diagnostics each line's official schema and design 10.4's known disagreements give each construct, property
 * names spelled in UTF-16 code units, the places the 3.1 text's dialect id may sit, and the spellings of the fixed
 * methods as `additionalOperations` keys.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { array, finite, type FiniteSpace, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record, String as Str } from "effect"
import { Digest } from "effect/crypto"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { documentAt, entryUri, lineGen } from "#test/support/normalizing.ts"
import {
	methods,
	type Spelling,
	spellings,
	type Unit,
	units
} from "#test/validate/diagnostics.dictionary.ts"
import { rewriteDialect } from "#validate/dialect.ts"
import { type Diagnosis, diagnoseDocument } from "#validate/index.ts"

/** The dialect id the 3.1.2 text gives Schema Objects, which its official schema does not pin. */
const textDialect = "https://spec.openapis.org/oas/3.1/dialect/base"

/** The dated dialect id the 3.1 official schema pins (design 3.2, dialect id substitution). */
const datedDialect = "https://spec.openapis.org/oas/3.1/dialect/2024-11-10"

/** The JSON Schema 2020-12 dialect id: a dialect id, but not the text's. */
const otherDialect = "https://json-schema.org/draft/2020-12/schema"

/** The official schemas whose keywords reject a construct, by the ids their errors cite. */
const schema30 = "https://spec.openapis.org/oas/3.0/schema/2024-10-18"

const schema31 = "https://spec.openapis.org/oas/3.1/schema/2026-08-03"

const schema32 = "https://spec.openapis.org/oas/3.2/schema/2026-08-30"

const schemaBase32 = "https://spec.openapis.org/oas/3.2/schema-base/2026-08-30"

const validationVocabulary = "https://json-schema.org/draft/2020-12/meta/validation"

/** The one response every planted operation answers with. */
const ok: Json = { "200": { description: "ok" } }

/** Where a construct sits in a document: a root member, a Path Item under `paths`, a schema or an example component. */
type Placement = Readonly<{ at: "root" | "path" | "schema" | "example"; key: string; value: Json }>

/**
 * The document of `line` holding each placement where it sits, its paths and components present whatever it holds. A
 * root placement keyed `openapi` declares the document's version.
 */
const placedDocument = (line: SpecLine, placements: ReadonlyArray<Placement>): Json => {
	const at = (where: Placement["at"]): Readonly<Record<string, Json>> =>
		Record.fromEntries(
			Arr.map(
				Arr.filter(placements, (placement) => placement.at === where),
				(placement) => [placement.key, placement.value] as const
			)
		)
	return documentAt(line, {
		paths: at("path"),
		components: { examples: at("example"), schemas: at("schema") },
		...at("root")
	})
}

/** The constructs a document may hold, each in a place of its own, so none changes what the schema says of another. */
const PLANTS = [
	"a two-digit patch version",
	"$self with a fragment",
	"the text's dialect id as jsonSchemaDialect",
	"the text's dialect id as two Schema Objects' $schema",
	"a link parameter that is no string",
	"allowReserved on a path parameter",
	"an unknown Parameter Object member",
	"an operation with no responses",
	"servers that are no array",
	"a Schema Object type that names no type",
	"a Schema Object of the text's dialect whose type names no type"
] as const

type Plant = (typeof PLANTS)[number]

/** Where each construct sits on `line`: only the patch version names its line. */
const placementOf = (line: SpecLine): Readonly<Record<Plant, Placement>> => ({
	"a two-digit patch version": { at: "root", key: "openapi", value: `${line}.10` },
	"$self with a fragment": { at: "root", key: "$self", value: "https://x.example/a#frag" },
	"the text's dialect id as jsonSchemaDialect": {
		at: "root",
		key: "jsonSchemaDialect",
		value: textDialect
	},
	"the text's dialect id as two Schema Objects' $schema": {
		at: "schema",
		key: "Dialect",
		value: {
			$schema: textDialect,
			properties: { inner: { $schema: textDialect, type: "string" } },
			type: "object"
		}
	},
	"a link parameter that is no string": {
		at: "path",
		key: "/link",
		value: {
			get: {
				responses: {
					"200": { description: "ok", links: { l: { operationId: "x", parameters: { id: 5 } } } }
				}
			}
		}
	},
	"allowReserved on a path parameter": {
		at: "path",
		key: "/reserved/{id}",
		value: {
			get: {
				parameters: [
					{
						allowReserved: true,
						in: "path",
						name: "id",
						required: true,
						schema: { type: "string" }
					}
				],
				responses: ok
			}
		}
	},
	"an unknown Parameter Object member": {
		at: "path",
		key: "/unknown/{x}",
		value: {
			get: {
				parameters: [{ foo: 1, in: "query", name: "b", schema: { type: "string" } }],
				responses: ok
			}
		}
	},
	"an operation with no responses": { at: "path", key: "/bare", value: { get: {} } },
	"servers that are no array": { at: "root", key: "servers", value: "x" },
	"a Schema Object type that names no type": {
		at: "schema",
		key: "Typo",
		value: { type: "strng" }
	},
	"a Schema Object of the text's dialect whose type names no type": {
		at: "schema",
		key: "Typed",
		value: { $schema: textDialect, type: "strng" }
	}
})

/** A notice as the model states it: its row, its code's slug and its pointer. */
type Notice = Readonly<{ row: string; slug: string; pointer: string }>

/** A schema refusal as the model states it: its pointer and the keyword of the official schema that rejects it. */
type SchemaRefusal = Readonly<{ pointer: string; keywordLocation: string }>

/** What a construct gives on one line: the notices the known disagreements make of it, and the schema refusals. */
type Outcome = Readonly<{ notices: ReadonlyArray<Notice>; refusals: ReadonlyArray<SchemaRefusal> }>

const nothing: Outcome = { notices: [], refusals: [] }

const notices = (row: string, slug: string, pointers: ReadonlyArray<string>): Outcome => ({
	notices: Arr.map(pointers, (pointer) => ({ row, slug, pointer })),
	refusals: []
})

const refused = (pointer: string, keywordLocation: string): Outcome => ({
	notices: [],
	refusals: [{ pointer, keywordLocation }]
})

/**
 * What each line says of each construct. A known disagreement (design 10.4) is a notice on the lines its row names: any
 * 3.0.x patch is allowed (DOC-02), `$self` may hold a fragment (DOC-03), the 3.1 text's dialect id stands wherever the
 * schema pins the dated one (SCH-01, one notice per value), a Link parameter may be any constant (LNK-04) and
 * `allowReserved` is not forbidden outside the query (PRM-35). Every other case of the official schema of the line is a
 * refusal at the instance it rejects, citing the rejecting keyword; a line whose schema admits the construct says
 * nothing.
 */
const outcomeOf: Readonly<Record<Plant, Readonly<Record<SpecLine, Outcome>>>> = {
	"a two-digit patch version": {
		"3.0": notices("DOC-02", "patch-digits", ["/openapi"]),
		"3.1": nothing,
		"3.2": nothing
	},
	"$self with a fragment": {
		"3.0": refused("/$self", `${schema30}#/additionalProperties`),
		"3.1": refused("/$self", `${schema31}#/unevaluatedProperties`),
		"3.2": notices("DOC-03", "self-fragment", ["/$self"])
	},
	"the text's dialect id as jsonSchemaDialect": {
		"3.0": refused("/jsonSchemaDialect", `${schema30}#/additionalProperties`),
		"3.1": notices("SCH-01", "dialect-base-id", ["/jsonSchemaDialect"]),
		"3.2": refused("/jsonSchemaDialect", `${schemaBase32}#/$defs/dialect/const`)
	},
	"the text's dialect id as two Schema Objects' $schema": {
		"3.0": {
			notices: [],
			refusals: [
				{
					pointer: "/components/schemas/Dialect/$schema",
					keywordLocation: `${schema30}#/definitions/Schema/additionalProperties`
				},
				{
					pointer: "/components/schemas/Dialect/properties/inner/$schema",
					keywordLocation: `${schema30}#/definitions/Schema/additionalProperties`
				}
			]
		},
		"3.1": notices("SCH-01", "dialect-base-id", [
			"/components/schemas/Dialect/$schema",
			"/components/schemas/Dialect/properties/inner/$schema"
		]),
		"3.2": {
			notices: [],
			refusals: [
				{
					pointer: "/components/schemas/Dialect/$schema",
					keywordLocation: `${schemaBase32}#/$defs/dialect/const`
				},
				{
					pointer: "/components/schemas/Dialect/properties/inner/$schema",
					keywordLocation: `${schemaBase32}#/$defs/dialect/const`
				}
			]
		}
	},
	"a link parameter that is no string": {
		"3.0": nothing,
		"3.1": notices("LNK-04", "non-string-parameter", [
			"/paths/~1link/get/responses/200/links/l/parameters/id"
		]),
		"3.2": notices("LNK-04", "non-string-parameter", [
			"/paths/~1link/get/responses/200/links/l/parameters/id"
		])
	},
	"allowReserved on a path parameter": {
		"3.0": nothing,
		"3.1": notices("PRM-35", "allow-reserved-outside-query", [
			"/paths/~1reserved~1{id}/get/parameters/0/allowReserved"
		]),
		"3.2": nothing
	},
	"an unknown Parameter Object member": {
		"3.0": refused(
			"/paths/~1unknown~1{x}/get/parameters/0/foo",
			`${schema30}#/definitions/Parameter/additionalProperties`
		),
		"3.1": refused(
			"/paths/~1unknown~1{x}/get/parameters/0/foo",
			`${schema31}#/$defs/parameter/unevaluatedProperties`
		),
		"3.2": refused(
			"/paths/~1unknown~1{x}/get/parameters/0/foo",
			`${schema32}#/$defs/parameter/unevaluatedProperties`
		)
	},
	"an operation with no responses": {
		"3.0": refused("/paths/~1bare/get", `${schema30}#/definitions/Operation/required`),
		"3.1": nothing,
		"3.2": nothing
	},
	"servers that are no array": {
		"3.0": refused("/servers", `${schema30}#/properties/servers/type`),
		"3.1": refused("/servers", `${schema31}#/properties/servers/type`),
		"3.2": refused("/servers", `${schema32}#/properties/servers/type`)
	},
	"a Schema Object type that names no type": {
		"3.0": refused(
			"/components/schemas/Typo/type",
			`${schema30}#/definitions/Schema/properties/type/enum`
		),
		"3.1": refused(
			"/components/schemas/Typo/type",
			`${validationVocabulary}#/properties/type/anyOf`
		),
		"3.2": refused(
			"/components/schemas/Typo/type",
			`${validationVocabulary}#/properties/type/anyOf`
		)
	},
	"a Schema Object of the text's dialect whose type names no type": {
		"3.0": {
			notices: [],
			refusals: [
				{
					pointer: "/components/schemas/Typed/$schema",
					keywordLocation: `${schema30}#/definitions/Schema/additionalProperties`
				},
				{
					pointer: "/components/schemas/Typed/type",
					keywordLocation: `${schema30}#/definitions/Schema/properties/type/enum`
				}
			]
		},
		"3.1": {
			notices: [
				{ row: "SCH-01", slug: "dialect-base-id", pointer: "/components/schemas/Typed/$schema" }
			],
			refusals: [
				{
					pointer: "/components/schemas/Typed/type",
					keywordLocation: `${validationVocabulary}#/properties/type/anyOf`
				}
			]
		},
		"3.2": {
			notices: [],
			refusals: [
				{
					pointer: "/components/schemas/Typed/$schema",
					keywordLocation: `${schemaBase32}#/$defs/dialect/const`
				},
				{
					pointer: "/components/schemas/Typed/type",
					keywordLocation: `${validationVocabulary}#/properties/type/anyOf`
				}
			]
		}
	}
}

/** The row under which each line refuses what its official schema rejects. */
const refusalRowOf: Readonly<Record<SpecLine, string>> = {
	"3.0": "VAL-02",
	"3.1": "VAL-03",
	"3.2": "VAL-04"
}

/** A diagnostic as the properties compare it: its code, row, severity, scope and pointer. */
type DiagnosticSeen = Readonly<{
	code: string
	row: string
	severity: string
	scope: string
	pointer: string
}>

/** A refusal as the diagnosis property compares it: its diagnostic and the keyword location it cites. */
type RefusalSeen = DiagnosticSeen & Readonly<{ keywordLocation: string }>

/** A diagnosis as the diagnosis property compares it, each list in pointer order, then by code. */
export type DiagnosisSeen = Readonly<{
	notices: ReadonlyArray<DiagnosticSeen>
	refusals: ReadonlyArray<RefusalSeen>
}>

/** A diagnosis as the properties of the diagnostics alone compare it, each list in pointer order, then by code. */
export type DiagnosticsSeen = Readonly<{
	notices: ReadonlyArray<DiagnosticSeen>
	refusals: ReadonlyArray<DiagnosticSeen>
}>

const byPlace: Order.Order<DiagnosticSeen> = Order.Struct({
	pointer: Order.String,
	code: Order.String
})

const seenOf = (diagnostic: Diagnostic): DiagnosticSeen => ({
	code: diagnostic.code,
	row: diagnostic.row,
	severity: diagnostic.severity,
	scope: diagnostic.scope,
	pointer: diagnostic.pointer
})

/** What diagnoseDocument answers for `document`, read under the Digest service a check is given, as it is compared. */
const diagnosisOf = (document: Json, digest: typeof Digest.Digest.Service) =>
	Effect.map(
		diagnoseDocument(document, entryUri).pipe(Effect.provideService(Digest.Digest, digest)),
		(diagnosis: Diagnosis): DiagnosisSeen => ({
			notices: Arr.sort(Arr.map(diagnosis.notices, seenOf), byPlace),
			refusals: Arr.sort(
				Arr.map(diagnosis.refusals, (refusal) => ({
					...seenOf(refusal.diagnostic),
					keywordLocation: refusal.keywordLocation
				})),
				byPlace
			)
		})
	)

/** The model's notice as the diagnostic it is: an element-scope notice under its row. */
const noticeSeen = (notice: Notice): DiagnosticSeen => ({
	code: `${notice.row}/${notice.slug}`,
	row: notice.row,
	severity: "notice",
	scope: "element",
	pointer: notice.pointer
})

/** The model's schema refusal on `line` as the refusal it is: a document-scope refusal under the line's row. */
const refusalSeen =
	(line: SpecLine) =>
	(refusal: SchemaRefusal): RefusalSeen => ({
		code: `${refusalRowOf[line]}/schema-invalid`,
		row: refusalRowOf[line],
		severity: "refusal",
		scope: "document",
		pointer: refusal.pointer,
		keywordLocation: refusal.keywordLocation
	})

/** The outcomes of every construct of `plants` on `line`, joined. */
const outcomesOf = (line: SpecLine, plants: ReadonlyArray<Plant>): Outcome => ({
	notices: Arr.flatMap(plants, (plant) => outcomeOf[plant][line].notices),
	refusals: Arr.flatMap(plants, (plant) => outcomeOf[plant][line].refusals)
})

/** A document of a line holding some of the constructs. */
export type Planted = Readonly<{ line: SpecLine; plants: ReadonlyArray<Plant> }>

/** Every line, with no construct and with every one, two or three of them together. */
export const plantedSpace: FiniteSpace<Planted> = finite((source) => ({
	line: source.draw(lineGen),
	plants: source.draw(subset(PLANTS, { min: 0, max: 3 }))
}))

export type DiagnosisFeature =
	| "no diagnostic"
	| "a notice beside a refusal"
	| "two notices of one row"
	| `a ${"DOC-02" | "DOC-03" | "SCH-01" | "LNK-04" | "PRM-35"} notice`
	| `a ${"VAL-02" | "VAL-03" | "VAL-04"} refusal`

/** The diagnosis the model states for a planted document, each list in pointer order, then by code. */
const expectedDiagnosisOf = (planted: Planted): DiagnosisSeen => {
	const outcome = outcomesOf(planted.line, planted.plants)
	return {
		notices: Arr.sort(Arr.map(outcome.notices, noticeSeen), byPlace),
		refusals: Arr.sort(Arr.map(outcome.refusals, refusalSeen(planted.line)), byPlace)
	}
}

const plantedDocument = (planted: Planted): Json =>
	placedDocument(
		planted.line,
		Arr.map(planted.plants, (plant) => placementOf(planted.line)[plant])
	)

/** A planted document after its diagnosis, and the diagnosis. */
export type PlantedSeen = Readonly<{ input: Json; diagnosis: DiagnosisSeen }>

/** What the model states of a planted document: it is left as it was built, and diagnosed as its line says. */
export const expectedPlantedOf = (planted: Planted): PlantedSeen => ({
	input: plantedDocument(planted),
	diagnosis: expectedDiagnosisOf(planted)
})

/** The planted document after diagnoseDocument reads it, and the diagnosis it gives. */
export const plantedAnswerOf = (planted: Planted, digest: typeof Digest.Digest.Service) => {
	const input = plantedDocument(planted)
	return Effect.map(diagnosisOf(input, digest), (diagnosis): PlantedSeen => ({ input, diagnosis }))
}

export const diagnosisFeaturesOf = (planted: Planted): ReadonlyArray<DiagnosisFeature> => {
	const expected = expectedDiagnosisOf(planted)
	const rows = Arr.map(expected.notices, (notice) => notice.row)
	const facts: ReadonlyArray<readonly [boolean, DiagnosisFeature]> = [
		[
			Arr.isReadonlyArrayEmpty(expected.notices) && Arr.isReadonlyArrayEmpty(expected.refusals),
			"no diagnostic"
		],
		[
			Arr.isReadonlyArrayNonEmpty(expected.notices) &&
				Arr.isReadonlyArrayNonEmpty(expected.refusals),
			"a notice beside a refusal"
		],
		[Arr.length(Arr.dedupe(rows)) < Arr.length(rows), "two notices of one row"],
		[Arr.contains(rows, "DOC-02"), "a DOC-02 notice"],
		[Arr.contains(rows, "DOC-03"), "a DOC-03 notice"],
		[Arr.contains(rows, "SCH-01"), "a SCH-01 notice"],
		[Arr.contains(rows, "LNK-04"), "a LNK-04 notice"],
		[Arr.contains(rows, "PRM-35"), "a PRM-35 notice"],
		[Arr.isReadonlyArrayNonEmpty(expected.refusals) && planted.line === "3.0", "a VAL-02 refusal"],
		[Arr.isReadonlyArrayNonEmpty(expected.refusals) && planted.line === "3.1", "a VAL-03 refusal"],
		[Arr.isReadonlyArrayNonEmpty(expected.refusals) && planted.line === "3.2", "a VAL-04 refusal"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

const textOf: Readonly<Record<Unit, string>> = {
	letter: "a",
	"high surrogate": "\uD83D",
	"low surrogate": "\uDE00"
}

/** A code unit as a pointer shows it when it stands alone: `\u` and its four uppercase hexadecimal digits. */
const escapedOf: Readonly<Record<Unit, string>> = {
	letter: "a",
	"high surrogate": "\\uD83D",
	"low surrogate": "\\uDE00"
}

/** A document of a line holding a schema property named in code units, and at most one construct beside it. */
export type Named = Readonly<{
	line: SpecLine
	name: ReadonlyArray<Unit>
	plants: ReadonlyArray<Plant>
}>

/** Every line, every name of one to three code units, with no construct beside it or each one alone. */
export const namedSpace: FiniteSpace<Named> = finite((source) => ({
	line: source.draw(lineGen),
	name: source.draw(array(word(units), { min: 1, max: 3 })),
	plants: source.draw(subset(PLANTS, { min: 0, max: 1 }))
}))

/**
 * Whether the unit at `index` stands alone, as UTF-16 reads it: a high surrogate no low one follows, or a low surrogate
 * no high one precedes.
 */
const standsAlone = (name: ReadonlyArray<Unit>, index: number, unit: Unit): boolean => {
	switch (unit) {
		case "letter":
			return false
		case "high surrogate":
			return name[index + 1] !== "low surrogate"
		case "low surrogate":
			return name[index - 1] !== "high surrogate"
	}
}

const loneIn = (name: ReadonlyArray<Unit>): ReadonlyArray<boolean> =>
	Arr.map(name, (unit, index) => standsAlone(name, index, unit))

export type NamedFeature =
	| "a lone high surrogate"
	| "a lone low surrogate"
	| "a surrogate pair"
	| "a lone surrogate beside a construct"
	| "a well-formed name beside a construct"

export const namedFeaturesOf = (named: Named): ReadonlyArray<NamedFeature> => {
	const lone = loneIn(named.name)
	const anyLone = Arr.some(lone, (alone) => alone)
	const facts: ReadonlyArray<readonly [boolean, NamedFeature]> = [
		[
			Arr.some(named.name, (unit, index) => unit === "high surrogate" && lone[index] === true),
			"a lone high surrogate"
		],
		[
			Arr.some(named.name, (unit, index) => unit === "low surrogate" && lone[index] === true),
			"a lone low surrogate"
		],
		[
			Arr.some(named.name, (unit, index) => unit === "high surrogate" && lone[index] === false),
			"a surrogate pair"
		],
		[anyLone && Arr.isReadonlyArrayNonEmpty(named.plants), "a lone surrogate beside a construct"],
		[!anyLone && Arr.isReadonlyArrayNonEmpty(named.plants), "a well-formed name beside a construct"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

const diagnosticsSeenOf = (diagnosis: DiagnosisSeen): DiagnosticsSeen => ({
	notices: diagnosis.notices,
	refusals: Arr.map(diagnosis.refusals, ({ keywordLocation: _, ...diagnostic }) => diagnostic)
})

/**
 * The diagnostics the model states for a named document: a name holding a lone surrogate is no Unicode text, so the
 * document is refused at that name (DOC-14) before any schema reads it, and nothing else is said of it; a well-formed
 * name says nothing, and the construct beside it says what it says alone.
 */
export const expectedNamedOf = (named: Named): DiagnosticsSeen => {
	const lone = loneIn(named.name)
	return Arr.some(lone, (alone) => alone)
		? {
				notices: [],
				refusals: [
					{
						code: "DOC-14/invalid-encoding",
						row: "DOC-14",
						severity: "refusal",
						scope: "document",
						pointer: `/components/schemas/One/properties/${Arr.join(
							Arr.map(named.name, (unit, index) =>
								lone[index] === true ? escapedOf[unit] : textOf[unit]
							),
							""
						)}`
					}
				]
			}
		: diagnosticsSeenOf(expectedDiagnosisOf({ line: named.line, plants: named.plants }))
}

/** The diagnostics diagnoseDocument gives a named document, each list in pointer order, then by code. */
export const namedAnswerOf = (named: Named, digest: typeof Digest.Digest.Service) =>
	Effect.map(
		diagnosisOf(
			placedDocument(named.line, [
				{
					at: "schema",
					key: "One",
					value: {
						properties: {
							[Arr.join(
								Arr.map(named.name, (unit) => textOf[unit]),
								""
							)]: { type: "string" }
						},
						type: "object"
					}
				},
				...Arr.map(named.plants, (plant) => placementOf(named.line)[plant])
			]),
			digest
		),
		diagnosticsSeenOf
	)

/** The places a dialect id may sit in a document. */
const SITES = [
	"jsonSchemaDialect at the root",
	"a Schema Object's $schema",
	"a nested Schema Object's $schema",
	"a $schema in an allOf item",
	"a $schema inside an example value",
	"a jsonSchemaDialect below the root",
	"another dialect's $schema"
] as const

type Site = (typeof SITES)[number]

/**
 * A place a dialect id sits: where, holding which id, its pointer, and whether the rewrite counts it. The rewrite
 * counts the text's id as the root's `jsonSchemaDialect` or as any `$schema`, wherever it sits, since the walk does not
 * tell Schema Objects from other values; a `jsonSchemaDialect` below the root and another dialect's id are no site.
 */
type Sited = Readonly<{
	placement: (id: string) => Placement
	id: string
	pointer: string
	counted: boolean
}>

const siteOf: Readonly<Record<Site, Sited>> = {
	"jsonSchemaDialect at the root": {
		placement: (id) => ({ at: "root", key: "jsonSchemaDialect", value: id }),
		id: textDialect,
		pointer: "/jsonSchemaDialect",
		counted: true
	},
	"a Schema Object's $schema": {
		placement: (id) => ({ at: "schema", key: "Dialect", value: { $schema: id, type: "string" } }),
		id: textDialect,
		pointer: "/components/schemas/Dialect/$schema",
		counted: true
	},
	"a nested Schema Object's $schema": {
		placement: (id) => ({
			at: "schema",
			key: "Nested",
			value: { properties: { inner: { $schema: id } }, type: "object" }
		}),
		id: textDialect,
		pointer: "/components/schemas/Nested/properties/inner/$schema",
		counted: true
	},
	"a $schema in an allOf item": {
		placement: (id) => ({ at: "schema", key: "Composed", value: { allOf: [{ $schema: id }] } }),
		id: textDialect,
		pointer: "/components/schemas/Composed/allOf/0/$schema",
		counted: true
	},
	"a $schema inside an example value": {
		placement: (id) => ({ at: "example", key: "Example", value: { value: { $schema: id } } }),
		id: textDialect,
		pointer: "/components/examples/Example/value/$schema",
		counted: true
	},
	"a jsonSchemaDialect below the root": {
		placement: (id) => ({
			at: "example",
			key: "Nested",
			value: { value: { jsonSchemaDialect: id } }
		}),
		id: textDialect,
		pointer: "/components/examples/Nested/value/jsonSchemaDialect",
		counted: false
	},
	"another dialect's $schema": {
		placement: (id) => ({ at: "schema", key: "Other", value: { $schema: id } }),
		id: otherDialect,
		pointer: "/components/schemas/Other/$schema",
		counted: false
	}
}

/** A document of a line holding a dialect id at some of the places one may sit. */
export type Dialected = Readonly<{ line: SpecLine; sites: ReadonlyArray<Site> }>

/** Every line, with every set of the places a dialect id may sit. */
export const dialectedSpace: FiniteSpace<Dialected> = finite((source) => ({
	line: source.draw(lineGen),
	sites: source.draw(subset(SITES, { min: 0, max: SITES.length }))
}))

/** A rewrite as the property compares it: the input after it, the copy, whether they are one value, the sites counted. */
export type RewriteSeen = Readonly<{
	input: Json
	copy: Json
	sameValue: boolean
	occurrences: ReadonlyArray<string>
}>

/** Whether the rewrite counts a site on `line`: only the 3.1 line has the text's dialect id. */
const rewrittenOn = (line: SpecLine, site: Site): boolean => line === "3.1" && siteOf[site].counted

const dialectedDocument = (dialected: Dialected, idOf: (site: Site) => string): Json =>
	placedDocument(
		dialected.line,
		Arr.map(dialected.sites, (site) => siteOf[site].placement(idOf(site)))
	)

/**
 * The rewrite the model states: the input unchanged, a copy that is another value holding the dated id at every
 * counted site of the 3.1 line and everything else as the input holds it, and the counted sites' pointers.
 */
export const expectedRewriteOf = (dialected: Dialected): RewriteSeen => ({
	input: dialectedDocument(dialected, (site) => siteOf[site].id),
	copy: dialectedDocument(dialected, (site) =>
		rewrittenOn(dialected.line, site) ? datedDialect : siteOf[site].id
	),
	sameValue: false,
	occurrences: Arr.sort(
		Arr.map(
			Arr.filter(dialected.sites, (site) => rewrittenOn(dialected.line, site)),
			(site) => siteOf[site].pointer
		),
		Order.String
	)
})

/** What rewriteDialect does to a dialected document, its counted pointers sorted. */
export const rewriteAnswerOf = (dialected: Dialected) => {
	const input = dialectedDocument(dialected, (site) => siteOf[site].id)
	return Effect.map(rewriteDialect(input), (rewritten): RewriteSeen => ({
		input,
		copy: rewritten.copy,
		sameValue: Object.is(rewritten.copy, input),
		occurrences: Arr.sort(rewritten.occurrences, Order.String)
	}))
}

export type DialectFeature =
	| "no site"
	| "an id rewritten"
	| "an id left on 3.0"
	| "an id left on 3.2"
	| "a jsonSchemaDialect below the root left"
	| "another dialect's id left"

export const dialectFeaturesOf = (dialected: Dialected): ReadonlyArray<DialectFeature> => {
	const facts: ReadonlyArray<readonly [boolean, DialectFeature]> = [
		[Arr.isReadonlyArrayEmpty(dialected.sites), "no site"],
		[Arr.some(dialected.sites, (site) => rewrittenOn(dialected.line, site)), "an id rewritten"],
		[dialected.line === "3.0" && Arr.isReadonlyArrayNonEmpty(dialected.sites), "an id left on 3.0"],
		[dialected.line === "3.2" && Arr.isReadonlyArrayNonEmpty(dialected.sites), "an id left on 3.2"],
		[
			dialected.line === "3.1" &&
				Arr.contains(dialected.sites, "a jsonSchemaDialect below the root"),
			"a jsonSchemaDialect below the root left"
		],
		[
			dialected.line === "3.1" && Arr.contains(dialected.sites, "another dialect's $schema"),
			"another dialect's id left"
		]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

const spelledAs: Readonly<Record<Spelling, (method: string) => string>> = {
	lowercase: (method) => method,
	uppercase: Str.toUpperCase,
	capitalized: Str.capitalize
}

/** A 3.2 Path Item holding a fixed method and an `additionalOperations` key spelling that method. */
export type MethodKey = Readonly<{ method: string; spelling: Spelling }>

/** Every fixed method of the 3.2 Path Item Object, in every spelling. */
export const methodKeySpace: FiniteSpace<MethodKey> = finite((source) => ({
	method: source.draw(word(methods)),
	spelling: source.draw(word(spellings))
}))

export type MethodKeyFeature = `a ${Spelling} key`

export const methodKeyFeaturesOf = (key: MethodKey): ReadonlyArray<MethodKeyFeature> => [
	`a ${key.spelling} key`
]

/**
 * What the model states of a fixed method as an `additionalOperations` key: the text bars it in any spelling (PTH-24),
 * which the structure check refuses, so validation says nothing of it, whether its schema bars the spelling or not.
 */
export const expectedMethodKey: DiagnosisSeen = expectedDiagnosisOf({ line: "3.2", plants: [] })

/** The diagnosis diagnoseDocument gives the 3.2 document whose Path Item holds the method and the key. */
export const methodKeyAnswerOf = (key: MethodKey, digest: typeof Digest.Digest.Service) =>
	diagnosisOf(
		placedDocument("3.2", [
			{
				at: "path",
				key: "/a",
				value: {
					additionalOperations: { [spelledAs[key.spelling](key.method)]: { responses: ok } },
					[key.method]: { responses: ok }
				}
			}
		]),
		digest
	)
