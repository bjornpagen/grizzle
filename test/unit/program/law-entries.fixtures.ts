import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { encode, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { lawModel } from "#compiler/program/laws.ts"
import { Logic } from "#compiler/public/compute.ts"
import { accumulated, contract, drawn, natural, int4, int8 } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { derivedEntry, derivedLaw } from "#compiler/runtime/law-entry.ts"
import { lawBuilder } from "#compiler/schema/law-entries.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { ownedKind } from "#compiler/schema/protocol.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { statementDescOf } from "#compiler/schema/statements.ts"
import { regexField } from "#compiler/text/field.ts"
import type { LawEntry, OwnLaw, StatedLaw } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { caseGen as lawsCaseGen, lawText, levelsOf } from "#test/unit/program/laws.fixtures.ts"

/** A drawn schema of every law kind, as lawsOf's property draws it (laws.fixtures.ts caseGen). */
type LawsCase = typeof lawsCaseGen extends Gen<infer C> ? C : never

/**
 * The catalog entries an author declares: each a name and a source that a snapshot.json and a served file carry as
 * written, JSON's quote, escape and control characters, astral characters and a source many words long among them.
 */
const catalog: Arr.NonEmptyReadonlyArray<{
	readonly name: string
	readonly source: string
}> = [
	{
		name: "Template held",
		source: "QTI 3.0 §4.1.1: the item's identifier, which a ledger's item sessions read"
	},
	{ name: "E1 derived", source: "fin.md §16, the attribute family's count" },
	{ name: 'a "quoted" name', source: "line one\nline two, a \\ and a\ttab" },
	{ name: "ünïcödé ✓", source: "𝒮 reading 85 (xi:include's xpointer)" }
]

/**
 * A drawn schema and the catalog entry its author declares at each of its statements, the base level's then the level
 * above's, in their order (levelsOf): an index into `catalog`, or none, so each law the statement states derives its
 * entry.
 */
export interface EntriesCase {
	readonly laws: LawsCase
	readonly declared: ReadonlyArray<Option.Option<number>>
	readonly catalogued: Catalogued
}

/**
 * The catalog entry its author declares, an index into `catalog`, or none, at each declaration a law no statement states
 * comes from, on the relation Catalogued: the relation itself, for its primary key's law; its generated field `g`, for
 * its generated law; the refined text type of its two fields `a` and `b`, for their pattern laws, one entry for the
 * type; the contract of its field `n`, for the contract's law; grizzle's own contract natural, the type of its field
 * `m`, for natural's law; and the refined text type of CatalogLine's pieces, whose concat fold accumulates them into
 * CatalogLine's and CatalogDoc's accumulated fields, for the pattern laws of the written field and the accumulated
 * ones alike.
 */
export interface Catalogued {
	readonly key: Option.Option<number>
	readonly generated: Option.Option<number>
	readonly text: Option.Option<number>
	readonly contract: Option.Option<number>
	readonly natural: Option.Option<number>
	readonly joined: Option.Option<number>
}

/** Every statement of a case's levels, the base's then the level above's, as levelsOf builds them. */
export const statementsOf = (c: LawsCase): ReadonlyArray<Statement> => {
	const { base, above } = levelsOf(c)
	return [
		...base.statements,
		...Option.match(above, { onNone: () => [], onSome: (l) => l.statements })
	]
}

/** A catalog entry's index, or none. */
const entryGen: Gen<Option.Option<number>> = (source) =>
	source.draw(boolean) ? Option.some(source.draw(int(0, catalog.length - 1))) : Option.none()

export const entriesCaseGen: Gen<EntriesCase> = (source) => {
	const laws = source.draw(lawsCaseGen)
	return {
		laws,
		declared: Arr.map(statementsOf(laws), () => source.draw(entryGen)),
		catalogued: {
			key: source.draw(entryGen),
			generated: source.draw(entryGen),
			text: source.draw(entryGen),
			contract: source.draw(entryGen),
			natural: source.draw(entryGen),
			joined: source.draw(entryGen)
		}
	}
}

/** The pattern Catalogued's two refined text fields share, which no text of every value matches. */
const cataloguedPattern = { source: "^[a-z]{1,8}$", flags: "u" } as const

/** The pattern of CatalogLine's pieces, which their concat fold accumulates into texts of the same pattern. */
const joinedPattern = { source: "^[a-z]*$", flags: "u" } as const

/** The name of Catalogued's contract, apart from every contract lawsOf's schemas declare. */
const cataloguedContract = "Catalogued_units"

/** A declaration with the entry `at` names, law(...)'s, or as it is where `at` names none. */
const declaredAs = <S extends object>(at: Option.Option<number>, declaration: S): S =>
	Option.match(at, {
		onNone: () => declaration,
		onSome: (i) => lawBuilder(catalogAt(i), declaration)
	})

const contractKey = Symbol("contract")
/**
 * The relations the case's Catalogued declarations are made at (Catalogued), with the entries it declares: Catalogued,
 * keyed by its id, two fields `a` and `b` of one refined text type, a field `n` of a contract, a field `m` of natural, a
 * written integer `k` and a field `g` generated from it; and CatalogDoc and its ordered CatalogLines, whose pieces, of
 * one refined text type, a concat fold accumulates into each line's `before` and `after` and each document's `text`.
 */
const cataloguedOf = (
	c: Catalogued
): {
	readonly relations: ReadonlyArray<AnyRelation>
	readonly statements: ReadonlyArray<Statement>
	readonly declarations: ReadonlyArray<object>
} => {
	const text = declaredAs(c.text, regexField(cataloguedPattern.source, [cataloguedPattern.flags]))
	const units = declaredAs(
		c.contract,
		contract<typeof contractKey>()(cataloguedContract, int8, (u) => Logic.ge(u, 0n))
	)
	const count = declaredAs(c.natural, natural)
	const joined = declaredAs(
		c.joined,
		str.bytes(64, str.regex(joinedPattern.source, joinedPattern.flags))
	)
	const Catalogued = declaredAs(
		c.key,
		generatedRelation(
			"Catalogued",
			{ id: Id, a: text, b: text, n: units, m: count, k: int4 },
			["id"],
			(row) => ({ g: declaredAs(c.generated, generatedField(int4, row["k"], [])) }),
			[]
		)
	)
	const Doc = relation("CatalogDoc", { id: Id, n: drawn(natural), text: accumulated(joined, "") }, [
		"id"
	])
	const Line = relation(
		"CatalogLine",
		{
			doc: Id,
			at: drawn(natural),
			piece: joined,
			before: accumulated(joined, ""),
			after: accumulated(joined, "")
		},
		["doc", "at"]
	)
	const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))
	const at = (drawn: Option.Option<number>, d: object): ReadonlyArray<object> =>
		Option.isSome(drawn) ? [d] : []
	return {
		relations: [Catalogued, Doc, Line],
		statements: [
			lines,
			fold(lines, Monoid.concat, on(Line, "doc", "piece", "before", "after"), on(Doc, "id", "text"))
		],
		declarations: [
			...at(c.key, Catalogued),
			...at(c.generated, Catalogued.fields.g),
			...at(c.text, text),
			...at(c.contract, units),
			...at(c.natural, count),
			...at(c.joined, joined)
		]
	}
}

