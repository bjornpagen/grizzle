import { accumulated, closedId, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"

/**
 * The relations the generic-source agreement's helpers are generic over (test/support/agreement/generic-sources.ts),
 * by family, each of relations of one heading, one that holds that heading and a field more, and ones that hold every
 * field but one at a carrier no other carrier of that field is assignable to or from; and the relations their
 * statements read beside them. A drawn or accumulated field is named by the family or fold of each statement over its
 * relation, so each relation is one a schema admits beside those statements.
 */
export const Kind = closed("Kind", ["a", "b"])
export const Other = closed("Other", ["x", "y"])

/** The members' one heading: a key, a reference, a closed id and a number. */
const heading = { id: uuid, owner: uuid, kind: closedId(Kind), n: pg.integer } as const

export const A = relation("A", heading, ["id"])
export const B = relation("B", heading, ["id"])
export const W = relation("W", { ...heading, extra: uuid }, ["id"])
export const MOwner = relation("MOwner", { ...heading, owner: pg.integer }, ["id"])
export const MKind = relation("MKind", { ...heading, kind: closedId(Other) }, ["id"])
export const MN = relation("MN", { ...heading, n: pg.bigint }, ["id"])

/** The indexed members' one heading: a reference to an owner and a drawn index. */
const indexedHeading = { id: uuid, owner: uuid, at: drawn(natural) } as const

export const IA = relation("IA", indexedHeading, ["id"])
export const IB = relation("IB", indexedHeading, ["id"])
export const IM = relation("IM", { ...indexedHeading, at: pg.integer }, ["id"])

/** The owners' one heading: a key and the count a family draws. */
const slotsHeading = { id: uuid, k: drawn(natural) } as const

export const Slots = relation("Slots", slotsHeading, ["id"])
export const Slots2 = relation("Slots2", slotsHeading, ["id"])
export const SlotsM = relation("SlotsM", { ...slotsHeading, k: pg.integer }, ["id"])

/** An owner whose count fold folds its family's count into `size`. */
export const Folded = relation(
	"Folded",
	{ id: uuid, k: drawn(natural), size: accumulated(natural, 0n) },
	["id"]
)

/** A relation a reference is contained in, and an arm keyed as the members are. */
export const Target = relation("Target", { id: uuid }, ["id"])
export const Arm = relation("Arm", { id: uuid }, ["id"])

/** The trees' one heading: a self-parented tree's parent, its drawn index, count and interval, and its root field. */
const treeHeading = {
	id: uuid,
	parent: uuid,
	at: drawn(natural),
	children: drawn(natural),
	start: drawn(natural),
	end: drawn(natural),
	doc: uuid
} as const

export const T1 = relation("T1", treeHeading, ["id"])
export const T2 = relation("T2", treeHeading, ["id"])
export const TM = relation("TM", { ...treeHeading, doc: pg.integer }, ["id"])

/** The schema the agreement's queries are over: every member and the relation a join reads. */
export const Members = schema("Members", { Kind, Other, Target, A, B, W, MOwner, MKind, MN }, [])
