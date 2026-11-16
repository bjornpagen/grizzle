/**
 * A login's served classifier classifies every refusal its writes can raise exactly as its installation's full
 * classifier does. A served file holds each role's refusals cut to what its writes can raise (adapter/served/project.ts),
 * so the cut must lose nothing a statement of the role can meet: a refusal misread by the cut is an ExecutionFailure
 * where the installation names a law, or a law where it names another.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts: a roster
 * with holes, a code key, a set, checked contracts that may share one domain, a generated column, a table CHECK), and
 * logins drawn over them (test/support/served-login.ts), each login compiled as `grizzle generate` compiles it under the
 * level's codes, for every role that writes:
 *
 * - cut: the role's refusals as its served file holds them, the file read back from the JSON value its text parses to,
 *   rebuilt as a layer rebuilds them (adapter/witness/index.ts servedWitness), under the codes the file holds;
 * - full: every refusal of the role's installation (adapter/served/refusals.ts installationWitness);
 * - Differential (R1): every refusal the role's writes can raise, as test/support/served-reach.ts computes it from the
 *   compiled program and the installation, never through program/schema.ts raisableOf, reported as PostgreSQL reports
 *   it at a statement writing some of the role's written relations: a table constraint's or rule trigger's violation;
 *   a domain's CHECK, at a statement writing a column it types; an unstored contract domain's CHECK; the CHECK of the
 *   domain a context claim is cast to, at a statement writing through the query entry that reads the context, where
 *   that domain types only stored columns of relations the role does not write; a write statement's refusal of a law,
 *   its DETAIL's key decoded through the refused relation's heading; a roster domain's CHECK, which is grizzle's
 *   defect; a generated column's NOT NULL; a concurrent change at a written relation; a fact outside a query entry the
 *   role writes through. The cut's outcome is the full classifier's, the same value as the runtime reads it
 *   (test/support/served.ts runtimeDifference), the host asked the same of the same columns; a feature is noted only
 *   where that outcome is a law outcome.
 * - Narrowing (R2): a domain shared with a relation the role does not write is classified alike at a statement writing
 *   some of its columns, its uses narrowed to the written tables as the full classifier narrows them by the statement.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { drawnSchema } from "#test/support/served-login.ts"
import {
	contractClaim,
	differential,
	type Feature,
	loginOf,
	sketchGen
} from "#test/unit/served/refusals.fixtures.ts"

/** A served login's classifier classifies every refusal a role's writes can raise exactly as its installation's full classifier does. */
export const aServedLoginsClassifierClassifiesEveryRefusalARolesWritesCanRaiseExactlyAsItsInstallationsFullClassifierDoes =
	property.explore(aimed(sketchGen("drawn"), [[contractClaim, sketchGen("contract claim")]]), {
		needs: {},
		situations: [
			"a table constraint classified alike",
			"a domain shared with a relation the role does not write, narrowed alike",
			"a law refusal decoded alike",
			"a roster domain's refusal classified alike",
			"a concurrent change classified alike",
			"a fact outside a written query entry classified alike",
			"a statement writing some of the role's written relations",
			"a write reading a context field whose contract domain types only unwritten stored columns",
			"a roster with a hole",
			"a generated column",
			"a table CHECK",
			"contracts sharing one domain",
			"a code key"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level, login]) =>
				Effect.suspend(() => {
					const drawn = drawnSchema(notes.draw(resolveCase(sketch)), level)
					return differential(
						drawn,
						level,
						loginOf(drawn, login, notes.draw),
						notes.draw,
						notes.note
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the installation's full classifier (adapter/served/refusals.ts installationWitness), over the refusals test/support/served-reach.ts computes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/schema.ts",
				original: "\t\t\tconst uses = c.uses.filter((u) => tables.has(u.table))",
				replacement: "\t\t\tconst uses = c.uses.filter((u) => !tables.has(u.table))",
				why: "A domain constraint's uses are narrowed to the tables the role does not write (program/schema.ts raisableConstraint): a shared domain's refusal names the other relations' laws, and a domain typing written columns alone is dropped, so the cut reads its refusal as no law."
			},
			{
				file: "packages/engine/src/program/schema.ts",
				original:
					"\treturn [\n\t\t...contractChain(t).map((contract) => names.contractDomain(contract).name),\n\t\t...(pattern === undefined ? [] : [pattern.name])\n\t]",
				replacement: "\treturn [...(pattern === undefined ? [] : [pattern.name])]",
				why: "A cast value's contract chain is left out of the domains it meets (program/schema.ts castDomains): a context claim of a checked contract whose domain types only unwritten columns is no law of the cut."
			},
			{
				file: "packages/grizzle/src/adapter/served/project.ts",
				original: "\t\t\t\t...(writes.length === 0 ? [] : claims),\n",
				replacement: "",
				why: "The cut leaves a context's claims out of the domains a write casts to (adapter/served/project.ts refusalsOf), so the claim's domain is no law of the cut."
			}
		]
	})
