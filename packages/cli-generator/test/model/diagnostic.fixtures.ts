/**
 * What the properties of diagnostic.test.ts read: diagnostic and verdict sketches, faults planted in them, and a
 * model of design 3.7's diagnostic order written apart from the module's own.
 */

import {
	aimed,
	type Aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Exit,
	Option,
	Order,
	Predicate,
	Record,
	Schema,
	String as Str
} from "effect"
import {
	isDiagnostic,
	isDocumentRefusal,
	isRefusal,
	makeDiagnostic,
	sortDiagnostics
} from "#model/diagnostic.ts"
import type { Diagnostic, DiagnosticInput } from "#model/diagnostic.ts"
import type { Json } from "#model/pointer.ts"
import { Verdict } from "#model/verdict.ts"

type Scope = "document" | "operation" | "element" | "field"

type Severity = "refusal" | "notice"

/** A fault planted in a diagnostic's JSON form, each of which isDiagnostic must refuse. */
export type DiagnosticFault =
	| "a code naming another row"
	| "a malformed code"
	| "an unknown scope"
	| "a pointer that is no RFC 6901 text"
	| "a position below one"

/** A diagnostic as drawn: its row, code slug, place and every optional field, and one fault or none. */
export type DiagnosticSketch = Readonly<{
	prefix: string
	number: number
	slug: string
	document: string
	pointer: string
	scope: Scope
	severity: Severity
	column: Option.Option<number>
	line: Option.Option<number>
	hint: Option.Option<string>
	operation: Option.Option<
		Readonly<{ method: string; path: string; operationId: Option.Option<string> }>
	>
	related: Option.Option<ReadonlyArray<Readonly<{ document: string; pointer: string }>>>
	wire: Option.Option<string>
	fault: Option.Option<DiagnosticFault>
}>

export type CodecFeature =
	| `${DiagnosticFault} refused`
	| "a diagnostic of every optional field"
	| "a diagnostic of no optional field"
	| "a row whose prefix holds a digit"
	| `a ${Scope} ${Severity}`

const documents = ["file:///a.json", "file:///b.json", "file:///z.json"] as const

const pointerGen = element([
	"",
	"/paths/~1x/get",
	"/paths/~1x/get/parameters/2",
	"/paths/~1x/get/parameters/10",
	"/paths/~1x",
	"/info",
	"/a~0b",
	"/components/schemas/A"
])

const sketchGen =
	(fault: Gen<Option.Option<DiagnosticFault>>): Gen<DiagnosticSketch> =>
	(s) => ({
		prefix: s.draw(element(["PRM", "S30", "CFG", "RQB", "A1B"])),
		number: s.draw(int(1, 30)),
		slug: s.draw(element(["compound-nested", "a", "array-without-items", "x1-y2"])),
		document: s.draw(element(documents)),
		pointer: s.draw(pointerGen),
		scope: s.draw(element<Scope>(["document", "operation", "element", "field"])),
		severity: s.draw(element<Severity>(["refusal", "notice"])),
		column: s.draw(option(int(1, 80))),
		line: s.draw(option(int(1, 400))),
		hint: s.draw(option(element(["h", 'naming.operations["x"].skip']))),
		operation: s.draw(
			option((inner) => ({
				method: inner.draw(element(["GET", "POST"])),
				path: inner.draw(element(["/x", "/users/{id}"])),
				operationId: inner.draw(option(element(["users-update", "list"])))
			}))
		),
		related: s.draw(
			option(
				array(
					(inner) => ({
						document: inner.draw(element(documents)),
						pointer: inner.draw(pointerGen)
					}),
					{ min: 0, max: 2 }
				)
			)
		),
		wire: s.draw(option(element(["session", "X-Trace"]))),
		fault: s.draw(fault)
	})

const noFault: Gen<Option.Option<DiagnosticFault>> = constant(Option.none())

