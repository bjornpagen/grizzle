/**
 * A world's direct writers end with the case that began them (RealWorld.reset): a case that ends with a direct
 * transaction open, aborted or ended leaves no backend of the world's logins in a transaction, so no SERIALIZABLE
 * snapshot a direct writer took outlives the case that took it. A shared world (exhaustive.test.ts's slot world, the
 * education suites' one world) meets its next reset only when its next case comes, which a run of catalog-changing
 * cases on fresh worlds may hold off for minutes; a snapshot held that long keeps the cluster's SSI cleanup from
 * advancing for every file on it.
 *
 * One world of the documents installation is realized for the whole test and shared by every case, as a slot world is.
 * A case draws a reality and a short program of direct moves (BEGIN, statements, COMMIT or ROLLBACK, under drawn live,
 * stale and wild shares), each performed by the driver and held to the worlds model at every step (runStep), so it ends
 * however its draws leave it: its transaction open, aborted by a refusal, ended, or never begun. The case runs in a
 * scope of its own, and once that scope has closed, before the next case resets the world, the property reads the
 * world's database.
 *
 * Oracle: the specification. After the case, pg_stat_activity lists no backend of the world's database, other than
 * the substrate's own owner and superuser sessions, that is in a transaction, and no direct writer's backend at all.
 * Features: a case that ended with its direct transaction open, one that ended with it aborted, and one that ended with
 * none in progress.
 *
 * @plant test/plants/pg/world-model/world-direct-outlives-case.patch A direct writer's scope forked from the world's
 * again, which leaves the writer of a case that ended with its transaction open idle in it after the case.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { drawAction, unnoted } from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import {
	noAims,
	type Weights,
	weightsGen,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type { ModelState } from "#test/support/worlds/model/types.ts"

/** How a case's program left its direct writers when it ended: one in a transaction, open or aborted, or none. */
type Ending =
	| "a case ended with its direct transaction open"
	| "a case ended with its direct transaction aborted"
	| "a case ended with no direct transaction in progress"

const situations: Arr.NonEmptyReadonlyArray<Ending> = [
	"a case ended with its direct transaction open",
	"a case ended with its direct transaction aborted",
	"a case ended with no direct transaction in progress"
]

/** A case: how many moves its program draws, and the shares its inputs are drawn under. */
interface SessionsCase {
	readonly moves: number
	readonly weights: Weights
}

/**
 * The direct moves only, BEGIN and the end drawn as often as a statement, under a run's drawn validity shares, so a
 * program ends in each of its endings about as often.
 */
const caseGen: Gen<SessionsCase> = (source) => ({
	moves: source.draw(int(1, 4)),
	weights: {
		...source.draw(weightsGen),
		actions: { ...zeroWeights.actions, "direct-begin": 1, direct: 1, "direct-end": 1 },
		kinds: ["direct-begin", "direct", "direct-end"],
		aims: noAims
	}
})

/**
 * How the model's last state leaves the case's direct writers: one with its transaction open, else one aborted, else
 * none in a transaction, every one it began ended (or its BEGIN refused).
 */
const endingOf = (state: ModelState): Ending => {
	const direct = Arr.flatMap(state.sessions, (s) => (s.kind === "direct" ? [s] : []))
	if (Arr.some(direct, (s) => s.transaction === "open")) {
		return "a case ended with its direct transaction open"
	}
	return Arr.isReadonlyArrayNonEmpty(direct)
		? "a case ended with its direct transaction aborted"
		: "a case ended with no direct transaction in progress"
}

/**
 * The backends of the world's database, other than the substrate's owner and superuser and the reader's own, that are
 * in a transaction or are a direct writer's: pid, role, application name and state, each as text.
 */
const leftQuery = `SELECT a.pid::text, a.usename::text, coalesce(a.application_name, '')::text, coalesce(a.state, '')::text
FROM pg_catalog.pg_stat_activity AS a
WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
	AND a.usename NOT IN ($1::name, 'postgres'::name)
	AND (a.xact_start IS NOT NULL OR a.application_name LIKE 'grizzle-substrate psql direct %')`

const cases = 24

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"the worlds model: a direct writer's case",
	(it) => {
		it.effect("every direct writer a case begins ends with that case", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const world = yield* realize(docsInstall, ordinarySession)
					const host = hostSchemaOf(docsBase, world.names)
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "a case's end ends its direct writers: once its scope closes, no backend of the world's logins is in a transaction and no direct writer's backend remains"
							},
							suite: "pg/world-model/sessions",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Ending>(situations, { cases: 4 * cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(sc, c) =>
							Effect.gen(function* () {
								const ended = yield* Effect.scoped(
									Effect.gen(function* () {
										const reality = c.draw(realityGen(docsBase, host))
										yield* world.reset(reality)
										const start = yield* checkStart(
											world,
											initialState(docsInstall, world.names, reality)
										)
										return yield* Effect.reduce(
											indices(sc.moves),
											(): ModelState => start,
											(state, index) =>
												Effect.map(
													runStep(
														world,
														state,
														drawAction(c.draw, state, sc.weights),
														index,
														unnoted
													),
													(stepped) => stepped.next
												)
										)
									})
								)
								c.note(endingOf(ended))
								const left = yield* s.admin.queryValues(leftQuery, [pgPin.devRole])
								assert.deepEqual(
									left,
									[],
									`after a case whose program left it so (${endingOf(ended)}), no backend of the world's logins is in a transaction and no direct writer's remains`
								)
							})
					)
				})
			)
		)
	}
)
