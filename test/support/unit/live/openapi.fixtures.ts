/** What the properties of openapi.test.ts read: its spaces, models and helpers. */

import { documentWire } from "@bjornpagen/grizzle-openapi/document"
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { array, type Gen } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import {
	Result as Answered,
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { readings } from "#adapter/live/call-error.ts"
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { sha256Base32 } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import {
	type EventDescriptor,
	events,
	type FailureSource,
	wireRefusals
} from "#compiler/live/events.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { joined } from "#test/support/chunked.ts"
import { documentErrors } from "#test/support/openapi/validator.ts"
import {
	type CaseSketch,
	caseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import {
	compiledLogin,
	type DrawnSchema,
	drawnLogin,
	drawnSchema,
	loginGen,
	type RoleShape
} from "#test/support/served-login.ts"

export type Feature =
	| "a list read"
	| "a paged read"
	| "an answered read"
	| "a write"
	| "a role reading a context"
	| "a role reading none"
	| "a login no role of which reads a context"
	| "a schema shared"
	| "a wire node shared"
	| "a summary seen again under what it may depend on"
	| "a body's description seen again under what it may depend on"
	| "a tag's description seen again under what it may depend on"

/** The target a JSON value names as a JSON Reference (`{"$ref": target}`, its one member), none for any other value. */
const referenceOf = (value: unknown): string | undefined => {
	if (!isRecord(value) || isList(value) || Rec.keys(value).length !== 1) {
		return undefined
	}
	const target = value["$ref"]
	return typeof target === "string" ? target : undefined
}

/** The member `step` of a JSON value, an array's by its index, none where it has none. */
const memberOf = (value: unknown, step: string): unknown =>
	isRecord(value) && Rec.has(value, step) ? value[step] : undefined

/**
 * A value read through every JSON Reference it is (RFC 6901 pointers from `document`'s root, `~1` and `~0` escaped), as
 * a reader of the document follows them: the value at the end of the chain.
 */
const readThrough = (document: unknown, value: unknown): unknown => {
	let here = value
	for (let target = referenceOf(here); target !== undefined; target = referenceOf(here)) {
		here = Str.startsWith("#/")(target)
			? Arr.reduce(Str.split(Str.slice(2)(target), "/"), document, (node: unknown, step) =>
					memberOf(node, Str.replaceAll("~0", "~")(Str.replaceAll("~1", "/")(step)))
				)
			: undefined
	}
	return here
}

/** The member at `path` of a JSON value of `document`, each step read through its references; none where none is. */
const atIn = (document: unknown, value: unknown, path: ReadonlyArray<string>): unknown =>
	Arr.reduce(path, readThrough(document, value), (here: unknown, step) =>
		readThrough(document, memberOf(here, step))
	)

/** The JSON Schema 2020-12 keywords whose value is one schema. */
const oneSchemaKeywords = [
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
] as const

/** The JSON Schema 2020-12 keywords whose value is a list of schemas. */
const schemaListKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"] as const

/** The JSON Schema 2020-12 keywords whose value names a schema for each of its keys. */
const schemaMapKeywords = ["$defs", "dependentSchemas", "patternProperties", "properties"] as const

/** Every Schema Object at and under `schema`, each subschema at the position JSON Schema 2020-12 reads one at. */
const schemasUnder = (schema: unknown): ReadonlyArray<unknown> => {
	if (!isRecord(schema) || isList(schema)) {
		return []
	}
	return [
		schema,
		...Arr.flatMap(oneSchemaKeywords, (k) => schemasUnder(memberOf(schema, k))),
		...Arr.flatMap(schemaListKeywords, (k) => {
			const list = memberOf(schema, k)
			return isList(list) ? Arr.flatMap(list, schemasUnder) : []
		}),
		...Arr.flatMap(schemaMapKeywords, (k) => {
			const named = memberOf(schema, k)
			return isRecord(named) && !isList(named) ? Arr.flatMap(Rec.values(named), schemasUnder) : []
		})
	]
}

/** The Schema Objects of a media type of a request body or a response: its schema's and its item schema's. */
const mediaSchemas = (content: unknown): ReadonlyArray<unknown> =>
	isRecord(content)
		? Arr.flatMap(Rec.values(content), (media) => [
				...schemasUnder(memberOf(media, "schema")),
				...schemasUnder(memberOf(media, "itemSchema"))
			])
		: []

/**
 * Every Schema Object of an OpenAPI document, at every position it stands at: each component and what it holds, and in
 * each operation each parameter's schema, its request body's and each response's.
 */
const documentSchemas = (document: unknown): ReadonlyArray<unknown> => {
	const components = memberOf(memberOf(document, "components"), "schemas")
	const paths = memberOf(document, "paths")
	const operations = isRecord(paths)
		? Arr.flatMap(Rec.values(paths), (item) => (isRecord(item) ? Rec.values(item) : []))
		: []
	return [
		...(isRecord(components) ? Arr.flatMap(Rec.values(components), schemasUnder) : []),
		...Arr.flatMap(operations, (operation) => {
			const parameters = memberOf(operation, "parameters")
			const responses = memberOf(operation, "responses")
			return [
				...(isList(parameters)
					? Arr.flatMap(parameters, (p) => schemasUnder(memberOf(p, "schema")))
					: []),
				...mediaSchemas(memberOf(memberOf(operation, "requestBody"), "content")),
				...(isRecord(responses)
					? Arr.flatMap(Rec.values(responses), (r) => mediaSchemas(memberOf(r, "content")))
					: [])
			]
		})
	]
}

/** Every record and array at and under a JSON value. */
const nodesUnder = (value: unknown): ReadonlyArray<unknown> => {
	if (isList(value)) {
		return [value, ...Arr.flatMap(value, nodesUnder)]
	}
	return isRecord(value) ? [value, ...Arr.flatMap(Rec.values(value), nodesUnder)] : []
}

/** A JSON value's canonical text. */
const textOf = (value: unknown): string => {
	const text = writeCanonicalJson(trusted<Json>(value))
	if (!text.ok) {
		throw new Error(`a document's value with a canonical text: ${text.error.message}`)
	}
	return text.value
}

/** The canonical texts of `nodes` that stand at two places or more and are longer than `bound` gives each. */
const repeatedPast = (
	nodes: ReadonlyArray<unknown>,
	bound: (text: string) => number
): ReadonlyArray<string> => {
	const counts = new Map<string, number>()
	for (const node of nodes) {
		const text = textOf(node)
		counts.set(text, (counts.get(text) ?? 0) + 1)
	}
	return Arr.map(
		Arr.filter(Arr.fromIterable(counts), ([text, count]) => count > 1 && text.length > bound(text)),
		([text]) => Str.slice(0, 200)(text)
	)
}

/** A JSON value's own keys, none for any other value. */
const keysOf = (value: unknown): ReadonlyArray<string> => (isRecord(value) ? Rec.keys(value) : [])

/** A run of characters no declared name holds: what separates two words of a description. */
const nonWord = regex("[^A-Za-z0-9_]+")

/** The words of a JSON value that is a text, each a run of ASCII letters, digits and underscores, as a declared name is. */
const wordsOf = (value: unknown): ReadonlySet<string> =>
	new Set(typeof value === "string" ? Str.split(value, nonWord) : [])

/** Whether a text names every one of `names` as a word. */
const namesAll = (value: unknown, names: ReadonlyArray<string>): boolean => {
	const words = wordsOf(value)
	return Arr.every(names, (name) => words.has(name))
}

/**
 * The texts a run has seen, each under what it may depend on (dependsOnly): a summary's, a body description's and a
 * tag description's.
 */
interface Seen {
	readonly summaries: Map<string, unknown>
	readonly bodies: Map<string, unknown>
	readonly tags: Map<string, unknown>
}

/** A run's seen texts, none yet. */
export const unseen = (): Seen => ({ summaries: new Map(), bodies: new Map(), tags: new Map() })

/**
 * That `text` depends on `on` alone: the text of every earlier document of the run seen under the same `on` is this
 * one, and `again` is told so, else `text` is seen under it.
 */
const dependsOnly = (
	seen: Map<string, unknown>,
	on: unknown,
	text: unknown,
	message: string,
	again: () => void
) => {
	const key = Formatter.format(on)
	const before = seen.get(key)
	if (before === undefined) {
		seen.set(key, text)
		return
	}
	again()
	assert.deepEqual(
		text,
		before,
		`${message}: ${Formatter.format(text)} beside ${Formatter.format(before)}`
	)
}

/** How many programs of a role do each thing, by their served forms: read or write. */
const deedsOf = (members: ReadonlyArray<ServedMember>) => ({
	reads: Arr.filter(members, (m) => m.kind !== "change").length,
	writes: Arr.filter(members, (m) => m.kind === "change").length
})

/** The relations a member's wire says it writes: a ChangeSet's outcome's. */
const relationsOf = (member: ServedMember): ReadonlyArray<string> => {
	switch (member.kind) {
		case "change": {
			const wire = member.wire.member
			return wire.shape === "write" ? wire.outcome.relations : []
		}
		case "read":
		case "key":
		case "paged":
			return []
	}
}

/** Whether a member is a read answered at its call's instant alone (served/forms.ts ServedReadLive `answered`). */
const answeredOf = (member: ServedMember): boolean => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return member.read.live.kind === "answered"
		case "change":
			return false
	}
}

