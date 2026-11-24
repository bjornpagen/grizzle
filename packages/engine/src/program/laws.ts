import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { generatedFieldLaws, lawDescription } from "#compiler/analysis/theory/description.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { fieldPatternLaws, patternLawId, planTextDomains } from "#compiler/physical/ddl/domains.ts"
import { sealLaws } from "#compiler/physical/ddl/seal.ts"
import { parseBuiltSchema } from "#compiler/program/input.ts"
import { builtLawModel, compiledSchema } from "#compiler/program/schema.ts"
import { namedGenerated, namedLaw } from "#compiler/runtime/law-entry.ts"
import { malformed, orThrow } from "#compiler/schema/protocol.ts"
import { statementTextsOf } from "#compiler/schema/statements.ts"
import type { IdentifiedLaw, OwnLaw, StatedLaw } from "#compiler/types/changeset/changeset.ts"
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
export interface SchemaLaws {
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

/**
 * A schema's laws (`derivedLaws`), derived where its compiled state's laws are first read and held there
 * (program/schema.ts CompiledSchema `laws`), its CompileError thrown, refused at `operation`, as lawsOf and its
 * siblings document.
 */
const schemaLaws = (schema: AnySchema, operation: string): SchemaLaws => {
	const compiled = orThrow(
		Result.flatMap(parseBuiltSchema(schema, captureLoc(operation, [])), compiledSchema)
	)
	return compiled.laws.read(() => derivedLaws(compiled.model))
}

/**
 * The theory's laws in theory order, each described as an outcome describes it, each owned statement's beside it as
 * its normalization merged them (analysis/theory/laws.ts KeptLaw); then each stored field's pattern law and each
 * generated field's law, which no statement states; then each sealed unit's seal law (physical/ddl/seal.ts), its unit
 * statement's. Each with the identity a refusal names it by: a theory law's own, a pattern law's under the text domain
 * its pattern's key is planned as (planTextDomains, patternLawId), as the installation identifies it, a generated
 * field's and a seal's.
 */
const derivedLaws = (model: LawModel): SchemaLaws => {
	const theory = model.theory.laws.map((law, position) => ({
		placed: Object.freeze({ position, law: namedLaw(lawDescription(law)) }),
		id: law.id,
		statements: law.statements
	}))
	const domains = new Map(
		planTextDomains(model.owned, model.theory, [], []).map((p) => [p.key, p.domain.named] as const)
	)
	const patterns = fieldPatternLaws(model).map((p): IdentifiedLaw<OwnLaw> =>
		Object.freeze({
			law: namedLaw(p.law),
			id: patternLawId(
				defined(domains.get(p.regex.key), "planTextDomains plans every stored field's pattern key"),
				p
			)
		})
	)
	const generated = generatedFieldLaws(
		[...model.relations.values()].map((r) => r.relation),
		model.owned.declared.generated
	).map((g): IdentifiedLaw<OwnLaw> => Object.freeze({ law: namedGenerated(g.law), id: g.id }))
	/** Each unit statement's index, by its unit's name: a unit is stated by one statement (schema/own.ts ownUnits). */
	const unitStatements = new Map(
		model.owned.statements.flatMap((statement, at) =>
			statement.kind === "unit" ? [[statement.name, at] as const] : []
		)
	)
	const seals = sealLaws(model.owned).map((s, i) => ({
		placed: Object.freeze({
			position: theory.length + patterns.length + generated.length + i,
			law: namedLaw(s.described)
		}),
		id: s.id,
		statements: [defined(unitStatements.get(s.unit.name), "a sealed unit's statement")]
	}))
	const stated = Map.groupBy(
		[...theory, ...seals].flatMap((t) =>
			t.statements.map((statement) => ({ statement, placed: t.placed }))
		),
		(s) => s.statement
	)
	return {
		laws: Object.freeze([
			...theory.map((t): IdentifiedLaw<OwnLaw> => Object.freeze({ law: t.placed.law, id: t.id })),
			...patterns,
			...generated,
			...seals.map((t): IdentifiedLaw<OwnLaw> => Object.freeze({ law: t.placed.law, id: t.id }))
		]),
		byStatement: new Map(
			[...model.owned.statementAt].map(([text, statement]) => [
				text,
				Object.freeze((stated.get(statement) ?? []).map((s) => s.placed))
			])
		),
		checks: model.constraints.flatMap((c) =>
			c.laws.flatMap((l): ReadonlyArray<CheckName> => {
				const law = namedLaw(l.described)
				return law.kind === "check" ? [{ law, name: c.name }] : []
			})
		)
	}
}

/**
 * lawsOf(schema): every law a schema built by schema(...) or schema.extend states, each once, with its identity
 * (types/changeset IdentifiedLaw): `law` exactly as an `invariant-rejected` outcome names it (types/changeset Law), its
 * catalog entry (`entry`) included, the one its statements' author declares (law(...)) or the one grizzle derives
 * (runtime/law-entry.ts derivedEntry), so `sameLaw` holds of a law here and a law an outcome names exactly when they
 * are one law, and every law an outcome over the schema names is one of these; and `id`, the one a refusal's RefusedLaw names it by: a theory law's LawId, a
 * stored field's pattern law's LawId under the text domain its pattern is installed as, a generated field's
 * GeneratedLawId, and a sealed unit's seal law's LawId. An application that names the laws it handles keys its names by these ids and reads a refusal's laws
 * by their ids, with no search and no table of ids of its own.
 *
 * In the schema's canonical order of laws, whatever order the schema declares its relations and statements in: the
 * theory's laws in theory order (each ordinary relation's primary key by relation name, then the statements' laws in
 * canonical statement order, then each contract's by contract name), each described as an outcome describes it
 * (analysis/theory/description.ts lawDescription); then each stored field's pattern law (physical/ddl/domains.ts
 * fieldPatternLaws); then each generated field's law (generatedFieldLaws); the last two by relation name and each
 * relation's fields in declared order; then each sealed unit's seal law, by unit name (physical/ddl/seal.ts sealLaws).
 * The installation reads its text domains' and generated columns' laws from those same fields, and its seal triggers'
 * laws from the same units, so the two can never disagree. A law two statements state, such as a key that restates the primary
 * key, is listed once.
 *
 * It throws CompileError for any other value, a role's included, and for a schema that does not compile. A built
 * schema's laws are compiled once, where any of lawsOf, lawsByStatement and constraintNamesOf first reads them.
 */
export const lawsOf = (schema: AnySchema): ReadonlyArray<IdentifiedLaw<OwnLaw>> =>
	schemaLaws(schema, "lawsOf").laws

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
 * fold's one law, a mirrors' two containments, an alternatives law's containments, a sealed unit's seal law, and none
 * for a mutable or an unsealed unit. A law two statements state is each one's, such as a span primary key's law and a
 * key over its fields.
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
	const { byStatement } = schemaLaws(schema, "lawsByStatement")
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
 * is the name a direct SQL writer's refusal by the check `law` names (SQLSTATE 23514), the check its relation and name
 * are, as lawsOf lists it or as it states itself, its entry aside: a row check's CHECK constraint,
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
): ((law: Extract<StatedLaw, { readonly kind: "check" }>) => string) => {
	const { checks } = schemaLaws(schema, "constraintNamesOf")
	return (law) => {
		const [name, ...others] = new Set(
			checks.flatMap((c) =>
				c.law.relation === law.relation && c.law.name === law.name ? [c.name] : []
			)
		)
		if (name === undefined || others.length > 0) {
			throw malformed("constraintNamesOf", "a check the schema states, discharged under one name")
		}
		return name
	}
}
