/** What the property of pattern-identity.test.ts reads: its patterns, their spellings, its schema and its snapshots. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str, Struct } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { type ExprDesc, guardedExpr } from "#compiler/ir/desc.ts"
import type { PatternValue, Spellings } from "#compiler/ir/pattern.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import {
	check,
	contained,
	decodedQuery,
	f,
	field,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { spelled } from "#test/support/fixtures/ir/scalar.ts"
import { admittedNames } from "#test/support/kernel/dict.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { rowStepsOf, statementsOf } from "#test/unit/deploy/renames.fixtures.ts"
import { admittedPatternOver, families } from "#test/unit/text/generators.ts"

/**
 * How a case writes its pattern again: as a spelling of the same language, the pattern in a group, beside an empty
 * piece, or as an alternation of itself; or as another language, the pattern or a code point no family's alphabet
 * holds, a language some text of the first's holds no match of, unless the first's matches every text.
 */
export type Respelling =
	| "a group"
	| "an empty piece"
	| "an alternation of itself"
	| "another language"

export const respellings: Arr.NonEmptyReadonlyArray<Respelling> = [
	"a group",
	"an empty piece",
	"an alternation of itself",
	"another language"
]

/** The spelling `respelling` writes `source` as. */
const respelled = (source: string, respelling: Respelling): string => {
	switch (respelling) {
		case "a group":
			return `(?:${source})`
		case "an empty piece":
			return `(?:${source})(?:)`
		case "an alternation of itself":
			return `(?:${source})|(?:${source})`
		case "another language":
			return `(?:${source})|\u{2603}`
	}
}

/** A case: a pattern over a family's alphabet, and the second spelling a respelling writes it as. */
export interface SpellingCase {
	readonly first: PatternValue
	readonly second: PatternValue
	readonly respelling: Respelling
}

export const spellingCases: Gen<SpellingCase> = (source) => {
	const { alphabet } = source.draw(element(families))
	const pattern = source.draw(admittedPatternOver(alphabet))
	const respelling = source.draw(element(respellings))
	return { first: spelled(pattern), second: spelled(respelled(pattern, respelling)), respelling }
}

/**
 * A case of an installation's spellings (ir/pattern.ts installedSpellings): the spellings of one or two languages, each
 * a pattern over a family's alphabet and its three respellings of its own language (a group, beside an empty piece, an
 * alternation of itself), held in a drawn order and in another, and a history that spells the first language by one of
 * its spellings, or none.
 */
export interface HeldSpellings {
	readonly languages: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<PatternValue>>
	readonly held: ReadonlyArray<PatternValue>
	readonly reordered: ReadonlyArray<PatternValue>
	readonly history: Spellings
}

/** The spellings of one language: a pattern and each respelling of its own language. */
const languageSpellingsGen: Gen<Arr.NonEmptyReadonlyArray<PatternValue>> = (source) => {
	const { alphabet } = source.draw(element(families))
	const pattern = source.draw(admittedPatternOver(alphabet))
	return [
		spelled(pattern),
		...Arr.map(
			Arr.filter(respellings, (r) => r !== "another language"),
			(r) => spelled(respelled(pattern, r))
		)
	]
}

export const heldSpellingsGen: Gen<HeldSpellings> = (source) => {
	const first = source.draw(languageSpellingsGen)
	const languages: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<PatternValue>> = source.draw(
		boolean
	)
		? [first, source.draw(languageSpellingsGen)]
		: [first]
	const all = Arr.flatten(languages)
	const kept = source.draw(boolean) ? first[source.draw(int(0, first.length - 1))] : undefined
	return {
		languages,
		held: source.draw(shuffled(all, { min: all.length, max: all.length })),
		reordered: source.draw(shuffled(all, { min: all.length, max: all.length })),
		history: kept === undefined ? new Map() : new Map([[kept.pattern, kept.spelling]])
	}
}

const t = field("t")

/** Text.matches(t, pattern), its pattern the literal of its pattern value. */
const matches = (pattern: PatternValue): ExprDesc => ({
	kind: "compute",
	fn: "matches",
	args: [t, literal(pattern)]
})

/**
 * Logic.when(Text.matches(t, pattern), (p) => Text.octetLength(p) >= 0, true): a guard of the pattern, its
 * branch reading its parameter.
 */
const guarded = (pattern: PatternValue): ExprDesc => ({
	kind: "when",
	guard: { kind: "matches", pattern },
	subject: t,
	proved: {
		kind: "compare",
		op: "ge",
		left: {
			kind: "compute",
			fn: "octetLength",
			args: [guardedExpr({ kind: "matches", pattern }, t)]
		},
		right: literal(0)
	},
	otherwise: literal(true)
})

/** D: the rows of T whose text matches the pattern, by id. */
const matching = (pattern: PatternValue) =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "id", origin: { relation: "T", field: "id" } },
					{ id: "t", origin: { relation: "T", field: "t" } }
				],
				matches: [
					{
						source: { kind: "relation", name: "T" },
						bindings: { id: { kind: "var", var: "id" }, t: { kind: "var", var: "t" } }
					}
				],
				where: [
					{
						kind: "compute",
						fn: "matches",
						args: [{ kind: "var", var: "t" }, literal(pattern)]
					}
				],
				head: { id: { kind: "var", var: "id" } },
				interiors: [],
				attach: []
			}
		]
	})