/**
 * The sources a member's call over HTTP meets its failures at (live/events.ts failures), by its served form: the HTTP
 * door's and its Db's opening before it runs, then a live read's run and subscription, an answered read's run alone,
 * and a ChangeSet's run and refusing outcome.
 */
const sourcesOf = (member: ServedMember): ReadonlyArray<FailureSource> => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return answeredOf(member) ? ["door", "open", "read"] : ["door", "open", "read", "watch"]
		case "change":
			return ["door", "open", "apply", "outcome"]
	}
}

/** The kinds the classification's tables read the failures at `sources` as, each once, in code-unit order. */
const kindsAt = (sources: ReadonlyArray<FailureSource>): Array<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.flatMap(sources, (source) => {
				const reading: ReadonlyArray<string> = readings[source]
				return reading
			})
		),
		Order.String
	)

/**
 * What a member's summary says it is, as a word each, by its served form (served/forms.ts ServedMemberForm): `live`
 * exactly for a read a call watches, `answered` for one answered at its call's instant alone, `paged` for a paged one,
 * and `write` for a ChangeSet's.
 */
const kindWords = (member: ServedMember): ReadonlyArray<readonly [string, boolean]> => [
	[
		"live",
		(member.kind === "read" || member.kind === "key" || member.kind === "paged") &&
			!answeredOf(member)
	],
	["answered", answeredOf(member)],
	["paged", member.kind === "paged"],
	["write", member.kind === "change"]
]

