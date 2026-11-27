/** What the property of named-domains.test.ts reads: its box, the installation of a case and the domains' namers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { ledgerTable } from "#compiler/deploy/ledger/ledger.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { admitLoginRoles, type FieldDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { fullRoleDesc, installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { closed, decodedSchema, f, relation } from "#test/support/fixtures/ir/desc.ts"
import { owning } from "#test/support/policy.ts"

/** What a contract is over: a refined text, a contract over one, an integer, or a closed id. */
const bases = ["refined text", "contract over refined text", "integer", "closed id"] as const

type Base = (typeof bases)[number]

/** A case: the contract C's base, and whether a field beside C's is typed by C's refined text itself. */
export interface NamedCase {
	readonly base: Base
	readonly bare: boolean
}

export const namedCaseGen: Gen<NamedCase> = (source) => ({
	base: source.draw(element(bases)),
	bare: source.draw(boolean)
})

/** The refined text the cases' contracts rest on and the bare field is typed by. */
const word: FieldDesc = f.regex("^[a-z]+$", "u")

const baseDesc: { readonly [B in Base]: FieldDesc } = {
	"refined text": word,
	"contract over refined text": f.contract("Inner", word, undefined),
	integer: f.integer,
	"closed id": f.closedId("Kind")
}

const loc = SourceLoc("named domains case", [])

/** The installation of a case: Item(id, c: C, and w: the refined text where `bare`), beside the closed relation Kind
 * where C is over its closed id, with one login whose one full role reads and writes Item, so the installation grants
 * its domains. */
export const installationOf = (c: NamedCase): Installation => {
	const owned = owning(
		decodedSchema({
			name: "Named",
			relations: [
				...(c.base === "closed id" ? [closed.ordered("Kind", ["a", "b"])] : []),
				relation(
					"Item",
					{
						id: f.uuid,
						c: f.contract("C", baseDesc[c.base], undefined),
						...(c.bare ? { w: word } : {})
					},
					["id"]
				)
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

export type NamedFeature =
	| "a contract over a refined text"
	| "a contract over a contract over a refined text"
	| "a contract over an integer"
	| "a contract over a closed id"
	| "the refined text typing a field of its own"

export const featuresOf = (c: NamedCase): ReadonlyArray<NamedFeature> => [
	c.base === "refined text"
		? "a contract over a refined text"
		: c.base === "contract over refined text"
			? "a contract over a contract over a refined text"
			: c.base === "integer"
				? "a contract over an integer"
				: "a contract over a closed id",
	...(c.bare ? ["the refined text typing a field of its own" as const] : [])
]

/** A domain an installation creates, by its name, and the statement that creates it. */
type Created = Extract<SqlStatement, { readonly kind: "createDomain" }>

/** The domains an installation creates. */
const createdDomains = (i: Installation): ReadonlyArray<Created> =>
	Arr.filter(i.statements, (s): s is Created => s.kind === "createDomain")

/**
 * The domains an installation plans from its schema's types, which something must name: every domain it creates but
 * natural's, grizzle's own contract, which every installation holds whether or not a field holds it, since a count is
 * a natural wherever a query reads one (5757e399b).
 */
export const plannedDomains = (i: Installation): ReadonlyArray<Created> => {
	const natural = i.names.contractDomain(succeeded(parseDeclaredName("natural")))
	return Arr.filter(
		createdDomains(i),
		(d) => !(d.name.schema === natural.schema && d.name.name === natural.name)
	)
}

/** Whether a statement only states objects of its own: a comment on one, or a privilege on some, none a use of them. */
const statesOnly = (s: SqlStatement): boolean =>
	s.kind === "comment" || s.kind === "grant" || s.kind === "revoke"

/**
 * The statements that may name the domain `d` creates: every statement of the installation but `d` itself and those
 * that only state objects (statesOnly), another domain's creation among them, whose base or CHECK may name it; and
 * grizzle's ledger table, whose digests the SHA-256 digest domain types (deploy/ledger/ledger.ts ledgerTable), which
 * every migration's Prepare creates beside the installation.
 */
export const namersOf = (i: Installation, d: Created): ReadonlyArray<SqlStatement> => [
	...Arr.filter(i.statements, (s) => s !== d && !statesOnly(s)),
	ledgerTable(i.names.schema)
]

/** Whether a statement names the object `name` of `schema`, as any of its object names, in its canonical text. */
export const names = (s: SqlStatement, schema: string, name: string): boolean =>
	Str.includes(Str.slice(1, -1)(canonicalTextOf({ schema, name })))(canonicalTextOf(s))

/** The domains each GRANT USAGE ON DOMAIN of an installation names, by schema and name. */
export const grantedDomains = (
	i: Installation
): ReadonlyArray<{ readonly schema: string; readonly name: string }> =>
	Arr.flatMap(i.statements, (s) =>
		s.kind === "grant" && s.on.kind === "DOMAIN" && Arr.contains(s.privileges, "USAGE")
			? s.on.names
			: []
	)
