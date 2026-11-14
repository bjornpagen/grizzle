/**
 * A login's OpenAPI 3.2 document, read off its served file alone (served/forms.ts ServedFile): one operation per program
 * of each of its roles, `POST /<login>/<role>/<program>`, whose request body is the program's input and whose answer is
 * a `text/event-stream` of its events (live/events.ts events), each event's data the JSON of its payload, every schema
 * an interpreter of the program's wire shape (live/shape.ts) over the wire's one scalar table (live/wire.ts), refined
 * here by what each scalar type states beyond its carrier. `grizzle generate` writes it beside the served file as
 * canonical JSON, and `grizzle check` compares its bytes.
 *
 * Every shape is written once (core/share.ts): a Schema Object that stands in the document more than once, and is
 * longer than a reference to it, is the component named by its digest (sharedName), referenced from every place it
 * stood, so a type's schema, a role's witness or a heading two relations share is one component; and the wire every
 * operation and role carries for a client (`x-grizzle-wire`) holds each node it shares once, in the root's table, as
 * live/document.ts reads it. Every reference is the document's own, from its root.
 */
import { appendAll } from "#compiler/core/array.ts"
import { compareText, type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Base32 } from "#compiler/core/sha256.ts"
import { type Parts, type SharingFormat, shareRepeated } from "#compiler/core/share.ts"
import { contractOf, octetsOf, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import { referenceKey, wireExtension, wireReference } from "#compiler/live/document.ts"
import {
	type EventDescriptor,
	events,
	type Retry,
	type Role,
	wireHeader,
	wireRefusals
} from "#compiler/live/events.ts"
import {
	memberShape,
	roleWitness,
	type ServedLeaf,
	type ServedWire,
	wireScalarOf
} from "#compiler/live/member.ts"
import {
	inputSchema,
	type MemberShape,
	type RoleWitness,
	type SchemaReference,
	slotSchemas,
	type WireFacts,
	type WireInput,
	type WireParam
} from "#compiler/live/shape.ts"
import {
	type SchemaGap,
	sameJson,
	scalarSchema,
	type WireSchema,
	withGaps
} from "#compiler/live/wire.ts"
import { toEcma } from "#compiler/scalar/regex/ecma.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import type { ServedFile, ServedMember, ServedRoleForm } from "#compiler/served/forms.ts"

/** The OpenAPI version the document states, 3.2.0, whose `itemSchema` describes each event of a stream. */
const openApiVersion = "3.2.0"

/** The directory, beside the served files' (served/forms.ts servedDirectory), that holds a schema's documents. */
export const openApiDirectory = "openapi"

/** The file of a login's document, within its schema's migrations directory. */
export const openApiPath = (login: string): string => `${openApiDirectory}/${login}.json`

/** The security scheme a role that reads a context is called under: the verified bearer token its claims are read from. */
const bearer = "bearer"

/** The value a CallError's retry holds where the same call may be run again (live/events.ts Retry). */
const retrySafe: Retry = "safe"

/**
 * The schema of a scalar type: its carrier's spelling (live/wire.ts), with each pattern of a refined text as an
 * ECMA-262 `pattern` printed from the pattern's IR (scalar/regex/ecma.ts), and the laws no keyword states listed as its
 * gaps: a contract's predicate, a byte bound (beside `maxLength`, which every value within it meets, a code point
 * taking at least a byte), and a pattern no IR prints.
 */
const typeSchema = (type: ScalarType): WireSchema => {
	const carrier = scalarSchema(wireScalarOf(type))
	const gaps: Array<SchemaGap> = contractOf(type) === undefined ? [] : ["contract"]
	const refinements: Array<WireSchema> = []
	const text = textOf(type)
	if (text !== undefined && text.regex !== "wildcard") {
		for (const pattern of text.regex.patterns) {
			const node = parsePattern(pattern.source, pattern.flags)
			if (node.ok && node.value.kind !== "never") {
				refinements.push({ pattern: toEcma(node.value) })
			} else {
				gaps.push("pattern")
			}
		}
		const octets = octetsOf(text.regex.check)
		if (octets !== undefined) {
			refinements.push({ maxLength: octets })
			gaps.push("octets")
		}
	}
	return withGaps(refinements.length === 0 ? carrier : { ...carrier, allOf: refinements }, gaps)
}

/** The schema of a leaf: its one type's, or one of its types' where its column holds values of several. */
const leafSchema = (leaf: ServedLeaf): WireSchema => {
	const schemas = mapNonEmpty(leaf.types, typeSchema)
	const [first, ...rest] = schemas
	const distinct = rest.filter(
		(schema, at) => !schemas.slice(0, at + 1).some((s) => sameJson(s, schema))
	)
	return distinct.length === 0 ? first : { anyOf: [first, ...distinct] }
}

/**
 * The extension a stream's event carries for its consumer (`x-stream`): what an event of each role is to the stream,
 * and for a `ready` the event that follows it where one alone may (an instant read's `end`, live/events.ts), so a
 * consumer knows the stream ends there.
 */
const streamRole = (
	role: Role,
	descriptor: EventDescriptor
): ReadonlyArray<readonly [string, Json]> => {
	switch (role) {
		case "item":
			return []
		case "ready":
			return [
				["x-stream", descriptor.next === undefined ? { role } : { role, next: descriptor.next }]
			]
		case "end":
			return [["x-stream", { role }]]
		case "error": {
			const member = Object.entries(descriptor.payload).find(([, slot]) => slot === "error")
			return member === undefined
				? [["x-stream", { role }]]
				: [["x-stream", { role, retryWhen: { pointer: `/${member[0]}/retry`, equals: retrySafe } }]]
		}
	}
}

/**
 * What a program does to its role's relations: reads them, writes the relations its ChangeSet writes (its outcome's
 * counts', live/shape.ts WireOutcome), or refreshes its targets.
 */
type Deed =
	| { readonly kind: "reads" }
	| { readonly kind: "writes" | "refreshes"; readonly relations: ReadonlyArray<string> }

/**
 * One program's operation: its path; its operation object but for its parameters, its request body, its response and
 * its wire, which the document's sharing writes (operationJson); its operationId; the schema of its one header, its
 * wire's digest; its body's description and schema; its stream's item schema; its components by name, its events'
 * schemas and a nesting fact's levels; its wire as generate read it; and its program's name and deed.
 */
interface Operation {
	readonly path: string
	readonly operation: { readonly [member: string]: Json }
	readonly id: string
	readonly answer: string
	readonly header: WireSchema
	readonly bodyDescription: string
	readonly body: WireSchema
	readonly items: WireSchema
	readonly components: ReadonlyArray<readonly [string, WireSchema]>
	readonly wire: ServedWire
	readonly program: { readonly name: string; readonly deed: Deed }
}

/** Where the document's components are, before a component's name. */
const componentsPointer = "#/components/schemas/"

/** The reference to the component named `name`. */
const componentReference: SchemaReference = (name) => ({
	[referenceKey]: `${componentsPointer}${name}`
})

/**
 * An operation's events (live/events.ts events), the operation of a member of a role whose refusals name `witness`, each
 * the SSE item of its name and its payload's JSON as its data.
 */
const eventsOf = (
	shape: MemberShape<ServedLeaf>,
	witness: RoleWitness<ServedLeaf>,
	prefix: string
): ReadonlyArray<readonly [string, string, WireSchema]> => {
	const slots = slotSchemas(shape, witness, leafSchema)
	const named: ReadonlyArray<readonly [string, EventDescriptor]> = Object.entries(
		events[shape.shape]
	)
	return named.map(([name, descriptor]) => {
		const payload = Object.entries(descriptor.payload)
		const data: WireSchema = {
			type: "object",
			properties: Object.fromEntries(payload.map(([member, slot]) => [member, slots[slot]])),
			required: payload.map(([member]) => member),
			additionalProperties: false
		}
		const item: WireSchema = Object.fromEntries([
			["type", "object"],
			[
				"properties",
				{
					event: { const: name },
					data: { type: "string", contentMediaType: "application/json", contentSchema: data }
				}
			],
			["required", ["event", "data"]],
			["additionalProperties", false],
			...streamRole(descriptor.role, descriptor)
		])
		return [name, `${prefix}.${name}`, item]
	})
}

/** Whether a role's calls need a bearer token: it reads a context, whose facts are read from the token's claims. */
const readsContext = (role: ServedRoleForm): boolean => role.contexts.length > 0

/** Words listed as prose: `a`, `a and b`, `a, b and c`. */
const listed = (words: ReadonlyArray<string>): string => {
	const last = words.at(-1)
	return words.length < 2 || last === undefined
		? words.join("")
		: `${words.slice(0, -1).join(", ")} and ${last}`
}

/** What a member's program does (Deed), by its served form, a ChangeSet's relations read off its wire's outcome. */
const deedOf = (member: ServedMember, shape: MemberShape<ServedLeaf>): Deed => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
		case "instant":
			return { kind: "reads" }
		case "change":
			return {
				kind: "writes",
				relations:
					shape.shape === "write" && shape.outcome.kind === "change" ? shape.outcome.relations : []
			}
		case "refresh":
			return {
				kind: "refreshes",
				relations: member.refresh.targets.map((target) => target.relation)
			}
	}
}

