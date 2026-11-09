import { generatedFieldLaws, lawDescription } from "#compiler/analysis/theory/description.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { StatementDesc } from "#compiler/ir/desc.ts"
import { compileLaws, type LawModel } from "#compiler/laws/model/model.ts"
import { fieldPatternLaws } from "#compiler/physical/ddl/domains.ts"
import { parseBuiltSchema } from "#compiler/program/schema.ts"
import { canonicalStatementText, own } from "#compiler/schema/own.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { expansionDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

/** A law at its position in lawsOf's list. */
interface PlacedLaw {
	readonly position: number
	readonly law: Law
}

/**
 * A schema's laws, derived once from its law model: every law in the schema's canonical order of laws, and each owned
 * statement's laws, by the statement's canonical text (Owned.statementAt), each at its position in that order, none for
 * a statement that states no law. The one derivation lawsOf and lawsByStatement read.
 */
interface SchemaLaws {
	readonly laws: ReadonlyArray<Law>
	readonly byStatement: ReadonlyMap<string, ReadonlyArray<PlacedLaw>>
}

/**
 * The law model of a schema built by schema(...) or schema.extend, compiled for `operation`: CompileError, thrown, for
 * any other value, a role's included, and for a schema that does not compile.
 */
const lawModelOf = (schema: AnySchema, operation: string): LawModel =>
	orThrow(
		Result.flatMap(parseBuiltSchema(schema, captureLoc(operation, [])), (built) =>
			Result.flatMap(own(built.desc), compileLaws)
		)
	)

/**
 * The theory's laws in theory order, each described as an outcome describes it, each owned statement's beside it as
 * its normalization merged them (analysis/theory/laws.ts KeptLaw); then each stored field's pattern law and each
 * generated field's law, which no statement states.
 */
const schemaLaws = (model: LawModel): SchemaLaws => {
	const theory = model.theory.laws.map((law, position) => ({
		placed: Object.freeze({ position, law: lawDescription(law) }),
		statements: law.statements
	}))
	const stated = Map.groupBy(
		theory.flatMap((t) => t.statements.map((statement) => ({ statement, placed: t.placed }))),
		(s) => s.statement
	)
	return {
		laws: Object.freeze([
			...theory.map((t) => t.placed.law),
			...fieldPatternLaws(model).map((p) => p.law),
			...generatedFieldLaws([...model.relations.values()].map((r) => r.relation)).map((g) => g.law)
		]),
		byStatement: new Map(
			[...model.owned.statementAt].map(([text, statement]) => [
				text,
				Object.freeze((stated.get(statement) ?? []).map((s) => s.placed))
			])
		)
	}
}

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
export const lawsOf = (schema: AnySchema): ReadonlyArray<Law> =>
	schemaLaws(lawModelOf(schema, "lawsOf")).laws

/** What a statement given to lawsByStatement's lookup must be. */
const aStatedStatement =
	"a statement the schema states: one built by key, mutable, check, contained, mirrors, alternatives, ordered, counted, tree or fold, which a level of the schema states"

/** The statements a statement value is owned as: a mirrors' two containments, any other statement itself. */
const ownedAs = (statement: unknown): NonEmptyReadonlyArray<StatementDesc> => {
	const expansion = expansionDescOf(statement)
	if (expansion !== undefined) {
		return expansion.statements
	}
	const desc = statementDescOf(statement)
	if (desc === undefined) {
		throw malformed("lawsByStatement", aStatedStatement)
	}
	return [desc]
}

/** The laws of the owned statement `desc` is, by its canonical text; refused when no level of the schema states it. */
const placedOf = (
	byStatement: SchemaLaws["byStatement"],
	desc: StatementDesc
): ReadonlyArray<PlacedLaw> => {
	const placed = byStatement.get(canonicalStatementText(desc))
	if (placed === undefined) {
		throw malformed("lawsByStatement", aStatedStatement)
	}
	return placed
}

/**
 * lawsByStatement(schema): the laws each statement of a schema built by schema(...) or schema.extend states, compiled
 * once, as a lookup: `lawsByStatement(schema)(statement)` is the laws `statement` states, each one lawsOf(schema) lists,
 * in lawsOf's order, read from the same derivation: a key's, a check's, a containment's, a family's, a tree's and a
 * fold's one law, a mirrors' two containments, an alternatives law's containments, and none for a mutable. A law two
 * statements state is each one's, such as a span primary key's law and a key over its fields.
 *
 * A statement is its canonical form, as the schema keeps it, so an equal statement built again is the same statement,
 * at whatever level the schema states it. lawsByStatement throws CompileError for a value lawsOf refuses, and the lookup
 * for a statement the schema does not state: a value no statement builder made, or a statement no level of the schema
 * states (MalformedDescription). Each call of lawsByStatement compiles the schema's laws; a lookup compiles nothing.
 */
export const lawsByStatement = <S extends AnySchema>(
	schema: S
): ((statement: S["statements"][number]) => ReadonlyArray<Law>) => {
	const { byStatement } = schemaLaws(lawModelOf(schema, "lawsByStatement"))
	return (statement) =>
		Object.freeze([
			...new Map(
				ownedAs(statement)
					.flatMap((desc) => placedOf(byStatement, desc))
					.toSorted((a, b) => a.position - b.position)
					.map((p) => [p.position, p.law] as const)
			).values()
		])
}
