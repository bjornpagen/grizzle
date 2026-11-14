/**
 * A login's OpenAPI document (live/openapi.ts), over logins drawn as `grizzle generate` compiles them, with no database
 * (test/support/served-login.ts compiledLogin): roles reading a generated schema's queries, an ordered one read whole or
 * paged, writing relations through ChangeSets whose facts each call supplies, perhaps through a query entry that reads a
 * context; and writers of generated write schemas running one drawn ChangeSet, its array members the call's, its
 * read-backs delivered in its outcome.
 *
 * Properties, of each login's document, read off its served file alone as generate writes it (ServedEntry openapi):
 * - Valid: it validates against the official OpenAPI 3.2 schema, vendored with its SHA-256, and against the OAS base
 *   schema, which validates its every Schema Object under the OAS dialect, offline (test/support/openapi/validator.ts).
 * - Canonical: its text is its value's canonical JSON, a final newline after it, so check compares bytes.
 * - One operation per program: its paths are exactly `/<login>/<role>/<program>` of each member of each role, each with
 *   one POST, its operationId `<role>.<program>` and its tags the role alone, its `grizzle-wire` header the one value of
 *   its wire's digest, and its `x-grizzle-wire`, as the client reads it (live/document.ts documentWire), its served
 *   wire; and the document's root `x-grizzle-wire` holds each role's served witness, by the role's name.
 * - Each shape once: no Schema Object stands at two places in the document (every position JSON Schema 2020-12 reads a
 *   schema at, from each component, each request body, each event stream's item schema and each parameter's schema)
 *   unless its canonical text is no longer than the reference to the component of its digest
 *   (`{"$ref":"#/components/schemas/shared.<its SHA-256 in base32>"}`), and no record or array stands at two places in
 *   the document's wire (the root's roles and table, each operation's member) unless its text is no longer than a
 *   reference to the table's next entry (`{"$ref":"#/x-grizzle-wire/shared/<n>"}`). Every reference is read through as
 *   a reader does, so the properties above read the document as its readers do.
 * - Events by shape: each operation's stream is the events of its member's shape (live/events.ts events), one component
 *   each, discriminated by `event`; a list's upsert carries `after`, a set's does not, and a write's answer is its
 *   outcome; a paged member's body takes its window. An instant read's `ready` says in its `x-stream` that `end`
 *   follows it, and no other's does.
 * - Described, each name once: one tag per role, in the login's order, whose description names every context the role
 *   reads and says its calls need a bearer token exactly where it reads one; each operation's summary says what its
 *   program is (live or at its call's instant, ordered, paged by window, a write or a refresh); each operation's
 *   description names every relation its program writes or refreshes, its key's fields and its parameters; and its
 *   `grizzle-wire` header's description names what a call naming no digest and one naming another are answered
 *   (live/events.ts wireRefusals).
 * - Short: what each text may depend on bounds it, whatever the program's size. A summary depends on its program's
 *   kind and shape alone; a body's description on its input's kind, its parameters' count and its facts' count by op;
 *   a tag's description on its role's name, its programs' count by what they do, and its contexts. Each is held to
 *   that over every document a run draws: two operations alike in what it may depend on have the same text, so no
 *   summary grows with its program's relations.
 * - Bearer exactly where used: the document declares its bearer scheme exactly when some role reads a context, and an
 *   operation's security names it exactly when its role reads one.
 * - Exact errors: each operation's error event admits exactly the kinds of CallError its call over HTTP may end with:
 *   those the classification's tables (adapter live/call-error.ts readings) read the failures of the HTTP door and of
 *   the Db's opening as, and of its answer's sources: a live read's run and subscription, a read's at its call's
 *   instant run alone, a ChangeSet's run and its refusing outcome, a refresh's run alone.
 *
 * Oracle: the served file the document is read off, its members and their wires, the event model's own table, and the
 * classification's tables.
 *
 * Features: a set read, a list read, a paged read, an instant read, a write, a refresh, a write with an array member, a
 * write with a read-back, a role reading a context, a role reading none, a login no role of which reads a context, a
 * schema shared, a wire node shared.
 *
 * Plants (~/.cache/grizzle-release/LIVE-OPENAPI/plants): openapi-non-program-operation (an operation for each role
 * beside its programs'), openapi-list-without-after (an ordered program's upsert from the set shape's events).
 * Plants (~/.cache/grizzle-release/OPENAPI/plants): instant-ready-unmarked (an instant read's ready without `next`),
 * summary-instant-live (an instant read's summary says live), summary-lists-relations (a write's summary names the
 * relations it writes), tag-lists-relations (a role's description names the relations its programs write),
 * body-lists-facts (a body's description names the relations of its facts), description-drops-relation (an
 * operation's description names all its written relations but its last), wire-header-undescribed (the header's
 * description names no stale answer), bearer-always (the bearer scheme declared for every login),
 * errors-every-kind (every error event admits all twelve kinds, as before), refresh-meets-outcome (the model gives a
 * refresh a ChangeSet's refusing outcome too).
 * Plants (~/.cache/grizzle-release/OUTPUTSIZE/plants): openapi-body-unshared (each request body written as its operation
 * built it, every schema in it inline), openapi-wire-unshared (each operation's wire member written whole).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
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
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { documentWire } from "#compiler/live/document.ts"
import {
	type EventDescriptor,
	events,
	type FailureSource,
	wireRefusals
} from "#compiler/live/events.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { ServedFile, ServedMember } from "#compiler/served/forms.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { documentErrors } from "#test/support/openapi/validator.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	buildChangeSet,
	changeSetSketchGen,
	resolveChangeSet,
	type WChangeSet
} from "#test/support/oracle/write/changeset.ts"
import { factsSketchGen, resolveFacts } from "#test/support/oracle/write/facts.ts"
import { buildWSchema, resolveSchema, schemaSketchGen } from "#test/support/oracle/write/schema.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	loginGen,
	type RoleShape
} from "#test/support/served-login.ts"

type Feature =
	| "a set read"
	| "a list read"
	| "a paged read"
	| "an instant read"
	| "a write"
	| "a refresh"
	| "a write with an array member"
	| "a write with a read-back"
	| "a role reading a context"
	| "a role reading none"
	| "a login no role of which reads a context"
	| "a schema shared"
	| "a wire node shared"

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
const unseen = (): Seen => ({ summaries: new Map(), bodies: new Map(), tags: new Map() })

/**
 * That `text` depends on `on` alone: the text of every earlier document of the run seen under the same `on` is this
 * one, else `text` is seen under it.
 */
