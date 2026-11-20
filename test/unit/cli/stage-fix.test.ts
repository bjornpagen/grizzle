/**
 * The fix a refused migrate prints names what the refusal found wrong (cli/run.ts renderMigrateError, the stage's fix of
 * cli/refusals.ts migrateStageFix): every reason whose fix a superuser makes on the server stops at a stage of its own,
 * so its fix names the setting or the right it found wanting, and what the database holds as the report's outcome says.
 *
 * Over drawn refusals of each such reason (refusalGen): the server's max_stack_depth below the default the pattern
 * limits were measured at, its wal_level minimal under a live source, and a decoder login with no replication right
 * once every folder applied. Oracle: the specification each arm states beside its reason: the server's setting or the
 * role's right it names, and the outcome of the stage it stops at.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { characterOf, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { stackDepthRequired } from "#adapter/admission/expectation.ts"
import {
	DecoderUnreplicated,
	MigrateError,
	type MigrateOutcome,
	StackTooShallow,
	stageOutcome,
	WalLevelMinimal
} from "#adapter/migrate/errors.ts"
import { migrateStageFix } from "#cli/refusals.ts"

/** A reason a superuser fixes on the server, by its tag. */
type ServerReason = "StackTooShallow" | "WalLevelMinimal" | "DecoderUnreplicated"

/**
 * A refused migrate whose reason a superuser fixes on the server, beside the specification of it: the reason, what its
 * fix must name, the server's setting or the role's right it found wanting, and what the database holds when it stops.
 */
interface Refused {
	readonly error: MigrateError
	readonly found: ServerReason
	readonly names: string
	readonly outcome: MigrateOutcome
}

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

/** A drawn PostgreSQL identifier for a schema or a role. */
const identifierGen: Gen<string> = string(characterOf(lowercase), { min: 1, max: 12 })

/**
 * Each reason a superuser fixes on the server, its fields drawn: a max_stack_depth below 2048 kB, a live source's schema
 * at wal_level minimal, or a decoder login and its schema left with no replication right.
 */
const refusalGen: Gen<Refused> = weighted<Refused>([
	[
		1,
		(source) => ({
			error: new MigrateError({
				reason: new StackTooShallow({
					observed: String(source.draw(int(64, 2047))),
					required: stackDepthRequired
				})
			}),
			found: "StackTooShallow",
			names: "max_stack_depth",
			outcome: "nothingRan"
		})
	],
	[
		1,
		(source) => ({
			error: new MigrateError({
				reason: new WalLevelMinimal({ schema: source.draw(identifierGen) })
			}),
			found: "WalLevelMinimal",
			names: "wal_level",
			outcome: "nothingRan"
		})
	],
	[
		1,
		(source) => ({
			error: new MigrateError({
				reason: new DecoderUnreplicated({
					schema: source.draw(identifierGen),
					role: source.draw(identifierGen)
				})
			}),
			found: "DecoderUnreplicated",
			names: "REPLICATION",
			outcome: "noVerdict"
		})
	]
])

/** A refused migrate's fix names what its reason found wanting on the server, and its outcome what the database holds. */
export const aRefusedMigratesFixNamesTheServerSettingOrRightItsReasonFoundWanting =
	property.explore(refusalGen, {
		needs: {},
		situations: [
			"StackTooShallow",
			"WalLevelMinimal",
			"DecoderUnreplicated"
		] satisfies ReadonlyArray<Reached<ServerReason>>,
		check:
			(_, c: Case<ServerReason>) =>
			({ error, found, names, outcome }) =>
				Effect.sync(() => {
					c.note(found)
					const fix = migrateStageFix[error.stage]
					assert.ok(
						Str.includes(names)(fix),
						`${found} stops at stage ${error.stage}, whose fix names no ${names}: ${fix}`
					)
					assert.equal(stageOutcome[error.stage], outcome, `${found}'s outcome`)
				}),
		oracle: {
			kind: "specification",
			name: "the server's setting or the role's right each reason finds wanting, and what the database holds when it stops"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\tWalLevelMinimal: "wal",',
				replacement: '\tWalLevelMinimal: "stack",',
				why: "A minimal wal_level stops at the stack depth's stage, so its report's fix tells a superuser to raise max_stack_depth, which the server already meets (edullm's IMPL-READALOUD on cluster 5441)."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\tDecoderUnreplicated: "replication",',
				replacement: '\tDecoderUnreplicated: "drift",',
				why: "A decoder login with no replication right stops at the drift stage, whose fix and outcome speak of a catalog that differs from the snapshot, where no drift check ran."
			}
		]
	})
