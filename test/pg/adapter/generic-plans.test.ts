/**
 * Every session grizzle opens plans generically: a login's, every session of a Db's pool, and an owner's, the migration
 * identity's and the command line's (adapter/wire/session.ts connectSession) and a listener's (connectListener), each
 * starts under plan_cache_mode at force_generic_plan (physical/ddl/roles.ts genericPlans), against PostgreSQL 19.
 *
 * Each case opens one session of its kind as a login of a fresh schema holding every fixed login default
 * (roleDefaultSettings, its role storing them as an installed login's does) for the login's pool, and as a login that
 * stores none for an owner's sessions, so the setting it shows is the one its startup sent; and it reads SHOW
 * plan_cache_mode, then the setting's source in pg_settings: the client's own options for both kinds.
 *
 * Oracle: PostgreSQL's own SHOW and pg_settings, read on the session itself.
 *
 * Features: each session kind.
 */

import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type GenericPlansFeature,
	genericPlansFeatures,
	runGenericPlans,
	sessionKinds
} from "#test/pg/adapter/generic-plans.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Every session grizzle opens, a login's and an owner's, starts under plan_cache_mode at force_generic_plan. */
export const everySessionGrizzleOpensALoginsAndAnOwnersStartsUnderGenericPlans = property.exhaust(
	finite(sessionKinds),
	{
		needs: { substrate: Substrate.fresh },
		situations: genericPlansFeatures,
		check:
			({ substrate }, c) =>
			(kind: GenericPlansFeature) =>
				Effect.provideServiceEffect(Effect.scoped(runGenericPlans(kind, c)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's SHOW plan_cache_mode and pg_settings' source, read on the session itself"
		},
		box: "a login's pool session, an owner's session and an owner's listening session, one each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/served.ts",
				original: "\townerStartup: ownerStartupOptions,\n",
				replacement: '\townerStartup: "",\n',
				why: "An owner's session that states its default level alone: the migration identity's and the command line's sessions plan with PostgreSQL's auto mode, five calls with their values first."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: '\t{ parameter: "lc_time", value: "C.UTF-8" },\n\tgenericPlans\n',
				replacement: '\t{ parameter: "lc_time", value: "C.UTF-8" }\n',
				why: "A login's defaults without generic plans: a Db's pool sessions start without them and plan with PostgreSQL's auto mode."
			}
		]
	}
)
