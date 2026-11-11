/**
 * The naming door's rendering (core/identity.ts), over whole installations and the declared-name rules:
 *
 * - one schema installed under two schema names installs alike: every name that depends on the installation is
 *   `<schema>__<name>` or hashed, so the two install scripts are one script once the installation is abstracted
 *   (test/pg/migrate/support.ts installationAbstraction), whatever the two names, one a prefix of the other included;
 * - a COMMENT names a hashed object only, and says what its identity is: a readable name spells its identity itself;
 * - two declared names of one namespace that convert alike are one name, refused as IdentifierCollision, and a name the
 *   rule refuses (a leading `_`, a conversion past maxIdentifierBytes) is refused as MalformedDescription;
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
 * Features: two plain schema names and one a prefix of the other, a hashed object commented; relations alike, fields
 * alike, a refused relation name, a refused field name; an admission and a digest collision; a temporary admitted,
 * minted again, meeting a standing name, meeting another temporary.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): identity-comment-canonical (a comment holding the canonical text, not
 * the display), identity-declared-by-spelling (a namespace keyed by the spelling, not the conversion),
 * identity-census-blind (the census never looks for a collision), identity-temporary-standing-blind (a temporary never
 * meets a standing name) and identity-temporary-again-refused (a temporary minted again refused as its own twin).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import {
	censusOf,
	type Identity,
	identity,
	TemporaryCensus,
	type TemporaryKind
} from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { hashedNames } from "#compiler/physical/install/comments.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { AnyLogin, AnySchema } from "#compiler/public/schema.ts"
import { type Owned, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { CommentTarget } from "#compiler/sql/ast.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import { installationAbstraction } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import { allocatedLevels, installationSql } from "#test/support/compile.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import { aliasGroups, refusedNames } from "#test/support/kernel/dict.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput, owning } from "#test/support/policy.ts"

/** A fixture with its login: the shop, and the ledger, whose residual law and derived relation install as extensions. */
type Fixture = "shop" | "ledger"

/** The fixtures, each declared under one name and installed under two. */
const declaredUnder = "names"
const fixtureOf = (fixture: Fixture): { readonly schema: AnySchema; readonly server: AnyLogin } =>
	fixture === "shop" ? shopV1(declaredUnder, "none") : ledger(declaredUnder)

/**
 * The schema names an installation is drawn under, none of which the declared name, a digest or another name holds as
 * a part: plain pairs, and pairs one of which is a prefix of the other.
 */
const schemaNames = ["gz_naming_one", "gz_naming_two", "gz_naming", "gz_naming_alt"] as const

const installed = (owned: Owned, login: AnyLogin, at: Identity<"schema">): Installation => {
	const logins = [succeeded(ownLogin(defined(loginDescOf(login), "a login value")))]
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				allocatedLevels(at, owned.levels),
				logins,
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

/** The identifier a COMMENT's target names. */
const targetName = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
			return on.name
		case "COLUMN":
			return on.column
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
		case "DOMAIN CONSTRAINT":
			return on.name
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "DOMAIN":
		case "SEQUENCE":
		case "INDEX":
		case "STATISTICS":
		case "FUNCTION":
			return on.name.name
	}
}

type InstallFeature =
	| "two plain names"
	| "one name a prefix of the other"
	| "a hashed object commented"

/** Each temporary kind's constructor: the names a migration sets an object aside and swaps an index under. */
const temporaryOf: { readonly [K in TemporaryKind]: (of: string) => Identity<K> } = {
	aside: identity.aside,
	swap: identity.swap
}

/** Admits each of `temporaries` in order, each under its own identifier. */
const admitsAll = (
	census: TemporaryCensus,
	temporaries: ReadonlyArray<Identity<TemporaryKind>>
): void => {
	for (const t of temporaries) {
		assert.equal(succeeded(census.admit(t)), t.identifier, t.display)
	}
}

/** Refuses `temporary` as DigestCollision of its identifier, naming `display` before it and its own display after. */
const collides = (
	census: TemporaryCensus,
	temporary: Identity<TemporaryKind>,
	display: string
): void => {
	const reason = refused(census.admit(temporary), "DigestCollision").reason
	if (reason._tag !== "DigestCollision") {
		return assert.fail(`a DigestCollision, not ${reason._tag}`)
	}
	assert.equal(reason.identifier, temporary.identifier)
	assert.deepEqual([reason.display, reason.otherDisplay], [display, temporary.display])
}

type TemporaryFeature = "admitted" | "minted again" | "a standing name met" | "two temporaries met"

