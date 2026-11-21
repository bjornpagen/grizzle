/**
 * What the property of flatten.test.ts reads: request bodies drawn as schema trees (scalars with every format and
 * encoding the rules turn on, bare, union, multi-type, map and array schemas, objects three deep, references into
 * `$defs`, `allOf` merges, read-only and constant members), every codec and line, refused fields and Encoding rules;
 * and a model of design 4.5's body flags written from the rules flattenBody's JSDoc states, apart from its walk.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { deepEquals } from "@bjornpagen/testing/assert"
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
	option,
	type Space,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record, Result, String as Str } from "effect"
import { fixedDocumentUri, fixedMediaRange, isWireName } from "#model/brands.ts"
import type { WireName } from "#model/brands.ts"
import type { EncodingRule } from "#model/entities.ts"
import { formatPointer } from "#model/pointer.ts"
import { flattenBody } from "#names/flatten.ts"
import { foldKebab } from "#names/fold.ts"
import { reservedFlagNames } from "#names/reserved.ts"

type Line = "3.0" | "3.1" | "3.2"

type Codec = "json" | "form" | "multipart" | "binary" | "xml" | "text"

type ScalarType = "string" | "integer" | "number" | "boolean"

/** A schema node of a drawn body. */
type Node =
	| Readonly<{
			tag: "scalar"
			type: ScalarType
			format: Option.Option<"binary" | "password" | "byte">
			encoding: Option.Option<
				"base64" | "base64url" | "binary" | "7Bit" | "8BIT" | "quoted-printable"
			>
			mediaType: boolean
			readOnly: boolean
			constant: boolean
	  }>
	| Readonly<{ tag: "bare" | "union" | "multi" | "map"; readOnly: boolean }>
	| Readonly<{ tag: "array"; items: Node; readOnly: boolean }>
	| Readonly<{ tag: "object"; members: ReadonlyArray<Member>; readOnly: boolean }>
	| Readonly<{ tag: "ref"; def: string }>
	| Readonly<{ tag: "allOf"; parts: ReadonlyArray<Node> }>

/** A member of an object: its name, its schema, and whether the object requires it. */
type Member = Readonly<{ name: string; node: Node; required: boolean }>

/** A drawn body: its codec and line, its root object and `$defs`, refused fields and Encoding rules by property. */
export type BodyCase = Readonly<{
	codec: Codec
	line: Line
	root: ReadonlyArray<Member>
	defs: ReadonlyArray<readonly [string, Node]>
	refused: ReadonlyArray<WireName>
	base64Parts: ReadonlyArray<WireName>
	scalarFields: ReadonlyArray<WireName>
}>

const scalarJson = (node: Extract<Node, { tag: "scalar" }>): Json => {
	const entries: ReadonlyArray<Option.Option<readonly [string, Json]>> = [
		Option.some(["type", node.type]),
		Option.map(node.format, (format) => ["format", format]),
		Option.map(node.encoding, (encoding) => ["contentEncoding", encoding]),
		node.mediaType ? Option.some(["contentMediaType", "image/png"]) : Option.none(),
		node.readOnly ? Option.some(["readOnly", true]) : Option.none(),
		node.constant ? Option.some(["const", constantOf(node.type)]) : Option.none()
	]
	return Record.fromEntries(Arr.getSomes(entries))
}

/** The value a constant scalar of a type holds. */
const constantOf = (type: ScalarType): Json =>
	type === "string" ? "fixed" : type === "boolean" ? true : 7

const readOnlyMark = (readOnly: boolean): Readonly<Record<string, Json>> =>
	readOnly ? { readOnly: true } : {}

