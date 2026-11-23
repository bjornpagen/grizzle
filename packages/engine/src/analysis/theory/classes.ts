import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { FieldId } from "#compiler/core/ids.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import type { CompatibilityClass } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

export interface ClassMember {
	readonly field: FieldId
	readonly type: ScalarType
}

/**
 * A compatibility class: its fields, sorted, a representative type, its first member's, whose base carrier every member
 * shares (scalar/compute/types.ts sameCarrier), and each member's own type with its contracts and refinements.
 */
export interface FieldClass extends CompatibilityClass {
	readonly fields: ReadonlyArray<FieldId>
	readonly representative: ScalarType
	readonly members: ReadonlyArray<ClassMember>
}

/** Class members in field order. */
const byField = mapInput(compareStrings, (m: ClassMember) => m.field)

/** One field in the union-find forest. */
class FieldNode {
	readonly field: FieldId
	readonly type: ScalarType
	/** The next node toward its class's root; a root is its own parent. */
	parent: FieldNode = this
	/** The size of its class, kept on the root. */
	size = 1

	constructor(field: FieldId, type: ScalarType) {
		this.field = field
		this.type = type
	}

	/** The root of the node's class, halving the path to it. */
	root(): FieldNode {
		if (this.parent === this) {
			return this
		}
		const grand = this.parent.parent
		this.parent = grand
		return grand.root()
	}
}

/**
 * Field-compatibility classes.
 *
 * Union-find over the admitted pairings: the i-th field of a contained side is paired with the i-th field of the
 * other side, a family's group with its owner's key, a fold's step value with its accumulators and ends, and a tree's
 * start with its end. The structure is near-linear, O((F + L) α(F)), with union by size and path halving.
 *
 * Each pairing states what its two fields share (`meets`): a containment's their base carrier, one SQL type once their
 * contracts are stripped (scalar/compute/types.ts sameCarrier), since a refinement only narrows the values and the
 * inclusion is one law under the base's equality; a family's, a fold's and a tree's their nominal identity, contract
 * and closed roster included (compatible). So every member of a class shares its base carrier. Two fields a pairing
 * does not admit never pair: the compiler never adds a cast to make them join, so such a pairing is refused. Contracts
 * and refinements stay per member and are not merged: natural and pg.bigint, or two text fields, can admit different
 * value subsets, and a numeric typmod does not change identity. A key determines values; it never merges classes by
 * itself.
 */
export class FieldClasses {
	readonly #nodes = new Map<FieldId, FieldNode>()

	add(field: FieldId, type: ScalarType): void {
		this.#node({ field, type })
	}

	/** The node of a field, made at its type the first time the field is added or paired. */
	#node(member: ClassMember): FieldNode {
		const known = this.#nodes.get(member.field)
		if (known !== undefined) {
			return known
		}
		const node = new FieldNode(member.field, member.type)
		this.#nodes.set(member.field, node)
		return node
	}

	/** Pairs two fields, each at its column's type, where `meets` admits their types: whether they were paired. */
	union(a: ClassMember, b: ClassMember, meets: (x: ScalarType, y: ScalarType) => boolean): boolean {
		const na = this.#node(a)
		const nb = this.#node(b)
		if (!meets(na.type, nb.type)) {
			return false
		}
		const ra = na.root()
		const rb = nb.root()
		if (ra !== rb) {
			const [big, small] = ra.size >= rb.size ? [ra, rb] : [rb, ra]
			small.parent = big
			big.size += small.size
		}
		return true
	}

	/** Every class, each with its fields sorted, in order of its first field. */
	classes(): ReadonlyArray<FieldClass> {
		const groups = new Map<FieldNode, [FieldNode, ...Array<FieldNode>]>()
		for (const node of this.#nodes.values()) {
			const root = node.root()
			const group = groups.get(root)
			if (group === undefined) {
				groups.set(root, [node])
			} else {
				group.push(node)
			}
		}
		return [...groups.values()]
			.map((nodes) => {
				const members: [ClassMember, ...Array<ClassMember>] = [
					...mapNonEmpty(nodes, (n) => Object.freeze({ field: n.field, type: n.type }))
				]
				members.sort(byField)
				const first = members[0]
				const cls: FieldClass = Object.freeze({
					fields: Object.freeze(members.map((m) => m.field)),
					representative: first.type,
					members: Object.freeze(members)
				})
				return { first: first.field, cls }
			})
			.toSorted((x, y) => (x.first < y.first ? -1 : 1))
			.map(({ cls }) => cls)
	}
}
