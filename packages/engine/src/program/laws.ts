import { generatedFieldLaws, lawDescription } from "#compiler/analysis/theory/description.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { fieldPatternLaws } from "#compiler/physical/ddl/domains.ts"
import { parseBuiltSchema } from "#compiler/program/schema.ts"
import { own } from "#compiler/schema/own.ts"
import { orThrow } from "#compiler/schema/protocol.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

/**
 * lawsOf(schema): every law a schema built by schema(...) or schema.extend states, each once, exactly as an
 * `invariant-rejected` outcome names it (types/changeset Law), so `sameLaw` holds of a law here and a law an outcome
 * names exactly when they are one law, and every law an outcome over the schema names is one of these.
 *
 * In the schema's canonical order of laws, whatever order the schema declares its relations and statements in: the
 * theory's laws in theory order (each ordinary relation's primary key by relation name, then the statements' laws in
 * canonical statement order, then each contract's by contract name), each described as an outcome describes it
 * (analysis/theory/description.ts lawDescription); then each stored field's pattern law (physical/ddl/domains.ts
 * fieldPatternLaws); then each generated field's law (generatedFieldLaws); the last two by relation name and each
 * relation's fields in declared order. The installation reads its text domains' and generated columns' laws from those
 * same fields, so the two can never disagree. A law two statements state, such as a key that restates the primary
 * key, is listed once.
 *
 * It throws CompileError for any other value, a role's included, and for a schema that does not compile. Each call
 * compiles the schema's laws.
 */
export const lawsOf = (schema: AnySchema): ReadonlyArray<Law> => {
	const model = orThrow(
		Result.flatMap(parseBuiltSchema(schema, captureLoc("lawsOf", [])), (built) =>
			Result.flatMap(own(built.desc), compileLaws)
		)
	)
	return Object.freeze([
		...model.theory.laws.map(lawDescription),
		...fieldPatternLaws(model).map((p) => p.law),
		...generatedFieldLaws([...model.relations.values()].map((r) => r.relation)).map((g) => g.law)
	])
}
