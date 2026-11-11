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
import { type EventDescriptor, events, type Retry, type Role } from "#compiler/live/events.ts"
import { memberShape, memberWire, type ServedLeaf, wireScalarOf } from "#compiler/live/member.ts"
import { inputSchema, type MemberShape, slotSchemas } from "#compiler/live/shape.ts"
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

/** The extension a stream's event carries for its consumer (`x-stream`): what an event of each role is to the stream. */
const streamRole = (
	role: Role,
	descriptor: EventDescriptor
): ReadonlyArray<readonly [string, Json]> => {
	switch (role) {
		case "item":
			return []
		case "ready":
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

/** One program's operation, and the schemas of its events, by their components' names. */
interface Operation {
	readonly path: string
	readonly operation: WireSchema
	readonly events: ReadonlyArray<readonly [string, WireSchema]>
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

/** The operation of one member of `role` in `file`'s document. */
const operationOf = (
	file: ServedFile,
	role: ServedRoleForm,
	member: ServedMember
): Result.Result<Operation, CompileError> =>
	Result.flatMap(memberShape(member, role), (shape) =>
		Result.map(memberWire(member, role), (wire): Operation => {
			const operationId = `${role.name}.${member.name}`
			const items = eventsOf(shape, operationId)
			return {
				path: `/${file.login}/${role.name}/${member.name}`,
				operation: {
					operationId,
					tags: [role.name],
					security: role.contexts.length === 0 ? [] : [{ [bearer]: [] }],
					requestBody: {
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
												items.map(([name, component]) => [
													name,
													`#/components/schemas/${component}`
												])
											)
										}
									}
								}
							}
						}
					},
					"x-grizzle-wire": { digest: wire.digest, member: wire.member }
				},
				events: items.map(([, component, schema]) => [component, schema])
			}
		})
	)

/**
 * The OpenAPI 3.2 document of a login's served file (see the module's header): its info naming the login and the
 * snapshot fingerprint it serves, an operation per program of each role, every event's schema a component, and the
 * bearer scheme a role that reads a context is called under. A member whose wire shape is refused refuses it.
 */
export const openApiDocument = (file: ServedFile): Result.Result<Json, CompileError> => {
	const operations: Array<Operation> = []
	for (const role of file.roles) {
		for (const member of role.members) {
			const operation = operationOf(file, role, member)
			if (!operation.ok) {
				return operation
			}
			operations.push(operation.value)
		}
	}
	return Result.ok({
		openapi: openApiVersion,
		info: { title: file.login, version: file.fingerprint, "x-grizzle-login": file.login },
		tags: file.roles.map((role) => ({ name: role.name })),
		paths: Object.fromEntries(operations.map((o) => [o.path, { post: o.operation }])),
		components: {
			schemas: Object.fromEntries(operations.flatMap((o) => o.events)),
			securitySchemes: { [bearer]: { type: "http", scheme: "bearer" } }
		}
	})
}

/** The document's text: canonical JSON, keys in code-unit order, and a final newline, as a served file's. */
export const openApiText = (file: ServedFile): Result.Result<string, CompileError> =>
	Result.flatMap(openApiDocument(file), (document) =>
		Result.map(writeCanonicalJson(document), (text) => `${text}\n`)
	)
