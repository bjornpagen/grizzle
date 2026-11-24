import { Array as Arr, Effect } from "effect"
import { type TemporaryRefused, temporaryRefusal } from "#adapter/errors/failures.ts"
import {
	type FlightFailure,
	type Frame,
	excludesNothing,
	preparedStatement,
	runFramed
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { ServedStandUp } from "#compiler/plan/change.ts"
import { standUpName, standUpTexts } from "#compiler/plan/runtime.ts"

/**
 * A session's stand-up of a write (engine runtime/write/flight.ts StandUp): before the session's first call of the write,
 * one transaction of its own, the write's frame but locking nothing before its snapshot: BEGIN, the Db's prologue (the
 * ledger's fence, then the guard's call that enters the role), the write's stand-ups the session has not run yet, each
 * text its named statement (a carrier's table and its emptying, made as the role; a judged table's stand-up, which makes
 * the judge's tables as its definer), COMMIT; the session records each once its COMMIT answered (wire/session.ts
 * Session `stoodUp`), so the session runs each once, whichever write of it runs first. A session that has run every one
 * sends nothing. The call's own transaction then makes no relation, so every plan it makes outlives it.
 *
 * Its failure: TemporaryRefused, where a carrier's table was refused for the role's want of TEMPORARY on the database;
 * else its flight's.
 */
export const standUp = (
	session: Session,
	frame: Frame,
	standUps: ReadonlyArray<ServedStandUp>
): Effect.Effect<void, StandUpFailure> =>
	Effect.suspend(() => {
		const missing = Arr.filter(standUps, (s) => !session.stoodUp.held.has(standUpName(s)))
		if (!Arr.isReadonlyArrayNonEmpty(missing)) {
			return Effect.void
		}
		const sent = Arr.flatMap(missing, (s) =>
			Arr.map(standUpTexts(s), (text, at) => ({ text, table: s.kind === "carrier" && at === 0 }))
		)
		return Effect.mapBoth(
			runFramed(
				session,
				{ ...frame, exclusion: excludesNothing },
				Arr.map(sent, (s) => preparedStatement(s.text, []))
			),
			{
				onSuccess: () => {
					session.stoodUp.add(Arr.map(missing, standUpName))
				},
				onFailure: (failure): StandUpFailure => {
					if (failure._tag !== "BatchRefused" || sent[failure.index]?.table !== true) {
						return failure
					}
					return temporaryRefusal(failure.failure) ?? failure
				}
			}
		)
	})

/** How a stand-up fails (`standUp`): a carrier's table refused for want of TEMPORARY, or its flight's failure. */
export type StandUpFailure = TemporaryRefused | FlightFailure