const dependsOnly = (seen: Map<string, unknown>, on: unknown, text: unknown, message: string) => {
	const key = Formatter.format(on)
	const before = seen.get(key)
	if (before === undefined) {
		seen.set(key, text)
		return
	}
	assert.deepEqual(
		text,
		before,
		`${message}: ${Formatter.format(text)} beside ${Formatter.format(before)}`
	)
}

/** How many programs of a role do each thing, by their served forms: read, write or refresh. */
const deedsOf = (members: ReadonlyArray<ServedMember>) => ({
	reads: Arr.filter(members, (m) => m.kind !== "change" && m.kind !== "refresh").length,
	writes: Arr.filter(members, (m) => m.kind === "change").length,
	refreshes: Arr.filter(members, (m) => m.kind === "refresh").length
})

/** The relations a member's wire says it writes or refreshes: a ChangeSet's outcome's, a refresh's targets'. */
const relationsOf = (member: ServedMember): ReadonlyArray<string> => {
	switch (member.kind) {
		case "change": {
			const wire = member.wire.member
			return wire.shape === "write" && wire.outcome.kind === "change" ? wire.outcome.relations : []
		}
		case "refresh":
			return Arr.map(member.refresh.targets, (target) => target.relation)
		case "read":
		case "key":
		case "paged":
		case "instant":
			return []
	}
}

/**
 * The sources a member's call over HTTP meets its failures at (live/events.ts failures), by its served form: the HTTP
 * door's and its Db's opening before it runs, then a live read's run and subscription, a read's at its call's instant
 * run alone, a ChangeSet's run and refusing outcome, a refresh's run alone.
 */
const sourcesOf = (member: ServedMember): ReadonlyArray<FailureSource> => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return ["door", "open", "read", "watch"]
		case "instant":
			return ["door", "open", "read"]
		case "change":
			return ["door", "open", "apply", "outcome"]
		case "refresh":
			return ["door", "open", "apply"]
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
 * exactly for a read a call watches, `instant` for one at its call's instant, `ordered` for a read of a list, `paged`
 * for a paged one, `write` for a ChangeSet's and `refresh` for a refresh's.
 */
const kindWords = (member: ServedMember): ReadonlyArray<readonly [string, boolean]> => {
	const shape = member.wire.member.shape
	return [
		["live", member.kind === "read" || member.kind === "key" || member.kind === "paged"],
		["instant", member.kind === "instant"],
		["ordered", shape === "list" || shape === "instantList"],
		["paged", member.kind === "paged"],
		["write", member.kind === "change"],
		["refresh", member.kind === "refresh"]
	]
}

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
		const schemaShared = textOf({ $ref: `#/components/schemas/shared.${sha256Base32("")}` }).length
		assert.deepEqual(
			repeatedPast(
				documentSchemas(document),
				(t) => textOf({ $ref: `#/components/schemas/shared.${sha256Base32(t)}` }).length
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
				`role ${r.name}'s description depends on its name, its contexts and its programs' count by deed alone\n${printed()}`
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
				`${path}: its summary depends on its program's kind and shape alone\n${printed()}`
			)
			const input = member.wire.member.input
			assert.ok(
				namesAll(at(operation, "description"), [
					...relationsOf(member),
					...(member.kind === "key" ? member.fields : []),
					...Arr.map(input.params, (p) => p.name)
				]),
				`${path}: its description names the relations it writes or refreshes, its key's fields and its parameters: ${Formatter.format(at(operation, "description"))}\n${printed()}`
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
				`${path}: its body's description depends on its input's kind, its parameters' count and its facts' count by op alone\n${printed()}`
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
			note(
				shape === "set" || shape === "instantSet"
					? "a set read"
					: shape === "list" || shape === "instantList"
						? "a list read"
						: "a write"
			)
			if (member.kind === "paged") {
				note("a paged read")
			}
			if (member.kind === "instant") {
				note("an instant read")
			}
			if (member.kind === "refresh") {
				note("a refresh")
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
						member.kind === "instant" ? { role: "ready", next: "end" } : { role: "ready" },
						`${path}: its ready says end follows it exactly for an instant read\n${printed()}`
					)
				}
				const data = at(component, "properties", "data", "contentSchema", "required")
				if (name === "upsert") {
					const ordered = shape === "list" || shape === "instantList"
					assert.deepEqual(
						data,
						ordered ? ["row", "after"] : ["row"],
						`${path}: a ${shape}'s upsert ${ordered ? "carries" : "carries no"} after\n${printed()}`
					)
				}
			}
			if (member.kind === "change" && member.variants.kind === "change") {
				if (member.variants.change.members.length > 0) {
					note("a write with an array member")
				}
				if (member.variants.change.readBacks.length > 0) {
					note("a write with a read-back")
				}
			}
		}
	})

