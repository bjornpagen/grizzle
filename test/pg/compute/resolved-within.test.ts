/**
 * A reference's target within its base, r.resolvedWithin (ir/rel.ts TextSplit `resolvedWithin`, the library's
 * resolvedWithin, physical/ddl/library.ts), served reads on PostgreSQL 19 against the host's resolution within a base
 * and the oracle's own (resolved-within.fixtures.ts): over one transaction's pairings, RFC 3986 §5.4's 42 examples,
 * drawn references of every shape against drawn bases (dot segments, `..` past the root, empty and percent-encoded
 * segments among them) and a package's references against its documents' URIs, each target within its base is the
 * host's (@bjornpagen/grizzle-text uri.ts resolveWithin) and the reference's (the oracle's resolution where its own
 * depth over the walked path climbs nowhere), and the pairings whose walk climbs past its root are a negation of it.
 *
 * Oracle: the host's resolveWithin, and the oracle's resolvedReference and climbsOf (test/support/oracle/evaluate/uri.ts),
 * which read RFC 3986 §5.2 by other means.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	factsOf,
	hostTargets,
	idsOf,
	pairingsGen,
	referenceAbove,
	referenceTargets,
	Resolutions,
	resolutionsInstall,
	resolutionsTemplate,
	targetsText,
	type WithinFeature,
	withinFeatures
} from "#test/pg/compute/resolved-within.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A reference's target within its base is RFC 3986's target where no `..` of the path its resolution walks climbs past
 * that path's root, and none where one does, as the host and the reference resolve it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aReferencesTargetWithinItsBaseIsRFC3986sTargetWhereNoDotDotClimbsPastItsPathsRootAndNoneWhereOneDoes =
	property.explore(pairingsGen, {
		needs: { fixture: Substrate.fresh(resolutionsTemplate) },
		situations: [
			"a reference with a scheme",
			"a reference with an authority",
			"a reference with an empty path",
			"a reference with an absolute path",
			"a reference with a relative path",
			"a dot segment",
			"a .. past the root",
			"an undefined query against a base's",
			"the RFC's example base",
			"a percent-encoded dot",
			"a package's reference within it",
			"a package's reference above its root",
			"a reference of no path against a climbing base"
		] satisfies ReadonlyArray<Reached<WithinFeature>>,
		check:
			({ fixture }, k: Case<WithinFeature>) =>
			(batch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Resolutions, {}, resolutionsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({
										params: {},
										facts: { insert: factsOf(batch.pairs) }
									})
									const none = { params: {}, facts: {} }
									const where = Formatter.format(batch.pairs)
									const rows = yield* db.workload.within.once(none)
									const within = targetsText(rows)
									assert.deepEqual(
										within,
										hostTargets(batch.pairs),
										`the host's targets, of ${where}`
									)
									assert.deepEqual(
										within,
										referenceTargets(batch.pairs),
										`the reference's targets, of ${where}`
									)
									const above = yield* db.workload.above.once(none)
									assert.deepEqual(
										idsOf(above),
										referenceAbove(batch.pairs),
										`the pairings whose walk climbs, of ${where}`
									)
									for (const feature of withinFeatures(batch)) {
										k.note(feature)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's resolveWithin and the oracle's resolution, read from RFC 3986 §5.2 by other means, where its depth over the walked path's segments climbs nowhere"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\t["leading", and([l("lead"), eq(l("t"), text(".."))])]',
				replacement: '\t\t\t["leading", lit.bool(false)]',
				why: "A leading `..` climbs nowhere, so a reference with a scheme and a relative path `../h`, or one against a base of no path, has a target where the host's walk climbs."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\t["held", when(and([l("lead"), eq(l("t"), text(""))]), integer(0), push)],',
				replacement: '\t\t\t["held", push],',
				why: "The empty unit an absolute path's empty first segment pushes holds characters, so `../../a.png` from `package:///items/i.xml` pops it and stays within, where the host's walk climbs above the package root."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\tclimbed: and([not(kept), gt(walk.read("climbs"), integer(0))])',
				replacement: '\t\tclimbed: gt(walk.read("climbs"), integer(0))',
				why: "A reference of no path, which keeps its base's path unwalked, is read as climbing where the base's own `..` segments climb in its merge, where the host resolves it within."
			}
		]
	})