const anyFault: Gen<Option.Option<DiagnosticFault>> = weighted<Option.Option<DiagnosticFault>>([
	[3, noFault],
	[
		1,
		map(
			element<DiagnosticFault>([
				"a code naming another row",
				"a malformed code",
				"an unknown scope",
				"a pointer that is no RFC 6901 text",
				"a position below one"
			]),
			Option.some
		)
	]
])

const rowOf = (sketch: DiagnosticSketch): string => `${sketch.prefix}-${sketch.number}`

/** A code off `^[A-Z][A-Z0-9]*-[0-9]+/<kebab>$`, built from the sketch's own row. */
const malformedCode = (sketch: DiagnosticSketch): string =>
	[
		`${Str.toLowerCase(sketch.prefix)}-${sketch.number}/${sketch.slug}`,
		rowOf(sketch),
		`${sketch.prefix}${sketch.number}/${sketch.slug}`,
		`${rowOf(sketch)}/${Str.toUpperCase(sketch.slug)}`,
		`${rowOf(sketch)}/-${sketch.slug}`
	][sketch.number % 5] ?? rowOf(sketch)

const entry = <A>(key: string, value: Option.Option<A>): Option.Option<readonly [string, A]> =>
	Option.map(value, (present) => [key, present] as const)

/** The sketch's encoded form, every optional key present or absent, its fault planted. */
const encodedOf = (sketch: DiagnosticSketch): Json => {
	const fault = Option.getOrUndefined(sketch.fault)
	const row = rowOf(sketch)
	const code = fault === "a malformed code" ? malformedCode(sketch) : `${row}/${sketch.slug}`
	return Record.fromEntries([
		["code", code],
		...Arr.getSomes([
			entry("column", fault === "a position below one" ? Option.some(0) : sketch.column)
		]),
		["document", sketch.document],
		["element", "Parameter style deepObject"],
		...Arr.getSomes([entry("hint", sketch.hint), entry("line", sketch.line)]),
		["message", "deepObject value has nested objects"],
		["openapi", "3.0.3"],
		...Arr.getSomes([
			entry(
				"operation",
				Option.map(sketch.operation, (operation) =>
					Record.fromEntries([
						["method", operation.method],
						...Arr.getSomes([entry("operationId", operation.operationId)]),
						["path", operation.path]
					])
				)
			)
		]),
		["pointer", fault === "a pointer that is no RFC 6901 text" ? "#/paths" : sketch.pointer],
		...Arr.getSomes([entry("related", sketch.related)]),
		["row", fault === "a code naming another row" ? `${sketch.prefix}-${sketch.number + 1}` : row],
		["scope", fault === "an unknown scope" ? "property" : sketch.scope],
		["severity", sketch.severity],
		["specSection", "https://spec.openapis.org/oas/v3.0.4.html#style-values"],
		...Arr.getSomes([entry("wire", sketch.wire)])
	])
}

/** The factory's input for a sketch: its encoded form without `row`, every absent optional key given as undefined. */
const inputOf = (sketch: DiagnosticSketch): DiagnosticInput => ({
	code: `${rowOf(sketch)}/${sketch.slug}`,
	column: Option.getOrUndefined(sketch.column),
	document: sketch.document,
	element: "Parameter style deepObject",
	hint: Option.getOrUndefined(sketch.hint),
	line: Option.getOrUndefined(sketch.line),
	message: "deepObject value has nested objects",
	openapi: "3.0.3",
	operation: Option.getOrUndefined(
		Option.map(sketch.operation, (operation) =>
			Option.match(operation.operationId, {
				onNone: () => ({ method: operation.method, path: operation.path }),
				onSome: (operationId) => ({ method: operation.method, operationId, path: operation.path })
			})
		)
	),
	pointer: sketch.pointer,
	related: Option.getOrUndefined(sketch.related),
	scope: sketch.scope,
	severity: sketch.severity,
	specSection: "https://spec.openapis.org/oas/v3.0.4.html#style-values",
	wire: Option.getOrUndefined(sketch.wire)
})

/** What the reader, the factory and the predicates answer for one sketch. */
export type CodecAnswer =
	| Readonly<{ kind: "refused" }>
	| Readonly<{
			kind: "read"
			value: Json
			built: Json
			builtKeys: ReadonlyArray<string>
			refusal: boolean
			documentRefusal: boolean
	  }>

