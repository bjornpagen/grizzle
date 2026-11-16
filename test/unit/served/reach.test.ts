/**
 * A login's served file holds exactly what the login's code can reach. `grizzle generate` compiles each login into
 * `served/<login>.json`, and a layer loads nothing else, so a roster or a law the file holds beyond the login's reach
 * is waste every cold start pays, and one it lacks is a load that fails or a refusal misread.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts), and logins
 * drawn over them (test/support/served-login.ts:
 * roles that may write some relations, write some of those and perhaps a query entry reading a context, and read some
 * of the case's queries), each login compiled as generate compiles it (adapter/served/compile.ts snapshotCompiled,
 * then servedEntryOf) and its file read back from the JSON value its text parses to:
 *
 * - Rosters, sufficiency: the file holds the codes of every roster a role's code meets, its decoders' closed ids and
 *   sets, its codecs' parameters, claims and window anchors, and the columns of every relation its writes write.
 * - Rosters, minimality: every roster the file holds is one of those, or one a form of the file holds as a type, which
 *   a load rebuilds from its codes (served/json.ts `~roster:`).
 * - The load fails closed: the file loads (adapter/served/load.ts loadServed), and without the codes of any one roster
 *   it holds it does not, a defect or a refusal and never a layer.
 * - Laws, sufficiency and minimality: each role's refusals hold exactly what its writes can raise of its installation,
 *   its table constraints and triggers, each domain's CHECK with its uses on the written tables alone, its unstored
 *   contract domains, the theory's laws over the written relations, their generated columns, their rosters' domains,
 *   their tables and headings, and the query entries it writes through into them; and every role, writing or not,
 *   holds the domains its members' parameters are cast to at the boundary, and their rosters' (served-reach.ts castBy).
 *
 * The oracle is the reach computed independently from the compiled program and the installation
 * (test/support/served-reach.ts): the statements' parameters and written relations, the decoders, and the written
 * relations' field types, never through program/served.ts servedRosters or program/schema.ts raisableOf.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { drawnSchema, loginGen } from "#test/support/served-login.ts"
import { type Feature, reach } from "#test/unit/served/reach.fixtures.ts"

/** A login's served file holds exactly the rosters and the laws the login's code can reach. */
export const aLoginsServedFileHoldsExactlyTheRostersAndTheLawsTheLoginsCodeCanReach =
	property.explore((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const, {
		needs: {},
		situations: [
			"a roster the login reaches",
			"a roster of the installation no role reaches",
			"a role that writes",
			"a role that writes nothing",
			"a relation a role may write and does not",
			"a written column typed by a roster",
			"a domain shared with a relation the role does not write",
			"a law a write statement raises",
			"a write through a query entry reading a context",
			"a clocked member with a contract-typed param"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level]) =>
				Effect.suspend(() => {
					const drawn = drawnSchema(notes.draw(resolveCase(sketch)), level)
					return reach(drawn, level, notes.draw(loginGen(drawn)), notes.note)
				}),
		oracle: {
			kind: "specification",
			name: "the reach computed from the compiled program and its installation (test/support/served-reach.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/served/project.ts",
				original: "\t\t\t\t\tArr.filter([...snapshot.codes.rosters], ([name]) => used.has(name)),",
				replacement: "\t\t\t\t\t[...snapshot.codes.rosters],",
				why: "The file holds every roster of the snapshot (adapter/served/project.ts); rosters' minimality fails, and the file loads without the added codes."
			},
			{
				file: "packages/grizzle/src/adapter/served/project.ts",
				original: "\t\t\t\t\tArr.filter([...snapshot.codes.rosters], ([name]) => used.has(name)),",
				replacement:
					"\t\t\t\t\tArr.drop(\n\t\t\t\t\t\tArr.filter([...snapshot.codes.rosters], ([name]) => used.has(name)),\n\t\t\t\t\t\t1\n\t\t\t\t\t),",
				why: "The file drops the first roster it would hold; rosters' sufficiency fails, and the file does not load."
			}
		]
	})