/** Catalogued's declarations as its case names them: each a value law(...) refuses to name again where it named it. */
export const cataloguedDeclarations = (c: Catalogued): ReadonlyArray<object> =>
	cataloguedOf(c).declarations

/**
 * The laws Catalogued's declarations state with no statement, each by its identity text, with the catalog entry its
 * case declares: its primary key's, its generated field's, its two fields' pattern laws, the type's one entry at both,
 * and its contract's.
 */
export const cataloguedEntries = (c: Catalogued): ReadonlyArray<readonly [string, number]> => {
	const stated = (
		at: Option.Option<number>,
		law: StatedLaw
	): ReadonlyArray<readonly [string, number]> =>
		Option.match(at, {
			onNone: () => [],
			onSome: (i) => [[statedText(derivedLaw(law)), i] as const]
		})
	const pattern = (
		relation: string,
		field: string,
		spelled: { readonly source: string; readonly flags: "u" }
	): StatedLaw => ({ kind: "pattern", relation, field, patterns: [spelled] })
	return [
		...stated(c.key, { kind: "primaryKey", relation: "Catalogued", fields: ["id"] }),
		...stated(c.generated, { kind: "generated", relation: "Catalogued", field: "g" }),
		...stated(c.text, pattern("Catalogued", "a", cataloguedPattern)),
		...stated(c.text, pattern("Catalogued", "b", cataloguedPattern)),
		...stated(c.contract, { kind: "contract", contract: cataloguedContract }),
		...stated(c.natural, { kind: "contract", contract: "natural" }),
		...stated(c.joined, pattern("CatalogLine", "piece", joinedPattern)),
		...stated(c.joined, pattern("CatalogLine", "before", joinedPattern)),
		...stated(c.joined, pattern("CatalogLine", "after", joinedPattern)),
		...stated(c.joined, pattern("CatalogDoc", "text", joinedPattern))
	]
}

