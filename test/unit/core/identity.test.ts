import { describe, it } from "@effect/vitest"
import { drawn, exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { AnyLogin, AnySchema } from "#compiler/public/schema.ts"
import { type Owned, ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { CommentTarget } from "#compiler/sql/ast.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import { installationAbstraction } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import { aliasGroups, refusedNames } from "#test/support/kernel/dict.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"

/**
 * The naming door's rendering (core/identity.ts), over whole installations and the declared-name rules:
 *
 * - one schema installed under two schema names installs alike: every name that depends on the installation is
 *   `<schema>__<name>` or hashed, so the two install scripts are one script once the installation is abstracted
 *   (test/pg/migrate/support.ts installationAbstraction), whatever the two names, one a prefix of the other included;
 * - a COMMENT names a hashed object only, and says what its identity is: a readable name spells its identity itself;
 * - two declared names of one namespace that convert alike are one name, refused as IdentifierCollision, and a name the
 *   rule refuses (a leading `_`, a conversion past 63 bytes) is refused as MalformedDescription.
 */

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
	return succeeded(compileInstallation(owned, completeInstallOptions(owned, at, logins, [])))
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
		case "TYPE":
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
							suite: "unit/core/identity-installations",
							generator: (source) =>
								[
									source.draw(element<Fixture>(["shop", "ledger"])),
									source.draw(element(nonEmpty(pairs, "pairs of schema names")))
								] as const,
							literal: Formatter.format,
							limit: 2 * pairs.length,
							features: features<InstallFeature>([
								"two plain names",
								"one name a prefix of the other",
								"a hashed object commented"
							]),
							caseHang: Duration.minutes(2)
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
									installationAbstraction(x)(Arr.join(x.sql, "\n")),
									installationAbstraction(y)(Arr.join(y.sql, "\n")),
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
							limit: 2 * (alike.length + refusedNames.length),
							features: features<RuleFeature>([
								"relations alike",
								"fields alike",
								"a refused relation name",
								"a refused field name"
							]),
							caseHang: Duration.minutes(2)
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
										assert.ok(
											!ownedInput(schemaOf([relation(drawn.p, { id: f.uuid }, ["id"])])).ok,
											drawn.p
										)
										return
									case "a refused field name":
										assert.ok(
											!ownedInput(
												schemaOf([relation("Item", { id: f.uuid, [drawn.p]: f.bigint }, ["id"])])
											).ok,
											drawn.p
										)
								}
							})
					)
				)
			})
	)
})