const keysOf = (value: unknown): ReadonlyArray<string> =>
	Predicate.isReadonlyObject(value) ? Record.keys(value) : []

/**
 * The reader's and factory's answer: a refusal, or the value read, the factory's diagnostic from the same fields and
 * the predicates over the value.
 */
export const codecAnswerOf = (sketch: DiagnosticSketch): Effect.Effect<CodecAnswer> =>
	Effect.gen(function* () {
		const value = encodedOf(sketch)
		if (!isDiagnostic(value)) {
			return { kind: "refused" }
		}
		const built = yield* makeDiagnostic(inputOf(sketch))
		return {
			kind: "read",
			value,
			built,
			builtKeys: keysOf(built),
			refusal: isRefusal(value),
			documentRefusal: isDocumentRefusal(value)
		}
	})

/** The order the model lists a Diagnostic's members in: its fields as declared, absent optional ones left out. */
const declared = [
	"code",
	"column",
	"document",
	"element",
	"hint",
	"line",
	"message",
	"openapi",
	"operation",
	"pointer",
	"related",
	"row",
	"scope",
	"severity",
	"specSection",
	"wire"
] as const

/**
 * The model's answer: a faulty sketch refused; a sound one read as it is, and the factory builds the same diagnostic
 * with its members in the model's order.
 */
export const expectedCodecOf = (sketch: DiagnosticSketch): CodecAnswer => {
	if (Option.isSome(sketch.fault)) {
		return { kind: "refused" }
	}
	const value = encodedOf(sketch)
	return {
		kind: "read",
		value,
		built: value,
		builtKeys: Arr.filter(declared, (key) => Arr.contains(keysOf(value), key)),
		refusal: sketch.severity === "refusal",
		documentRefusal: sketch.severity === "refusal" && sketch.scope === "document"
	}
}

export const codecFeaturesOf = (sketch: DiagnosticSketch): ReadonlyArray<CodecFeature> => {
	const optional: ReadonlyArray<Option.Option<unknown>> = [
		sketch.column,
		sketch.line,
		sketch.hint,
		sketch.operation,
		sketch.related,
		sketch.wire
	]
	return Option.match(sketch.fault, {
		onSome: (fault): ReadonlyArray<CodecFeature> => [`${fault} refused`],
		onNone: (): ReadonlyArray<CodecFeature> => [
			`a ${sketch.scope} ${sketch.severity}`,
			...(Arr.every(optional, Option.isSome)
				? ["a diagnostic of every optional field" as const]
				: []),
			...(Arr.every(optional, Option.isNone) ? ["a diagnostic of no optional field" as const] : []),
			...(Str.includes("3")(sketch.prefix) || Str.includes("1")(sketch.prefix)
				? ["a row whose prefix holds a digit" as const]
				: [])
		]
	})
}

const scoped =
	(scope: Scope, severity: Severity): Gen<DiagnosticSketch> =>
	(s) => ({ ...s.draw(sketchGen(noFault)), scope, severity })

/** Diagnostic sketches, aimed at each fault, each scope and severity, and at every and no optional field. */
export const diagnosticSpace: Aimed<DiagnosticSketch, CodecFeature> = aimed(sketchGen(anyFault), [
	...Arr.map(
		[
			"a code naming another row",
			"a malformed code",
			"an unknown scope",
			"a pointer that is no RFC 6901 text",
			"a position below one"
		] as const,
		(fault) => [`${fault} refused`, sketchGen(constant(Option.some(fault)))] as const
	),
	...Arr.flatMap(["document", "operation", "element", "field"] as const, (scope) =>
		Arr.map(
			["refusal", "notice"] as const,
			(severity) => [`a ${scope} ${severity}`, scoped(scope, severity)] as const
		)
	),
	[
		"a diagnostic of every optional field",
		(s) => {
			const sketch = s.draw(sketchGen(noFault))
			return {
				...sketch,
				column: Option.some(3),
				line: Option.some(12),
				hint: Option.some("h"),
				operation: Option.some({ method: "GET", path: "/x", operationId: Option.some("list") }),
				related: Option.some([{ document: "file:///b.json", pointer: "/info" }]),
				wire: Option.some("session")
			}
		}
	],
	[
		"a diagnostic of no optional field",
		(s) => ({
			...s.draw(sketchGen(noFault)),
			column: Option.none(),
			line: Option.none(),
			hint: Option.none(),
			operation: Option.none(),
			related: Option.none(),
			wire: Option.none()
		})
	],
	["a row whose prefix holds a digit", (s) => ({ ...s.draw(sketchGen(noFault)), prefix: "S30" })]
])

