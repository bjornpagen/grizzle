import { lawDescription } from "#compiler/analysis/theory/description.ts"
import { defined } from "#compiler/core/invariant.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { StatementDesc } from "#compiler/ir/desc.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { parseBuiltSchema } from "#compiler/program/schema.ts"
import { canonicalStatementText, own } from "#compiler/schema/own.ts"
import { orThrow } from "#compiler/schema/protocol.ts"
import { expansionDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"

/** A statement of a schema as it was declared, beside the laws an `invariant-rejected` outcome names for it. */
export interface StatementLaws<St extends Statement> {
	readonly statement: St
	readonly laws: ReadonlyArray<Law>
}

/** The statements a declared statement is owned as: a mirrors' two containments, any other statement itself. */
const ownedAs = (statement: Statement): ReadonlyArray<StatementDesc> => {
	const expansion = expansionDescOf(statement)
	return expansion === undefined
		? [
				defined(
					statementDescOf(statement),
					"a built schema's statement is a statement or a mirrors"
				)
			]
		: expansion.statements
}

/**
 * lawsOf(schema): every statement of a schema built by schema(...) or schema.extend, in its declared order, its base's
 * first, each beside the laws an `invariant-rejected` outcome names when that statement is broken (types/changeset
 * Law), in the schema's canonical order of laws: a key's, a check's, a containment's, a family's, a tree's and a fold's
 * one law, a mirrors' two containments, an alternatives law's containments, and none for a mutable. The laws are the
 * engine's own: the schema's law model compiled once (laws/model compileLaws), each law of its theory that a statement
 * states described as an outcome describes it (analysis/theory/description.ts lawDescription), so `sameLaw` holds of
 * a law here and the law an outcome names exactly when they are one law. A law two statements state is each one's. It
 * throws CompileError for any other value, a role's included, and for a schema that does not compile.
 */
export const lawsOf = <S extends AnySchema>(
	schema: S
): ReadonlyArray<StatementLaws<S["statements"][number]>> => {
	const { owned, theory } = orThrow(
		Result.flatMap(parseBuiltSchema(schema, captureLoc("lawsOf", [])), (built) =>
			Result.flatMap(own(built.desc), compileLaws)
		)
	)
	const described = theory.laws.map((law) => ({
		statements: law.statements,
		law: lawDescription(law)
	}))
	return Object.freeze(
		schema.statements.map((statement) => {
			const at = ownedAs(statement).map((desc) =>
				defined(
					owned.statementAt.get(canonicalStatementText(desc)),
					"ownership owns every statement a schema declares"
				)
			)
			return Object.freeze({
				statement,
				laws: Object.freeze(
					described.flatMap((d) => (d.statements.some((i) => at.includes(i)) ? [d.law] : []))
				)
			})
		})
	)
}
