/** What the properties of sessions.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { worldTemplate } from "#test/support/worlds/execute/template.ts"
import {
	noAims,
	type Weights,
	weightsGen,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { ModelState } from "#test/support/worlds/model/types.ts"

/** How a case's program left its direct writers when it ended: one in a transaction, open or aborted, or none. */
export type Ending =
	| "a case ended with its direct transaction open"
	| "a case ended with its direct transaction aborted"
	| "a case ended with no direct transaction in progress"

export const situations: Arr.NonEmptyReadonlyArray<Ending> = [
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
export const caseGen: Gen<SessionsCase> = (source) => ({
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
export const endingOf = (state: ModelState): Ending => {
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
export const leftQuery = `SELECT a.pid::text, a.usename::text, coalesce(a.application_name, '')::text, coalesce(a.state, '')::text
FROM pg_catalog.pg_stat_activity AS a
WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
	AND a.usename NOT IN ($1::name, 'postgres'::name)
	AND (a.xact_start IS NOT NULL OR a.application_name LIKE 'grizzle-substrate psql direct %')`

export const cases = 24

/**
 * The docs world installed once per member (worlds/execute/template.ts worldTemplate), each case realizing its layers
 * and sessions over a fresh clone of it (Substrate.freshOf), a database of the case's own, as the search's was its
 * file's own: every case's reset refreshes the world's derived relations (execute/index.ts RealWorld reset), and
 * OrgDocs' rows are no table a seat's reset empties.
 */
export const docsWorld = worldTemplate({
	declaredIn: import.meta,
	name: "sessions",
	install: docsInstall,
	ambient: ordinarySession
})