/** A node's JSON Schema. */
const jsonOf = (node: Node): Json => {
	switch (node.tag) {
		case "scalar":
			return scalarJson(node)
		case "bare":
			return { ...readOnlyMark(node.readOnly) }
		case "union":
			return { oneOf: [{ type: "string" }, { type: "integer" }], ...readOnlyMark(node.readOnly) }
		case "multi":
			return { type: ["string", "null"], ...readOnlyMark(node.readOnly) }
		case "map":
			return {
				type: "object",
				additionalProperties: { type: "string" },
				...readOnlyMark(node.readOnly)
			}
		case "array":
			return { type: "array", items: jsonOf(node.items), ...readOnlyMark(node.readOnly) }
		case "object":
			return {
				type: "object",
				properties: Record.fromEntries(
					Arr.map(node.members, (m) => [m.name, jsonOf(m.node)] as const)
				),
				...(Arr.some(node.members, (m) => m.required)
					? {
							required: Arr.map(
								Arr.filter(node.members, (m) => m.required),
								(m) => m.name
							)
						}
					: {}),
				...readOnlyMark(node.readOnly)
			}
		case "ref":
			return { $ref: `#/$defs/${node.def}` }
		case "allOf":
			return { allOf: Arr.map(node.parts, jsonOf) }
	}
}

const defsOf = (c: BodyCase): Readonly<Record<string, Json>> =>
	Record.fromEntries([
		["Root", jsonOf({ tag: "object", members: c.root, readOnly: false })],
		...Arr.map(c.defs, ([key, node]) => [key, jsonOf(node)] as const)
	])

/** A rule naming one property: base64 transfer encoding for a multipart part, the scalar switch for a form field. */
const ruleOf = (name: WireName, kind: "base64" | "scalars"): EncodingRule => ({
	contentType: [fixedMediaRange("text/plain")],
	headers: [],
	...(kind === "base64"
		? { contentEncoding: "base64" as const }
		: {
				nonStandardScalars: "deepObjectScalars" as const,
				serialization: { explode: true, style: "deepObject" as const }
			}),
	origin: {
		document: fixedDocumentUri("file:///spec.json"),
		pointer: formatPointer(["encoding", name])
	},
	rows: [],
	target: { kind: "property", name }
})

/** What flattenBody answers for a case, notes aside. */
export type Flattened = Readonly<{
	constants: ReadonlyArray<Readonly<{ pointer: string; value: Json }>>
	flags: ReadonlyArray<
		Readonly<{
			kind: string
			name: string
			pointer: string
			repeated: boolean
			schemaPointer: string
		}>
	>
	reserved: ReadonlyArray<Readonly<{ flag: string; name: string; pointer: string }>>
	skipped: ReadonlyArray<Readonly<{ pointer: string; reason: string }>>
}>

export const actualOf = (c: BodyCase): Result.Result<Flattened, string> => {
	const encoding = [
		...Arr.map(c.base64Parts, (name) => ruleOf(name, "base64")),
		...Arr.map(c.scalarFields, (name) => ruleOf(name, "scalars"))
	]
	return Result.mapBoth(
		flattenBody(
			defsOf(c),
			{ codec: c.codec, schema: { key: "Root" }, encoding, refusedFields: c.refused },
			c.line
		),
		{
			onFailure: (failure) => failure._tag,
			onSuccess: (body): Flattened => ({
				constants: body.constants,
				flags: Arr.map(body.flags, (flag) => ({
					kind: flag.kind,
					name: flag.name,
					pointer: flag.pointer,
					repeated: flag.repeated,
					schemaPointer: flag.schemaPointer
				})),
				reserved: body.reserved,
				skipped: body.skipped
			})
		}
	)
}

/** How design 4.5 reads a schema: an object's members, a scalar flag's kind, or opaque (one JSON flag). */
type Classified =
	| Readonly<{ tag: "object"; members: ReadonlyArray<Placed> }>
	| Readonly<{ tag: "scalar"; kind: string; repeated: boolean }>
	| Readonly<{ tag: "opaque" }>

/** A member and the source pointer of the schema that declares it. */
type Placed = Readonly<{ member: Member; at: string }>

type Context = Readonly<{ codec: Codec; line: Line; defs: ReadonlyMap<string, Node> }>

const escaped = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

const pointerOf = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (t) => `/${escaped(t)}`),
		""
	)

const opaque: Classified = { tag: "opaque" }

const identity: ReadonlySet<string> = new Set(["binary", "7bit", "8bit"])