/**
 * The document of a login's served file, written as generate writes it (`text`), held to every property of the header.
 */
const holds = (
	file: ServedFile,
	text: string,
	seen: Seen,
	note: (feature: Feature) => void,
	printed: () => string
) =>
	Effect.gen(function* () {
		const document = trustedJson<unknown>(text)
		const at = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
			atIn(document, value, path)
		const errors = yield* documentErrors(document)
		assert.deepEqual(errors, [], `the document validates against OpenAPI 3.2\n${printed()}`)
		const canonical = writeCanonicalJson(trusted<Json>(document))
		assert.ok(
			canonical.ok && `${canonical.value}\n` === text,
			`the document's text is canonical\n${printed()}`
		)
		const wire = documentWire(document)
		for (const r of file.roles) {
			assert.ok(
				deepEquals<unknown>(wire.roles.get(r.name), r.wire.witness),
				`the root's x-grizzle-wire holds role ${r.name}'s served witness\n${printed()}`
			)
		}
		const schemaShared = textOf({
			$ref: `#/components/schemas/shared.${sha256Base32(wellFormed(""))}`
		}).length
		assert.deepEqual(
			repeatedPast(
				documentSchemas(document),
				(t) => textOf({ $ref: `#/components/schemas/shared.${sha256Base32(wellFormed(t))}` }).length
			),
			[],
			`no schema longer than its reference (${schemaShared} characters) stands at two places\n${printed()}`
		)
		const rootWire = memberOf(document, "x-grizzle-wire")
		const table = memberOf(rootWire, "shared")
		const roleWires = memberOf(rootWire, "roles")
		const pathItems = memberOf(document, "paths")
		const wireNodes = [
			...(isList(table) ? Arr.flatMap(table, nodesUnder) : []),
			...(isRecord(roleWires)
				? Arr.flatMap(Rec.values(roleWires), (w) => nodesUnder(memberOf(w, "witness")))
				: []),
			...(isRecord(pathItems)
				? Arr.flatMap(Rec.values(pathItems), (item) =>
						nodesUnder(memberOf(memberOf(memberOf(item, "post"), "x-grizzle-wire"), "member"))
					)
				: [])
		]
		const wireBound = textOf({
			$ref: `#/x-grizzle-wire/shared/${isList(table) ? table.length : 0}`
		}).length
		assert.deepEqual(
			repeatedPast(wireNodes, () => wireBound),
			[],
			`no wire node longer than a reference into its table (${wireBound} characters) stands at two places\n${printed()}`
		)
		if (Arr.some(keysOf(at(document, "components", "schemas")), Str.startsWith("shared."))) {
			note("a schema shared")
		}
		if (isList(table) && table.length > 0) {
			note("a wire node shared")
		}
		const expected = Arr.flatMap(file.roles, (r) =>
			Arr.map(r.members, (member) => ({
				role: r,
				member,
				path: `/${file.login}/${r.name}/${member.name}`
			}))
		)
		const paths = at(document, "paths")
		const contextual = Arr.some(file.roles, (r) => r.contexts.length > 0)
		if (!contextual) {
			note("a login no role of which reads a context")
		}
		assert.deepEqual(
			keysOf(at(document, "components", "securitySchemes")),
			contextual ? ["bearer"] : [],
			`the bearer scheme is declared exactly when some role reads a context\n${printed()}`
		)
		const tags = at(document, "tags")
		assert.deepEqual(
			isList(tags) ? Arr.map(tags, (tag) => at(tag, "name")) : [],
			Arr.map(file.roles, (r) => r.name),
			`one tag per role, in the login's order\n${printed()}`
		)
		for (const [r, tag] of Arr.zip(file.roles, isList(tags) ? tags : [])) {
			const description = at(tag, "description")
			assert.ok(
				namesAll(
					description,
					Arr.map(r.contexts, (context) => context.name)
				),
				`role ${r.name}'s description names its contexts: ${Formatter.format(description)}\n${printed()}`
			)
			dependsOnly(
				seen.tags,
				{
					role: r.name,
					contexts: r.contexts,
					programs: deedsOf(r.members)
				},
				description,
				`role ${r.name}'s description depends on its name, its contexts and its programs' count by deed alone\n${printed()}`,
				() => note("a tag's description seen again under what it may depend on")
			)
			assert.ok(
				typeof description === "string" &&
					Str.includes(r.contexts.length === 0 ? "need no bearer token" : "need a bearer token")(
						description
					),
				`role ${r.name}'s description says its calls need a bearer token exactly when it reads a context: ${Formatter.format(description)}`
			)
		}
		assert.deepEqual(
			Arr.sort(keysOf(paths), Order.String),
			Arr.sort(
				Arr.map(expected, (e) => e.path),
				Order.String
			),
			`one path per program\n${printed()}`
		)
		for (const { role: r, member, path } of expected) {
			note(r.contexts.length === 0 ? "a role reading none" : "a role reading a context")
			assert.deepEqual(keysOf(at(paths, path)), ["post"], `${path}: one POST\n${printed()}`)
			const operation = at(paths, path, "post")
			assert.equal(
				at(operation, "operationId"),
				`${r.name}.${member.name}`,
				`${path}: its operationId`
			)
			assert.deepEqual(at(operation, "tags"), [r.name], `${path}: its tags, its role alone`)
			assert.deepEqual(
				at(operation, "security"),
				r.contexts.length === 0 ? [] : [{ bearer: [] }],
				`${path}: it names the bearer scheme exactly when its role reads a context`
			)
			const parameters = at(operation, "parameters")
			assert.deepEqual(
				isList(parameters)
					? Arr.map(parameters, (p) =>
							isRecord(p) ? { ...Rec.remove(p, "description"), schema: at(p, "schema") } : p
						)
					: parameters,
				[
					{
						in: "header",
						name: "grizzle-wire",
						required: true,
						schema: { type: "string", const: member.wire.digest }
					}
				],
				`${path}: its grizzle-wire header, its digest's one value`
			)
			assert.ok(
				namesAll(at(parameters, "0", "description"), [wireRefusals.absent, wireRefusals.other]),
				`${path}: its grizzle-wire header's description names what a call naming no digest and another one are answered`
			)
			const summary = at(operation, "summary")
			for (const [word, holds] of kindWords(member)) {
				assert.equal(
					wordsOf(summary).has(word),
					holds,
					`${path}: its summary ${holds ? "says" : "does not say"} ${word}: ${Formatter.format(summary)}`
				)
			}
			dependsOnly(
				seen.summaries,
				{ kind: member.kind, shape: member.wire.member.shape },
				summary,
				`${path}: its summary depends on its program's kind and shape alone\n${printed()}`,
				() => note("a summary seen again under what it may depend on")
			)
			const input = member.wire.member.input
			assert.ok(
				namesAll(at(operation, "description"), [
					...relationsOf(member),
					...(member.kind === "key" ? member.fields : []),
					...Arr.map(input.params, (p) => p.name)
				]),
				`${path}: its description names the relations it writes, its key's fields and its parameters: ${Formatter.format(at(operation, "description"))}\n${printed()}`
			)
			dependsOnly(
				seen.bodies,
				{
					input: input.kind,
					params: input.params.length,
					facts:
						input.kind === "call"
							? Arr.map(
									Arr.dedupe(Arr.map(input.facts, (f) => f.op)),
									(op) => [op, Arr.filter(input.facts, (f) => f.op === op).length] as const
								)
							: []
				},
				at(operation, "requestBody", "description"),
				`${path}: its body's description depends on its input's kind, its parameters' count and its facts' count by op alone\n${printed()}`,
				() => note("a body's description seen again under what it may depend on")
			)
			assert.ok(
				deepEquals<unknown>(
					Arr.findFirst(wire.operations, ([p]) => p === path).pipe(
						Option.map(([, w]) => w),
						Option.getOrUndefined
					),
					member.wire
				),
				`${path}: its x-grizzle-wire, as the client reads it, its served wire\n${printed()}`
			)
			const shape = member.wire.member.shape
			note(shape === "write" ? "a write" : "a list read")
			if (member.kind === "paged") {
				note("a paged read")
			}
			if (answeredOf(member)) {
				note("an answered read")
			}
			const errors = at(
				document,
				"components",
				"schemas",
				`${r.name}.${member.name}.error`,
				"properties",
				"data",
				"contentSchema",
				"properties",
				"error",
				"oneOf"
			)
			assert.deepEqual(
				Arr.sort(
					isList(errors)
						? Arr.map(errors, (branch) => {
								const kind = at(branch, "properties", "kind", "const")
								return typeof kind === "string" ? kind : Formatter.format(kind)
							})
						: [],
					Order.String
				),
				kindsAt(sourcesOf(member)),
				`${path}: its error event admits exactly the kinds its call may end with\n${printed()}`
			)
			const body = at(operation, "requestBody", "content", "application/json", "schema", "required")
			assert.deepEqual(
				body,
				member.kind === "paged" ? ["params", "facts", "window"] : ["params", "facts"],
				`${path}: its body's members`
			)
			const stream = at(operation, "responses", "200", "content", "text/event-stream", "itemSchema")
			const shapeEvents: { readonly [name: string]: EventDescriptor } = events[shape]
			const named = Rec.keys(shapeEvents)
			const branches = at(stream, "oneOf")
			assert.ok(
				isList(branches) && branches.length === named.length,
				`${path}: one branch per event`
			)
			assert.deepEqual(
				Arr.sort(keysOf(at(stream, "discriminator", "mapping")), Order.String),
				Arr.sort(named, Order.String),
				`${path}: the events of its shape, ${shape}`
			)
			for (const name of named) {
				const component = at(document, "components", "schemas", `${r.name}.${member.name}.${name}`)
				assert.equal(
					at(component, "properties", "event", "const"),
					name,
					`${path}: the event ${name}`
				)
				if (name === "ready") {
					assert.deepEqual(
						at(component, "x-stream"),
						answeredOf(member) ? { role: "ready", next: "end" } : { role: "ready" },
						`${path}: its ready says end follows it exactly for an answered read\n${printed()}`
					)
				}
				const data = at(component, "properties", "data", "contentSchema", "required")
				if (name === "upsert") {
					assert.deepEqual(
						data,
						["row", "after"],
						`${path}: a ${shape}'s upsert carries its row and after\n${printed()}`
					)
				}
			}
		}
	})

