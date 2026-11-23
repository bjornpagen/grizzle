/**
 * Endpoints equal programs: a login's HTTP routes are exactly its served members. Over generated public schemas
 * (test/support/oracle/public), each extended by a drawn law level, and a login drawn over each (test/support/served-login.ts:
 * one or two roles, each writing some relations through ChangeSets and reading some of the case's queries, an ordered
 * one perhaps paged, perhaps reading at its call's instant, a role perhaps serving nothing), compiled as `grizzle generate` compiles it with no database and
 * served from its file as an application serves it (served(file, name)):
 *
 * - the route table the handler dispatches on (http httpRoutes) holds exactly one route for every member of every
 *   role's workload, at the request line `POST /<login>/<role>/<program>` by their declared names, naming that login,
 *   role and program, and no other route: none for a role that serves nothing, none for a program the login does not
 *   serve.
 *
 * The oracle is the drawn login itself: the programs each drawn role's workload was built with, by the names the
 * drawing gave them, never the served file the routes are read from.
 *
 * Features: a role that serves nothing, a role that serves programs, two roles, a read member, a paged member, a change
 * member. A witness whose turn aims at a paged member draws a case every read of which is ordered
 * (oracle/public/generate.ts orderedCaseSketchGen), and its login's first role reads each of them paged
 * (served-login.ts pagedLoginGen), rather than leave the situation to the tape: its fixed floor witnesses missed it
 * once the closed/open rules drew no op for a change.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CaseSketch,
	caseSketchGen,
	orderedCaseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { drawnSchema, loginGen, pagedLoginGen } from "#test/support/served-login.ts"
import { type Feature, routesOf } from "#test/unit/live/routes.fixtures.ts"

/** How a case draws its schema and login: as drawn, or aimed at a paged member. */
type Aim = "drawn" | "paged"

/** A case's sketch drawn as `aim` says: aimed at a paged member, every read of its case ordered. */
const sketchGen =
	(aim: Aim): Gen<readonly [CaseSketch, LawLevel, Aim]> =>
	(source) => [
		source.draw(aim === "paged" ? orderedCaseSketchGen : caseSketchGen),
		source.draw(lawLevelGen),
		aim
	]

/**
 * The HTTP surface's routes are exactly the login's served members, one route each.
 *
 * Budget: its suite's count before the conversion (unit/live/routes: 60 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theHTTPSurfacesRoutesAreExactlyTheLoginsServedMembersOneRouteEach = property.explore(
	aimed(sketchGen("drawn"), [["a paged member", sketchGen("paged")]]),
	{
		needs: {},
		situations: [
			"a role that serves nothing",
			"a role that serves programs",
			"two roles",
			"a read member",
			"a paged member",
			"a change member"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level, aim]) =>
				Effect.suspend(() => {
					const drawnCase = drawnSchema(notes.draw(resolveCase(sketch)), level)
					return routesOf(
						drawnCase,
						level,
						notes.draw((aim === "paged" ? pagedLoginGen : loginGen)(drawnCase)),
						notes.note
					)
				}),
		oracle: {
			kind: "specification",
			name: "the programs each drawn role's workload was built with, by their drawn names"
		},
		budget: { runs: 60, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/http/routes.ts",
				original: "\t\t\tfor (const member of role.members) {",
				replacement:
					'\t\t\tfor (const member of role.members.length > 0 ? role.members : [{ name: "" }]) {',
				why: "A route without a program: the table holds a route for every role of the file, a role that serves nothing included."
			}
		]
	}
)
