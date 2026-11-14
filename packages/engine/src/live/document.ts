/**
 * A login's wire as its OpenAPI document carries it (live/openapi.ts), read back for a client: each role's witness
 * (live/shape.ts RoleWitness) under the document's root `x-grizzle-wire`, and each operation's wire (OperationWire)
 * under its own `x-grizzle-wire`, every node the document shares written once in the root's table, `shared`, and
 * referenced everywhere else as a JSON Reference into it, `{"$ref": "#/x-grizzle-wire/shared/<index>"}`
 * (core/share.ts). No wire record holds a `$ref` of its own, so a record of that one member is a reference.
 *
 * Runtime-free and browser-safe: a client reads the document once, trusting it as grizzle's own file.
 */
import { defect, defined } from "#compiler/core/invariant.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { MemberWire, RoleWitness } from "#compiler/live/shape.ts"
import type { WireScalar } from "#compiler/live/wire.ts"

/** The extension a document carries its wire under, at its root and in each operation. */
export const wireExtension = "x-grizzle-wire"

/** The member of a JSON Reference. */
export const referenceKey = "$ref"

/** The pointer of the document's table of shared wire nodes, before an entry's index. */
const sharedPointer = `#/${wireExtension}/shared/`

/** The reference to the shared wire node at index `at` of the document's table. */
export const wireReference = (at: number): string => `${sharedPointer}${at}`

/** The document's root wire: each role's (live/member.ts RoleWire), by name, and the table of shared nodes. */
interface RootWire {
	readonly roles: { readonly [role: string]: { readonly witness: unknown } }
	readonly shared: ReadonlyArray<unknown>
}

/** The parts of a login's document a client reads: the login's name, its root wire, and each operation's wire. */
interface WiredDocument {
	readonly info: { readonly "x-grizzle-login": string }
	readonly [wireExtension]: RootWire
	readonly paths: {
		readonly [path: string]: {
			readonly post: {
				readonly [wireExtension]: { readonly digest: string; readonly member: unknown }
			}
		}
	}
}

/** The index a reference to the document's table names, or none for a record that is no reference. */
const referenced = (record: Readonly<Record<string, unknown>>): number | undefined => {
	const keys = Object.keys(record)
	const target = record[referenceKey]
	if (keys.length !== 1 || typeof target !== "string") {
		return undefined
	}
	if (!target.startsWith(sharedPointer)) {
		throw defect(`a wire reference into ${sharedPointer}, not ${target}`)
	}
	return Number(target.slice(sharedPointer.length))
}

/** A wire node with each reference standing for the table's entry it names, each entry read before any reading it. */
const resolved = (node: unknown, table: ReadonlyArray<unknown>): unknown => {
	if (isList(node)) {
		return node.map((item) => resolved(item, table))
	}
	if (!isPlainRecord(node)) {
		return node
	}
	const at = referenced(node)
	if (at !== undefined) {
		return defined(table[at], `the document's wire table holds entry ${at} before any reading it`)
	}
	const out: Record<string, unknown> = {}
	for (const [key, member] of Object.entries(node)) {
		out[key] = resolved(member, table)
	}
	return out
}

/** An operation's wire as its document carries it (live/member.ts ServedWire): its digest and its member's shape. */
export interface OperationWire {
	readonly digest: string
	readonly member: MemberWire
}

/**
 * A login's wire as a client reads it from its document: the login's name, each role's witness and each operation's
 * wire.
 */
export interface DocumentWire {
	readonly login: string
	readonly roles: ReadonlyMap<string, RoleWitness<WireScalar>>
	readonly operations: ReadonlyArray<readonly [string, OperationWire]>
}

/**
 * The wire of a login's document (see the module's header): its table read in order, each entry over the entries
 * before it, so each shared node is one object, then each role's witness and each operation's wire, by its path,
 * trusted as the document `grizzle generate` wrote.
 */
export const documentWire = (document: unknown): DocumentWire => {
	const read = trusted<WiredDocument>(document)
	const root = read[wireExtension]
	const table: Array<unknown> = []
	for (const entry of root.shared) {
		table.push(resolved(entry, table))
	}
	return {
		login: read.info["x-grizzle-login"],
		roles: new Map(
			Object.entries(root.roles).map(([role, wire]) => [
				role,
				trusted<RoleWitness<WireScalar>>(resolved(wire.witness, table))
			])
		),
		operations: Object.entries(read.paths).map(([path, operation]) => {
			const wire = operation.post[wireExtension]
			return [
				path,
				{ digest: wire.digest, member: trusted<MemberWire>(resolved(wire.member, table)) }
			]
		})
	}
}
