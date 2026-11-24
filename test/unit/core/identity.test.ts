/**
 * The naming door's rendering (core/identity.ts), over whole installations and the declared-name rules:
 *
 * - one schema installed under two schema names installs alike: every name that depends on the installation is
 *   `<schema>__<name>` or hashed, so the two install scripts are one script once the installation is abstracted
 *   (test/pg/migrate/support.ts installationAbstraction), whatever the two names, one a prefix of the other included;
 *   and every object named by its definition's digest is named alike, its definition read in no schema
 *   (sql/type-schemas.ts digestedHooks), where the definitions fixture's contracts over a contract, over a closed id
 *   and calling Xml.isPattern, its CHECK's row function calling a closed relation's constant and its generated set
 *   field's row function of no parameter each read the installation's schema;
 * - a COMMENT names a hashed object only, and says what its identity is: a readable name spells its identity itself;
 * - two declared names of one namespace that convert alike are one name, refused as IdentifierCollision, and a name the
 *   rule refuses is refused: by its characters (a leading `_`) as MalformedDescription, by a conversion past
 *   maxIdentifierBytes as IdentifierTooLong;
 * - the census admits distinct hashed identities of distinct identifiers, and refuses two distinct identities of one
 *   identifier, a digest collision, as DigestCollision naming both, before anything is installed;
 * - a migration's census of its temporaries (TemporaryCensus), over the hashed names an installed snapshot leaves
 *   standing, admits every distinct temporary under its identifier and one minted again under the same, and refuses
 *   one whose identifier a standing name or another temporary has as DigestCollision naming both, where it is minted.
 *
 * Oracles: the installation abstraction as the differential between two schema names; the comment's contract (a hashed
 * object's comment is its identity's display); the declared-name rule itself (parseDeclaredName, conversionOf), whose
 * classification of the dictionary (test/support/kernel/dict.ts) the schema's namespaces must agree with; and the
 * census's contract over forged twins, which share an identifier and differ in identity.
 *
 * Features: two plain schema names and one a prefix of the other, a hashed object commented, a definition over the
 * installation's names; relations alike, fields
 * alike, a refused relation name, a refused field name; an admission and a digest collision; a temporary admitted,
 * minted again, meeting a standing name, meeting another temporary.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	censusOf,
	type Identity,
	identity,
	parseNameCharacters,
	TemporaryCensus,
	type TemporaryKind
} from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { installationAbstraction } from "#test/pg/migrate/support.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import {
	admitsAll,
	censusGen,
	collides,
	declaredNamesGen,
	fixtureOf,
	type InstallFeature,
	installationGen,
	installed,
	type RuleFeature,
	schemaOf,
	snapshots,
	targetName,
	type TemporaryFeature,
	temporariesGen,
	temporaryOf
} from "#test/unit/core/identity.fixtures.ts"

/** The naming door installs one schema under two schema names alike, and comments exactly its hashed objects. */
export const theNamingDoorInstallsOneSchemaUnderTwoSchemaNamesAlikeAndCommentsExactlyItsHashedObjects =
	property.exhaust(finite(installationGen), {
		box: "the shop, the ledger and the definitions, each under every pair of four schema names",
		needs: {},
		situations: [
			"two plain names",
			"one name a prefix of the other",
			"a hashed object commented",
			"a definition over the installation's names"
		] satisfies ReadonlyArray<Reached<InstallFeature>>,
		check:
			(_, c: Case<InstallFeature>) =>
			([fixture, [a, b]]) =>
				Effect.sync(() => {
					c.note(
						Str.startsWith(b)(a) || Str.startsWith(a)(b)
							? "one name a prefix of the other"
							: "two plain names"
					)
					if (fixture === "definitions") {
						c.note("a definition over the installation's names")
					}
					const { schema, server } = fixtureOf(fixture)
					const owned = owning(schema)
					const [x, y] = [
						installed(owned, server, identity.schema(parsedSchemaName(a))),
						installed(owned, server, identity.schema(parsedSchemaName(b)))
					]
					assert.equal(
						installationAbstraction(x)(Arr.join(installationSql(x, "abstracted"), "\n")),
						installationAbstraction(y)(Arr.join(installationSql(y, "abstracted"), "\n")),
						`${fixture} under ${a} and ${b}`
					)
					const commented = (i: typeof x) => {
						const hashed = new Map<string, Identity<IdentityKind>>(
							Arr.flatMap(i.identities, (named) =>
								named.form === "hashed" ? [[named.identifier, named] as const] : []
							)
						)
						for (const comment of Arr.flatMap(i.manifest.comments, (s) =>
							s.kind === "comment" ? [s] : []
						)) {
							const named = hashed.get(targetName(comment.on))
							assert.ok(
								named !== undefined,
								`${comment.on.kind} ${targetName(comment.on)} is a hashed object`
							)
							assert.equal(comment.text, named.display)
							c.note("a hashed object commented")
						}
					}
					commented(x)
					commented(y)
				}),
		oracle: {
			kind: "universal",
			name: "one script under two schema names, once the installation is abstracted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					"export const displayOf = (identity: Identity<IdentityKind>): string => identity.display",
				replacement:
					"export const displayOf = (identity: Identity<IdentityKind>): string => identity.canonical",
				why: "a hashed object's COMMENT holds its identity's canonical text, not its display; the comment property fails."
			},
			{
				file: "packages/engine/src/sql/type-schemas.ts",
				original:
					"\tfunctionRef: (f) => (installed.has(f.schema) ? { ...f, schema: digestedTypes } : f),\n",
				replacement: "\tfunctionRef: (f) => f,\n",
				why: "An identity digests its definition's calls of the installation's functions by their schema, so a row function calling a closed relation's constant and a contract calling Xml.isPattern are named apart under two schema names: a fresh install of a migrated history names its row functions apart from the history's, as test/pg/migrate/fixtures met for Payroll's levy_line."
			},
			{
				file: "packages/engine/src/sql/type-schemas.ts",
				original:
					'\t\tt.kind === "named" && installed.has(t.schema) ? { ...t, schema: digestedTypes } : t\n',
				replacement: "\t\tt\n",
				why: "An identity digests its definition's types of the installation's domains by their schema, so a contract over another contract or over a closed id, and a row function returning a roster's bits domain, are named apart under two schema names."
			}
		]
	})

