/**
 * W6.Q10, a domain is its definition (physical/ddl/domains.ts): a contract's domain is named by the digest of its
 * physical definition, its base type, collation and CHECK, so two contracts of one definition share one domain and two
 * of different definitions never do.
 *
 * Over every pair of contracts A and B, each over one of three bases (integer, bigint, wildcard text) under one of two
 * predicates (none, and VALUE >= 0), on two columns of one relation:
 * - the columns' types name one domain exactly when the pairs' bases and predicates are equal (metamorphic: equal
 *   definitions, equal names; any difference, a new name);
 * - the installation creates each distinct definition's domain once, so the CREATE DOMAINs of contract domains are as
 *   many as the distinct definitions;
 * - a role that writes the relation holds USAGE once per domain;
 * - a shared checked domain's constraint reports every contract sharing it, and names each column's contract by the
 *   column, so a violation on either column reports that column's law.
 *
 * The oracle is the definition equality stated over the case's choices, never read from the installation. The box: 3
 * bases × 2 predicates, squared, exhausted (36 cases).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { decodeDesc, type ExprDesc, type FieldDesc, type LiteralDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { fullRoleDesc, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { decodedSchema, f, ge, literal, relation, value } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

const bases = ["integer", "bigint", "text"] as const
type Base = (typeof bases)[number]
const predicates = ["none", "nonnegative"] as const
type Predicate = (typeof predicates)[number]

/** A contract's definition as the case states it. */
interface Definition {
	readonly base: Base
	readonly predicate: Predicate
}

interface Pair {
	readonly a: Definition
	readonly b: Definition
}

const definitionGen: Gen<Definition> = (source) => ({
	base: source.draw(element(bases)),
	predicate: source.draw(element(predicates))
})

const pairGen: Gen<Pair> = (source) => ({
	a: source.draw(definitionGen),
	b: source.draw(definitionGen)
})

const baseDesc: { readonly [B in Base]: FieldDesc } = {
	integer: f.integer,
	bigint: f.bigint,
	text: f.wildcard
}

/** The zero of each base, a literal of its own type: the bound a predicate compares VALUE with. */
const zero: { readonly [B in Base]: LiteralDesc } = { integer: 0, bigint: 0n, text: "" }

/** VALUE >= zero, its base's own literal. */
const predicateDesc = (d: Definition): ExprDesc | undefined =>
	d.predicate === "none" ? undefined : ge(value, literal(zero[d.base]))

const contractDesc = (name: string, d: Definition): FieldDesc =>
	f.contract(name, baseDesc[d.base], predicateDesc(d))

const same = (x: Definition, y: Definition): boolean =>
	x.base === y.base && x.predicate === y.predicate

const loc = SourceLoc("domain dedup case", [])

const installationOf = (p: Pair): Installation => {
	const owned = owning(
		decodedSchema({
			name: "Dedup",
			relations: [
				relation("Item", { id: f.uuid, a: contractDesc("A", p.a), b: contractDesc("B", p.b) }, [
					"id"
				])
			],
			statements: [],
			extends: undefined
		})
	)
	const app = succeeded(fullRoleDesc(owned.desc, "app", loc))
	const login = succeeded(
		Result.flatMap(
			decodeDesc("login", { name: "desk", base: owned.desc, roles: [app], loc }),
			ownLogin
		)
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				owned.installation,
				[login],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

type DedupFeature =
	| "a shared domain"
	| "two domains"
	| "a shared checked domain"
	| "a base shared, predicates apart"

const featuresOf = (p: Pair): ReadonlyArray<DedupFeature> => [
	same(p.a, p.b) ? "a shared domain" : "two domains",
	...(same(p.a, p.b) && p.a.predicate === "nonnegative"
		? ["a shared checked domain" as const]
		: []),
	...(p.a.base === p.b.base && p.a.predicate !== p.b.predicate
		? ["a base shared, predicates apart" as const]
		: [])
]

/** The contract domains a case's installation creates: every CREATE DOMAIN but the roster and text ones, which this
 * schema has none of. */
const domainsOf = (
	i: Installation
): ReadonlyArray<Extract<SqlStatement, { readonly kind: "createDomain" }>> =>
	Arr.filter(
		i.statements,
		(s): s is Extract<SqlStatement, { readonly kind: "createDomain" }> => s.kind === "createDomain"
	)

describe("contract domains by definition (W6.Q10)", () => {
	it.effect("share one domain exactly when their definitions are equal", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/physical/domain-dedup",
					generator: pairGen,
					literal: Formatter.format,
					limit: 36,
					coverage: requiredInSpace<DedupFeature>([
						"a shared domain",
						"two domains",
						"a shared checked domain",
						"a base shared, predicates apart"
					]),
					caseHang
				},
				(p, c) =>
					Effect.sync(() => {
						for (const feature of featuresOf(p)) {
							c.note(feature)
						}
						const i = installationOf(p)
						const a = i.names.contractDomain(succeeded(parseDeclaredName("A")))
						const b = i.names.contractDomain(succeeded(parseDeclaredName("B")))
						assert.equal(
							a.name === b.name,
							same(p.a, p.b),
							"one domain exactly for equal definitions"
						)
						assert.equal(
							domainsOf(i).length,
							same(p.a, p.b) ? 1 : 2,
							"each distinct definition's domain is created once"
						)
						const usage = Arr.flatMap(i.statements, (s) =>
							s.kind === "grant" && s.on.kind === "DOMAIN" ? Arr.map(s.on.names, (n) => n.name) : []
						)
						assert.equal(new Set(usage).size, usage.length, "USAGE once per domain")
						if (same(p.a, p.b) && p.a.predicate === "nonnegative") {
							const entry = defined(
								Arr.findFirst(
									i.constraintLaws,
									(cl) => cl.kind === "domainConstraint" && cl.owner === a.name
								).pipe(Option.getOrUndefined),
								"the shared domain's constraint"
							)
							assert.equal(entry.laws.length, 2, "the shared constraint reports both contracts")
							assert.ok(
								entry.kind === "domainConstraint" &&
									entry.uses.length === 2 &&
									new Set(Arr.map(entry.uses, (u) => u.law)).size === 2,
								"each column names its own contract's law"
							)
						}
					})
			)
		)
	)
})