/** A diagnostic list to sort: sound sketches, the documents the set lists, and the order the list arrives in. */
export type SortCase = Readonly<{
	listed: ReadonlyArray<string>
	sketches: ReadonlyArray<DiagnosticSketch>
	arrival: ReadonlyArray<number>
}>

export type OrderFeature =
	| "two pointers differing in an array index"
	| "a document outside the set"
	| "two diagnostics at one place told apart by code"
	| "a pointer and its own descendant"

const sortGen =
	(sketch: Gen<DiagnosticSketch>): Gen<SortCase> =>
	(s) => {
		const sketches = s.draw(array(sketch, { min: 0, max: 6 }))
		return {
			listed: s.draw(shuffled(["file:///a.json", "file:///b.json"], { min: 1, max: 2 })),
			sketches,
			arrival: s.draw(
				shuffled(
					Array.from({ length: sketches.length }, (_, index) => index),
					{
						min: sketches.length,
						max: sketches.length
					}
				)
			)
		}
	}

const indexToken = regex("^(?:0|[1-9][0-9]*)$", "u")

/** Design 3.7's order on pointer text, token by token: two array indices by number, other tokens by code units. */
const pointerTokens = (pointer: string): ReadonlyArray<string> =>
	Arr.drop(Str.split("/")(pointer), 1)

const tokenOrder: Order.Order<string> = Order.make((left, right) =>
	indexToken.test(left) && indexToken.test(right)
		? Order.Number(Number(left), Number(right))
		: Order.String(left, right)
)

/** A diagnostic as an order sees it: its document, pointer and code. */
type Placed = Readonly<{ document: string; pointer: string; code: string }>

/** The model's order: the document's place in the set (any other last), then pointer, then code. */
const modelOrder = (listed: ReadonlyArray<string>): Order.Order<Placed> =>
	Order.combineAll<Placed>([
		Order.mapInput(Order.Number, (d: Placed) =>
			Option.getOrElse(
				Arr.findFirstIndex(listed, (document) => document === d.document),
				() => listed.length
			)
		),
		Order.mapInput(Order.Array(tokenOrder), (d: Placed) => pointerTokens(d.pointer)),
		Order.mapInput(Order.String, (d: Placed) => d.code)
	])

const placedOf = (d: Readonly<{ document: string; pointer: string; code: string }>): Placed => ({
	document: d.document,
	pointer: d.pointer,
	code: d.code
})

/** The diagnostics a sort case holds, in arrival order. */
const arrivedOf = (c: SortCase): Effect.Effect<ReadonlyArray<Diagnostic>> =>
	Effect.forEach(
		Arr.getSomes(Arr.map(c.arrival, (index) => Arr.get(c.sketches, index))),
		(sketch) => makeDiagnostic(inputOf(sketch))
	)

/** What sortDiagnostics answers: its order once, and again over its own output. */
export const sortedOf = (
	c: SortCase
): Effect.Effect<Readonly<{ once: ReadonlyArray<Placed>; twice: ReadonlyArray<Placed> }>> =>
	Effect.map(arrivedOf(c), (arrived) => {
		const once = sortDiagnostics(c.listed, arrived)
		return {
			once: Arr.map(once, placedOf),
			twice: Arr.map(sortDiagnostics(c.listed, once), placedOf)
		}
	})

