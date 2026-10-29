import { Array as Arr } from "effect"
import { parentUse } from "#compiler/check/scan.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { AttachDesc, QueryDesc, QueryStageDesc } from "#compiler/ir/desc.ts"
import type { NodeOf, RelDag } from "#compiler/ir/rel.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"

type Delivered = "array" | "option" | "one"

/**
 * What a read needs from the logical analysis of its query.
 *
 * A compiled template carries its checked query, whose metadata is the checker's conservative claim: card many and
 * every attachment delivered as an array ("Delivered types start at ReadonlyArray; analysis/logical narrows them by
 * evidence", check/checker.ts). The read delivers what the evidence proves, as TypeScript types it (Attached<Child,
 * Ev>), so it reads the template's analyzed DAG (QueryTemplate.analyzed): the checked query annotated once, at compile,
 * under the schema's laws and the context the read runs in, exactly as analysis/logical does for every other consumer:
 *
 * - the root's normative cardinality, which get requires to be atMostOne or one (eligibility.ts);
 * - each attachment's delivered type: ReadonlyArray without evidence, Option when the child's bindings on the parent's
 *   variables cover a key of the child relation, the child is take(1), or it is an aggregate whose group the parent
 *   fixes, and the bare child when a containment proves exactly one; and its correlation, the child
 *   columns equated with parent columns.
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

export interface AttachmentFacts {
	/**
	 * The delivered type of an attachment, by the label of its Attach node: total over the attachments of the analyzed
	 * DAG (QueryTemplate.analyzed, a write's analyzed DAG); a label it does not hold is a defect.
	 */
	readonly delivered: (attach: NodeId, name: string) => Delivered
	/** The delivered spine's root, where a program's delivered statements are. */
	readonly root: AttachmentScope
	/**
	 * The child columns of an attachment that its delivered child carries: every child column but the correlation
	 * columns no head key delivers. `scope` is where the attachment `name` is on the delivered spine, none off it.
	 */
	readonly carried: (
		attach: NodeId,
		scope: AttachmentScope | undefined,
		name: string,
		column: string
	) => boolean
}

/**
 * The attachment facts over an analyzed DAG and a Description's delivered spine. A lowered program names its
 * attachments by label, and the analyzed DAG is another form of the query, so each is read through the analyzed DAG's
 * Attach nodes by label, gathered by one walk when the facts are built.
 */
export const analyzedAttachmentFacts = (
	analyzed: RelDag,
	spine: AttachmentScope
): AttachmentFacts => {
	const attaches = new Map<NodeId, NodeOf<"Attach">>()
	for (const node of topoOrder(analyzed)) {
		if (node.kind === "Attach") {
			attaches.set(node.id, node)
		}
	}
	/**
	 * The one site of the fact that every attachment a lowered program names is an Attach node of the analyzed DAG
	 * under its label: the lowering names it by id and label, runtime values no TypeScript type ties to the DAG's nodes,
	 * so a miss is a defect of the compiler.
	 */
	const attachNode = (id: NodeId, name: string): NodeOf<"Attach"> => {
		const n = attaches.get(id)
		if (n === undefined || n.name !== name) {
			throw defect(`the attachment ${name} at ${id} of the analyzed DAG`)
		}
		return n
	}
	return {
		delivered: (id, name) => attachNode(id, name).delivered,
		root: spine,
		carried: (id, scope, name, column) =>
			!Arr.some(attachNode(id, name).correlation, (c) => c.child === column) ||
			scope?.under.get(name)?.heads.has(column) === true
	}
}

/** The attachment facts of a template's query, over its analyzed DAG and its Description's head keys: built once by the
 * compiled read or page template that holds them. */
export const attachmentFacts = (template: QueryTemplate, desc: QueryDesc): AttachmentFacts =>
	analyzedAttachmentFacts(template.analyzed, attachmentHeads(desc))
