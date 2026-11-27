/**
 * A domain exists only where something names it (physical/ddl/domains.ts typeRefinements, restingDomains): every
 * domain an installation plans from its schema's types (every CREATE DOMAIN but natural's, grizzle's own, which every
 * installation holds) is named by another of its statements, a column's type, another domain's base or CHECK, a
 * function's signature or body, a cast, or grizzle's ledger table, never by its own creation, comment and privileges
 * alone; and no role is granted USAGE on a domain, which PostgreSQL checks only where an object of it is created, and
 * a role creates none, its carriers holding session types (ir/physical.ts sessionTypeRef).
 *
 * Over a contract C on a field of Item, its base a refined text, a contract over one, an integer or a closed id, with
 * and without a field beside it typed by C's refined text itself, in an installation of one login whose full role reads
 * and writes Item. The oracle is the specification, read off the installation's statements: no installation reads its
 * own collector. The box: 4 bases × 2, exhausted (8 cases).
 *
 * Features: each base, and the refined text typing a field of its own.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	featuresOf,
	grantedDomains,
	installationOf,
	namedCaseGen,
	type NamedFeature,
	names,
	namersOf,
	plannedDomains
} from "#test/unit/physical/named-domains.fixtures.ts"

/** Every domain an installation creates is named by something, and no role is granted USAGE on a domain. */
export const everyDomainAnInstallationCreatesIsNamedBySomethingAndNoRoleIsGrantedUsageOnADomain =
	property.exhaust(finite(namedCaseGen), {
		needs: {},
		situations: [
			"a contract over a refined text",
			"a contract over a contract over a refined text",
			"a contract over an integer",
			"a contract over a closed id",
			"the refined text typing a field of its own"
		] satisfies ReadonlyArray<Reached<NamedFeature>>,
		check: (_, c: Case<NamedFeature>) => (k) =>
			Effect.sync(() => {
				for (const feature of featuresOf(k)) {
					c.note(feature)
				}
				const i = installationOf(k)
				for (const d of plannedDomains(i)) {
					assert.ok(
						Arr.some(namersOf(i, d), (s) => names(s, d.name.schema, d.name.name)),
						`the domain ${d.name.name} is named by nothing but its own creation, comment and privileges`
					)
				}
				assert.deepEqual(grantedDomains(i), [], "no role is granted USAGE on a domain")
			}),
		oracle: {
			kind: "specification",
			name: "a domain is named by a statement of the installation that is not its own creation, comment or privilege, or by grizzle's ledger"
		},
		box: "a contract on a field of Item over a refined text, a contract over one, an integer or a closed id, with and without a field typed by the refined text itself",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\treturn own === undefined ? armTypes(t).flatMap(typeRefinements) : [own]\n",
				replacement:
					"\treturn [...(own === undefined ? armTypes(t).flatMap(typeRefinements) : [own]), ...(t.contract === undefined ? [] : typeRefinements(t.contract.base))]\n",
				why: "The installation holds the text domain of a contract's refined base again (eb07f21f5's collector, down each contract's chain), which nothing names: the contract's domain carries its pattern over `text`."
			},
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\t\trestingDomains(b, contract.base, use)\n",
				replacement: "\t\ttypeDomains(b, contract.base, use)\n",
				why: "A role reading a contract's column uses every domain its base's type names (typeDomains down the contract's base), a refined base's text domain among them, which nothing rests on and the installation does not create."
			}
		]
	})