/** Design 6.3's binary part: format binary or an identity encoding; else, with no format or encoding, a media type or no keyword at all. */
const binaryLeaf = (node: Extract<Node, { tag: "scalar" }>): boolean =>
	Option.contains(node.format, "binary") ||
	Option.exists(node.encoding, (e) => identity.has(Str.toLowerCase(e))) ||
	(Option.isNone(node.format) && Option.isNone(node.encoding) && node.mediaType)

/** Design 6.3's base64 property: a base64 or base64url encoding, or on 3.0 `format: byte` with no encoding. */
const base64Leaf = (node: Extract<Node, { tag: "scalar" }>, line: Line): boolean =>
	node.type === "string" &&
	(Option.contains(node.encoding, "base64") ||
		Option.contains(node.encoding, "base64url") ||
		(line === "3.0" && Option.isNone(node.encoding) && Option.contains(node.format, "byte")))

const scalarOf = (ctx: Context, node: Extract<Node, { tag: "scalar" }>): Classified => {
	const multipart = ctx.codec === "multipart"
	const stringly = node.type === "string"
	if (
		multipart &&
		((stringly && binaryLeaf(node)) || (stringly && Option.contains(node.format, "password")))
	) {
		return { tag: "scalar", kind: "file", repeated: false }
	}
	if (!multipart && base64Leaf(node, ctx.line)) {
		return { tag: "scalar", kind: "file", repeated: false }
	}
	return { tag: "scalar", kind: node.type, repeated: false }
}

/** Members declared at `at` (a source pointer), each placed at its own `properties` pointer. */
const placed = (members: ReadonlyArray<Member>, at: string): ReadonlyArray<Placed> =>
	Arr.map(members, (member) => ({ member, at: `${at}/properties/${escaped(member.name)}` }))

const defPointer = (key: string): string => `/components/schemas/${escaped(key)}`

/** Design 4.5's reading of a node declared at `at`. */
const classify = (ctx: Context, node: Node, at: string): Classified => {
	switch (node.tag) {
		case "scalar":
			return scalarOf(ctx, node)
		case "bare":
			return ctx.codec === "multipart" ? { tag: "scalar", kind: "file", repeated: false } : opaque
		case "union":
		case "multi":
		case "map":
			return opaque
		case "object":
			return { tag: "object", members: placed(node.members, at) }
		case "ref":
			return Option.match(Option.fromUndefinedOr(ctx.defs.get(node.def)), {
				onNone: () => opaque,
				onSome: (target) => classify(ctx, target, defPointer(node.def))
			})
		case "array": {
			const item = classify(ctx, node.items, `${at}/items`)
			return item.tag === "scalar" && !item.repeated
				? {
						tag: "scalar",
						kind: item.kind === "file" && ctx.codec !== "multipart" ? "string" : item.kind,
						repeated: true
					}
				: opaque
		}
		case "allOf": {
			const parts = Arr.map(node.parts, (part, index) =>
				classify(ctx, part, `${at}/allOf/${index}`)
			)
			const objects = Arr.flatMap(parts, (part) => (part.tag === "object" ? [part.members] : []))
			if (objects.length !== parts.length) {
				return opaque
			}
			const merged: Array<Placed> = []
			for (const one of Arr.flatten(objects)) {
				const existing = Arr.findFirst(merged, (other) => other.member.name === one.member.name)
				if (Option.isNone(existing)) {
					merged.push(one)
				} else if (!sameSchema(existing.value.member.node, one.member.node)) {
					return opaque
				} else if (one.member.required && !existing.value.member.required) {
					merged.splice(merged.indexOf(existing.value), 1, {
						...existing.value,
						member: { ...existing.value.member, required: true }
					})
				}
			}
			return { tag: "object", members: merged }
		}
	}
}

const sameSchema = (left: Node, right: Node): boolean => deepEquals(jsonOf(left), jsonOf(right))

/** S30-31: on 3.0 a member whose schema, or its one `$ref`'s target, is read-only gets nothing. */
const readOnlyOf = (ctx: Context, node: Node): boolean =>
	node.tag === "ref"
		? Option.exists(
				Option.fromUndefinedOr(ctx.defs.get(node.def)),
				(target) => target.tag !== "ref" && target.tag !== "allOf" && target.readOnly
			)
		: node.tag !== "allOf" && node.readOnly

