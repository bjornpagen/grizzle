import { topoOrder } from "#compiler/ir/dag.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import { type ParamDecl, paramColumns } from "#compiler/ir/products.ts"
import { exprsOf, type RelDag } from "#compiler/ir/rel.ts"
import { isVectorType, vectorExtension } from "#compiler/physical/vector/storage.ts"
import type { Owned } from "#compiler/schema/own.ts"

interface ExtensionPremise {
	readonly extensions: ReadonlyArray<string>
	readonly extensionSchemas: Readonly<Record<string, string>>
}

const noExtensions: ExtensionPremise = { extensions: [], extensionSchemas: {} }

const vectorPremise = (vectorSchema: string): ExtensionPremise => ({
	extensions: [vectorExtension.name],
	extensionSchemas: { [vectorExtension.name]: vectorSchema }
})

/** Whether a compiled query names a vector anywhere: a node's heading, a scalar expression's type (a distance over a
 * projected-away vector column, a vector literal), or a parameter. */
const queryUsesVectors = (dag: RelDag, params: ReadonlyArray<ParamDecl>): boolean => {
	const nodes = topoOrder(dag)
	return (
		nodes.some((n) => n.heading.some((c) => isVectorType(c.type))) ||
		exprClosure(nodes.flatMap((n) => exprsOf(n))).some((e) => isVectorType(e.type)) ||
		params.some((p) => paramColumns(p).some((c) => isVectorType(c.type)))
	)
}

/** The extension premise of one template's statements.
 *
 * The extension-schema premise of a template (`TemplateRequirements`). Every vector type, cosine_distance and comparison a template emits is qualified by the schema the installation
 * names for the extension, `vector_ext` on the local cluster. The SQL text therefore rests on that schema
 * as on any other premise:
 *
 * a template whose statements name a vector records the requirement `extensions: ["vector"]` and
 * `extensionSchemas: { vector: <ext> }`, which admission checks against the installation it runs on. */
export const queryExtensionPremise = (
	dag: RelDag,
	params: ReadonlyArray<ParamDecl>,
	vectorSchema: string
): ExtensionPremise => (queryUsesVectors(dag, params) ? vectorPremise(vectorSchema) : noExtensions)

/** Whether a field is a vector, directly or as a contract's base. */
const isVectorDesc = (desc: FieldDesc): boolean =>
	desc.kind === "vector" || (desc.kind === "contract" && isVectorDesc(desc.base))

/** Whether a schema declares a vector field anywhere: a stored or closed relation's heading. A derived relation's
 * fields are inferred from a definition over those relations, so it stores a vector only when one of them does. */
export const schemaUsesVectors = (owned: Owned): boolean =>
	Object.values(owned.relations).some((r) =>
		Object.values(r.fields).some((f) => isVectorDesc(f.desc))
	)
