/**
 * Names a library derives (the package root's and the dynamic door's derivedName, schema/api.ts): a relation's, a
 * generated relation's and a roster's name stays readable and of any length, the key its schema's types hold it under,
 * refused for nothing but its characters and a collision in its schema's namespace; every PostgreSQL identifier its
 * schema's installation names an object by fits PostgreSQL's 63 bytes (installedIdentifiersOf), and what a derived name
 * installs, a relation's table and whole view and a roster's domain and whole view, is hashed over the name, `__`-led,
 * where a declared name's is its conversion.
 *
 * - A level of drawn names of den's words at any length, of distinct conversions, each a relation, a generated relation
 *   or a roster, derived or declared, every relation over the level's first roster by a closed id and a set. Oracle:
 *   PostgreSQL's identifier bound, the naming door's two forms and the conversion.
 * - Two names that convert alike, one derived at least, beside each other: refused as IdentifierCollision. Oracle: the
 *   namespace's one rule, a name per conversion.
 * - The kept cases of a derived name's identity: two of den's relations of one stem and path and two names, and one of
 *   den's beside a records relation of its stem and path, each its own table and whole view, as a table hashed over the
 *   stem and path alone was not. Oracle: the namespace keeps names unique, so their identities are.
 *
 * Features: each kind of name derived past the bound and declared within it; each pair of namings alike; each kept
 * case.
 */
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { conversionOf, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { installedIdentifiersOf, type InstalledIdentifier } from "#compiler/program/install.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import { generated, sha256, int4 } from "#compiler/public/fields.ts"
import { derivedName, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type AlikeNaming,
	alikeGen,
	builtOf,
	type Drawn,
	type DrawnNaming,
	type KeptCase,
	keptCases,
	levelGen,
	levelOf,
	type NamedKind,
	Sittings,
	sittingsQuery
} from "#test/unit/schema/derived-names.fixtures.ts"

/** The identifiers of an installation whose identity spells out `display`. */
const spelling = (
	identifiers: ReadonlyArray<InstalledIdentifier>,
	display: string
): ReadonlyArray<string> =>
	Arr.flatMap(identifiers, (i) => (i.display === display ? [i.identifier] : []))

/** The one identifier an installation names `display` by, asserted to be one. */
const theOne = (
	identifiers: ReadonlyArray<InstalledIdentifier>,
	display: string,
	what: string
): string => {
	const [one, ...others] = spelling(identifiers, display)
	if (one === undefined || others.length > 0) {
		return assert.fail(`${what}: the installation names ${display} once`)
	}
	return one
}

/** The displays of what a drawn name installs under its name: a relation's table, a roster's domain, and its whole view. */
const installedDisplays = (d: Drawn): readonly [string, string] => [
	d.kind === "roster" ? `roster ${d.name}` : `relation ${d.name}`,
	`whole view of relation ${d.name}`
]

/** What a drawn name reaches: its kind, its naming, and whether its conversion passes PostgreSQL's identifier. */
type LevelFeature = `${NamedKind} ${DrawnNaming} ${"within" | "past"}`

/**
 * A level of drawn names compiles, every identifier its installation names an object by fits PostgreSQL's identifier,
 * a derived name's table or domain and whole view are hashed and a declared one's are its conversion, and each name is
 * the key its schema holds its relation under.
 */
export const aDerivedNameIsReadableAtAnyLengthAndEveryIdentifierItsLevelInstallsFits =
	property.explore(levelGen, {
		needs: {},
		situations: [
			"relation derived past",
			"generated derived past",
			"roster derived past",
			"relation declared within",
			"generated declared within",
			"roster declared within"
		] satisfies ReadonlyArray<Reached<LevelFeature>>,
		check: (_, c: Case<LevelFeature>) => (drawn: ReadonlyArray<Drawn>) =>
			Effect.sync(() => {
				const what = Formatter.format(Arr.map(drawn, (d) => `${d.naming} ${d.kind} ${d.name}`))
				const built = builtOf(drawn)
				const level = levelOf(built)
				succeeded(
					catchCompileError(() => lawsOf(level)),
					`${what}: the level compiles`
				)
				const identifiers = installedIdentifiersOf(level)
				for (const i of identifiers) {
					assert.ok(
						utf8Length(i.identifier) <= maxIdentifierBytes,
						`${what}: ${i.display} is named within PostgreSQL's identifier: ${i.identifier}`
					)
				}
				for (const { drawn: d, value } of built) {
					const past = utf8Length(conversionOf(d.name)) > maxIdentifierBytes
					c.note(`${d.kind} ${d.naming} ${past ? "past" : "within"}`)
					assert.ok(
						level.relations[d.name] === value,
						`${what}: ${d.name} is the key its level holds it under`
					)
					for (const display of installedDisplays(d)) {
						const identifier = theOne(identifiers, display, what)
						if (d.naming === "derived") {
							assert.ok(
								Str.startsWith("__")(identifier),
								`${what}: ${display} is hashed: ${identifier}`
							)
						} else {
							assert.equal(
								identifier,
								conversionOf(d.name),
								`${what}: ${display} is its conversion`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's identifier bound, the naming door's two forms, a derived name's hashed and a declared name's its conversion, and the name the level's key"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\t\tnamed: identity.derivedTable(name, spelling),",
				replacement: "\t\t\t\t\tnamed: identity.table(name),",
				why: "A derived relation's table is rendered readable, its name's conversion: past the bound an identifier PostgreSQL cuts short, and within it no hashed name."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\t\tnamed: identity.derivedRosterDomain(name),",
				replacement: "\t\t\t\t\tnamed: identity.rosterDomain(name),",
				why: "A derived roster's domain is rendered readable, its name's conversion, past the bound an identifier PostgreSQL cuts short."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\t\twhole: identity.derivedWholeView(name, [name])",
				replacement: "\t\t\t\t\twhole: identity.wholeView(name)",
				why: "A derived roster's whole view is rendered readable, past the bound an identifier PostgreSQL cuts short."
			},
			{
				file: "packages/engine/src/schema/relation.ts",
				original: '\tconst rosterName = admittedName(name, naming, label, "roster")',
				replacement: '\tconst rosterName = admittedName(name, declaredNaming, label, "roster")',
				why: "A derived roster's name is admitted by the declared-name rule: one past the bound is refused where it is built."
			},
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: "\t\tunordered: unorderedRosterNamed(derivedRosterNaming)",
				replacement: "\t\tunordered: unorderedRosterNamed(declaredNaming)",
				why: "derivedName's roster is declared: its domain readable, and one past the bound refused where it is built."
			},
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: "\t\tgenerated: generatedNamed(admitted),",
				replacement: "\t\tgenerated: generatedNamed(declaredNaming),",
				why: "derivedName's generated relation is declared: its table readable, and one past the bound refused where it is built."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: "\tconst name = parseDerivedName(closed)",
				replacement: "\tconst name = parseDeclaredName(closed)",
				why: "A closed id's roster is looked up by the declared-name rule: a closed id or a set over a derived roster past the bound names no closed relation, and its relation does not compile."
			},
			{
				file: "packages/engine/src/program/install.ts",
				original: "\t\t...Object.values(installation.owned.relations).flatMap(wholeViewsOf)",
				replacement: "",
				why: "installedIdentifiersOf leaves out the whole views a role reads its relations through, so a derived relation's whole view is no identifier it lists."
			}
		]
	})

/** What a pair of names alike reaches: its namings. */
type AlikeFeature = `${AlikeNaming[0]} beside ${AlikeNaming[1]}`

/** Two names that convert alike, one derived at least, are refused in one level as IdentifierCollision. */
export const twoNamesThatConvertAlikeAreRefusedWhereADerivedOneIsAmongThem = property.explore(
	alikeGen,
	{
		needs: {},
		situations: [
			"derived beside derived",
			"derived beside declared",
			"declared beside derived"
		] satisfies ReadonlyArray<Reached<AlikeFeature>>,
		check: (_, c: Case<AlikeFeature>) => (alike) =>
			Effect.sync(() => {
				const [one, two] = alike.namings
				const what = `${one} ${alike.first.kind} ${alike.first.name} beside ${two} ${alike.second.kind} ${alike.second.name}`
				c.note(`${one} beside ${two}`)
				assert.equal(
					conversionOf(alike.first.name),
					conversionOf(alike.second.name),
					`${what}: the names convert alike`
				)
				const made = catchCompileError(() => lawsOf(levelOf(builtOf([alike.first, alike.second]))))
				assert.ok(!made.ok, `${what}: refused`)
				assert.equal(
					made.error.reason._tag,
					"IdentifierCollision",
					`${what}: refused as IdentifierCollision`
				)
			}),
		oracle: {
			kind: "universal",
			name: "the namespace's one rule: one name per conversion, a derived name's among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					"\t\treturn Result.map(this.#take(name, conversionOf(parsed.value), kind, loc), () => parsed.value)",
				replacement:
					"\t\treturn Result.map(this.#take(name, parsed.value, kind, loc), () => parsed.value)",
				why: "A derived name takes its text in the namespace, not its conversion: it meets no name spelled otherwise that converts alike."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					'\t\t\t\tconst name = unwrap(this.#schemaNames.declareDerived(declared, "roster", r.loc))',
				replacement:
					'\t\t\t\tconst name = unwrap(DeclaredNamespace.of("roster").declareDerived(declared, "roster", r.loc))',
				why: "A derived roster is declared into a namespace of its own: it meets no relation or roster whose name converts alike."
			}
		]
	}
)

/** The owner every records value of the kept cases holds. */
const owner = Object.freeze({ digest: sha256, root: sha256 })

/** A kept case's level, its laws compiled, and the two names whose tables and whole views it holds apart. */
const keptLevel = (kept: KeptCase) => {
	const den = derivedName({ stem: "EssaySitting", path: ["key"] })
	const Keyed = den.relation("EssaySittingKeyed", { id: int4, n: int4 }, ["id"])
	switch (kept) {
		case "two derived relations of one stem and path": {
			const Value = den.generated("EssaySittingKeyValue", { id: int4, n: int4 }, ["id"], (row) => ({
				m: generated(int4, row.n)
			}))
			const level = schema("Kept", [Keyed, Value], [])
			assert.ok(
				level.relations.EssaySittingKeyed === Keyed &&
					level.relations.EssaySittingKeyValue === Value,
				`${kept}: each name is the key its level holds it under`
			)
			return { level, names: ["EssaySittingKeyed", "EssaySittingKeyValue"] } as const
		}
		case "a derived relation beside records of its stem and path": {
			const records = recordsBuilder("EssaySitting", sittingsQuery, owner, ["digest", "root"], [])
			const level = schema.extend([Sittings], "Kept", [...records.relations, Keyed], records.rules)
			return { level, names: ["EssaySittingKey", "EssaySittingKeyed"] } as const
		}
	}
}

/**
 * Two of den's relations of one stem and path and two names, and one of den's beside a records relation of its stem and
 * path, are each their own table and whole view: a derived identity is hashed over its name, which the namespace keeps
 * unique, never over the stem and path alone.
 */
export const denRelationsOfOneStemAndPathAreEachTheirOwnTableAndWholeView = property.exhaust(
	finite((source) => source.draw(element(keptCases))),
	{
		needs: {},
		situations: [...keptCases] satisfies ReadonlyArray<Reached<KeptCase>>,
		check: (_, c: Case<KeptCase>) => (kept) =>
			Effect.sync(() => {
				c.note(kept)
				const { level, names } = keptLevel(kept)
				lawsOf(level)
				const identifiers = installedIdentifiersOf(level)
				const [first, second] = names
				for (const display of ["relation", "whole view of relation"]) {
					const one = theOne(identifiers, `${display} ${first}`, kept)
					const two = theOne(identifiers, `${display} ${second}`, kept)
					assert.ok(
						one !== two && Str.startsWith("__")(one) && Str.startsWith("__")(two),
						`${kept}: ${first} and ${second} are named by two hashed identifiers (${display}): ${one} and ${two}`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "the namespace keeps every name unique, so a derived identity hashed over its name is its own"
		},
		box: "two of den's relations of one stem and path, a relation and a generated relation, and one of den's beside the records relation records of its stem derive at its path",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					"): Identity<K> => mint(kind, [name, spelling], spelling.flatMap(nameSegments), display, hashed)",
				replacement:
					"): Identity<K> => mint(kind, [spelling], spelling.flatMap(nameSegments), display, hashed)",
				why: "A derived identity is hashed over its stem and path alone: two relations of one stem and path are one table and one whole view."
			}
		]
	}
)