/** The one value a required member's schema admits: its `const`, through a reference too. */
const oneValueOf = (ctx: Context, node: Node): Option.Option<Json> =>
	node.tag === "scalar" && node.constant
		? Option.some(constantOf(node.type))
		: node.tag === "ref"
			? Option.flatMap(Option.fromUndefinedOr(ctx.defs.get(node.def)), (target) =>
					oneValueOf(ctx, target)
				)
			: Option.none()

type Walked = Readonly<{
	constants: ReadonlyArray<Readonly<{ pointer: string; value: Json }>>
	flags: ReadonlyArray<
		Readonly<{
			kind: string
			name: string
			pointer: string
			repeated: boolean
			schemaPointer: string
		}>
	>
	skipped: ReadonlyArray<Readonly<{ pointer: string; reason: string }>>
}>

const empty: Walked = { constants: [], flags: [], skipped: [] }

const joinWalks = (walks: ReadonlyArray<Walked>): Walked => ({
	constants: Arr.flatMap(walks, (w) => w.constants),
	flags: Arr.flatMap(walks, (w) => w.flags),
	skipped: Arr.flatMap(walks, (w) => w.skipped)
})

const foldedName = (name: string): Option.Option<string> =>
	Option.map(Result.getSuccess(foldKebab(name)), (f) => f.name)

/** Design 4.5's JSON and form fields: two names deep as dotted flags, deeper objects one JSON flag. */
const walkFields = (
	ctx: Context,
	c: BodyCase,
	members: ReadonlyArray<Placed>,
	depth: number,
	names: ReadonlyArray<string>,
	tokens: ReadonlyArray<string>
): Walked =>
	joinWalks(
		Arr.map(members, ({ member, at }): Walked => {
			if (
				(depth === 1 && Arr.contains(c.refused, member.name)) ||
				(ctx.line === "3.0" && readOnlyOf(ctx, member.node))
			) {
				return empty
			}
			const here = [...tokens, member.name]
			const pointer = pointerOf(here)
			const one = member.required ? oneValueOf(ctx, member.node) : Option.none()
			if (Option.isSome(one)) {
				return { ...empty, constants: [{ pointer, value: one.value }] }
			}
			return Option.match(foldedName(member.name), {
				onNone: (): Walked => ({ ...empty, skipped: [{ pointer, reason: "EmptyFold" }] }),
				onSome: (name): Walked => {
					const dotted = [...names, name]
					if (depth === 1 && Arr.contains(c.scalarFields, member.name) && c.codec === "form") {
						return {
							...empty,
							flags: [
								{
									kind: "json",
									name: Arr.join(dotted, "."),
									pointer,
									repeated: false,
									schemaPointer: at
								}
							]
						}
					}
					const classified = classify(ctx, member.node, at)
					if (
						classified.tag === "object" &&
						depth < 2 &&
						Arr.isReadonlyArrayNonEmpty(classified.members)
					) {
						return walkFields(ctx, c, classified.members, depth + 1, dotted, here)
					}
					return {
						...empty,
						flags: [
							{
								kind: classified.tag === "scalar" ? classified.kind : "json",
								name: Arr.join(dotted, "."),
								pointer,
								repeated: classified.tag === "scalar" && classified.repeated,
								schemaPointer: at
							}
						]
					}
				}
			})
		})
	)

/** Design 6.3's multipart parts: one flag a top-level part, a part of no flag's shape skipped. */
const walkParts = (ctx: Context, c: BodyCase, members: ReadonlyArray<Placed>): Walked =>
	joinWalks(
		Arr.map(members, ({ member, at }): Walked => {
			if (
				Arr.contains(c.refused, member.name) ||
				(ctx.line === "3.0" && readOnlyOf(ctx, member.node))
			) {
				return empty
			}
			const pointer = pointerOf([member.name])
			return Option.match(foldedName(member.name), {
				onNone: (): Walked => ({ ...empty, skipped: [{ pointer, reason: "EmptyFold" }] }),
				onSome: (name): Walked => {
					const part = classify(ctx, member.node, at)
					if (part.tag === "opaque") {
						return { ...empty, skipped: [{ pointer, reason: "UnsupportedPart" }] }
					}
					const kind =
						part.tag === "object"
							? "json"
							: Arr.contains(c.base64Parts, member.name)
								? "file"
								: part.kind
					return {
						...empty,
						flags: [
							{
								kind,
								name,
								pointer,
								repeated: part.tag === "scalar" && part.repeated,
								schemaPointer: at
							}
						]
					}
				}
			})
		})
	)

