/** What test/unit/served/levels.test.ts reads: its installations of three levels, and a login's compile over each. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Cause, Effect, Exit } from "effect"
import { servedEntryOf, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type RosterOrder, rosterOrders } from "#compiler/ir/scalar.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { type Owned, ownBuilt } from "#compiler/schema/own.ts"
import { closedBuilder, materializedDerived } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import type { LawLevel } from "#test/support/oracle/public/laws.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import { drawnSchema } from "#test/support/served-login.ts"

/** A situation the property reaches: a login over a level, by where the level stands, and how its compile ends. */
export type Feature =
	| "a login over the installation's top"
	| "a login over a level below a level that declares a roster"
	| "a login over the installation's first level"
	| "a login's compile served"
	| "a login's compile refused"

/** The top level's own: its roster's order, beside the law level's and the case's. */
export interface Top {
	readonly order: RosterOrder
}

export const topGen: Gen<Top> = (source) => ({ order: source.draw(element(rosterOrders)) })

/**
 * An installation of three levels: a generated public schema (test/support/oracle/public), its law level extending it
 * (laws.ts: a roster with holes, keys, a set, contracts, a materialized view), and a top extending that, as an
 * application's views level does, which declares two rosters of its own and a materialized view of the levels below
 * it: so each level below the top is installed under codes that hold rosters no relation of that level is typed by.
 */
export interface Installation {
	/**
	 * A login over each level, its first, its middle and its top in that order: one role, holding every relation of its
	 * levels whole and writing each it may write.
	 */
	readonly logins: readonly [unknown, unknown, unknown]
	/** The installation's codes over its top owned: every level's rosters, the law level's with its holes (laws.ts). */
	readonly codes: (owned: Owned) => Codebook
}

export const installationOf = (c: ProgramCase, level: LawLevel, own: Top): Installation => {
	const drawn = drawnSchema(c, level)
	const Shade = closedBuilder("TopShade", ["dim", "lit"], own.order, [])
	const Lamp = closedBuilder("TopLamp", ["off", "on"], "ordered", [])
	const [first] = drawn.relations
	const Seen = materializedDerived(
		"TopSeen",
		queryOver(drawn.laws.schema).rule((r: RuleValue) => {
			const fact = varsOver(first.value, "fact")
			return r.match(first.value, fact).find(fact)
		}),
		[]
	)
	const base = drawn.built.schema
	const laws = drawn.laws.schema
	const top = schema.extend(laws, "TopLevel", [Shade, Lamp, Seen], [], [])
	return {
		logins: [
			login(base, "probe0", [
				role(base, "probe", wholeEntriesOf(base), { write: writableNamesOf(base) })
			]),
			login(laws, "probe1", [
				role(laws, "probe", wholeEntriesOf(laws), { write: writableNamesOf(laws) })
			]),
			login(top, "probe2", [
				role(top, "probe", wholeEntriesOf(top), { write: writableNamesOf(top) })
			])
		],
		codes: drawn.laws.codes
	}
}

/**
 * How a login's compile ended, as `grizzle generate` compiles it (adapter/served/compile.ts snapshotCompiled, then
 * servedEntryOf) under the snapshot of the installation, whose codes hold every level's rosters: served, refused with a
 * ServedRefusal, or died, a defect, with the cause's text.
 */
export type Compiled =
	| { readonly kind: "served" }
	| { readonly kind: "refused" }
	| { readonly kind: "died"; readonly cause: string }

/** A login over each level of `installation`, its first, its middle and its top in that order, compiled (Compiled). */
export const compiledOverEachLevel = (
	installation: Installation
): Effect.Effect<ReadonlyArray<Compiled>> =>
	Effect.gen(function* () {
		const installed = defined(builtLogin(installation.logins[2]), "a login over the top")
		const owned = succeeded(ownBuilt(installed.base), "the installation's top")
		const snapshot = yield* Effect.orDie(
			compiledSnapshot(installed, owned, installation.codes(owned))
		)
		return yield* Effect.forEach(installation.logins, (value) =>
			Effect.gen(function* () {
				const built = defined(builtLogin(value), "a login over a level")
				const input = {
					login: built,
					owned: succeeded(
						ownLoginOver(built, succeeded(ownBuilt(built.base), "the login's level")),
						"the login over its level"
					)
				}
				const exit = yield* Effect.exit(
					Effect.flatMap(snapshotCompiled(input, snapshot, transactionClock), servedEntryOf)
				)
				return Exit.match(exit, {
					onSuccess: (): Compiled => ({ kind: "served" }),
					onFailure: (cause): Compiled =>
						Cause.hasDies(cause)
							? { kind: "died", cause: Cause.pretty(cause) }
							: { kind: "refused" }
				})
			})
		)
	})
