/**
 * The live source's admission by the server's wal_level (adapter/migrate/live.ts walLevelOf, liveSourceRefusal), which
 * migrate's survey reads before any statement runs: a text the survey reads as PostgreSQL 19's wal_level is minimal,
 * replica or logical and nothing else, and a live source is refused at minimal alone, by WalLevelMinimal naming its
 * schema, since PostgreSQL 19 decodes at logical and turns decoding on by itself at replica, its default, when the
 * source's slot is made.
 *
 * Box, exhausted: the three levels, the two hidden aliases of replica, which current_setting never answers, and texts no
 * server answers. Oracle: PostgreSQL 19's documentation of wal_level and of logical decoding's activation, as a table
 * (wal-level.fixtures.ts specified).
 *
 * Features: each verdict, by its level.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import { liveSourceRefusal, walLevelOf } from "#adapter/migrate/live.ts"
import {
	features,
	specified,
	type WalFeature,
	walTextGen
} from "#test/unit/adapter/wal-level.fixtures.ts"

/** A live source is refused at wal_level minimal alone, and decoded at replica and logical, the only texts besides it PostgreSQL 19 reads wal_level as. */
export const aLiveSourceIsRefusedAtWalLevelMinimalAloneAndDecodedAtReplicaAndLogicalTheOnlyTextsBesidesItPostgreSQL19ReadsWalLevelAs =
	property.exhaust(finite(walTextGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<WalFeature>>,
		check: (_, c: Case<WalFeature>) => (text) =>
			Effect.sync(() => {
				const level = walLevelOf(text)
				const refusal = Option.flatMap(level, (parsed) => liveSourceRefusal(parsed, "app"))
				switch (specified(text)) {
					case "no level":
						c.note("a text no server reads as a level")
						assert.ok(Option.isNone(level), `${Formatter.format(text)} is read as no level`)
						break
					case "refused":
						c.note("a live source refused at minimal")
						assert.deepEqual(
							Option.map(refusal, (refused) => [refused._tag, refused.schema] as const),
							Option.some(["WalLevelMinimal", "app"] as const),
							"a live source at minimal is refused, naming its schema"
						)
						break
					case "decoded":
						c.note(
							text === "replica"
								? "a live source decoded at replica"
								: "a live source decoded at logical"
						)
						assert.ok(Option.isSome(level), `${text} is read as a level`)
						assert.ok(Option.isNone(refusal), `a live source at ${text} is admitted`)
						break
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's wal_level and its automatic activation of logical decoding (config.sgml, logicaldecoding.sgml)"
		},
		box: "every level PostgreSQL 19 reads wal_level as, the two hidden aliases of replica, and three texts no server answers",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/live.ts",
				original:
					'\tlevel === "minimal" ? Option.some(new WalLevelMinimal({ schema })) : Option.none()',
				replacement:
					'\tlevel !== "logical" ? Option.some(new WalLevelMinimal({ schema })) : Option.none()',
				why: "A live source is refused below wal_level = logical, as before PostgreSQL 19's automatic activation: replica, its default, is refused; the property fails at replica."
			}
		]
	})
