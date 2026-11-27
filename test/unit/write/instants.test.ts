/**
 * How a ChangeSet's writes meet the schema's instants (write/frontend/instants.ts), each refusal made when the
 * ChangeSet compiles, from the classifier's roles: an insert leaves a clock out, which it stamps, and states none; a
 * put states every instant and no clock, so a put of a clock's relation is refused either way; a delete states every
 * instant; a reference left out is stamped by its clock beside an insert of that clock in its stratum, by none where
 * its containments reach no one clock; no stamp's child is a field the same insert stamps; and a clock is stamped in
 * one statement of one stratum.
 *
 * The box, exhausted: SignIn(user, at, method) keyed (user, at), its at a clock of child user; Session(token, user, at)
 * keyed token, its at a reference stamped by SignIn's clock at its user; Visit(user, at, place), a second clock of child
 * user; Orphan(token, user, at), its at a reference carried into SignIn's at and into Visit's, two clocks, so no one
 * clock stamps it; and Chain(user, s, at) keyed (user, s, at), its s a reference stamped by SignIn's clock at its user
 * and its at a clock of child (user, s). Each case is one
 * ChangeSet, built as a JavaScript caller builds it (write/changeset/value.ts), so the shapes the types refuse are
 * reached too: an insert, a put and a delete of SignIn stating its instant from a stored one or leaving it out, from
 * a query or an array; Session stamped beside SignIn's insert, alone, a stratum after it, and stated from a stored
 * instant, and put stating a stored instant or leaving it out; Orphan stamped beside SignIn's insert; Chain stamped
 * beside it; SignIn stamped in two strata; SignIn and Session stamped in a stratum one statement after another realizes,
 * beside a delete of Session, whose removals run before its addition; and SignIn and Session stamped in one statement,
 * Session's insert from two queries, or from host rows and a query, or beside two deletes of Visit, each operation of
 * one relation one action over its sources' union (write/frontend/compile.ts), Session put from two queries stating
 * stored instants, and Visit deleted from a query beside its insert, which stamps Visit's clock past every stored
 * instant, so its deletion excepts none of its rows (write/schedule/plan.ts exceptsOf).
 *
 * Property, per case, against the rule stated over the case (instants.fixtures.ts cases, each with its verdict): the
 * ChangeSet compiles, or is refused as InstantRefused at the relation and field the rule names, by its rule.
 *
 * Features: every rule, and a ChangeSet that stamps, states and deletes instants as the rules admit.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	Clocks,
	instantCaseGen,
	type InstantWriteFeature,
	featureOf
} from "#test/unit/write/instants.fixtures.ts"

/** A ChangeSet writes an instant as the schema's laws make it: it stamps what it leaves out and states only stored instants, each refusal naming its field and rule. */
export const aChangeSetWritesAnInstantAsTheSchemasLawsMakeItStampingWhatItLeavesOutAndStatingOnlyStoredInstants =
	property.exhaust(finite(instantCaseGen), {
		needs: {},
		situations: [
			"compiled",
			"clockStated",
			"unstated",
			"unstampable",
			"clockUnstamped",
			"childStamped",
			"stampedApart in strata",
			"stampedApart in statements"
		] satisfies ReadonlyArray<Reached<InstantWriteFeature>>,
		check: (_, k: Case<InstantWriteFeature>) => (c) =>
			Effect.sync(() => {
				k.note(featureOf(c.verdict))
				const compiled = compileWrite(
					checking(Clocks),
					descOf(c.changeSet()),
					realityWrite(succeeded(testArtifacts(Clocks, testCompile), "the schema's artifacts"))
				)
				if (c.verdict.kind === "compiled") {
					succeeded(compiled, `${c.name} compiles`)
					return
				}
				const reason = refused(compiled, "InstantRefused", `${c.name} is refused`).reason
				if (reason._tag === "InstantRefused") {
					assert.deepEqual(
						{ relation: reason.relation, field: reason.field, rule: reason.rule },
						{ relation: c.verdict.relation, field: c.verdict.field, rule: c.verdict.rule },
						`${c.name}'s refusal names its field and its rule`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rules of how a write writes an instant, stated per case (instants.fixtures.ts cases)"
		},
		box: "SignIn's clock, Session's stamped reference, Orphan's unstamped one and Chain's reference and clock, each case one ChangeSet inserting, putting or deleting them from a query or an array, in one stratum, two, or one realized statement by statement",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/insert/stamp.ts",
				original:
					"\t\t\tquery: namedBody(read, namesOrUnit(carried.map((f) => out.columns.of(f))))\n",
				replacement: "\t\t\tquery: namedBody(read, carried.map((f) => out.columns.of(f)))\n",
				why: "A stamped input of no field, the unit relation, is named by no column where its read's one public column is the unit marker: an insert whose every caller field the call computes dies an internal invariant as it compiles (edullm's Q15, pantry's author_app and the ledger's result composition)."
			},
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: '\t\tif (role.kind === "clock" && op !== "delete" && stated(field)) {\n',
				replacement: "\t\tif (false) {\n",
				why: "An insert or a put may state a clock, so an insert of SignIn from its stored rows compiles where the rule refuses it, and the property fails."
			},
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original:
					"\t\tconst inChild = s.stamp.child.find((f) => stamped.some((o) => o.field.name === f.name))\n",
				replacement: "\t\tconst inChild = s.stamp.child.find(() => false)\n",
				why: "A stamp may read a child the same insert stamps, so Chain's at, of child (user, s), compiles beside its s where the rule refuses it, and the property fails."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\t\t\tconst group = headed.find((g) => sameHeading(g.heading, heading))\n",
				replacement: "\t\t\t\t\tconst group = headed.find(() => false)\n",
				why: "Each query of an operation on a relation is its own action, as before the merge, so Session's two inserts beside SignIn's are two statements of one stratum stamping SignIn.at, refused where the rule compiles them, and the property fails."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\t\t\t\tslot === undefined ? undefined : headed.find((g) => sameHeading(g.heading, carried))\n",
				replacement: "\t\t\t\t\t\tslot === undefined ? undefined : headed.find(() => false)\n",
				why: "The slot of an operation is an action apart from its queries, as before the merge, so Session's host rows and query beside SignIn's insert are two statements stamping SignIn.at, refused where the rule compiles them, and the property fails."
			},
			{
				file: "packages/engine/src/write/delete/exact.ts",
				original:
					'\t\t...rest.filter((f) => isCarried(f) || (f.writing.kind === "instant" && pk.includes(f)))\n',
				replacement: "\t\t...rest.filter((f) => isCarried(f))\n",
				why: "An exact deletion matches facts without the instant of its key, which its target is reached by, so Visit's deletion from two queries, one deletion over their union, dies where the rule compiles it, and the property fails."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					"\t\t!headStamped(b.info.stamps).some((s) => key.some((f) => f.name === s.field.name))\n",
				replacement: "\t\ttrue\n",
				why: "An exact deletion excepts an insertion that stamps its key's instant, whose rows carry none to compare at, so Visit's deletion beside its insert dies where the rule compiles it, and the property fails."
			},
			{
				file: "packages/engine/src/write/frontend/instants.ts",
				original: "\t\t\tif (clocks.get(clockText(s)) !== a.stratum) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "A reference is stamped where no insert of its clock is, so Session alone compiles where the rule refuses it, and the property fails."
			}
		]
	})