/** A count of things in words: `1 relation`, `2 relations`. */
const counted = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`

/**
 * An operation's summary: what its program is, by its served form (served/forms.ts ServedMemberForm) alone, so it is
 * as short for a program of hundreds of relations as for one of one: a live read of a set or an ordered one, by its
 * key, paged by window, a read at its call's instant alone, a write or a refresh. What the program names is its
 * description's (descriptionOf).
 */
const summaryOf = (member: ServedMember): string => {
	switch (member.kind) {
		case "read":
			return member.read.key.kind === "set" ? "A live set read" : "A live ordered read"
		case "key":
			return member.read.key.kind === "set"
				? "A live set read by its key"
				: "A live ordered read by its key"
		case "paged":
			return "A live ordered read paged by window"
		case "instant":
			return member.read.key.kind === "set"
				? "A set read at the call's instant"
				: "An ordered read at the call's instant"
		case "change":
			return "A write"
		case "refresh":
			return "A refresh"
	}
}

/** A parameter as a description names it: its name, a relation parameter's marked as a relation's facts. */
const paramWords = (param: WireParam<ServedLeaf>): string =>
	param.param.kind === "scalar" ? param.name : `${param.name} (a relation's facts)`

/**
 * An operation's description: what its program names, each once, the one place the document lists it: the relations
 * its ChangeSet writes or its refresh refreshes, a key read's key fields, and the parameters its program declares.
 */
const descriptionOf = (member: ServedMember, deed: Deed, input: WireInput<ServedLeaf>): string =>
	[
		...(deed.kind === "reads" || deed.relations.length === 0
			? []
			: [`It ${deed.kind} ${listed(deed.relations)}.`]),
		...(member.kind === "key" ? [`It reads by its key ${listed(member.fields)}.`] : []),
		input.params.length === 0
			? "It takes no params."
			: `It takes the params ${listed(input.params.map(paramWords))}.`
	].join(" ")

/** The words of an op of a ChangeSet's facts, before the relations it is given for. */
const opWords: { readonly [Op in WireFacts<ServedLeaf>["op"]]: string } = {
	insert: "insert into",
	delete: "delete from",
	put: "put into"
}

/**
 * The facts a ChangeSet's array members take from the call, counted by op: how many relations the call gives facts to
 * insert into, delete from or put into, in the order the ops first appear; their relations are the schema's.
 */
const factsWords = (facts: ReadonlyArray<WireFacts<ServedLeaf>>): string => {
	const ops = new Map<WireFacts<ServedLeaf>["op"], number>()
	for (const member of facts) {
		ops.set(member.op, (ops.get(member.op) ?? 0) + 1)
	}
	return ops.size === 0
		? "no facts"
		: `the facts to ${listed(
				[...ops].map(([op, count]) => `${opWords[op]} ${counted(count, "relation", "relations")}`)
			)}`
}

/**
 * A request body's description, read off its program's input (live/shape.ts WireInput): how many parameters its
 * program declares, and the facts its ChangeSet's array members take from the call counted by op, or a page's window;
 * their names are its schema's and its operation's description's.
 */
const inputDescription = (input: WireInput<ServedLeaf>): string => {
	const params =
		input.params.length === 0 ? "no params" : counted(input.params.length, "param", "params")
	switch (input.kind) {
		case "call":
			return `The call's input: ${params}; ${factsWords(input.facts)}.`
		case "window":
			return `The call's input: ${params}; no facts; and the window of its page, an anchor and a size.`
	}
}

/**
 * The operation of one member of `role`, whose refusals name `witness`, in `file`'s document: its shape read off its
 * served form, as generate read its wire, whose digest its request names in its one header, and which its
 * `x-grizzle-wire` carries for a client; its summary, what its program is; its description, what its program names;
 * and its body's description, what its input
 * holds.
 */
const operationOf = (
	file: ServedFile,
	role: ServedRoleForm,
	witness: RoleWitness<ServedLeaf>,
	member: ServedMember
): Result.Result<Operation, CompileError> =>
	Result.map(memberShape(member, role.name), (shape): Operation => {
		const operationId = `${role.name}.${member.name}`
		const items = eventsOf(shape, witness, operationId)
		const deed = deedOf(member, shape)
		const input = inputSchema(shape.input, operationId, leafSchema, componentReference)
		return {
			path: `/${file.login}/${role.name}/${member.name}`,
			operation: {
				operationId,
				summary: summaryOf(member),
				description: descriptionOf(member, deed, shape.input),
				tags: [role.name],
				security: readsContext(role) ? [{ [bearer]: [] }] : []
			},
			id: operationId,
			answer: shape.shape,
			header: { type: "string", const: member.wire.digest },
			bodyDescription: inputDescription(shape.input),
			body: input.schema,
			items: {
				oneOf: items.map(([, component]) => componentReference(component)),
				discriminator: {
					propertyName: "event",
					mapping: Object.fromEntries(
						items.map(([name, component]) => [name, `${componentsPointer}${component}`])
					)
				}
			},
			components: [
				...items.map(([, component, schema]) => [component, schema] as const),
				...input.named
			],
			wire: member.wire,
			program: { name: member.name, deed }
		}
	})

/** The schemas each operation holds beside its components, in the order the document's sharing reads them. */
const operationSchemaKeys = ["header", "body", "items"] as const

/** An operation's schemas, as the document's sharing wrote them: its header's, its body's and its stream's items'. */
type OperationSchemas = { readonly [K in (typeof operationSchemaKeys)[number]]: Json }

/**
 * An operation as the document holds it: its object, its one header, its request body, its response, and its wire, its
 * schemas `schemas` and its wire's member `member` as the document's sharing wrote them.
 */
const operationJson = (o: Operation, schemas: OperationSchemas, member: Json): Json => ({
	...o.operation,
	parameters: [
		{
			in: "header",
			name: wireHeader,
			description: `The digest of the program's wire form, as x-grizzle-wire states it: a call naming none is answered ${wireRefusals.absent}, and one naming another form ${wireRefusals.other}, so no client decodes by a form the server no longer serves.`,
			required: true,
			schema: schemas.header
		}
	],
	requestBody: {
		description: o.bodyDescription,
		required: true,
		content: { "application/json": { schema: schemas.body } }
	},
	responses: {
		"200": {
			description: `The ${o.answer} answer of ${o.id}: its events, then its end`,
			content: { "text/event-stream": { itemSchema: schemas.items } }
		}
	},
	[wireExtension]: { digest: o.wire.digest, member }
})

/** The words of each deed in a role's count of its programs. */
const deedWords: { readonly [K in Deed["kind"]]: string } = {
	reads: "reading",
	writes: "writing",
	refreshes: "refreshing"
}

/**
 * A role's tag description, read off its served form and its programs' deeds: how many programs it serves, counted
 * by what they do, each one's names its operation's; and whether its calls need a bearer token, with the contexts it
 * reads from the token's claims.
 */
const roleDescription = (
	role: ServedRoleForm,
	programs: ReadonlyArray<Operation["program"]>
): string => {
	const serves = (["reads", "writes", "refreshes"] as const).flatMap((kind) => {
		const count = programs.filter((program) => program.deed.kind === kind).length
		return count === 0 ? [] : [`${count} ${deedWords[kind]}`]
	})
	const token = readsContext(role)
		? `Its calls need a bearer token: it reads ${listed(
				role.contexts.map((context) =>
					context.claim === undefined
						? `the context ${context.name} from the claims' top level`
						: `the context ${context.name} from the claim ${context.claim}`
				)
			)}.`
		: "Its calls need no bearer token: it reads no context."
	return `Role ${role.name}: ${
		programs.length === 0
			? "it serves no program"
			: `it serves ${counted(programs.length, "program", "programs")}, ${listed(serves)}`
	}. ${token}`
}

/**
 * The bearer scheme of a login whose roles read a context: the Authorization header's bearer token (RFC 6750), an
 * RFC 7235 token68, which the login's verify reads; none where no role reads one, so no operation names it.
 */
const securitySchemes = (file: ServedFile): ReadonlyArray<readonly [string, Json]> =>
	file.roles.some(readsContext)
		? [
				[
					"securitySchemes",
					{
						[bearer]: {
							type: "http",
							scheme: "bearer",
							description: `The bearer token of the Authorization header, an RFC 7235 token68, which login ${file.login}'s verify reads: a role that reads a context reads it from the token's claims.`
						}
					}
				]
			]
		: []

/** A JSON value's canonical text, which every value the document's builders make has. */
const canonicalText = (json: Json): string => {
	const text = writeCanonicalJson(json)
	if (!text.ok) {
		throw defect(`a document's value with a canonical text: ${text.error.message}`)
	}
	return text.value
}