/** The model's sort: the same, whatever the arrival order, and a fixed point. */
export const expectedSortOf = (
	c: SortCase
): Readonly<{ once: ReadonlyArray<Placed>; twice: ReadonlyArray<Placed> }> => {
	const sorted = Arr.sort(
		Arr.map(c.sketches, (sketch) => ({
			document: sketch.document,
			pointer: sketch.pointer,
			code: `${rowOf(sketch)}/${sketch.slug}`
		})),
		modelOrder(c.listed)
	)
	return { once: sorted, twice: sorted }
}

export const orderFeaturesOf = (c: SortCase): ReadonlyArray<OrderFeature> => {
	const pairs = Arr.flatMap(c.sketches, (left, i) =>
		Arr.map(Arr.drop(c.sketches, i + 1), (right) => [left, right] as const)
	)
	const differInIndex = Arr.some(pairs, ([left, right]) => {
		const l = pointerTokens(left.pointer)
		const r = pointerTokens(right.pointer)
		return Arr.some(l, (token, at) =>
			Option.exists(
				Arr.get(r, at),
				(other) =>
					other !== token &&
					indexToken.test(other) &&
					indexToken.test(token) &&
					other.length !== token.length
			)
		)
	})
	return [
		...(differInIndex ? ["two pointers differing in an array index" as const] : []),
		...(Arr.some(c.sketches, (sketch) => !Arr.contains(c.listed, sketch.document))
			? ["a document outside the set" as const]
			: []),
		...(Arr.some(
			pairs,
			([l, r]) => l.document === r.document && l.pointer === r.pointer && l.slug !== r.slug
		)
			? ["two diagnostics at one place told apart by code" as const]
			: []),
		...(Arr.some(
			pairs,
			([l, r]) =>
				l.document === r.document &&
				l.pointer !== r.pointer &&
				(Str.startsWith(`${l.pointer}/`)(r.pointer) || Str.startsWith(`${r.pointer}/`)(l.pointer))
		)
			? ["a pointer and its own descendant" as const]
			: [])
	]
}

const sound = sketchGen(noFault)

const at =
	(document: string, pointer: string, slug: string): Gen<DiagnosticSketch> =>
	(s) => ({ ...s.draw(sound), document, pointer, slug })

/** Lists to sort, aimed at array indices, strays, codes at one place and descendants. */
export const sortSpace: Aimed<SortCase, OrderFeature> = aimed(sortGen(sound), [
	[
		"two pointers differing in an array index",
		(s) => ({
			...s.draw(sortGen(sound)),
			sketches: [
				s.draw(at("file:///a.json", "/p/2", "a")),
				s.draw(at("file:///a.json", "/p/10", "a"))
			],
			arrival: [1, 0]
		})
	],
	[
		"a document outside the set",
		(s) => ({
			listed: ["file:///a.json", "file:///b.json"],
			sketches: [s.draw(at("file:///z.json", "/a", "a")), s.draw(at("file:///b.json", "/z", "a"))],
			arrival: [0, 1]
		})
	],
	[
		"two diagnostics at one place told apart by code",
		(s) => ({
			...s.draw(sortGen(sound)),
			sketches: [s.draw(at("file:///a.json", "/x", "b")), s.draw(at("file:///a.json", "/x", "a"))],
			arrival: [0, 1]
		})
	],
	[
		"a pointer and its own descendant",
		(s) => ({
			...s.draw(sortGen(sound)),
			sketches: [
				s.draw(at("file:///a.json", "/paths/~1x/get", "a")),
				s.draw(at("file:///a.json", "/paths/~1x", "a"))
			],
			arrival: [0, 1]
		})
	]
])

/** A coverage element's kind, as the verdict's walk names it. */
type ElementKind =
	| "operation"
	| "parameter"
	| "refusedField"
	| "requestMedia"
	| "response"
	| "securityAlternative"
	| "server"

/** An invented claim's kind. */
type ClaimKind =
	| "command"
	| "refusedField"
	| "requestMedia"
	| "response"
	| "securityAlternative"
	| "server"