const whole = (kind: "body" | "body-file") => ({
	kind,
	name: kind,
	pointer: "",
	repeated: false,
	schemaPointer: ""
})

const flagOrder = Order.combine(
	Order.mapInput(Order.String, (flag: Flattened["flags"][number]) => flag.name),
	Order.mapInput(Order.String, (flag: Flattened["flags"][number]) => flag.pointer)
)

/** The model: design 4.5 and 6.3 by codec, every list in its documented order. */
export const expectedOf = (c: BodyCase): Result.Result<Flattened, string> => {
	const ctx: Context = { codec: c.codec, line: c.line, defs: new Map(c.defs) }
	if (c.codec === "binary" || c.codec === "xml") {
		return Result.succeed({ constants: [], flags: [whole("body-file")], reserved: [], skipped: [] })
	}
	if (c.codec === "text") {
		return Result.succeed({
			constants: [],
			flags: [whole("body"), whole("body-file")],
			reserved: [],
			skipped: []
		})
	}
	const root = placed(c.root, defPointer("Root"))
	const walked =
		c.codec === "multipart" ? walkParts(ctx, c, root) : walkFields(ctx, c, root, 1, [], [])
	const wholeFlags = c.codec === "multipart" ? [] : [whole("body"), whole("body-file")]
	const reserved = Arr.flatMap(walked.flags, (flag) => [
		...(reservedFlagNames.has(flag.name)
			? [{ flag: flag.name, name: flag.name, pointer: flag.pointer }]
			: []),
		...(flag.kind === "boolean" && !flag.repeated && reservedFlagNames.has(`no-${flag.name}`)
			? [{ flag: `no-${flag.name}`, name: flag.name, pointer: flag.pointer }]
			: [])
	])
	return Result.succeed({
		constants: walked.constants,
		flags: Arr.sort([...wholeFlags, ...walked.flags], flagOrder),
		reserved: Arr.sort(
			reserved,
			Order.combine(
				Order.mapInput(Order.String, (r: Flattened["reserved"][number]) => r.flag),
				Order.mapInput(Order.String, (r: Flattened["reserved"][number]) => r.pointer)
			)
		),
		skipped: Arr.sort(
			walked.skipped,
			Order.mapInput(Order.String, (s: Flattened["skipped"][number]) => s.pointer)
		)
	})
}

/** Member names: plain, cased, spaced, empty and unfoldable, prototype names, reserved flags, a digit-led name. */
const NAMES = [
	"name",
	"city",
	"FirstName",
	"Zip Code",
	"",
	"!!!",
	"__proto__",
	"body",
	"force",
	"help",
	"output",
	"verbose",
	"tags",
	"2fa",
	"a",
	"b"
] as const

const scalarGen: Gen<Node> = (s) => ({
	tag: "scalar",
	type: s.draw(
		weighted<ScalarType>([
			[2, constant("string")],
			[1, constant("integer")],
			[1, constant("number")],
			[1, constant("boolean")]
		])
	),
	format: s.draw(option(element(["binary", "password", "byte"] as const))),
	encoding: s.draw(
		option(element(["base64", "base64url", "binary", "7Bit", "8BIT", "quoted-printable"] as const))
	),
	mediaType: s.draw(boolean),
	readOnly: s.draw(int(0, 5)) === 0,
	constant: s.draw(int(0, 6)) === 0
})

