import { parentUse } from "#compiler/check/scan.ts"
import type { AttachDesc, QueryDesc, QueryStageDesc } from "#compiler/ir/desc.ts"
import type { ServedSpine, ServedSpineAttachment } from "#compiler/served/read.ts"

/** A delivered spine as the walk builds it, its attachments merged by name. */
interface Gathering {
	readonly under: Map<string, Gathering & { readonly heads: Set<string> }>
}

/** A gathered spine as the served form holds it, its attachments in the order the walk met them. */
const gatheredSpine = (scope: Gathering): ServedSpine => ({
	under: new Map(
		[...scope.under].map(([name, attached]): readonly [string, ServedSpineAttachment] => [
			name,
			{ heads: new Set(attached.heads), under: gatheredSpine(attached).under }
		])
	)
})

/**
 * The delivered spine of a Description (ServedSpine), from its root: each delivered attachment's child's head keys,
 * nested ones under theirs. An attachment of a heading group's arm is on that group's path, the root's; one inside an
 * imported query or an interior stage is read as its parent and delivers nothing, so only the delivered spine is walked:
 * the root's stage chain and its arms. A child's head keys are read with the checker's own walk (check/scan.ts
 * parentUse): a correlation column no head key delivers equals the parent's value and is not part of the delivered
 * child.
 */
export const servedSpine = (desc: QueryDesc): ServedSpine => {
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
	return gatheredSpine(root)
}