describe("the naming door", () => {
	it.effect(
		"installs one schema under two schema names alike, and comments exactly its hashed objects",
		(ctx) =>
			Effect.gen(function* () {
				const pairs = Arr.flatMap(schemaNames, (a) =>
					Arr.flatMap(schemaNames, (b) => (a < b ? [[a, b] as const] : []))
				)
				yield* searched(
					ctx,
					exhaust(
						{
							box: "the shop and the ledger, each under every pair of four schema names",
							oracle: {
								kind: "universal",
								name: "one script under two schema names, once the installation is abstracted"
							},
							suite: "unit/core/identity-installations",
							generator: (source) =>
								[
									source.draw(element<Fixture>(["shop", "ledger"])),
									source.draw(element(nonEmpty(pairs, "pairs of schema names")))
								] as const,
							literal: Formatter.format,
							coverage: requiredInSpace<InstallFeature>([
								"two plain names",
								"one name a prefix of the other",
								"a hashed object commented"
							]),
							caseHang
						},
						([fixture, [a, b]], c) =>
							Effect.sync(() => {
								c.note(
									Str.startsWith(b)(a) || Str.startsWith(a)(b)
										? "one name a prefix of the other"
										: "two plain names"
								)
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
							})
					)
				)
			})
	)

	type RuleFeature =
		| "relations alike"
		| "fields alike"
		| "a refused relation name"
		| "a refused field name"
	/** A case of the rules: two names that convert alike, as relations or as fields, or one refused name, as either. */
	type Drawn = { readonly kind: RuleFeature; readonly p: string; readonly q: string }

	it.effect(
		"refuses two declared names of one namespace that convert alike, and every name the rule refuses",
		(ctx) =>
			Effect.gen(function* () {
				const alike = Arr.flatMap(aliasGroups, (group) => {
					const [first, second] = group
					return second === undefined ? [] : [[first, second] as const]
				})
				const schemaOf = (relations: ReadonlyArray<ReturnType<typeof relation>>) => ({
					name: "Rules",
					relations,
					statements: [],
					extends: undefined
				})
				yield* searched(
					ctx,
					exhaust(
						{
							box: "every alias pair and every refused name of the identifier dictionary, as relations and as fields",
							oracle: {
								kind: "specification",
								name: "the declared-name rule's own classification"
							},
							suite: "unit/core/identity-declared-names",
							generator: element<Drawn>(
								nonEmpty(
									[
										...Arr.flatMap(alike, ([p, q]): ReadonlyArray<Drawn> => [
											{ kind: "relations alike", p, q },
											{ kind: "fields alike", p, q }
										]),
										...Arr.flatMap(refusedNames, (name): ReadonlyArray<Drawn> => [
											{ kind: "a refused relation name", p: name.declared, q: name.declared },
											{ kind: "a refused field name", p: name.declared, q: name.declared }
										])
									],
									"the declared-name cases"
								)
							),
							literal: Formatter.format,
							coverage: requiredInSpace<RuleFeature>([
								"relations alike",
								"fields alike",
								"a refused relation name",
								"a refused field name"
							]),
							caseHang
						},
						(drawn, c) =>
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
													relation(
														"Pair",
														{ id: f.uuid, [drawn.p]: f.bigint, [drawn.q]: f.bigint },
														["id"]
													)
												])
											),
											"IdentifierCollision",
											`${drawn.p} beside ${drawn.q}`
										)
										return
									case "a refused relation name":
										refused(
											ownedInput(schemaOf([relation(drawn.p, { id: f.uuid }, ["id"])])),
											"MalformedDescription",
											drawn.p
										)
										return
									case "a refused field name":
										refused(
											ownedInput(
												schemaOf([relation("Item", { id: f.uuid, [drawn.p]: f.bigint }, ["id"])])
											),
											"MalformedDescription",
											drawn.p
										)
								}
							})
					)
				)
			})
	)

	it.effect(
		"admits distinct hashed identities, and refuses two distinct identities of one identifier as DigestCollision",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a forged twin: one identifier, another identity"
						},
						suite: "unit/core/identity-census",
						draw: drawn((source) => ({
							fields: source.draw(array(element(["a", "b", "c", "d", "e"]), { min: 1, max: 5 })),
							twin: source.draw(boolean),
							at: source.draw(int(0, 4))
						})),
						literal: Formatter.format,
						coverage: required<"admitted" | "a digest collision">(
							["admitted", "a digest collision"],
							{ cases: 50, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ fields, twin, at }, c) =>
						Effect.sync(() => {
							const minted = Arr.map(Arr.dedupe(fields), (field) =>
								identity.sequence("Item", field)
							)
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
						})
				)
			)
	)

	it.effect(
		"admits a migration's distinct temporaries, and refuses one meeting a standing name or another temporary as DigestCollision where it is minted",
		(ctx) =>
			Effect.gen(function* () {
				const snapshots = new Map(
					Arr.map(["shop", "ledger"] as const, (fixture) => {
						const { schema, server } = fixtureOf(fixture)
						const installation = installed(
							owning(schema),
							server,
							identity.schema(parsedSchemaName("gz_naming"))
						)
						const names = Arr.dedupe(Arr.map(installation.identities, (i): string => i.identifier))
						return [
							fixture,
							{
								standing: hashedNames(installation.manifest.comments),
								names: nonEmpty(names, `${fixture}'s identifiers`)
							}
						] as const
					})
				)
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "a forged twin or a standing name at one identifier"
							},
							suite: "unit/core/identity-temporaries",
							draw: drawn((source) => ({
								snapshot: source.draw(element<Fixture>(["shop", "ledger"])),
								steps: source.draw(
									array(
										(step) => ({
											kind: step.draw(element<TemporaryKind>(["aside", "swap"])),
											of: step.draw(int(0, 0xffff)),
											again: step.draw(boolean)
										}),
										{ min: 1, max: 6 }
									)
								),
								meets: source.draw(
									element<"nothing" | "a standing name" | "another temporary">([
										"nothing",
										"a standing name",
										"another temporary"
									])
								),
								at: source.draw(int(0, 5))
							})),
							literal: Formatter.format,
							coverage: required<TemporaryFeature>(
								["admitted", "minted again", "a standing name met", "two temporaries met"],
								{ cases: 50, sense: notesOnly }
							),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ snapshot, steps, meets, at }, c) =>
							Effect.sync(() => {
								const { standing, names } = defined(snapshots.get(snapshot), snapshot)
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
							})
					)
				)
			})
	)
})
