import type { FieldId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import type { CompatibilityClass } from "#compiler/ir/products.ts"
import { type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { compatible } from "#compiler/scalar/compute/types.ts"

export interface ClassMember {
	readonly field: FieldId
	readonly type: ScalarType
}

/**
 * A compatibility class: its fields, sorted, a representative type, its first member's, whose identity every member
 * shares (scalar/compute/types.ts compatible), and each member's own type with its refinements.
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
 * Union-find over the admitted containment pairings: the i-th field of a contained or capacity side is paired
 * with the i-th field of the other side, and an alternatives expansion pairs its discriminator with its roster's handle
 * (its head containment) and each arm's key with the parent's key. The structure is near-linear, O((F + L) α(F)),
 * with union by size and path halving.
 *
 * A class keeps the nominal identity its members share: carrier, contract identity, closed roster identity, vector
 * dimensions, and span endpoint identity (scalar/compute/types.ts compatible). Two fields of different
 * identity never pair: the compiler never adds a cast to make incompatible fields join, so such a pairing
 * is refused. Refinements stay per member and are not merged: two compatible text fields can admit different value
 * subsets, and a numeric typmod or a serial declaration does not change identity. A key determines
 * values; it never merges classes by itself.
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

	/** Pairs two fields, each at its column's type, or says why they cannot be paired. */
	union(a: ClassMember, b: ClassMember): string | undefined {
		const na = this.#node(a)
		const nb = this.#node(b)
		if (!compatible(na.type, nb.type)) {
			return `fields of one identity (carrier, contract and closed roster); ${typeLabel(na.type)} against ${typeLabel(nb.type)}`
		}
		const ra = na.root()
		const rb = nb.root()
		if (ra === rb) {
			return undefined
		}
		const [big, small] = ra.size >= rb.size ? [ra, rb] : [rb, ra]
		small.parent = big
		big.size += small.size
		return undefined
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