/**
 * The refusal of a name the declared-name rule refuses, by the rule's own classification: IdentifierTooLong where its
 * characters keep the rule and so its conversion passes PostgreSQL's identifiers, MalformedDescription where they don't.
 */
const ruleRefusalOf = (name: string): "IdentifierTooLong" | "MalformedDescription" =>
	parseNameCharacters(name).ok ? "IdentifierTooLong" : "MalformedDescription"

/** The naming door refuses two declared names of one namespace that convert alike, and every name the rule refuses. */
export const theNamingDoorRefusesTwoDeclaredNamesOfOneNamespaceThatConvertAlikeAndEveryNameTheRuleRefuses =
	property.exhaust(finite(declaredNamesGen), {
		box: "every alias pair and every refused name of the identifier dictionary, as relations and as fields",
		needs: {},
		situations: [
			"relations alike",
			"fields alike",
			"a refused relation name",
			"a refused field name"
		] satisfies ReadonlyArray<Reached<RuleFeature>>,
		check: (_, c: Case<RuleFeature>) => (drawn) =>
			Effect.sync(() => {
				c.note(drawn.kind)
				switch (drawn.kind) {
					case "relations alike":
						refused(
							ownedInput(
								schemaOf([
									relation(drawn.p, { id: f.uuid }, ["id"]),
									relation(drawn.q, { id: f.uuid }, ["id"])
								])
							),
							"IdentifierCollision",
							`${drawn.p} beside ${drawn.q}`
						)
						return
					case "fields alike":
						refused(
							ownedInput(
								schemaOf([
									relation("Pair", { id: f.uuid, [drawn.p]: f.bigint, [drawn.q]: f.bigint }, ["id"])
								])
							),
							"IdentifierCollision",
							`${drawn.p} beside ${drawn.q}`
						)
						return
					case "a refused relation name":
						refused(
							ownedInput(schemaOf([relation(drawn.p, { id: f.uuid }, ["id"])])),
							ruleRefusalOf(drawn.p),
							drawn.p
						)
						return
					case "a refused field name":
						refused(
							ownedInput(schemaOf([relation("Item", { id: f.uuid, [drawn.p]: f.bigint }, ["id"])])),
							ruleRefusalOf(drawn.p),
							drawn.p
						)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the declared-name rule's own classification"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\t\tconst parsed = parsedName(name)",
				replacement:
					'\t\tconst parsed = parsedName(name.replace(/[^A-Za-z0-9_]/gu, "_").replace(/^[^A-Za-z]/u, "N"))',
				why: "Ownership declares a name the declared-name rule refuses under a spelling the rule admits (core/identity.ts DeclaredNamespace.declare), so a refused relation name and a refused field name are owned; the property fails at each, the one boundary that parses them, the type reading no character of a name."
			}
		]
	})

/** The naming door admits distinct hashed identities, and refuses two distinct identities of one identifier as DigestCollision. Its budget is its suite's before it was a property (test/unit/core/identity.test.ts at 4ca3036a): 200 runs and 50 steered cases. */
export const theNamingDoorAdmitsDistinctHashedIdentitiesAndRefusesTwoDistinctIdentitiesOfOneIdentifierAsDigestCollision =
	property.explore(censusGen, {
		needs: {},
		budget: { runs: 200, steered: 50 },
		situations: ["admitted", "a digest collision"] satisfies ReadonlyArray<
			Reached<"admitted" | "a digest collision">
		>,
		check:
			(_, c: Case<"admitted" | "a digest collision">) =>
			({ fields, twin, at }) =>
				Effect.sync(() => {
					const minted = Arr.map(Arr.dedupe(fields), (field) => identity.normCheck("Item", field))
					const original = defined(minted[at % minted.length], "a minted identity")
					if (!twin) {
						c.note("admitted")
						const census = succeeded(censusOf(minted))
						assert.equal(census.hashed.size, minted.length)
						return
					}
					c.note("a digest collision")
					const forged: Identity<IdentityKind> = {
						...original,
						canonical: `${original.canonical}'`,
						display: `a twin of ${original.display}`
					}
					const reason = refused(censusOf([...minted, forged]), "DigestCollision").reason
					if (reason._tag !== "DigestCollision") {
						return assert.fail(`a DigestCollision, not ${reason._tag}`)
					}
					assert.equal(reason.identifier, original.identifier)
					assert.deepEqual(
						[reason.display, reason.otherDisplay],
						[original.display, forged.display]
					)
				}),
		oracle: {
			kind: "specification",
			name: "a forged twin: one identifier, another identity"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\t\tseen.set(i.identifier, i)\n",
				replacement: "",
				why: "the census never records an identity it has seen, so it never finds a digest collision; the census property fails."
			}
		]
	})

