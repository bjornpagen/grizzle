/**
 * Each repeated shape of a JSON value defined once and referenced: the one sharing every file grizzle writes for a
 * login holds to (served/json.ts for the served file, live/openapi.ts for the OpenAPI document), over the format that
 * file reads its nodes by (SharingFormat).
 *
 * A format names, for a container node, the positions a reference may stand at (its slots) and what besides them makes
 * the node the node it is (its frame). Two nodes of one frame and the same nodes in their slots are one node. A node
 * that stands in its slots more than once over the distinct nodes holding it, and whose canonical text is longer than
 * the reference that would stand in for it, is written once in the file's table and referenced everywhere else; a node
 * no longer than its reference is trivial, and stays where it stands. A node's children are decided before it, so a
 * table entry references only entries before it, and a load reads the table in order, each entry over those before it.
 *
 * Runtime-free: generate runs it once per file it writes.
 */
import type { Json } from "#compiler/core/canonical.ts"
import { defined } from "#compiler/core/invariant.ts"
import { isList } from "#compiler/core/record.ts"

/**
 * A container node as a format reads it: what of it besides its slots makes it the node it is, as text that with the
 * slots' count and order fixes the node (its frame), and the values standing in its slots, each a position a reference
 * may stand at.
 */
export interface Parts {
	readonly frame: string
	readonly slots: ReadonlyArray<Json>
}

/**
 * How one file reads its JSON nodes for sharing: a node's parts, none for a node no reference stands in for and no
 * slot holds; the node rebuilt with `slots` in its slots, in the order its parts gave them; and the reference to a node
 * written as `node` at index `at` of the file's table.
 */
export interface SharingFormat {
	readonly parts: (node: Json) => Parts | undefined
	readonly rebuild: (node: Json, slots: ReadonlyArray<Json>) => Json
	readonly reference: (node: Json, at: number) => Json
}

/** A table entry: a node written once, and the reference every other place it stood at holds. */
export interface SharedNode {
	readonly node: Json
	readonly reference: Json
}

/** The values shared (shareRepeated): each root as the file writes it, and the table its references index, in order. */
export interface SharedValues {
	readonly roots: ReadonlyArray<Json>
	readonly table: ReadonlyArray<SharedNode>
}

/** A distinct node: its first occurrence, the values in its slots, and the distinct node in each slot, none for a leaf. */
interface Distinct {
	readonly node: Json
	readonly slots: ReadonlyArray<Json>
	readonly children: ReadonlyArray<number | undefined>
}

/**
 * The length of a JSON value's canonical text (core/canonical.ts writeCanonicalJson: JSON.stringify's spelling of each
 * scalar and key, no whitespace), each node `known` holds counted by its known length.
 */
const canonicalLength = (json: Json, known: ReadonlyMap<object, number>): number => {
	if (typeof json !== "object") {
		return JSON.stringify(json).length
	}
	const counted = known.get(json)
	if (counted !== undefined) {
		return counted
	}
	if (isList(json)) {
		let length = 1 + Math.max(json.length, 1)
		for (const item of json) {
			length += canonicalLength(item, known)
		}
		return length
	}
	const members = Object.entries(json)
	let length = 1 + Math.max(members.length, 1)
	for (const [key, member] of members) {
		length += JSON.stringify(key).length + 1 + canonicalLength(member, known)
	}
	return length
}

/**
 * `roots` with each repeated shape defined once (see the module's header), as `format` reads their nodes: each root as
 * the file writes it, a reference where the root itself is shared, and the table, each entry's node over the entries
 * before it.
 */
export const shareRepeated = (roots: ReadonlyArray<Json>, format: SharingFormat): SharedValues => {
	const ids = new Map<string, number>()
	const read = new Map<object, number | undefined>()
	const distinct: Array<Distinct> = []
	const holders: Array<number> = []
	const idOf = (node: Json): number | undefined => {
		if (typeof node !== "object") {
			return undefined
		}
		if (read.has(node)) {
			return read.get(node)
		}
		const parts = format.parts(node)
		if (parts === undefined) {
			read.set(node, undefined)
			return undefined
		}
		const children = parts.slots.map(idOf)
		const slotKeys = parts.slots.map((slot, i) => {
			const child = children[i]
			return child === undefined ? JSON.stringify(slot) : `#${child}`
		})
		const key = `${parts.frame}\u0000${slotKeys.join(",")}`
		let id = ids.get(key)
		if (id === undefined) {
			id = distinct.length
			ids.set(key, id)
			distinct.push({ node, slots: parts.slots, children })
			holders.push(0)
			for (const child of children) {
				if (child !== undefined) {
					holders[child] = defined(holders[child], "a child's holder count") + 1
				}
			}
		}
		read.set(node, id)
		return id
	}
	const rootIds = roots.map(idOf)
	for (const id of rootIds) {
		if (id !== undefined) {
			holders[id] = defined(holders[id], "a root's holder count") + 1
		}
	}
	const written: Array<Json> = []
	const references: Array<Json | undefined> = []
	const lengths = new Map<object, number>()
	const table: Array<SharedNode> = []
	const standing = (id: number): Json =>
		references[id] ?? defined(written[id], "a node written before its holder")
	for (const [id, { node, slots, children }] of distinct.entries()) {
		const rebuilt = format.rebuild(
			node,
			slots.map((slot, i) => {
				const child = children[i]
				return child === undefined ? slot : standing(child)
			})
		)
		const length = canonicalLength(rebuilt, lengths)
		let reference: Json | undefined
		if (defined(holders[id], "a node's holder count") > 1) {
			const candidate = format.reference(rebuilt, table.length)
			if (length > canonicalLength(candidate, lengths)) {
				reference = candidate
				table.push({ node: rebuilt, reference: candidate })
			}
		}
		written.push(rebuilt)
		references.push(reference)
		if (typeof rebuilt === "object") {
			lengths.set(rebuilt, length)
		}
	}
	return {
		roots: roots.map((root, i) => {
			const id = rootIds[i]
			return id === undefined ? root : standing(id)
		}),
		table
	}
}
