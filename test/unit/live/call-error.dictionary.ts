/**
 * The closed rosters call-error.test.ts exhausts: every SQLSTATE the runtime branches on (core/sqlstate.ts sqlstates),
 * serialization_failure first, and every source a call's failure is met at, the event model's own roster (live/events.ts
 * failures), its door first.
 */

import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr, Record as Rec } from "effect"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import { type FailureSource, failures } from "#compiler/live/events.ts"

/** Every SQLSTATE the runtime branches on (core/sqlstate.ts sqlstates). */
export const states = dictionary<Sqlstate>([
	sqlstates.serializationFailure,
	...Arr.filter(Rec.values(sqlstates), (state) => state !== sqlstates.serializationFailure)
])

/** Every source a call's failure is met at, the event model's own roster (live/events.ts failures). */
export const sources = dictionary<FailureSource>([
	"door",
	...Arr.filter(
		Arr.map(Rec.toEntries(failures), ([source]) => source),
		(source) => source !== "door"
	)
])
