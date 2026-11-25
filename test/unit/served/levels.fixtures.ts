/** What test/unit/served/levels.test.ts reads: its installations of four levels, and a login's compile over each. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Cause, Effect, Exit } from "effect"
import { servedEntryOf, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type RosterOrder, rosterOrders } from "#compiler/ir/scalar.ts"
import { login, role, wholeEntriesOf, wholeWritesOf } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { closedBuilder, derivedBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import type { LawLevel } from "#test/support/oracle/public/laws.ts"
import type { ProgramCase } from "#test/support/oracle/public/program.ts"
import { drawnSchema } from "#test/support/served-login.ts"

/** Where a login's level stands in its installation. */
export type LoginLevel =
	| "a login over the installation's first level"
	| "a login over a level below a level that declares a roster"
	| "a login over a level of derived relations alone, below a level that declares a roster"
	| "a login over the installation's top"

/** A situation the property reaches: a login over a level, by where the level stands, and how its compile ends. */
export type Feature = LoginLevel | "a login's compile served" | "a login's compile refused"

/** The top level's own: its roster's order, beside the law level's and the case's. */
export interface Top {
	readonly order: RosterOrder
}

export const topGen: Gen<Top> = (source) => ({ order: source.draw(element(rosterOrders)) })

/** A login over a level of an installation, with where the level stands. */
export interface LevelLogin {
	readonly at: LoginLevel
	readonly login: unknown
}

/**
 * An installation of four levels: a generated public schema (test/support/oracle/public), its law level extending it
 * (laws.ts: a roster with holes, keys, a set, contracts, a derived relation), a level of derived relations alone
 * extending that, a live view of the levels below it, which installs no table (alphatest-novus's reconciliation level),
 * and a top extending that, as an application's stored level above its views does, which declares two rosters of its
 * own and a derived relation of the levels below it: so each level below the top is installed under codes that hold
 * rosters no relation of that level is typed by.
 */
export interface Installation {
	/**
	 * A login over each level, its first, its law level, its level of derived relations and its top in that order: one
	 * role, holding every relation of its levels whole and writing each it may write.
	 */
	readonly logins: readonly [LevelLogin, LevelLogin, LevelLogin, LevelLogin]
	/** The installation's codes over its top owned: every level's rosters, the law level's with its holes (laws.ts). */
	readonly codes: (owned: Owned) => Codebook
}

export const installationOf = (c: ProgramCase, level: LawLevel, own: Top): Installation => {
	const drawn = drawnSchema(c, level)
	const Shade = closedBuilder(
		"TopShade",
		own.order === "zones" ? ["Etc/Dim", "Etc/Lit"] : ["dim", "lit"],
		own.order,
		[]
	)
	const Lamp = closedBuilder("TopLamp", ["off", "on"], "ordered", [])
	const [first] = drawn.relations
	/** Every fact of the first relation, which the views level and the top each read live. */
	const facts = queryOver(drawn.laws.schema).rule((r: RuleValue) => {
		const fact = varsOver(first.value, "fact")
		return r.match(first.value, fact).find(fact)
	})
	const Read = derivedBuilder("ViewsRead", facts, [])
	const Seen = derivedBuilder("TopSeen", facts, [])
	const base = drawn.built.schema
	const laws = drawn.laws.schema
	const views = schema.extend([laws], "ViewsLevel", [Read], [], [])
	const top = schema.extend([views], "TopLevel", [Shade, Lamp, Seen], [], [])
	return {
		logins: [
			{
				at: "a login over the installation's first level",
				login: login(base, "probe0", [
					role(base, "probe", wholeEntriesOf(base), wholeWritesOf(base))
				])
			},
			{
				at: "a login over a level below a level that declares a roster",
				login: login(laws, "probe1", [
					role(laws, "probe", wholeEntriesOf(laws), wholeWritesOf(laws))
				])
			},
			{
				at: "a login over a level of derived relations alone, below a level that declares a roster",
				login: login(views, "probe2", [
					role(views, "probe", wholeEntriesOf(views), wholeWritesOf(views))
				])
			},
			{
				at: "a login over the installation's top",
				login: login(top, "probe3", [role(top, "probe", wholeEntriesOf(top), wholeWritesOf(top))])
			}
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

/** A login's compile (Compiled), with where its level stands. */
export interface LevelCompiled {
	readonly at: LoginLevel
	readonly compiled: Compiled
}

/** A login over each level of `installation`, in the installation's order, compiled (LevelCompiled). */
export const compiledOverEachLevel = (
	installation: Installation
): Effect.Effect<ReadonlyArray<LevelCompiled>> =>
	Effect.gen(function* () {
		const installed = defined(builtLogin(installation.logins[3].login), "a login over the top")
		const owned = succeeded(installed.base.content.owned(), "the installation's top")
		const snapshot = yield* Effect.orDie(
			compiledSnapshot(installed, owned, installation.codes(owned))
		)
		return yield* Effect.forEach(installation.logins, ({ at, login: value }) =>
			Effect.gen(function* () {
				const built = defined(builtLogin(value), "a login over a level")
				const input = {
					login: built,
					owned: succeeded(
						ownLoginOver(built, succeeded(built.base.content.owned(), "the login's level")),
						"the login over its level"
					)
				}
				const exit = yield* Effect.exit(
					Effect.flatMap(snapshotCompiled(input, snapshot, transactionClock), servedEntryOf)
				)
				const compiled = Exit.match(exit, {
					onSuccess: (): Compiled => ({ kind: "served" }),
					onFailure: (cause): Compiled =>
						Cause.hasDies(cause)
							? { kind: "died", cause: Cause.pretty(cause) }
							: { kind: "refused" }
				})
				return { at, compiled }
			})
		)
	})