const kindFields: Readonly<Record<ElementKind | ClaimKind, Readonly<Record<string, Schema.Json>>>> =
	{
		command: {},
		operation: {},
		parameter: { in: "query", name: "id" },
		refusedField: { mediaType: "application/json", name: "tag" },
		requestMedia: { mediaType: "application/json" },
		response: { key: "200" },
		securityAlternative: { schemes: ["apiKey"] },
		server: { url: "https://api.example.com" }
	}

/** One coverage element or claim: its kind, whether it stands on a site or a claim, and its keys' arrival order. */
type Coverage<K extends ElementKind | ClaimKind> = Readonly<{
	kind: K
	on: "site" | "claim"
	keys: ReadonlyArray<string>
}>

export type VerdictSketch = Readonly<{
	byNotice: ReadonlyArray<Coverage<ElementKind>>
	missing: ReadonlyArray<Coverage<ElementKind>>
	invented: ReadonlyArray<Coverage<ClaimKind>>
	verdict: "accepted" | "partly-refused" | "refused"
}>

export type VerdictFeature = `a ${ElementKind} element` | `an invented ${ClaimKind}`

const elementKinds: Arr.NonEmptyReadonlyArray<ElementKind> = [
	"operation",
	"parameter",
	"refusedField",
	"requestMedia",
	"response",
	"securityAlternative",
	"server"
]

const claimKinds: Arr.NonEmptyReadonlyArray<ClaimKind> = [
	"command",
	"refusedField",
	"requestMedia",
	"response",
	"securityAlternative",
	"server"
]

const placeFields = (on: "site" | "claim"): Readonly<Record<string, Schema.Json>> =>
	on === "site"
		? { document: "file:///spec.json", pointer: "/paths/~1x/get" }
		: { path: ["users", "list"] }

const coverageGen =
	<K extends ElementKind | ClaimKind>(
		on: "site" | "claim",
		kinds: Arr.NonEmptyReadonlyArray<K>
	): Gen<Coverage<K>> =>
	(s) => {
		const kind = s.draw(element(kinds))
		const keys = [...Record.keys(placeFields(on)), "kind", ...Record.keys(kindFields[kind])]
		return { kind, on, keys: s.draw(shuffled(keys, { min: keys.length, max: keys.length })) }
	}

const verdictGen =
	(elements: Gen<Coverage<ElementKind>>, claims: Gen<Coverage<ClaimKind>>): Gen<VerdictSketch> =>
	(s) => ({
		byNotice: s.draw(array(elements, { min: 0, max: 3 })),
		missing: s.draw(array(elements, { min: 0, max: 2 })),
		invented: s.draw(array(claims, { min: 0, max: 3 })),
		verdict: s.draw(element(["accepted", "partly-refused", "refused"]))
	})

const coverageJson = (c: Coverage<ElementKind | ClaimKind>): Schema.Json => {
	const fields: Readonly<Record<string, Schema.Json>> = {
		...placeFields(c.on),
		kind: c.kind,
		...kindFields[c.kind]
	}
	return Record.fromEntries(Arr.map(c.keys, (key) => [key, fields[key] ?? null] as const))
}

/** The verdict a sketch describes, its coverage keys in the order they were drawn. */
const verdictOf = (v: VerdictSketch): Schema.Json => ({
	commandSources: { config: 1, fern: 0, fold: 1, forge: 0 },
	corpusVersion: 1,
	counts: {
		informational: 0,
		nonStandard: 1,
		notices: 1,
		operations: { generated: 2, refused: 1, total: 3 },
		refusals: { document: 0, element: 1, field: 1, operation: 0 }
	},
	coverage: {
		byNotice: Arr.map(v.byNotice, coverageJson),
		checked: true,
		invented: Arr.map(v.invented, coverageJson),
		missing: Arr.map(v.missing, coverageJson)
	},
	generator: {
		config: "corpus/config/stripe.json",
		configSha256: Str.repeat(32)("ab"),
		version: "0.1.0"
	},
	nonStandard: [
		{ choice: "deepObjectBrackets", pointer: "/paths/~1x/get/parameters/1", row: "PRM-27" }
	],
	notices: [{ code: "PRM-19/ignored-header", pointer: "/paths/~1x", row: "PRM-19" }],
	refusals: [
		{ code: "PRM-27/compound-nested", pointer: "/paths/~1x", row: "PRM-27", scope: "field" }
	],
	spec: { id: "stripe", openapi: "3.0.0", sha256: Str.repeat(32)("cd") },
	twinEquality: { checked: true, equal: true },
	verdict: v.verdict
})