/** A Schema Object's member as the document's sharing reads it: its slots, by its keyword (schemaMembers). */
type SchemaMember =
	| { readonly key: string; readonly kind: "properties"; readonly names: ReadonlyArray<string> }
	| { readonly key: string; readonly kind: "list"; readonly length: number }
	| { readonly key: string; readonly kind: "one" }
	| { readonly key: string; readonly kind: "frame"; readonly value: Json }

/** The keywords whose value is one schema, a slot. */
const oneSchemaKeywords: ReadonlySet<string> = new Set([
	"additionalProperties",
	"contentSchema",
	"items",
	"not"
])

/** The keywords whose value is a list of schemas, each a slot. */
const schemaListKeywords: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

/** The keyword whose value names a schema for each property, each a slot. */
const propertiesKeyword = "properties"

/**
 * A Schema Object's members in code-unit order, each read by its keyword: a schema of each property, a list of schemas,
 * one schema, or a value of the schema's own, its frame's.
 */
const schemaMembers = (schema: { readonly [key: string]: Json }): ReadonlyArray<SchemaMember> =>
	Object.keys(schema)
		.toSorted(compareText)
		.map((key): SchemaMember => {
			const value = defined(schema[key], `a schema's member ${key}`)
			if (key === propertiesKeyword && typeof value === "object" && !isList(value)) {
				return { key, kind: "properties", names: Object.keys(value).toSorted(compareText) }
			}
			if (schemaListKeywords.has(key) && isList(value)) {
				return { key, kind: "list", length: value.length }
			}
			return oneSchemaKeywords.has(key) ? { key, kind: "one" } : { key, kind: "frame", value }
		})