/** A fresh installation's codes: each roster's first. */
const firstCodes = (owned: Parameters<typeof rostersOf>[0]) => firstCodebook(rostersOf(owned))

/** `c` as a served call supplies it: every array member's facts the call's, every other member a query. */
const servedShape = (c: WChangeSet): WChangeSet => ({
	...c,
	strata: Arr.map(c.strata, (stratum) =>
		Arr.map(stratum, (m): WChangeSet["strata"][number][number] =>
			m.source.kind === "array" ? { ...m, source: { kind: "array", facts: [], stream: false } } : m
		)
	),
	binding: "passed"
})

layer(NodeServices.layer, { excludeTestServices: true })("a login's OpenAPI document", (it) => {
	it.effect(
		"validates, is canonical, and holds one operation per program, its events its shape's",
		(ctx) => {
			const seen = unseen()
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served file the document is read off and the event model's own table"
						},
						suite: "unit/live/openapi-logins",
						draw: drawn(
							(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a set read",
								"a list read",
								"a paged read",
								"an instant read",
								"a write",
								"a refresh",
								"a role reading a context",
								"a role reading none",
								"a login no role of which reads a context",
								"a schema shared",
								"a wire node shared"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([sketch, level], notes) =>
						Effect.gen(function* () {
							const c = notes.draw(resolveCase(sketch))
							const schema = drawnSchema(c, level)
							const [first, ...rest] = notes.draw(loginGen(schema))
							const shapes: Arr.NonEmptyReadonlyArray<RoleShape> = [
								{ ...first, refreshes: notes.draw(boolean) },
								...rest
							]
							const printed = () =>
								`${printCase(c)}\n${Formatter.format(level)}\n${Formatter.format(shapes)}`
							const compiled = yield* Effect.result(
								compiledLogin(drawnLogin(schema, shapes), schema.laws.codes)
							)
							if (Answered.isFailure(compiled)) {
								return
							}
							const entry = compiled.success.entry
							yield* holds(entry.file, entry.openapi, seen, notes.note, printed)
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
		}
	)

	it.effect(
		"documents every served ChangeSet's facts and outcome, valid and one operation per program",
		(ctx) => {
			const seen = unseen()
			return searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the served file the document is read off and the event model's own table"
						},
						suite: "unit/live/openapi-changes",
						draw: drawn(
							(source) =>
								[
									source.draw(schemaSketchGen),
									source.draw(pickGen),
									source.draw(factsSketchGen(5)),
									source.draw(changeSetSketchGen)
								] as const
						),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a write",
								"a write with an array member",
								"a write with a read-back",
								"a schema shared"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([schemaSketch, groupPick, factsSketch, changesSketch], notes) =>
						Effect.gen(function* () {
							const schema = notes.draw(resolveSchema(schemaSketch))
							const [first, ...rest] = Arr.filter(schema.groups, (g) => g.role === "drawn")
							if (first === undefined) {
								return
							}
							const group = pickFrom([first, ...rest], groupPick)
							const c = servedShape(
								notes.draw(resolveChangeSet(group, resolveFacts(group, factsSketch), changesSketch))
							)
							const built = buildWSchema(schema, "Wo")
							const { changes } = buildChangeSet(built.value, built.relations, group, c)
							const writer = role(built.value, "writer", wholeEntriesOf(built.value), {
								write: writableNamesOf(built.value)
							})
							const compiled = yield* Effect.result(
								compiledLogin(
									login(built.value, "server", [writer], {
										workload: [workload(built.value, { w: changes })]
									}),
									firstCodes
								)
							)
							if (Answered.isFailure(compiled)) {
								return
							}
							const entry = compiled.success.entry
							yield* holds(entry.file, entry.openapi, seen, notes.note, () => Formatter.format(c))
						}).pipe(Effect.scoped, Effect.orDie)
				)
			)
		}
	)
})
