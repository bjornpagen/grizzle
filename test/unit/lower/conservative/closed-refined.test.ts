/**
 * A Closed source's refined payload delivered by the conservative lowering (lower/conservative/refined.ts Tracer): a
 * roster read with a query-local text payload p0 over the pattern ^[a-z]+$, its rows the node's own, which the
 * lowering emits as base-typed VALUES literals (lower/conservative/closed).
 *
 * - **A literal in the pattern is proved on the host:** every payload literal the pattern's automaton admits is
 *   delivered uncast, whether or not the installation names a domain for the pattern, so a pattern no stored column
 *   carries lowers at all (the audit's floor case at TEST_SEED=3928500770, whose roster K0 carried such a payload).
 * - **A literal outside it is the database's to refuse:** with a domain named for the pattern, the delivered p0 is cast
 *   to it, which PostgreSQL checks for every delivered row; with none, the lowering refuses, naming p0's refinement.
 * - **An empty source claims nothing:** its placeholder rows, under WHERE false, define no delivered value, so it is
 *   delivered uncast.
 *
 * The box: every sequence of zero to two payload values over one in the pattern, one outside it (a capital), each under
 * names with and without the pattern's domain, each the source projected whole or filtered to its rows (a derived table
 * the trace follows). The oracle is the pattern's membership read off the values the case states, never the tracer.
 *
 * Features: each delivery (uncast with or without a domain, cast, refused, an empty source uncast).
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { textOf } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"
import {
	caseGen,
	domainName,
	type Feature,
	lowered,
	namesType
} from "#test/unit/lower/conservative/closed-refined.fixtures.ts"
import { T } from "#test/unit/lower/conservative/fixtures.ts"

/** A Closed source's refined payload is delivered uncast where the pattern admits every literal, cast to its domain or refused where one is outside. */
export const aClosedSourcesRefinedPayloadIsDeliveredUncastWhereThePatternAdmitsEveryLiteralCastToItsDomainOrRefusedWhereOneIsOutside =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"an in-pattern payload delivered uncast without a domain",
			"an in-pattern payload delivered uncast beside a domain",
			"an out-of-pattern payload cast to its domain",
			"an out-of-pattern payload refused without a domain",
			"an empty source delivered uncast"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, seen: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const regex = textOf(T.code)
				assert.ok(regex !== undefined && typeof regex !== "string", "the payload carries a pattern")
				const outside = Arr.some(c.payload, (v) => !patternMember(regex, v))
				assert.equal(outside, Arr.contains(c.payload, "Abc"), "the oracle's membership")
				const r = lowered(c)
				if (outside && !c.domain) {
					seen.note("an out-of-pattern payload refused without a domain")
					refused(r, "UnsupportedOperation", Formatter.format(c))
					return
				}
				const program = succeeded(r, Formatter.format(c))
				const statements = flight(program.roots)
				for (const s of statements) {
					assert.deepEqual(auditStatementViolations(s.ast), [], Formatter.format(c))
				}
				const cast = Arr.some(statements, (s) => namesType(s.ast, domainName))
				assert.equal(
					cast,
					outside,
					`p0 is cast to its domain exactly when a literal is outside the pattern: ${Formatter.format(c)}`
				)
				seen.note(
					c.payload.length === 0
						? "an empty source delivered uncast"
						: outside
							? "an out-of-pattern payload cast to its domain"
							: c.domain
								? "an in-pattern payload delivered uncast beside a domain"
								: "an in-pattern payload delivered uncast without a domain"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the pattern's membership of each value the case states"
		},
		box: "zero to two payload values over one in the pattern and one outside, with and without the pattern's domain, projected whole or filtered",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/refined.ts",
				original:
					'e.value.kind === "text" && regex !== undefined && patterns.member(regex, e.value.value)',
				replacement: 'e.value.kind === "text" && regex !== undefined',
				why: "The tracer admits every text literal of a patterned claim, in the pattern or not; the delivery search fails."
			}
		]
	})