const shapeGen =
	(depth: number, defs: ReadonlyArray<string>): Gen<Node> =>
	(s) => {
		const choice = s.draw(int(0, depth > 0 ? 9 : 6))
		const readOnly = s.draw(int(0, 6)) === 0
		switch (choice) {
			case 0:
			case 1:
			case 2:
				return s.draw(scalarGen)
			case 3:
				return { tag: s.draw(element(["bare", "union", "multi", "map"] as const)), readOnly }
			case 4:
				return { tag: "array", items: s.draw(weightedItems(defs)), readOnly }
			case 5:
			case 6:
				return Arr.isReadonlyArrayNonEmpty(defs)
					? { tag: "ref", def: s.draw(element(defs)) }
					: s.draw(scalarGen)
			case 7:
			case 8:
				return { tag: "object", members: s.draw(membersGen(depth - 1, defs)), readOnly }
			default:
				return {
					tag: "allOf",
					parts: [s.draw(objectGen(depth - 1, defs)), s.draw(objectGen(depth - 1, defs))]
				}
		}
	}

const weightedItems =
	(defs: ReadonlyArray<string>): Gen<Node> =>
	(s) =>
		s.draw(int(0, 3)) === 0
			? { tag: "object", members: s.draw(membersGen(0, defs)), readOnly: false }
			: s.draw(scalarGen)

const objectGen =
	(depth: number, defs: ReadonlyArray<string>): Gen<Node> =>
	(s) => ({ tag: "object", members: s.draw(membersGen(depth, defs)), readOnly: false })

const membersGen =
	(depth: number, defs: ReadonlyArray<string>): Gen<ReadonlyArray<Member>> =>
	(s) => {
		const count = s.draw(int(1, 3))
		const names: Array<string> = []
		for (let index = 0; index < count; index += 1) {
			const name = s.draw(element(NAMES))
			if (!Arr.contains(names, name)) {
				names.push(name)
			}
		}
		return Arr.map(names, (name) => ({
			name,
			node: s.draw(shapeGen(depth, defs)),
			required: s.draw(int(0, 2)) === 0
		}))
	}

const caseGen =
	(codec: Gen<Codec>, line: Gen<Line>): Gen<BodyCase> =>
	(s) => {
		const defKeys = s.draw(element([[], ["Leaf"], ["Leaf", "Base"]] as const))
		const defs = Arr.map(defKeys, (key, index): readonly [string, Node] => [
			key,
			s.draw(index === 0 ? scalarOrObject(Arr.drop(defKeys, 1)) : objectGen(1, []))
		])
		const root = s.draw(membersGen(2, defKeys))
		const topNames = Arr.map(root, (m) => m.name)
		const drawnCodec = s.draw(codec)
		const named = Arr.filter(topNames, isWireName)
		const pick = (): ReadonlyArray<WireName> =>
			Arr.isReadonlyArrayNonEmpty(named) && s.draw(int(0, 2)) === 0 ? [s.draw(element(named))] : []
		return {
			codec: drawnCodec,
			line: s.draw(line),
			root,
			defs,
			refused: pick(),
			base64Parts: drawnCodec === "multipart" ? pick() : [],
			scalarFields: drawnCodec === "form" ? pick() : []
		}
	}

const scalarOrObject =
	(defs: ReadonlyArray<string>): Gen<Node> =>
	(s) =>
		s.draw(boolean)
			? s.draw(scalarGen)
			: { tag: "object", members: s.draw(membersGen(1, defs)), readOnly: s.draw(int(0, 3)) === 0 }

const anyCodec = weighted<Codec>([
	[2, constant("json")],
	[1, constant("form")],
	[2, constant("multipart")],
	[1, constant("binary")],
	[1, constant("xml")],
	[1, constant("text")]
])

const anyLine = element<Line>(["3.0", "3.1", "3.2"])

export type Feature =
	| "a string flag"
	| "an integer flag"
	| "a number flag"
	| "a boolean flag"
	| "a repeated scalar flag"
	| "a JSON flag"
	| "a dotted flag two deep"
	| "a field through a reference"
	| "an allOf merged into fields"
	| "a base64 file flag"
	| "a multipart text part"
	| "a file part"
	| "a repeated file part"
	| "a password part"
	| "a part skipped as unsupported"
	| "a name folding to nothing"
	| "a reserved flag clash"
	| "a negation clash"
	| "a read-only member left out on 3.0"
	| "a read-only member kept on 3.1 or 3.2"
	| "a refused field"
	| "a body constant"
	| "a scalar-switch field"
	| "a base64 rule's part"
	| "a binary body"
	| "an xml body"
	| "a text body"