/** The naming door admits a migration's distinct temporaries, and refuses one meeting a standing name or another temporary as DigestCollision where it is minted. Its budget is its suite's before it was a property (test/unit/core/identity.test.ts at 4ca3036a): 300 runs and 50 steered cases. */
export const theNamingDoorAdmitsAMigrationsDistinctTemporariesAndRefusesOneMeetingAStandingNameOrAnotherTemporaryAsDigestCollisionWhereItIsMinted =
	property.explore(temporariesGen, {
		needs: {},
		budget: { runs: 300, steered: 50 },
		situations: [
			"admitted",
			"minted again",
			"a standing name met",
			"two temporaries met"
		] satisfies ReadonlyArray<Reached<TemporaryFeature>>,
		check:
			(_, c: Case<TemporaryFeature>) =>
			({ snapshot, steps, meets, at }) =>
				Effect.sync(() => {
					const { standing, names } = snapshots[snapshot]
					const minted: Array<Identity<TemporaryKind>> = []
					for (const step of steps) {
						const prior = minted[step.of % Math.max(minted.length, 1)]
						minted.push(
							step.again && prior !== undefined
								? prior
								: temporaryOf[step.kind](
										defined(names[step.of % names.length], "a standing identifier")
									)
						)
					}
					const target = defined(minted[at % minted.length], "a minted temporary")
					switch (meets) {
						case "nothing": {
							admitsAll(new TemporaryCensus(standing), minted)
							c.note("admitted")
							if (new Set(minted).size < minted.length) {
								c.note("minted again")
							}
							return
						}
						case "a standing name": {
							c.note("a standing name met")
							const live = {
								identifier: target.identifier,
								display: `an object standing under ${target.display}`
							}
							const census = new TemporaryCensus([...standing, live])
							const first = Option.getOrThrowWith(
								Arr.findFirstIndex(minted, (t) => t.identifier === target.identifier),
								() => new Error("the target among the minted temporaries")
							)
							admitsAll(census, minted.slice(0, first))
							collides(census, target, live.display)
							return
						}
						case "another temporary": {
							c.note("two temporaries met")
							const twin: Identity<TemporaryKind> = {
								...target,
								canonical: `${target.canonical}'`,
								display: `a twin of ${target.display}`
							}
							const census = new TemporaryCensus(standing)
							admitsAll(census, minted.slice(0, minted.indexOf(target) + 1))
							collides(census, twin, target.display)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "a forged twin or a standing name at one identifier"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\t\tif (prior !== undefined && prior.canonical !== temporary.canonical) {",
				replacement: "\t\tif (prior !== undefined) {",
				why: "a temporary minted again refused as its own twin; the temporary census property fails."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: "\t\tconst standing = this.#standing.get(identifier)",
				replacement: "\t\tconst standing = this.#standing.get(temporary.display)",
				why: "TemporaryCensus looks a temporary up among the standing names by its display, not its identifier, so a temporary never meets a standing name; the temporary census property fails."
			}
		]
	})
