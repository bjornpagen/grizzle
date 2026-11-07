import { Array as Arr } from "effect"
import type { AttachDesc, QueryDesc, QueryStageDesc } from "#compiler/plan/common.ts"
import { type NodeOf, parentUse } from "#compiler/plan/read.ts"

/**
 * Where a read's statements are on its delivered spine, which its Description states.
 *
 * Each attachment's delivered type is the one the template's analysis judged under the context the read runs in, which
 * every Attach node of a lowered program carries (rel.ts Attach judged), as TypeScript types it (Attached<Child, Ev>):
 * ReadonlyArray without evidence, Option when the child's bindings on the parent's variables cover a key of the child
 * relation, the child is take(1), or it is an aggregate whose group the parent fixes, and the bare child when a
 * containment proves exactly one. Its correlation is the child columns equated with parent columns.
 *
 * An attachment delivers its child query's head: the checker adds a correlation column to the
 * child for each parent variable the child reads, delivered under a head key when one delivers that variable and under
 * a fresh name clear of every head key otherwise (check/checker.ts attach). A correlation column no head key delivers
 * equals the parent's value and is not part of the delivered child, so the child's head keys are read from the query's
 * Description with the checker's own walk (check/scan.ts parentUse), per attachment along the delivered spine.
 *
 * Where a statement is on the delivered spine: the delivered attachments under it, by name, each with its child's head
 * keys and the attachments under it in turn.
 */
export interface AttachmentScope {
	readonly under: ReadonlyMap<string, AttachedHeads>
}

/** A delivered attachment on the spine: its child's head keys, and the delivered attachments under it. */
export interface AttachedHeads extends AttachmentScope {
	readonly heads: ReadonlySet<string>
}

/** A scope as the walk builds it, its attachments merged by name. */
interface Gathering {
	readonly under: Map<string, Gathering & { readonly heads: Set<string> }>
}

/**
 * The delivered spine of a Description, from its root: each delivered attachment's child's head keys, nested ones under
 * theirs. An attachment of a heading group's arm is on that group's path, the root's; one inside an imported query or
 * an interior stage is read as its parent and delivers nothing, so only the delivered spine is walked: the root's
 * stage chain and its arms.
 */
export const attachmentHeads = (desc: QueryDesc): AttachmentScope => {
	const root: Gathering = { under: new Map() }
	const visit = (a: AttachDesc, scope: Gathering): void => {
		const known = scope.under.get(a.name)
		const here: Gathering & { readonly heads: Set<string> } = known ?? {
			heads: new Set(),
			under: new Map()
		}
		scope.under.set(a.name, here)
		for (const k of parentUse(a.child).headKeys) {
			here.heads.add(k)
		}
		stage(a.child.stage, here)
	}
	const stage = (s: QueryStageDesc, scope: Gathering): void => {
		switch (s.kind) {
			case "rules":
				for (const arm of s.arms) {
					for (const a of arm.attach) {
						visit(a, scope)
					}
				}
				return
			case "union":
				stage(s.input, scope)
				for (const arm of s.arms) {
					for (const a of arm.attach) {
						visit(a, scope)
					}
				}
				return
			case "attach":
				stage(s.input, scope)
				visit(s.attach, scope)
				return
			case "named":
			case "order":
			case "take":
			case "approx":
				stage(s.input, scope)
				return
			case "recursive":
				return
		}
	}
	stage(desc.stage, root)
	return root
}

/**
 * Whether an attachment's delivered child carries the child column `column`: every child column but the correlation
 * columns no head key delivers. `scope` is where the attachment is on the delivered spine (attachmentHeads), none off
 * it. The attachment is the lowered program's own Attach node, whose correlation is the checker's.
 */
export const carried = (
	attach: NodeOf<"Attach">,
	scope: AttachmentScope | undefined,
	column: string
): boolean =>
	!Arr.some(attach.correlation, (c) => c.child === column) ||
	scope?.under.get(attach.name)?.heads.has(column) === true
