/**
 * A session outside any pool ends as a pool's do, against PostgreSQL 19 (adapter/wire/session.ts Session close), through
 * `grizzle migrate`'s own session (migrate/session.ts openMigrationSession): over three endings, a session that made as
 * many temporary tables as a session of pantry's export suite held is closed with its scope, as `grizzle migrate`
 * returns. With nothing holding its backend, no backend of it is left once the close returns, so a DROP DATABASE after
 * `grizzle migrate` finds none; with the bootstrap superuser's lock on its temporary schema holding its backend's drop of
 * them, the close waits until the hold is let go and then leaves no backend, or, interrupted, ends at once.
 *
 * Features: each ending.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	endings,
	runEnding,
	type SessionEndFeature
} from "#test/pg/adapter/session-end.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A session outside any pool ends once its server has closed it, its backend gone, until its close is interrupted.
 */
export const aSessionOutsideAnyPoolEndsOnceItsServerHasClosedItItsBackendGoneUntilItsCloseIsInterrupted =
	property.exhaust(finite(endings), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["unheld", "held, let go", "held, interrupted"] satisfies ReadonlyArray<
			Reached<SessionEndFeature>
		>,
		check:
			({ substrate }, c) =>
			(ending) =>
				Effect.provideServiceEffect(
					Effect.scoped(runEnding(ending, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL closes a backend's connection only once the backend has exited (REL_19_0 src/backend/libpq/pqcomm.c socket_close), and an interrupted close ends at once"
		},
		box: "a migration session of 150 temporary tables closed unheld, held then let go, or held and interrupted",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\tyield* Effect.addFinalizer(() => session.close)",
				replacement: "\t\t\tyield* Effect.addFinalizer(() => Effect.sync(session.destroy))",
				why: "A session outside any pool is destroyed at its scope's end, nothing awaited, as it was (d81ee19dc): `grizzle migrate` returns while its backend still drops its temporary tables, and a DROP DATABASE after it meets that backend."
			}
		]
	})