/** A fresh installation's codes: each roster's first. */
export const firstCodes = (owned: Parameters<typeof rostersOf>[0]) =>
	firstCodebook(rostersOf(owned))

export const tagSeenAgain: Feature = "a tag's description seen again under what it may depend on"

/**
 * Which login a document is of: one it draws over a case it resolves, or the first's, the login its sketch's document
 * before it drew over the case it resolved (Logins), at the document's own law level.
 */
type LoginOf = "drawn" | "first's"

/** A document of a cross-document case: its case sketch, its law level, and which login it is of. */
export type Document = readonly [CaseSketch, LawLevel, LoginOf]

/** The cases a case's documents resolved and the logins they drew over them, by the sketch each was resolved from. */
export type Logins = Map<
	CaseSketch,
	{ readonly case: ProgramCase; readonly shapes: Arr.NonEmptyReadonlyArray<RoleShape> }
>

/**
 * The document of a login over a case sketch and a law level, compiled as generate compiles it, held to every property
 * of the header beside the documents `seen` holds; a login the compiler refuses holds nothing. Its case and login are
 * ones `notes` resolves and draws, which `logins` then holds as the sketch's, or, for a document of the first's login,
 * the ones `logins` holds.
 */
export const documentHolds = (
	notes: Case<Feature>,
	seen: Seen,
	[sketch, level, loginOf]: Document,
	logins: Logins
) =>
	Effect.gen(function* () {
		const held =
			loginOf === "first's"
				? defined(logins.get(sketch), "the case and login its sketch's first document drew")
				: undefined
		const c = held?.case ?? notes.draw(resolveCase(sketch))
		const schema = drawnSchema(c, level)
		const shapes = held?.shapes ?? sketchLogin(notes, schema, sketch, logins)
		const printed = () => `${printCase(c)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
		const compiled = yield* Effect.result(
			compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		yield* holds(
			compiled.success.back,
			joined(compiled.success.entry.openapi),
			seen,
			notes.note,
			printed
		)
	}).pipe(Effect.scoped, Effect.orDie)

/** A login drawn over `schema`, which `logins` then holds with its case as `sketch`'s. */
const sketchLogin = (
	notes: Case<Feature>,
	schema: DrawnSchema,
	sketch: CaseSketch,
	logins: Logins
): Arr.NonEmptyReadonlyArray<RoleShape> => {
	const shapes = notes.draw(loginGen(schema))
	logins.set(sketch, { case: schema.case, shapes })
	return shapes
}

/**
 * A cross-document case: one case sketch's documents at two law levels, which differ in what no text of a document may
 * depend on, each of a login of its own, so a text is seen again under what it depends on where its logins' roles
 * coincide; then up to one document of another sketch, whose texts are seen again only where its schema's coincide.
 */
export const documentsGen: Gen<ReadonlyArray<Document>> = (source) => {
	const sketch = source.draw(caseSketchGen)
	const twice: ReadonlyArray<Document> = [
		[sketch, source.draw(lawLevelGen), "drawn"],
		[sketch, source.draw(lawLevelGen), "drawn"]
	]
	const other = source.draw(
		array((inner): Document => [inner.draw(caseSketchGen), inner.draw(lawLevelGen), "drawn"], {
			min: 0,
			max: 1
		})
	)
	return [...twice, ...other]
}

/**
 * A cross-document case aimed at a text seen again: one login's documents at two law levels, the second of the login
 * the first drew, so every role's texts are seen again under what they may depend on wherever both compile.
 */
export const sharedDocumentsGen: Gen<ReadonlyArray<Document>> = (source) => {
	const sketch = source.draw(caseSketchGen)
	return [
		[sketch, source.draw(lawLevelGen), "drawn"],
		[sketch, source.draw(lawLevelGen), "first's"]
	]
}