const anyNode = (members: ReadonlyArray<Member>, holds: (node: Node) => boolean): boolean =>
	Arr.some(
		members,
		(m) => holds(m.node) || (m.node.tag === "object" && anyNode(m.node.members, holds))
	)

export const featuresOf = (c: BodyCase): ReadonlyArray<Feature> => {
	const expected = expectedOf(c)
	const none: Flattened = { constants: [], flags: [], reserved: [], skipped: [] }
	const body = Result.getOrElse(expected, () => none)
	const fields = Arr.filter(body.flags, (flag) => flag.pointer !== "")
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const multipart = c.codec === "multipart"
	return [
		...when(c.codec === "binary", "a binary body"),
		...when(c.codec === "xml", "an xml body"),
		...when(c.codec === "text", "a text body"),
		...when(
			Arr.some(fields, (f) => f.kind === "string" && !f.repeated),
			"a string flag"
		),
		...when(
			Arr.some(fields, (f) => f.kind === "integer" && !f.repeated),
			"an integer flag"
		),
		...when(
			Arr.some(fields, (f) => f.kind === "number" && !f.repeated),
			"a number flag"
		),
		...when(
			Arr.some(fields, (f) => f.kind === "boolean" && !f.repeated),
			"a boolean flag"
		),
		...when(
			Arr.some(fields, (f) => f.kind !== "file" && f.repeated),
			"a repeated scalar flag"
		),
		...when(
			Arr.some(fields, (f) => f.kind === "json"),
			"a JSON flag"
		),
		...when(
			Arr.some(fields, (f) => Str.includes(".")(f.name)),
			"a dotted flag two deep"
		),
		...when(
			Arr.some(
				fields,
				(f) =>
					Str.startsWith("/components/schemas/Leaf")(f.schemaPointer) ||
					Str.startsWith("/components/schemas/Base")(f.schemaPointer)
			),
			"a field through a reference"
		),
		...when(
			Arr.some(fields, (f) => Str.includes("/allOf/")(f.schemaPointer)),
			"an allOf merged into fields"
		),
		...when(!multipart && Arr.some(fields, (f) => f.kind === "file"), "a base64 file flag"),
		...when(
			multipart && Arr.some(fields, (f) => f.kind === "string" && !f.repeated),
			"a multipart text part"
		),
		...when(multipart && Arr.some(fields, (f) => f.kind === "file" && !f.repeated), "a file part"),
		...when(
			multipart && Arr.some(fields, (f) => f.kind === "file" && f.repeated),
			"a repeated file part"
		),
		...when(
			multipart &&
				anyNode(
					c.root,
					(n) => n.tag === "scalar" && n.type === "string" && Option.contains(n.format, "password")
				) &&
				Arr.some(fields, (f) => f.kind === "file"),
			"a password part"
		),
		...when(
			Arr.some(body.skipped, (s) => s.reason === "UnsupportedPart"),
			"a part skipped as unsupported"
		),
		...when(
			Arr.some(body.skipped, (s) => s.reason === "EmptyFold"),
			"a name folding to nothing"
		),
		...when(
			Arr.some(body.reserved, (r) => r.flag === r.name),
			"a reserved flag clash"
		),
		...when(
			Arr.some(body.reserved, (r) => r.flag !== r.name),
			"a negation clash"
		),
		...when(
			c.line === "3.0" &&
				Arr.some(c.root, (m) =>
					readOnlyOf({ codec: c.codec, line: c.line, defs: new Map(c.defs) }, m.node)
				) &&
				(c.codec === "json" || c.codec === "form" || multipart),
			"a read-only member left out on 3.0"
		),
		...when(
			c.line !== "3.0" &&
				Arr.some(c.root, (m) =>
					readOnlyOf({ codec: c.codec, line: c.line, defs: new Map(c.defs) }, m.node)
				) &&
				Arr.isReadonlyArrayNonEmpty(fields),
			"a read-only member kept on 3.1 or 3.2"
		),
		...when(
			Arr.isReadonlyArrayNonEmpty(c.refused) &&
				(c.codec === "json" || c.codec === "form" || multipart),
			"a refused field"
		),
		...when(Arr.isReadonlyArrayNonEmpty(body.constants), "a body constant"),
		...when(
			c.codec === "form" && Arr.isReadonlyArrayNonEmpty(c.scalarFields),
			"a scalar-switch field"
		),
		...when(multipart && Arr.isReadonlyArrayNonEmpty(c.base64Parts), "a base64 rule's part")
	]
}

