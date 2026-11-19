/** What the properties of installs.test.ts read: the template forms the suites seat their cases on, and the count. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Effect, Tracer } from "effect"
import { countedSetTemplate, Owner } from "#test/pg/fin/counted-set.fixtures.ts"

/**
 * The template forms a converted suite seats its cases on, each by the helper a case reads its seat through, each over
 * a converted suite's own template: an installed template's Installed as the seat binds it (install-migrate.ts
 * installedTemplate, fin counted-set's), a seeded one's (seededTemplate, derived install's Written), a fixture's opened
 * over its clone (reads/support.ts fixtureTemplate and openedIn, adapter commit's Work), a fin family's seat
 * (fin/family.ts familyTemplate and familySeatIn, fin order's ordered family), a schedule's rig (schedules/rig.ts
 * rigTemplate and rigIn, met-skew's) and a world realized over its clone (worlds/execute/template.ts worldTemplate and
 * templateWorld, world-model sessions' docs world).
 */
export const forms = ["installed", "seeded", "fixture", "family", "rig", "world"] as const

export type Form = (typeof forms)[number]

/** The installed form's template, fin counted-set's, and the relation a case reads there, which holds no row. */
export const installedForm = { template: countedSetTemplate, relation: Owner } as const

/** A case: the form it seats, and which of three cases of it on the worker's seat it is. */
export const formCase: Gen<readonly [Form, number]> = (source) =>
	[source.draw(element(forms)), source.draw(int(1, 3))] as const

/**
 * `effect`'s answer, and the migrations it applied: every run of the apply runner (adapter/migrate/apply.ts
 * applyOnSession, a traced function, whose span each install's migration opens, a template's build's and a per-case
 * install's alike), counted by a tracer of its own that records each span as the native tracer does.
 */
export const migrationsApplied = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, number], E, R> =>
	Effect.suspend(() => {
		const applied = { count: 0 }
		const counting = Tracer.make({
			span: (options) => {
				if (options.name === "applyOnSession") {
					applied.count += 1
				}
				return new Tracer.NativeSpan(options)
			}
		})
		return Effect.map(
			Effect.withTracer(effect, counting),
			(answer) => [answer, applied.count] as const
		)
	})