/** A verdict's coverage, its keys in the order the encoding wrote them. */
type CoverageKeys = Readonly<{
	byNotice: ReadonlyArray<ReadonlyArray<string>>
	missing: ReadonlyArray<ReadonlyArray<string>>
	invented: ReadonlyArray<ReadonlyArray<string>>
}>

const coverageKeysOf = (encoded: unknown): CoverageKeys => {
	const coverage = Schema.decodeUnknownOption(
		Schema.Struct({
			coverage: Schema.Struct({
				byNotice: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				missing: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				invented: Schema.Array(Schema.Record(Schema.String, Schema.Json))
			})
		})
	)(encoded)
	return Option.match(coverage, {
		onNone: () => ({ byNotice: [], missing: [], invented: [] }),
		onSome: ({ coverage: c }) => ({
			byNotice: Arr.map(c.byNotice, Record.keys),
			missing: Arr.map(c.missing, Record.keys),
			invented: Arr.map(c.invented, Record.keys)
		})
	})
}

/** What a verdict's codec answers: the verdict re-encoded, or nothing, and its coverage's key orders. */
export const verdictAnswerOf = (
	v: VerdictSketch
): Effect.Effect<Readonly<{ encoded: Option.Option<unknown>; keys: CoverageKeys }>> =>
	Effect.map(
		Effect.exit(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Verdict)(verdictOf(v)),
				Schema.encodeEffect(Verdict)
			)
		),
		(exit) => {
			const encoded = Exit.isSuccess(exit) ? Option.some<unknown>(exit.value) : Option.none()
			return { encoded, keys: coverageKeysOf(Option.getOrUndefined(encoded)) }
		}
	)

/** The canonical key order of a coverage entry: its site's or claim's keys, then its kind's in alphabetical order. */
const canonicalKeys = (c: Coverage<ElementKind | ClaimKind>): ReadonlyArray<string> => [
	...Record.keys(placeFields(c.on)),
	...Arr.sort(["kind", ...Record.keys(kindFields[c.kind])], Order.String)
]

/** The model's answer: the verdict back as it was, each coverage entry's keys in the canonical order. */
export const expectedVerdictOf = (
	v: VerdictSketch
): Readonly<{ encoded: Option.Option<unknown>; keys: CoverageKeys }> => ({
	encoded: Option.some(verdictOf(v)),
	keys: {
		byNotice: Arr.map(v.byNotice, canonicalKeys),
		missing: Arr.map(v.missing, canonicalKeys),
		invented: Arr.map(v.invented, canonicalKeys)
	}
})

export const verdictFeaturesOf = (v: VerdictSketch): ReadonlyArray<VerdictFeature> => [
	...Arr.map([...v.byNotice, ...v.missing], (c): VerdictFeature => `a ${c.kind} element`),
	...Arr.map(v.invented, (c): VerdictFeature => `an invented ${c.kind}`)
]

const anyElement = coverageGen("site", elementKinds)

const anyClaim = coverageGen("claim", claimKinds)

/** Verdicts, aimed at each element and claim kind. */
export const verdictSpace: Aimed<VerdictSketch, VerdictFeature> = aimed(
	verdictGen(anyElement, anyClaim),
	[
		...Arr.map(
			elementKinds,
			(kind) => [`a ${kind} element`, verdictGen(coverageGen("site", [kind]), anyClaim)] as const
		),
		...Arr.map(
			claimKinds,
			(kind) =>
				[`an invented ${kind}`, verdictGen(anyElement, coverageGen("claim", [kind]))] as const
		)
	]
)
