import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { lawModel } from "#compiler/program/laws.ts"
import { schema } from "#compiler/public/schema.ts"
import { derivedEntry, derivedLaw } from "#compiler/runtime/law-entry.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { ownedKind } from "#compiler/schema/protocol.ts"
import { lawBuilder, statementDescOf } from "#compiler/schema/statements.ts"
import type { LawEntry, OwnLaw } from "#compiler/types/changeset/changeset.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
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
}

/** Every statement of a case's levels, the base's then the level above's, as levelsOf builds them. */
export const statementsOf = (c: LawsCase): ReadonlyArray<Statement> => {
	const { base, above } = levelsOf(c)
	return [
		...base.statements,
		...Option.match(above, { onNone: () => [], onSome: (l) => l.statements })
	]
}

export const entriesCaseGen: Gen<EntriesCase> = (source) => {
	const laws = source.draw(lawsCaseGen)
	return {
		laws,
		declared: Arr.map(statementsOf(laws), () =>
			source.draw(boolean) ? Option.some(source.draw(int(0, catalog.length - 1))) : Option.none()
		)
	}
}

/** The catalog entry of index `at`, as law(...) takes it. */
export const catalogAt = (at: number) => defined(catalog[at], "a catalog entry")

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
	const declaredBase = schema("Laws", Rec.values(Rec.fromEntries(base.relations)), baseStatements)
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
