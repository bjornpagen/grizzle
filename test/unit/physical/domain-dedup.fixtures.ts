/** What the properties of domain-dedup.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import {
	admitLoginRoles,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc
} from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { fullRoleDesc, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { decodedSchema, f, ge, literal, relation, value } from "#test/support/fixtures/ir/desc.ts"
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

export const pairGen: Gen<Pair> = (source) => ({
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

export const same = (x: Definition, y: Definition): boolean =>
	x.base === y.base && x.predicate === y.predicate

/** natural's definition, a bigint never below zero, which every schema holds (schema/own.ts #collectFields). */
const natural: Definition = { base: "bigint", predicate: "nonnegative" }

/** How many distinct definitions the case's installation holds: A's, B's and natural's, each once. */
export const distinctDefinitions = (p: Pair): number =>
	Arr.dedupeWith([p.a, p.b, natural], same).length

const loc = SourceLoc("domain dedup case", [])

export const installationOf = (p: Pair): Installation => {
	const owned = owning(
		decodedSchema({
			name: "Dedup",
			relations: [
				relation("Item", { id: f.uuid, a: contractDesc("A", p.a), b: contractDesc("B", p.b) }, [
					"id"
				])
			],
			statements: [],
			bases: []
		})
	)
	const app = succeeded(fullRoleDesc(owned.desc, "app", loc))
	const login = succeeded(
		Result.flatMap(admitLoginRoles(owned.desc, { name: "desk", roles: [app], loc }), ownLogin)
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				installationsOf(owned),
				[login],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

export type DedupFeature =
	| "a shared domain"
	| "two domains"
	| "a shared checked domain"
	| "a base shared, predicates apart"

export const featuresOf = (p: Pair): ReadonlyArray<DedupFeature> => [
	same(p.a, p.b) ? "a shared domain" : "two domains",
	...(same(p.a, p.b) && p.a.predicate === "nonnegative"
		? ["a shared checked domain" as const]
		: []),
	...(p.a.base === p.b.base && p.a.predicate !== p.b.predicate
		? ["a base shared, predicates apart" as const]
		: [])
]

/** The contract domains a case's installation creates: every CREATE DOMAIN but the roster and text ones, which this
 * schema has none of, and the digest domain (ir/physical.ts PhysicalNames digestDomain), which every Setup creates. */
export const domainsOf = (
	i: Installation
): ReadonlyArray<Extract<SqlStatement, { readonly kind: "createDomain" }>> =>
	Arr.filter(
		i.statements,
		(s): s is Extract<SqlStatement, { readonly kind: "createDomain" }> =>
			s.kind === "createDomain" &&
			!(s.name.schema === i.names.digestDomain.schema && s.name.name === i.names.digestDomain.name)
	)
