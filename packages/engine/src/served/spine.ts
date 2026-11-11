import { parentUse } from "#compiler/check/scan.ts"
import type { AttachDesc, QueryDesc, QueryStageDesc } from "#compiler/ir/desc.ts"
import {
	type ServedCarried,
	type ServedReadBack,
	type ServedSpine,
	servedRiddenSource,
	servedSource
} from "#compiler/served/read.ts"
import type { ReadBackCarried, ReadBackDelivery } from "#compiler/write/program/artifact.ts"

/**
 * A delivered spine as the walk builds it, its attachments merged by name in the order the walk met them: the served
 * spine itself, which no one changes once the walk returns it.
 */
interface Gathering {
	readonly under: Map<string, Gathering & { readonly heads: Set<string> }>
}

/**
 * The delivered spine of a Description (ServedSpine), from its root: each delivered attachment's child's head keys,
 * nested ones under theirs. An attachment of a heading group's arm is on that group's path, the root's; one inside an
 * imported query or an interior stage is read as its parent and delivers nothing, so only the delivered spine is
 * walked: the root's stage chain and its arms. A child's head keys are read with the checker's own walk (check/scan.ts
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
	return root
}

/**
 * How a delivered read-back's statement reaches the server, as the runtime reads it: sent, its program served
 * (servedSource); or riding the write statement at its position, its part at its tag, its parts read only
 * (servedRiddenSource).
 */
const servedCarried = (carried: ReadBackCarried): ServedCarried =>
	carried.kind === "sent"
		? { kind: "sent", source: servedSource(carried.run) }
		: {
				kind: "riding",
				source: servedRiddenSource(carried.run),
				statement: carried.statement,
				tag: carried.tag,
				part: { kind: carried.part.kind, width: carried.part.width }
			}

/**
 * A compiled ChangeSet's read-backs as the runtime runs them, in its artifact's order: each its name, its query's
 * delivered spine and its statements as they reach the server.
 */
export const servedReadBacks = (
	readBacks: ReadonlyArray<ReadBackDelivery>
): ReadonlyArray<ServedReadBack> =>
	readBacks.map((delivery) => ({
		name: delivery.name,
		spine: servedSpine(delivery.query),
		carried: servedCarried(delivery.carried)
	}))
