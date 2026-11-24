/**
 * A judged statement reads each reader of a session's delta once, however many of its reads read the rows it returns
 * (physical/ddl/deltas.ts headed): a reader the statement reads once is called where the read stands, and one it reads
 * twice or more through a MATERIALIZED CTE leading its WITH, so no read's rows are produced twice, where a call at each
 * read ran the reader's SELECT again for each (edullm's qti draft: 151 of its 1472 pairs of a judged statement and a
 * delta it reads read the delta more than once, the most 19 times). And each read of a delta that its statement selects
 * by constants reads the reader of that selection, its conjuncts moved into the reader (deltas.ts DeltaReads), never
 * the whole delta.
 *
 * Oracle: a specification, PostgreSQL's evaluation of a statement's CTEs: a MATERIALIZED one computed once for the
 * statement, a NOT MATERIALIZED one spelled at each of its reads (subselect.c inline_cte), a call in the body made where
 * it stands; and the shape's arms, each T's facts of one literal of `a`.
 *
 * Features: a reader read once, twice and three times or more; a statement reading two deltas; a whole rule's
 * statement and a probe's.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	judged,
	type Reached,
	selected,
	shapeGen
} from "#test/unit/physical/delta-reads.fixtures.ts"

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
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: '\t\t\t\tmaterialized: "MATERIALIZED",\n\t\t\t\tquery: simpleSelect(',
				replacement: '\t\t\t\tmaterialized: "NOT MATERIALIZED",\n\t\t\t\tquery: simpleSelect(',
				why: "PostgreSQL spells a reader's CTE at each read of it, so a statement that reads one reader twice or more calls it once for each read, each call producing its rows again; the property fails."
			}
		]
	})

/** Each read of T's delta under an arm's literal reads the reader of that selection, which returns that arm's rows. */
export const aReadOfADeltaUnderASelectionOnConstantsReadsTheReaderOfThatSelection =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a whole rule's statement",
			"a probe's statement",
			"a statement reading two deltas",
			"a delta read once"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => selected(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the shape's arms: each reads T's facts of its own literal of `a`, so each read of T's delta reads a reader whose one condition fixes `a` to an arm's literal, every arm's literal read, and no statement reads T's delta whole"
		},
		box: "every rule over D, a union of one to four rules over T each selecting T by a literal of its own, a check, S's containment or a key, whole or probed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\t\t\t\t\tconst over = overDelta(conjunct, read.column)",
				replacement: "\t\t\t\t\tconst over = undefined",
				why: "No selection moves into a reader: each arm reads T's delta whole through its one reader and keeps its literal's rows itself, every row of the delta produced for each arm; the property fails."
			}
		]
	})