/** The schemas a Schema Object's member holds in its slots (schemaMembers): none for one of its frame. */
const memberSlots = (
	schema: { readonly [key: string]: Json },
	member: SchemaMember
): ReadonlyArray<Json> => {
	const value = defined(schema[member.key], `a schema's member ${member.key}`)
	switch (member.kind) {
		case "properties":
			return typeof value === "object" && !isList(value)
				? member.names.map((name) => defined(value[name], `a schema of the property ${name}`))
				: []
		case "list":
			return isList(value) ? value : []
		case "one":
			return [value]
		case "frame":
			return []
	}
}

/** What a Schema Object's member adds to its frame: its keyword, and its names, its count or its value. */
const memberFrame = (member: SchemaMember): Json => {
	switch (member.kind) {
		case "properties":
			return [member.key, member.names]
		case "list":
			return [member.key, member.length]
		case "one":
			return [member.key]
		case "frame":
			return [member.key, member.value]
	}
}

/** A Schema Object's member rebuilt with the schemas `take` gives its slots, in their order. */
const memberRebuilt = (member: SchemaMember, take: () => Json): readonly [string, Json] => {
	switch (member.kind) {
		case "properties":
			return [member.key, Object.fromEntries(member.names.map((name) => [name, take()]))]
		case "list":
			return [member.key, Array.from({ length: member.length }, take)]
		case "one":
			return [member.key, take()]
		case "frame":
			return [member.key, member.value]
	}
}