/**
 * The case's schema over one pattern: T, its text bounded, and S at its base; a row check of the pattern, a row check of
 * its guard, a key over the rows of T it keeps and a containment from them into S, each reading T's field `keyed`; and
 * above the base D, the rows of T the pattern keeps, a live derived relation, with a key over it.
 */
const schemaOver = (pattern: PatternValue, keyed: string): SchemaDesc => ({
	name: "Judged",
	relations: [{ kind: "derived", name: "D", level: 1, query: matching(pattern) }],
	statements: [key(on("D", ["id"]))],
	bases: [
		{
			name: "Spelled",
			relations: [
				relation("T", { id: f.integer, t: f.regex("^.{0,16}$", "su"), [keyed]: f.integer }, ["id"]),
				relation("S", { u: f.integer }, ["u"])
			],
			statements: [
				check("Shaped", "T", matches(pattern)),
				check("Guarded", "T", guarded(pattern)),
				key(onWhere("T", [keyed], matches(pattern))),
				contained(onWhere("T", [keyed], matches(pattern)), on("S", ["u"]))
			],
			bases: []
		}
	]
})

/** The case's schema over `pattern`, its keyed selection and containment reading T's field u. */
const schemaOf = (pattern: PatternValue): SchemaDesc => schemaOver(pattern, "u")

/** The names a declared rename may give T's field u: the dictionary's admitted names whose conversion no field of T
 * holds. */
const renameTargets = nonEmpty(
	Arr.filter(admittedNames, (n) => !Arr.contains(["id", "t", "u"], n.converted)),
	"an admitted name no field of T converts to"
)

/** A case of a declared field rename: a pattern over a family's alphabet, and the name T's field u is renamed to. */
export interface RenameCase {
	readonly pattern: PatternValue
	readonly to: string
}

export const renameCases: Gen<RenameCase> = (source) => {
	const { alphabet } = source.draw(element(families))
	const pattern = spelled(source.draw(admittedPatternOver(alphabet)))
	return { pattern, to: source.draw(element(renameTargets)).declared }
}

/**
 * The draft from the snapshot `first` installed of the case's schema over `pattern` with T's field u renamed to
 * `to`, declared, as `grizzle generate --rename` drafts it: its statements and the steps it runs over stored rows.
 */
export const fieldRenamedOver = (
	first: Installed,
	pattern: PatternValue,
	to: string
): {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly rowSteps: ReadonlyArray<string>
} => {
	const schema = schemaOver(pattern, to)
	const declared: Declarations = {
		renames: [
			{
				from: { kind: "field", relation: parsedName("T"), field: parsedName("u") },
				to: { kind: "field", relation: parsedName("T"), field: parsedName(to) }
			}
		],
		drops: []
	}
	const codes = succeeded(draftCodes(schema, fromSnapshot(first.snapshot), declared))
	const installation = compile(schema, { ...asDrafted, codes: installedCodes(codes) })
	const { plan } = succeeded(
		generate({
			installation,
			timestamp: draftedAt(2),
			previous: fromSnapshot(first.snapshot),
			workload: noWorkload,
			declared,
			name: "renamed"
		})
	)
	return { statements: statementsOf(plan.steps), rowSteps: rowStepsOf(plan.steps) }
}

/** The case's schema over `pattern` compiled, and its snapshot, installed from nothing. */
export interface Installed {
	readonly installation: Installation
	readonly snapshot: DeploySnapshot
}

export const installedOf = (pattern: PatternValue): Installed => {
	const installation = compile(schemaOf(pattern), asDrafted)
	const { snapshot } = succeeded(
		generate({
			installation,
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "installed"
		})
	)
	return { installation, snapshot }
}

/**
 * The draft of the case's schema over `second` from the snapshot `first` installed, as `grizzle generate` drafts a
 * re-spelling: its codes and spellings drafted from that snapshot (draftCodes), so each language the snapshot records is
 * installed by its recorded spelling. What it changes, and whether its installation reads the ARE of `first`'s spelling.
 */
export const respelledOver = (
	first: Installed,
	second: PatternValue,
	firstPattern: PatternValue
): { readonly change: "none" | "schema"; readonly installsFirst: boolean } => {
	const schema = schemaOf(second)
	const codes = succeeded(draftCodes(schema, fromSnapshot(first.snapshot), noDeclarations))
	const installation = compile(schema, { ...asDrafted, codes: installedCodes(codes) })
	const { change } = succeeded(
		generate({
			installation,
			timestamp: draftedAt(2),
			previous: fromSnapshot(first.snapshot),
			workload: noWorkload,
			declared: noDeclarations,
			name: "respelled"
		})
	)
	return { change, installsFirst: installsAreOf(installation, firstPattern) }
}

/**
 * What a snapshot identifies its installation by: its theory, every law by its identifier and its check's identity,
 * every relation's record and the schema's fingerprint, but its spellings, how it spells each language; and every
 * object its manifest installs, by its kind and identifier.
 */
export const identityOf = (snapshot: DeploySnapshot) => ({
	theory: Struct.omit(snapshot.theory, ["spellings"]),
	objects: Arr.sort(
		Arr.map(snapshot.manifest.objects, (o) => `${o.kind} ${o.ident}`),
		Str.Order
	)
})

/** Whether some statement the installation installs reads the ARE of `pattern`'s spelling, as an SQL string's text. */
export const installsAreOf = (installation: Installation, pattern: PatternValue): boolean => {
	const are = Str.replaceAll("'", "''")(matchAre(pattern.spelling))
	return Arr.some(installation.statements, (s) => Str.includes(are)(printStatement(s)))
}
