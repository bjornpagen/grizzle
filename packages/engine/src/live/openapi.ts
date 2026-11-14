/**
 * A login's OpenAPI 3.2 document, read off its served file alone (served/forms.ts ServedFile): one operation per program
 * of each of its roles, `POST /<login>/<role>/<program>`, whose request body is the program's input and whose answer is
 * a `text/event-stream` of its events (live/events.ts events), each event's data the JSON of its payload, every schema
 * an interpreter of the program's wire shape (live/shape.ts) over the wire's one scalar table (live/wire.ts), refined
 * here by what each scalar type states beyond its carrier. `grizzle generate` writes it beside the served file as
 * canonical JSON, and `grizzle check` compares its bytes.
 */
import { type Json, writeCanonicalJson } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { contractOf, octetsOf, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import {
	type EventDescriptor,
	events,
	type Retry,
	type Role,
	wireHeader,
	wireRefusals
} from "#compiler/live/events.ts"
import { memberShape, type ServedLeaf, wireScalarOf } from "#compiler/live/member.ts"
import {
	inputSchema,
	type MemberShape,
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

/** One program's operation, the schemas of its events, by their components' names, and its name and deed. */
interface Operation {
	readonly path: string
	readonly operation: WireSchema
	readonly events: ReadonlyArray<readonly [string, WireSchema]>
	readonly program: { readonly name: string; readonly deed: Deed }
}

/** An operation's events (live/events.ts events), each the SSE item of its name and its payload's JSON as its data. */
const eventsOf = (
	shape: MemberShape<ServedLeaf>,
	prefix: string
): ReadonlyArray<readonly [string, string, WireSchema]> => {
	const slots = slotSchemas(shape, leafSchema)
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

/** The relations a deed names, after its verb; none for a read. */
const relationWords = (deed: Deed): string =>
	deed.kind === "reads" || deed.relations.length === 0 ? "" : ` of ${listed(deed.relations)}`

/**
 * An operation's summary: what its program is, by its served form (served/forms.ts ServedMemberForm), a live read of a
 * set or an ordered one, by its key's fields, paged by window, a read at its call's instant alone, a write of the
 * relations it writes, or a refresh of its targets.
 */
const summaryOf = (member: ServedMember, deed: Deed): string => {
	switch (member.kind) {
		case "read":
			return member.read.key.kind === "set" ? "A live set read" : "A live ordered read"
		case "key":
			return `A live ${member.read.key.kind === "set" ? "set" : "ordered"} read by its key ${listed(member.fields)}`
		case "paged":
			return "A live ordered read paged by window"
		case "instant":
			return member.read.key.kind === "set"
				? "A set read at the call's instant"
				: "An ordered read at the call's instant"
		case "change":
			return `A write${relationWords(deed)}`
		case "refresh":
			return `A refresh${relationWords(deed)}`
	}
}

/** A parameter as an input's description names it: its name, a relation parameter's marked as a relation's facts. */
const paramWords = (param: WireParam<ServedLeaf>): string =>
	param.param.kind === "scalar" ? param.name : `${param.name} (a relation's facts)`

/** The words of an op of a ChangeSet's facts on its relation. */
const factWords = (facts: WireFacts<ServedLeaf>): string => {
	switch (facts.op) {
		case "insert":
			return `insert into ${facts.relation}`
		case "delete":
			return `delete from ${facts.relation}`
		case "put":
			return `put into ${facts.relation}`
	}
}

/**
 * A request body's description, read off its program's input (live/shape.ts WireInput): the parameters its program
 * declares, by name, then the facts a ChangeSet's array members take from the call, by op and relation, or a page's
 * window.
 */
const inputDescription = (input: WireInput<ServedLeaf>): string => {
	const params =
		input.params.length === 0 ? "no params" : `the params ${listed(input.params.map(paramWords))}`
	switch (input.kind) {
		case "call":
			return `The call's input: ${params}; ${
				input.facts.length === 0 ? "no facts" : `the facts to ${listed(input.facts.map(factWords))}`
			}.`
		case "window":
			return `The call's input: ${params}; no facts; and the window of its page, an anchor and a size.`
	}
}

/**
 * The operation of one member of `role` in `file`'s document: its shape read off its served form, as generate read its
 * wire, whose digest its request names in its one header, and which its `x-grizzle-wire` carries for a client; its
 * summary, what its program is, and its body's description, what its input holds.
 */
const operationOf = (
	file: ServedFile,
	role: ServedRoleForm,
	member: ServedMember
): Result.Result<Operation, CompileError> =>
	Result.map(memberShape(member, role), (shape): Operation => {
		const operationId = `${role.name}.${member.name}`
		const items = eventsOf(shape, operationId)
		const deed = deedOf(member, shape)
		return {
			path: `/${file.login}/${role.name}/${member.name}`,
			operation: {
				operationId,
				summary: summaryOf(member, deed),
				tags: [role.name],
				security: readsContext(role) ? [{ [bearer]: [] }] : [],
				parameters: [
					{
						in: "header",
						name: wireHeader,
						description: `The digest of the program's wire form, as x-grizzle-wire states it: a call naming none is answered ${wireRefusals.absent}, and one naming another form ${wireRefusals.other}, so no client decodes by a form the server no longer serves.`,
						required: true,
						schema: { type: "string", const: member.wire.digest }
					}
				],
				requestBody: {
					description: inputDescription(shape.input),
					required: true,
					content: {
						"application/json": {
							schema: inputSchema(
								shape.input,
								`urn:grizzle:${file.login}:${role.name}:${member.name}`,
								leafSchema
							)
						}
					}
				},
				responses: {
					"200": {
						description: `The ${shape.shape} answer of ${operationId}: its events, then its end`,
						content: {
							"text/event-stream": {
								itemSchema: {
									oneOf: items.map(([, component]) => ({
										$ref: `#/components/schemas/${component}`
									})),
									discriminator: {
										propertyName: "event",
										mapping: Object.fromEntries(
											items.map(([name, component]) => [name, `#/components/schemas/${component}`])
										)
									}
								}
							}
						}
					}
				},
				"x-grizzle-wire": { digest: member.wire.digest, member: member.wire.member }
			},
			events: items.map(([, component, schema]) => [component, schema]),
			program: { name: member.name, deed }
		}
	})

/** The relations `deeds` name, each once, in their order. */
const relationsOf = (deeds: ReadonlyArray<Deed>): ReadonlyArray<string> => [
	...new Set(deeds.flatMap((deed) => (deed.kind === "reads" ? [] : deed.relations)))
]

/**
 * A role's tag description, read off its served form and its programs' deeds: the programs it reads by, the relations
 * it writes and the programs it writes them by, the relations it refreshes and the programs it refreshes them by; and
 * whether its calls need a bearer token, with the contexts it reads from the token's claims.
 */
const roleDescription = (
	role: ServedRoleForm,
	programs: ReadonlyArray<Operation["program"]>
): string => {
	const serves = (["reads", "writes", "refreshes"] as const).flatMap((verb) => {
		const mine = programs.filter((program) => program.deed.kind === verb)
		const relations = relationsOf(mine.map((program) => program.deed))
		return mine.length === 0
			? []
			: [
					`it ${verb}${relations.length === 0 ? "" : ` ${listed(relations)}`} by ${listed(
						mine.map((program) => program.name)
					)}`
				]
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
	return `Role ${role.name}: ${serves.length === 0 ? "it serves no program" : serves.join("; ")}. ${token}`
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

/**
 * The OpenAPI 3.2 document of a login's served file (see the module's header): its info naming the login, the level it
 * is over and the snapshot fingerprint it serves, a tag per role describing it, an operation per program of each role,
 * every event's schema a component, and the bearer scheme a role that reads a context is called under, declared
 * exactly where one does. A member whose wire shape is refused refuses it.
 */
const openApiDocument = (file: ServedFile): Result.Result<Json, CompileError> => {
	const operations: Array<Operation> = []
	const tags: Array<Json> = []
	for (const role of file.roles) {
		const own: Array<Operation> = []
		for (const member of role.members) {
			const operation = operationOf(file, role, member)
			if (!operation.ok) {
				return operation
			}
			own.push(operation.value)
		}
		operations.push(...own)
		tags.push({
			name: role.name,
			description: roleDescription(
				role,
				own.map((o) => o.program)
			)
		})
	}
	return Result.ok({
		openapi: openApiVersion,
		info: {
			title: file.login,
			version: file.fingerprint,
			description: `The programs login ${file.login} serves over ${file.base}: one operation per program of each of its roles, ${listed(file.roles.map((role) => role.name))}.`,
			"x-grizzle-login": file.login
		},
		tags,
		paths: Object.fromEntries(operations.map((o) => [o.path, { post: o.operation }])),
		components: Object.fromEntries([
			["schemas", Object.fromEntries(operations.flatMap((o) => o.events))],
			...securitySchemes(file)
		])
	})
}

/** The document's text: canonical JSON, keys in code-unit order, and a final newline, as a served file's. */
export const openApiText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(openApiDocument(file), (document) =>
		Result.map(writeCanonicalJson(document), (text) => `${text}\n`)
	)