/** The name of the component a shared schema is: `shared.` and its canonical text's SHA-256 in base32. */
const sharedName = (schema: Json): string => `shared.${sha256Base32(canonicalText(schema))}`

/**
 * The document's Schema Objects as its sharing reads them (core/share.ts): each object a schema stands at, its slots the
 * schemas it holds (each property's, a list's members, one schema's), its frame every other member, as its canonical
 * text; a shared schema is the component of its digest's name (sharedName).
 */
const schemaSharing: SharingFormat = {
	parts: (node): Parts | undefined => {
		if (typeof node !== "object" || isList(node)) {
			return undefined
		}
		const members = schemaMembers(node)
		return {
			frame: canonicalText(members.map(memberFrame)),
			slots: members.flatMap((member) => memberSlots(node, member))
		}
	},
	rebuild: (node, slots) => {
		if (typeof node !== "object" || isList(node)) {
			return node
		}
		let next = 0
		const take = (): Json => {
			const slot = defined(slots[next], "a schema for each slot")
			next += 1
			return slot
		}
		return Object.fromEntries(schemaMembers(node).map((member) => memberRebuilt(member, take)))
	},
	reference: (node) => componentReference(sharedName(node))
}

/**
 * The document's wire as its sharing reads it (core/share.ts): every record and array of it, each member or item a
 * slot; a shared node is an entry of the root's table, referenced by its index (live/document.ts wireReference). A
 * wire record holds no `$ref` of its own, which a reference alone holds.
 */
