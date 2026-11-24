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
 *   many as the distinct definitions, natural's among them, a bigint VALUE >= 0, which every schema holds;
 * - a shared checked domain's constraint reports every contract sharing it, and names each column's contract by the
 *   column, so a violation on either column reports that column's law.
 *
 * The oracle is the definition equality stated over the case's choices, never read from the installation. The box: 3
 * bases × 2 predicates, squared, exhausted (36 cases).
 *
 * Features: a shared domain, two domains, a shared checked domain, and a base shared with predicates apart.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type DedupFeature,
	distinctDefinitions,
	domainsOf,
	featuresOf,
	installationOf,
	pairGen,
	same
} from "#test/unit/physical/domain-dedup.fixtures.ts"

/** Contract domains by definition (W6.Q10) share one domain exactly when their definitions are equal. */
export const contractDomainsByDefinitionW6Q10ShareOneDomainExactlyWhenTheirDefinitionsAreEqual =
	property.exhaust(finite(pairGen), {
		needs: {},
		situations: [
			"a shared domain",
			"two domains",
			"a shared checked domain",
			"a base shared, predicates apart"
		] satisfies ReadonlyArray<Reached<DedupFeature>>,
		check: (_, c: Case<DedupFeature>) => (p) =>
			Effect.sync(() => {
				for (const feature of featuresOf(p)) {
					c.note(feature)
				}
				const i = installationOf(p)
				const a = i.names.contractDomain(succeeded(parseDeclaredName("A")))
				const b = i.names.contractDomain(succeeded(parseDeclaredName("B")))
				assert.equal(a.name === b.name, same(p.a, p.b), "one domain exactly for equal definitions")
				assert.equal(
					domainsOf(i).length,
					distinctDefinitions(p),
					"each distinct definition's domain is created once, natural's among them, which every schema holds"
				)
				if (same(p.a, p.b) && p.a.predicate === "nonnegative") {
					const entry = defined(
						Arr.findFirst(
							i.constraintLaws,
							(cl) => cl.kind === "domainConstraint" && cl.owner === a.name
						).pipe(Option.getOrUndefined),
						"the shared domain's constraint"
					)
					assertVariant(entry, "kind", "domainConstraint", "the shared domain types both columns")
					assert.equal(entry.uses.length, 2, "each contract's column is a use of the shared domain")
					assert.equal(
						new Set(Arr.map(entry.uses, (u) => u.law.law)).size,
						2,
						"each column names its own contract's law, so the shared constraint's laws, its uses', are both contracts'"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "two contracts share a domain exactly when their bases and predicates are equal"
		},
		box: "two contracts, each over integer, bigint or wildcard text, with no predicate or VALUE >= 0",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original:
					"\tdefinitionDigest(\n\t\tinNoSchema(\n\t\t\tnames.installed,\n\t\t\tcontractDefinition(names, { name: contract, base: source.base, check: source.check })\n\t\t)\n\t)",
				replacement:
					"\tdomainDigest(\n\t\t{\n\t\t\tcontract,\n\t\t\tdefinition: definitionDigest(\n\t\t\t\tinNoSchema(\n\t\t\t\t\tnames.installed,\n\t\t\t\t\tcontractDefinition(names, { name: contract, base: source.base, check: source.check })\n\t\t\t\t)\n\t\t\t)\n\t\t},\n\t\teveryProperty\n\t)",
				why: "A contract's domain is named by its contract as well as its definition, so two contracts of one definition never share one."
			}
		]
	})
