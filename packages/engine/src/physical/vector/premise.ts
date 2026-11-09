import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { Owned } from "#compiler/schema/own.ts"

/** Whether a field is a vector, directly or as a contract's base. */
const isVectorDesc = (desc: FieldDesc): boolean =>
	desc.kind === "vector" || (desc.kind === "contract" && isVectorDesc(desc.base))

/** Whether a schema declares a vector field anywhere: a stored or closed relation's heading. A derived relation's
 * fields are inferred from a definition over those relations, so it stores a vector only when one of them does. */
export const schemaUsesVectors = (owned: Owned): boolean =>
	Object.values(owned.relations).some((r) =>
		Object.values(r.fields).some((f) => isVectorDesc(f.desc))
	)
