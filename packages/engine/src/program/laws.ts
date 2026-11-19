import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { generatedFieldLaws, lawDescription } from "#compiler/analysis/theory/description.ts"
import { sameContent } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { fieldPatternLaws, patternLawId, planTextDomains } from "#compiler/physical/ddl/domains.ts"
import { builtLawModel, parseBuiltSchema } from "#compiler/program/schema.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { statementTextsOf } from "#compiler/schema/statements.ts"
import type { IdentifiedLaw, OwnLaw } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema, StatementsOf } from "#compiler/types/schema/schema.ts"

/** A law at its position in lawsOf's list. */
interface PlacedLaw {
	readonly position: number
	readonly law: OwnLaw
}

/** A check law of a schema and a name it is installed under: a row check's CHECK, or a derived check's triggers'. */
interface CheckName {
	readonly law: Extract<OwnLaw, { readonly kind: "check" }>
	readonly name: string
}

/**
 * A schema's laws, derived once from its law model: every law in the schema's canonical order of laws with its
 * identity, each owned statement's laws, by the statement's canonical text (Owned.statementAt), each at its position in
 * that order, none for a statement that states no law, and each check law with the name of every constraint or trigger
 * that discharges it. The one derivation lawsOf, lawsByStatement and constraintNamesOf read.
 */
interface SchemaLaws {
	readonly laws: ReadonlyArray<IdentifiedLaw<OwnLaw>>
	readonly byStatement: ReadonlyMap<string, ReadonlyArray<PlacedLaw>>
	readonly checks: ReadonlyArray<CheckName>
}

/**
 * The law model of a schema built by schema(...) or schema.extend, every slice of it planned, the one its value holds
 * (program/schema.ts builtLawModel), whatever reads it: CompileError for any other value, a role's included, refused
 * at `operation`, the reader whose call it is, which labels the refusal alone; and the schema's own CompileError for a
 * schema that does not compile.
 */
export const lawModel = (
	schema: AnySchema,
	operation: string
): Result.Result<LawModel, CompileError> =>
	Result.flatMap(parseBuiltSchema(schema, captureLoc(operation, [])), builtLawModel)

/** The law model of a schema (lawModel), its CompileError thrown, as lawsOf and its siblings document. */
const lawModelOf = (schema: AnySchema, operation: string): LawModel =>
	orThrow(lawModel(schema, operation))

/** Each law model's laws (`schemaLaws`), derived once per model, as a built schema's model is made once
 * (program/schema.ts builtLawModel). */
const derived = new WeakMap<LawModel, SchemaLaws>()

/** A law model's laws (`derivedLaws`), derived where the model's laws are first read and held for it (`derived`). */
const schemaLaws = (model: LawModel): SchemaLaws => {
	const known = derived.get(model)
	if (known !== undefined) {
		return known
	}
	const made = derivedLaws(model)
	derived.set(model, made)
	return made
}

/**
 * The theory's laws in theory order, each described as an outcome describes it, each owned statement's beside it as
 * its normalization merged them (analysis/theory/laws.ts KeptLaw); then each stored field's pattern law and each
 * generated field's law, which no statement states. Each with the identity a refusal names it by: a theory law's own,
 * a pattern law's under the text domain its pattern's key is planned as (planTextDomains, patternLawId), as the
 * installation identifies it, and a generated field's.
 */
const derivedLaws = (model: LawModel): SchemaLaws => {
	const theory = model.theory.laws.map((law, position) => ({
		placed: Object.freeze({ position, law: lawDescription(law) }),
		id: law.id,
		statements: law.statements
	}))
	const domains = new Map(
		planTextDomains(model.owned, model.theory, []).map((p) => [p.key, p.domain.named] as const)
	)
	const stated = Map.groupBy(
		theory.flatMap((t) => t.statements.map((statement) => ({ statement, placed: t.placed }))),
		(s) => s.statement
	)
	return {
		laws: Object.freeze([
			...theory.map((t): IdentifiedLaw<OwnLaw> => Object.freeze({ law: t.placed.law, id: t.id })),
			...fieldPatternLaws(model).map((p): IdentifiedLaw<OwnLaw> =>
				Object.freeze({
					law: p.law,
					id: patternLawId(
						defined(
							domains.get(p.regex.key),
							"planTextDomains plans every stored field's pattern key"
						),
						p
					)
				})
			),
			...generatedFieldLaws([...model.relations.values()].map((r) => r.relation)).map(
				(g): IdentifiedLaw<OwnLaw> => Object.freeze({ law: g.law, id: g.id })
			)
		]),
		byStatement: new Map(
			[...model.owned.statementAt].map(([text, statement]) => [
				text,
				Object.freeze((stated.get(statement) ?? []).map((s) => s.placed))
			])
		),
		checks: model.constraints.flatMap((c) =>
			c.laws.flatMap((l): ReadonlyArray<CheckName> =>
				l.described.kind === "check" ? [{ law: l.described, name: c.name }] : []
			)
		)
	}
}

