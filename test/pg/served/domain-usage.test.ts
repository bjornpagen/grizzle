/**
 * A role that holds USAGE on no domain runs every served statement over values of the installation's domains, on
 * PostgreSQL 19: a write that stands up a carrier of a contract's, a closed id's and a set's fields and casts its values
 * into their domains as it writes them, and a read by a refined and a closed id parameter beside the session's claim of
 * a closed id, judged by its domain. PostgreSQL checks a type's USAGE only where a statement creates an object of it,
 * and a role's one object, its session's carrier, holds its values by their session types (ir/physical.ts
 * sessionTypeRef), so the installation grants USAGE on no domain (physical/ddl/roles.ts addRole).
 *
 * Oracle: PostgreSQL itself: the writer holds USAGE on no domain of the installation (has_type_privilege), and every
 * call succeeds, the read finding the note the write put.
 *
 * The box, exhausted: the write, and the read after it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	calls,
	type DomainUsageFeature,
	domainUsageCase
} from "#test/pg/served/domain-usage.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A role holding USAGE on no domain runs every served statement over values of the installation's domains. */
export const aRoleHoldingUsageOnNoDomainRunsEveryServedStatementOverValuesOfTheInstallationsDomains =
	property.exhaust(finite(calls), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a write of every kind of domain by a role holding USAGE on no domain",
			"a read by refined and closed id parameters by a role holding USAGE on no domain"
		] satisfies ReadonlyArray<Reached<DomainUsageFeature>>,
		check:
			({ substrate }, c: Case<DomainUsageFeature>) =>
			(call) =>
				Effect.provideServiceEffect(
					domainUsageCase(call, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's privileges: has_type_privilege of every domain, and its acceptance of every served statement"
		},
		box: "the write of the notes through their carrier, and the read by refined and closed id parameters after it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/physical.ts",
				original: "\t\t: baseTypeRef(names, t)\n",
				replacement: "\t\t: fieldColumnType(names, t).type\n",
				why: "USAGE deleted while a carrier still names a domain: the writer's stand-up of its carrier, a column of it typed by Words, is refused 42501, permission denied for type."
			}
		]
	})
