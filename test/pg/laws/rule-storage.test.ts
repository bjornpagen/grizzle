/**
 * A rule judge's deltas store their values as their relations' bounds allow, against PostgreSQL 19 (physical/ddl/rules.ts
 * deltaStorage): over a Doc whose body has no bound and a Tag every field of whose widest row fits one heap tuple, each
 * under a rule over its join with Known, a transaction writes one of each, the body short or past a page and the label
 * short or at its bound, and its COMMIT is judged: it is accepted, each delta of Doc has its TOAST table and took the
 * body, and each delta of Tag is one relation, no TOAST table beside it, its every value in its row.
 *
 * Features: a body past a page, and a label at its bound.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runWrites,
	type StorageFeature,
	storageTemplate,
	writesGen
} from "#test/pg/laws/rule-storage.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule judge's delta holds its values in its row where its relation's widest row fits one heap tuple, and out of line
 * where it may not.
 */
export const aRuleJudgesDeltaHoldsItsValuesInItsRowWhereItsRelationsWidestRowFitsOneHeapTupleAndOutOfLineWhereItMayNot =
	property.exhaust(finite(writesGen), {
		needs: { judged: Substrate.fresh(storageTemplate) },
		situations: ["a body past a page", "a label at its bound"] satisfies ReadonlyArray<
			Reached<StorageFeature>
		>,
		check:
			({ judged }, c) =>
			(k) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { substrate, value } = yield* judged
						const session = yield* substrate.session({ ...ownerSession(), label: "writer" })
						yield* standUpJudge(session, value.installation)
						yield* runWrites(value, session, k, c)
					})
				),
		oracle: {
			kind: "postgresql",
			name: "the judged COMMIT accepted, and each delta's TOAST table as pg_class records it: Doc's, of a field of no bound, beside it; Tag's, of bounded fields whose widest row fits one heap tuple, none"
		},
		box: "a body short or past a page, and a label short or at its bound",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original:
					'\treturn rowBytes([...columns, ...count]) <= heapTupleMaxBytes ? "inline" : "toasted"',
				replacement: '\treturn rowBytes([...columns, ...count]) < 0 ? "inline" : "toasted"',
				why: "Every delta keeps its TOAST table, as format 6's did: Tag's delta, whose every value fits its row, is three relations, which its emptying's TRUNCATE gives new files and its session's exit drops."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: '\t\t\treturn "toasted"',
				replacement: "\t\t\tcontinue",
				why: "A delta of a field of no bound holds its values in its row too: Doc's delta has no TOAST table, and a body past a page is refused as a row too big, failing the COMMIT that wrote it."
			}
		]
	})
