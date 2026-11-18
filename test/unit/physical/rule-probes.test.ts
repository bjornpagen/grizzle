/**
 * The set judge runs each of a rule's probes once (physical/ddl/rules.ts addRules): in each of its guarded blocks, a
 * rule's probes over one table's delta of one side, its rows as the transaction left them (its NEW probes) or as it found
 * them (its OLD probes), no two probes are one statement, so no COMMIT runs one query twice over one region.
 *
 * Each case is a containment of S's k in a derived relation D of T: D has one to three arms, each matching T by k and
 * holding its a to a literal of its own or not at all, and each arm may join U by k. T's delete withdraws a fact of D
 * through each arm that matches it, and each such occurrence is a probe (analysis/theory/query.ts oldProbes); the
 * probes of arms that hold nothing of T's row apart read one query, so the judge's block over T's removed rows holds that
 * statement once.
 *
 * Oracle: universal, a set: each guarded block of the judge holds every probe statement, printed as PostgreSQL reads it,
 * at most once.
 *
 * Features: a block whose table's probes outnumber its statements (two probes of one statement), and a block of two
 * statements or more.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { judged, type Reached, shapeGen } from "#test/unit/physical/rule-probes.fixtures.ts"

/** The set judge runs each probe statement once in each guarded block. */
export const theSetJudgeRunsEachProbeStatementOnceInEachGuardedBlock = property.exhaust(
	finite(shapeGen),
	{
		needs: {},
		situations: [
			"a block whose probes outnumber its statements",
			"a block of two statements"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "universal",
			name: "a set: each guarded block holds every probe statement, as printed, at most once"
		},
		box: "every containment of S in a derived relation of T of one to three arms, each holding T's a to a literal of its own or not at all, each joining U by k or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tconst statements = probeStatements(probes)",
				replacement: "\t\t\tconst statements = probes.map((p) => p.statement)",
				why: "A guarded block of the judge runs every probe its table and side compile, each once per occurrence of the touched relation, so two arms that hold nothing of the row apart run one query twice; the property fails."
			}
		]
	}
)