const wireSharing: SharingFormat = {
	parts: (node): Parts | undefined => {
		if (typeof node !== "object") {
			return undefined
		}
		if (isList(node)) {
			return { frame: "[", slots: node }
		}
		if (Object.hasOwn(node, referenceKey)) {
			throw defect(`a wire record holding no member ${referenceKey}`)
		}
		const keys = Object.keys(node).toSorted(compareText)
		return {
			frame: `{${canonicalText(keys)}`,
			slots: keys.map((key) => defined(node[key], `a wire record's member ${key}`))
		}
	},
	rebuild: (node, slots) => {
		if (typeof node !== "object" || isList(node)) {
			return isList(node) ? slots : node
		}
		return Object.fromEntries(
			Object.keys(node)
				.toSorted(compareText)
				.map((key, at) => [key, defined(slots[at], `a wire record's member ${key}`)])
		)
	},
	reference: (_, at) => ({ [referenceKey]: wireReference(at) })
}

/** The root at `at` of values shared (core/share.ts). */
const rootAt = (roots: ReadonlyArray<Json>, at: number): Json =>
	defined(roots[at], "a root for each value shared")

/** Components by name, each name once: a name two components take is a defect of the document's naming. */
const componentsByName = (
	components: ReadonlyArray<readonly [string, Json]>
): { readonly [name: string]: Json } => {
	const out = new Map<string, Json>()
	for (const [name, schema] of components) {
		if (out.has(name)) {
			throw defect(`one component named ${name}`)
		}
		out.set(name, schema)
	}
	return Object.fromEntries(out)
}