/**
 * lawsOf(schema): every law a schema built by schema(...) or schema.extend states, each once, with its identity
 * (types/changeset IdentifiedLaw): `law` exactly as an `invariant-rejected` outcome names it (types/changeset Law), so
 * `sameLaw` holds of a law here and a law an outcome names exactly when they are one law, and every law an outcome over
 * the schema names is one of these; and `id`, the one a refusal's RefusedLaw names it by: a theory law's LawId, a
 * stored field's pattern law's LawId under the text domain its pattern is installed as, and a generated field's
 * GeneratedLawId. An application that names the laws it handles keys its names by these ids and reads a refusal's laws
 * by their ids, with no search and no table of ids of its own.
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
 * It throws CompileError for any other value, a role's included, and for a schema that does not compile. A built
 * schema's laws are compiled once, where any of lawsOf, lawsByStatement and constraintNamesOf first reads them.
 */
export const lawsOf = (schema: AnySchema): ReadonlyArray<IdentifiedLaw<OwnLaw>> =>
	schemaLaws(lawModelOf(schema, "lawsOf")).laws

/** What a statement given to lawsByStatement's lookup must be. */
const aStatedStatement =
	"a statement the schema states: one built by key, mutable, check, contained, mirrors, alternatives, ordered, counted, tree or fold, which a level of the schema states"

/** The canonical texts of the statements a statement value is owned as (schema/statements.ts statementTextsOf). */
const ownedAs = (statement: unknown): ReadonlyArray<string> => {
	const texts = statementTextsOf(statement)
	if (texts === undefined) {
		throw malformed("lawsByStatement", aStatedStatement)
	}
	return texts
}

/** The laws of the owned statement of canonical text `text`; refused when no level of the schema states it. */
const placedOf = (
	byStatement: SchemaLaws["byStatement"],
	text: string
): ReadonlyArray<PlacedLaw> => {
	const placed = byStatement.get(text)
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
 * states (MalformedDescription). A built schema's laws are compiled once (`lawsOf`), and a lookup compiles nothing: it
 * reads each statement's laws by the canonical text the statement's value holds from its build.
 */
export const lawsByStatement = <S extends AnySchema>(
	schema: S
): ((statement: StatementsOf<S>[number]) => ReadonlyArray<OwnLaw>) => {
	const { byStatement } = schemaLaws(lawModelOf(schema, "lawsByStatement"))
	return (statement) =>
		Object.freeze([
			...new Map(
				ownedAs(statement)
					.flatMap((text) => placedOf(byStatement, text))
					.toSorted((a, b) => a.position - b.position)
					.map((p) => [p.position, p.law] as const)
			).values()
		])
}

/**
 * constraintNamesOf(schema): the name PostgreSQL holds each check of a schema built by schema(...) or schema.extend
 * under, compiled once, as a lookup: `const constraintNameOf = constraintNamesOf(schema)`, then `constraintNameOf(law)`
 * is the name a direct SQL writer's refusal by the check `law` names (SQLSTATE 23514): a row check's CHECK constraint,
 * its declared name converted (`E1_derived` installs as `e_1_derived`), and a check over a derived relation's facts
 * the constraint triggers that hold it on every table its definition reads, named from its law, since its own name is
 * unique in no table's namespace. It is the name the schema's law model gives the one constraint or trigger that
 * discharges the law, read from the derivation lawsOf and lawsByStatement read, so the schema holds the information
 * once and the name is never spelled again.
 *
 * constraintNamesOf throws CompileError for a value lawsOf refuses, and the lookup MalformedDescription for a law that
 * is no check of the schema. A built schema's laws are compiled once (`lawsOf`); a lookup compiles nothing.
 */
export const constraintNamesOf = (
	schema: AnySchema
): ((law: Extract<OwnLaw, { readonly kind: "check" }>) => string) => {
	const { checks } = schemaLaws(lawModelOf(schema, "constraintNamesOf"))
	return (law) => {
		const [name, ...others] = new Set(
			checks.flatMap((c) => (sameContent(c.law, law) ? [c.name] : []))
		)
		if (name === undefined || others.length > 0) {
			throw malformed("constraintNamesOf", "a check the schema states, discharged under one name")
		}
		return name
	}
}
