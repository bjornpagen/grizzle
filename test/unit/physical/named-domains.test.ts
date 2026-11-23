/**
 * A domain exists, and a role holds USAGE on it, only where something names it (physical/ddl/domains.ts
 * typeRefinements, restingDomains): every domain an installation plans from its schema's types (every CREATE DOMAIN but
 * natural's, grizzle's own, which every installation holds) is named by another of its statements, a column's type,
 * another domain's base or CHECK, a function's signature or body, a cast, or grizzle's ledger table, never by its own
 * creation, comment and privileges alone; and every domain a role is granted USAGE on is one the installation creates.
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
	createdDomains,
	endpointCaseGen,
	endpointDomain,
	endpointInstallationOf,
	featuresOf,
	grantedDomains,
	installationOf,
	namedCaseGen,
	type NamedFeature,
	names,
	namersOf,
	plannedDomains
} from "#test/unit/physical/named-domains.fixtures.ts"

/** Every domain an installation creates is named by something, and every domain a role is granted is created. */
export const everyDomainAnInstallationCreatesIsNamedBySomethingAndEveryDomainARoleIsGrantedIsCreated =
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
				const created = createdDomains(i)
				for (const d of plannedDomains(i)) {
					assert.ok(
						Arr.some(namersOf(i, d), (s) => names(s, d.name.schema, d.name.name)),
						`the domain ${d.name.name} is named by nothing but its own creation, comment and privileges`
					)
				}
				for (const g of grantedDomains(i)) {
					assert.ok(
						Arr.some(created, (d) => d.name.schema === g.schema && d.name.name === g.name),
						`a role is granted USAGE on ${g.name}, a domain the installation does not create`
					)
				}
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
				original: "\treturn own === undefined ? [] : [own]\n",
				replacement:
					"\treturn [...(own === undefined ? [] : [own]), ...(t.contract === undefined ? [] : typeRefinements(t.contract.base))]\n",
				why: "The installation holds the text domain of a contract's refined base again (eb07f21f5's collector, down each contract's chain), which nothing names: the contract's domain carries its pattern over `text`."
			},
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\t\trestingDomains(b, contract.base, use)\n",
				replacement: "\t\ttypeDomains(b, contract.base, use)\n",
				why: "A role reading a contract's column is granted every domain its base's type names (typeDomains down the contract's base), a refined base's text domain among them, which nothing rests on and the installation does not create."
			}
		]
	})

/**
 * A role holds USAGE on a span's endpoint contract only where a column it reads or writes is typed by that contract
 * itself: a span column is its range, a builtin, and a value cast to the contract needs no USAGE, so the span alone
 * grants none (physical/ddl/domains.ts typeDomains). Over Item(id, during: a span over C), with and without a field
 * typed by C itself, in an installation of one login whose full role reads and writes Item; the oracle is the
 * specification, read off the installation's grants. The box: 2 cases, exhausted.
 */
export const aRoleHoldsUsageOnASpansEndpointContractOnlyWhereAColumnItHoldsIsTypedByIt =
	property.exhaust(finite(endpointCaseGen), {
		needs: {},
		situations: [],
		check: () => (k) =>
			Effect.sync(() => {
				const i = endpointInstallationOf(k)
				const c = endpointDomain(i)
				assert.equal(
					Arr.some(grantedDomains(i), (g) => g.schema === c.schema && g.name === c.name),
					k.typed,
					k.typed
						? "the role holds USAGE on C, which a column it holds is typed by"
						: "the role holds no USAGE on C, which only a span's endpoints are"
				)
			}),
		oracle: {
			kind: "specification",
			name: "USAGE on a domain only where a column the role holds is typed by it; a span column is its builtin range"
		},
		box: "a span over a contract C on Item, with and without a field typed by C",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\tcarrierDomains(b, t, use)\n",
				replacement:
					'\tcarrierDomains(b, t, use)\n\tif ("span" in t) {\n\t\ttypeDomains(b, t.span.endpoint, use)\n\t}\n',
				why: "A role reading or writing a span column is granted USAGE on its endpoint contract's domain, which no column of it is typed by: excess privilege."
			}
		]
	})