/**
 * The OpenAPI 3.2 document of a login's served file (see the module's header): its info naming the login, the level it
 * is over and the snapshot fingerprint it serves, a tag per role describing it, an operation per program of each role,
 * every event's schema and every nesting fact's level a component, each repeated schema a component of its own, the
 * wire of each role and each operation with its shared nodes in the root's table, and the bearer scheme a role that
 * reads a context is called under, declared exactly where one does. A member whose wire shape is refused refuses it.
 */
const openApiDocument = (file: ServedFile): Result.Result<Json, CompileError> => {
	const operations: Array<Operation> = []
	const tags: Array<Json> = []
	for (const role of file.roles) {
		const witness = roleWitness(role)
		const own: Array<Operation> = []
		for (const member of role.members) {
			const operation = operationOf(file, role, witness, member)
			if (!operation.ok) {
				return operation
			}
			own.push(operation.value)
		}
		appendAll(operations, own)
		tags.push({
			name: role.name,
			description: roleDescription(
				role,
				own.map((o) => o.program)
			)
		})
	}
	const components = operations.flatMap((o) => o.components)
	const schemas = shareRepeated(
		[
			...components.map(([, schema]) => schema),
			...operations.flatMap((o) => operationSchemaKeys.map((key) => o[key]))
		],
		schemaSharing
	)
	const schemaOf = (at: number, key: (typeof operationSchemaKeys)[number]): Json =>
		rootAt(
			schemas.roots,
			components.length + operationSchemaKeys.length * at + operationSchemaKeys.indexOf(key)
		)
	const operationSchemas = (at: number): OperationSchemas => ({
		header: schemaOf(at, "header"),
		body: schemaOf(at, "body"),
		items: schemaOf(at, "items")
	})
	const wires = shareRepeated(
		[...file.roles.map((role) => role.wire.witness), ...operations.map((o) => o.wire.member)],
		wireSharing
	)
	return Result.ok({
		openapi: openApiVersion,
		info: {
			title: file.login,
			version: file.fingerprint,
			description: `The programs login ${file.login} serves over ${file.base}: one operation per program of each of its roles, ${listed(file.roles.map((role) => role.name))}.`,
			"x-grizzle-login": file.login
		},
		tags,
		paths: Object.fromEntries(
			operations.map((o, at) => [
				o.path,
				{
					post: operationJson(o, operationSchemas(at), rootAt(wires.roots, file.roles.length + at))
				}
			])
		),
		components: Object.fromEntries([
			[
				"schemas",
				componentsByName([
					...components.map(([name], at) => [name, rootAt(schemas.roots, at)] as const),
					...schemas.table.map((entry) => [sharedName(entry.node), entry.node] as const)
				])
			],
			...securitySchemes(file)
		]),
		[wireExtension]: {
			roles: Object.fromEntries(
				file.roles.map((role, at) => [role.name, { witness: rootAt(wires.roots, at) }])
			),
			shared: wires.table.map((entry) => entry.node)
		}
	})
}

/** The document's text: canonical JSON, keys in code-unit order, and a final newline, as a served file's. */
export const openApiText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(openApiDocument(file), (document) =>
		Result.map(writeCanonicalJson(document), (text) => `${text}\n`)
	)