/** The first of twelve cases drawn that reaches `feature`, else the last: an aim an unlucky draw only delays. */
const reaching =
	(feature: Feature, gen: Gen<BodyCase>): Space<BodyCase> =>
	(s) => {
		const drawn = s.draw(array(gen, { min: 12, max: 12 }))
		return Option.getOrElse(
			Arr.findFirst(drawn, (c) => Arr.contains(featuresOf(c), feature)),
			() => Arr.lastNonEmpty([s.draw(gen), ...drawn])
		)
	}

const codecOf = (codec: Codec): Gen<BodyCase> => caseGen(constant(codec), anyLine)

const json = caseGen(element<Codec>(["json", "form"]), anyLine)

/** A multipart body of one plain string part, neither binary nor encoded: a text part, never a file. */
const multipartText: Space<BodyCase> = map(
	caseGen(constant("multipart"), anyLine),
	(c): BodyCase => ({
		...c,
		root: [
			{
				name: "note",
				node: {
					tag: "scalar",
					type: "string",
					format: Option.none(),
					encoding: Option.none(),
					mediaType: false,
					readOnly: false,
					constant: false
				},
				required: false
			}
		],
		refused: [],
		base64Parts: []
	})
)

/** Bodies, aimed at every flag kind, every codec and every rule that keeps, drops or reshapes a field. */
export const bodySpace: Aimed<BodyCase, Feature> = aimed(caseGen(anyCodec, anyLine), [
	["a string flag", reaching("a string flag", json)],
	["an integer flag", reaching("an integer flag", json)],
	["a number flag", reaching("a number flag", json)],
	["a boolean flag", reaching("a boolean flag", json)],
	["a repeated scalar flag", reaching("a repeated scalar flag", json)],
	["a JSON flag", reaching("a JSON flag", json)],
	["a dotted flag two deep", reaching("a dotted flag two deep", json)],
	["a field through a reference", reaching("a field through a reference", json)],
	["an allOf merged into fields", reaching("an allOf merged into fields", json)],
	["a base64 file flag", reaching("a base64 file flag", json)],
	["a multipart text part", multipartText],
	["a file part", reaching("a file part", codecOf("multipart"))],
	["a repeated file part", reaching("a repeated file part", codecOf("multipart"))],
	["a password part", reaching("a password part", codecOf("multipart"))],
	[
		"a part skipped as unsupported",
		reaching("a part skipped as unsupported", codecOf("multipart"))
	],
	["a name folding to nothing", reaching("a name folding to nothing", caseGen(anyCodec, anyLine))],
	["a reserved flag clash", reaching("a reserved flag clash", json)],
	["a negation clash", reaching("a negation clash", json)],
	[
		"a read-only member left out on 3.0",
		reaching(
			"a read-only member left out on 3.0",
			caseGen(element<Codec>(["json", "form", "multipart"]), constant("3.0"))
		)
	],
	[
		"a read-only member kept on 3.1 or 3.2",
		reaching(
			"a read-only member kept on 3.1 or 3.2",
			caseGen(element<Codec>(["json", "form", "multipart"]), element<Line>(["3.1", "3.2"]))
		)
	],
	[
		"a refused field",
		reaching("a refused field", caseGen(element<Codec>(["json", "form", "multipart"]), anyLine))
	],
	["a body constant", reaching("a body constant", json)],
	["a scalar-switch field", reaching("a scalar-switch field", codecOf("form"))],
	["a base64 rule's part", reaching("a base64 rule's part", codecOf("multipart"))],
	["a binary body", codecOf("binary")],
	["an xml body", codecOf("xml")],
	["a text body", codecOf("text")]
])