/** The catalog entry of index `at`, as law(...) takes it. */
export const catalogAt = (at: number) => defined(catalog[at], "a catalog entry")

/**
 * The text every copy of an unsealed unit statement shares, its description's canonical text apart from source
 * locations: an unsealed unit states no law, but law(...) gives it an entry, one over its copies, so two copies that
 * declare two entries are refused as two statements of one law are. None for every other statement, a sealed unit's
 * among them, whose entry is its seal law's.
 */
export const unitText = (statement: Statement): Option.Option<string> => {
	const desc = statementDescOf(statement)
	return desc?.kind === "unit" && !desc.sealed
		? Option.some(succeeded(encode(desc, withoutSourceLocs), "a unit's canonical text"))
		: Option.none()
}

/** Whether a statement value states laws a catalog entry can name: every statement but a mutable and a race. */
export const statesLaws = (statement: Statement): boolean => {
	const kind = statementDescOf(statement)?.kind
	return kind !== "mutable" && kind !== "race" && ownedKind(statement) !== undefined
}

/**
 * The case's schema with each statement given the entry its author declares there (law(...)), one level or the tables
 * a level above the core, as subjectOf builds it in declared order: the base level, and the schema whose top it is.
 */
export const namedSubjectOf = (
	c: EntriesCase
): {
	readonly base: AnySchema
	readonly subject: AnySchema
	readonly statements: ReadonlyArray<Statement>
} => {
	const { base, above } = levelsOf(c.laws)
	const name = (s: Statement, at: number): Statement =>
		Option.match(c.declared[at] ?? Option.none<number>(), {
			onNone: () => s,
			onSome: (i) => (statesLaws(s) ? lawBuilder(catalogAt(i), s) : s)
		})
	const baseStatements = Arr.map(base.statements, name)
	const catalogued = cataloguedOf(c.catalogued)
	const declaredBase = schema(
		"Laws",
		[...Rec.values(Rec.fromEntries(base.relations)), ...catalogued.relations],
		[...baseStatements, ...catalogued.statements]
	)
	return Option.match(above, {
		onNone: () => ({ base: declaredBase, subject: declaredBase, statements: baseStatements }),
		onSome: (level) => {
			const aboveStatements = Arr.map(level.statements, (s, i) =>
				name(s, base.statements.length + i)
			)
			return {
				base: declaredBase,
				subject: schema.extend(
					[declaredBase],
					"LawsAbove",
					Rec.values(Rec.fromEntries(level.relations)),
					aboveStatements
				),
				statements: [...baseStatements, ...aboveStatements]
			}
		}
	})
}

/** A law's identity text: lawText of what it states, its entry the one grizzle derives, whatever entry it carries. */
export const statedText = (l: OwnLaw): string =>
	Option.getOrThrowWith(lawText(derivedLaw(l)), () => new Error("a law's text"))

/** Two entries alike: one kind, one name, one source. */
export const sameEntry = (a: LawEntry, b: LawEntry): boolean =>
	a.kind === b.kind && a.name === b.name && a.source === b.source

/**
 * The entry the oracle expects of a law: the catalog entry its statements' author declares, where one of the statements
 * that state it declares one (`declared`, by the law's identity text), and otherwise the one grizzle derives from what it
 * states.
 */
export const expectedEntry = (declared: ReadonlyMap<string, number>, l: OwnLaw): LawEntry =>
	Option.match(Option.fromUndefinedOr(declared.get(statedText(l))), {
		onNone: () => derivedEntry(l),
		onSome: (i): LawEntry => ({ kind: "declared", ...catalogAt(i) })
	})

/**
 * A built schema's whole installation, under its declared names, owned from the built value as grizzle generate owns it
 * (program/laws.ts lawModel), so the catalog entries its statements carry reach the installation: the test naming
 * door's installationOf owns a schema's description, which holds none.
 */
export const builtInstallationOf = (subject: AnySchema): Installation => {
	const owned = succeeded(lawModel(subject, "the law entries' installation")).owned
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
}
