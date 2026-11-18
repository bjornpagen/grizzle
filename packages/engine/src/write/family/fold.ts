/** The compile side of a nesting's fill (runtime/write/fill.ts): where a nesting's walk starts. */
import { type Family, isTreeOf } from "#compiler/ir/family.ts"
import type { FillPosition } from "#compiler/ir/fill.ts"

/** Where a walk of a nesting of `relation` starts its root: a tree's root where `relation` is a tree's, else the
 * ChangeSet's own row. */
export const walkStart = (families: ReadonlyArray<Family>, relation: string): FillPosition => {
	const tree = families.find((f) => isTreeOf(f, relation))
	return tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
}
