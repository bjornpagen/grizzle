/**
 * A judged statement calls each delta's reader once, however many of its reads read the delta (physical/ddl/rules.ts
 * deltaHead, headed): it holds a MATERIALIZED CTE of each delta it reads, over the delta's reader, at the head of its
 * WITH, and every read of the delta scans the rows that CTE holds, where a call of the reader at each read ran the
 * reader's SELECT of the whole delta again for each (edullm's qti draft: 151 of its 1472 pairs of a judged statement and
 * a delta it reads read the delta more than once, the most 19 times).
 *
 * Oracle: a specification, PostgreSQL's evaluation of a statement's CTEs: a MATERIALIZED one computed once for the
 * statement, a NOT MATERIALIZED one spelled at each of its reads (subselect.c inline_cte), a call in the body made where
 * it stands.
 *
 * Features: a delta read once, twice and three times or more; a statement reading two deltas; a whole rule's statement
 * and a probe's.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { judged, type Reached, shapeGen } from "#test/unit/physical/delta-reads.fixtures.ts"

/** Each judged statement calls each delta's reader once, whatever number of its reads read the delta. */
export const aJudgedStatementCallsEachDeltasReaderOnceHoweverManyOfItsReadsReadTheDelta =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a delta read once",
			"a delta read twice",
			"a delta read three times or more",
			"a statement reading two deltas",
			"a whole rule's statement",
			"a probe's statement"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's evaluation of CTEs: a MATERIALIZED CTE's calls made once for its statement, a NOT MATERIALIZED one's at each of its reads, a call in the body where it stands"
		},
		box: "every rule over D, a union of one to four rules over T each selecting T by a literal of its own, a check, S's containment or a key, whole or probed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\tmaterialized: "MATERIALIZED",\n\tquery: simpleSelect(',
				replacement: '\tmaterialized: "NOT MATERIALIZED",\n\tquery: simpleSelect(',
				why: "PostgreSQL spells a delta's CTE at each read of it, so a whole rule's statement over a union of two rules or more over T calls T's reader once for each arm, each call reading the whole delta, as the judge's statements did when each read called the reader; the property fails."
			}
		]
	})
