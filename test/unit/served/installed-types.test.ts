/**
 * A served compile under a snapshot casts a parameter only to a type the snapshot's installation installs
 * (physical/install/plan.ts ParamSource `recorded`): a program whose parameter is cast to a pattern domain or to the
 * domain of a contract outside the base that the installation does not install is refused where it is compiled, as
 * UninstalledDomain, never by PostgreSQL where it runs (42704, type does not exist).
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts), and logins
 * drawn over them (test/support/served-login.ts liveLoginGen: reads of the case's queries, whose relation parameters
 * take stored headings; a read through the first role's query entry at the key a parameter binds, typed as the entry's
 * key field; perhaps a clocked read, its `now` typed by a contract outside the base), each login is compiled as
 * `grizzle generate` compiles it, and then again under the snapshot.json of an installation serving the same login with
 * some of its programs dropped, as drawn: a role's clocked read, its reads of the case's queries, its reads of its own
 * world.
 *
 * - Oracle: the types the login's programs cast their parameters to, read from its file compiled under its own snapshot
 *   (every parameter its roles' statements declare, test/support/served-reach.ts declaredBy: each pattern parameter's
 *   own pattern domain, at its place, and each contract outside the base down a parameter's type), against the
 *   parameter types the dropped installation's snapshot.json records (derived.params). The compile under that snapshot
 *   is refused as UninstalledDomain exactly when the login casts a parameter to one it lacks, or as UninstalledIndex
 *   where a program it compiles before reads through an index the dropped installation does not hold (deploy/snapshot/
 *   served.ts snapshotResolver: a typed refusal at the program, never a missed index), and is never refused as
 *   UninstalledDomain otherwise.
 * - A login compiles under the snapshot generated with its own workload as far as its parameter types and its indexes
 *   go: no compile of it there is refused as UninstalledDomain or UninstalledIndex, its installation planned for every
 *   read it makes.
 *
 * - No two domains of the login's installation share a CHECK body: a parameter's pattern domain is a domain over its
 *   pattern's structural text domain, with no CHECK of its own, the installation's own, which it holds for every
 *   pattern its served programs' parameters name (physical/ddl/domains.ts planTextDomains, addParamDomains), and
 *   PostgreSQL still reports the parameter's own domain when
 *   it refuses.
 */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { drawnSchema, liveLoginGen } from "#test/support/served-login.ts"
import {
	aimsAt,
	castsInstalled,
	type Feature,
	keptOf,
	sketchGen
} from "#test/unit/served/installed-types.fixtures.ts"

/**
 * A served compile under a snapshot casts a parameter only to a type the snapshot's installation installs.
 *
 * Budget: its suite's 60 independent cases (unit/served/installed-types: 60 and 60 steered, Vitest at grizzle
 * 4ca3036a), and 128 steered, measured: at 60 runs its witnesses, fixed by its identity, reach every required
 * situation after 128 steered cases and not before (toolchain-test run with a cap of 1,000, 2026-11-16); at
 * TEST_SEED=1 to 5 every kill is killed.
 */
export const aServedCompileUnderASnapshotCastsAParameterOnlyToATypeTheSnapshotsInstallationInstalls =
	property.explore(aimed(sketchGen({ kind: "drawn" }), aimsAt), {
		needs: {},
		situations: [
			"an uninstalled pattern domain refused",
			"an uninstalled contract refused",
			"a dropped program whose parameter types the installation installs, compiled",
			"a pattern parameter installed, compiled",
			"a contract parameter outside the base installed, compiled",
			"a parameter's pattern domain over a field's structural domain"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level, keeping]) =>
				Effect.suspend(() => {
					const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
					const roles = mapNonEmpty(notes.draw(liveLoginGen(schema)), (shape) => ({
						shape,
						kept: keptOf(keeping, notes.draw)
					}))
					return castsInstalled(schema, level, roles, notes.note)
				}),
		oracle: {
			kind: "specification",
			name: "the parameter types the login declares against those snapshot.json records (derived.params)"
		},
		budget: { runs: 60, steered: 128 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/served/installed-types.test.ts#aServedCompileUnderASnapshotCastsAParameterOnlyToATypeTheSnapshotsInstallationInstalls:-:4.1.0.0.1.0.0.1.0.1.0.1.0.0.1.2.0.1.0.1.0.1.2.1.0.1.2.1.0.1.0.1.0.1.0.0.1.0.0.1.0.1.0.1.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.4.0.0.0.0.0.0.0.m4g.0.0.0.0.0.0.3.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.pa8.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0"
				),
				reason:
					"a relation parameter of a pattern field that a read's constant false filter leaves unread",
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/served.ts",
				original: "\t\tthrow new Refusal(\n",
				replacement: "\t\tthrow new Error(\n",
				why: "A read through an index the snapshot does not hold is a missed index again, not a refusal of its program: a login compiled under the snapshot of an installation that dropped some of its programs dies inside its compile, though the snapshot was planned for another workload, and the property fails."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original: '\t\t\tparamNamed:\n\t\t\t\tparams.kind === "unserved"',
				replacement:
					'\t\t\tparamNamed:\n\t\t\t\tparams.kind === "unserved" || params.kind === "recorded"',
				why: "A parameter's pattern domain is named under a recorded installation whatever it installs, so a missing pattern domain compiles; the oracle's property fails."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: "\tparams: installation.installedParams",
				replacement: "\tparams: { domains: [], contracts: [] }",
				why: "snapshot.json records no parameter type, so a login does not compile under its own snapshot; the own-workload property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/admission.ts",
				original: "\tconst entry = admissionEntry(cx)",
				replacement:
					'\tconst entry = cx.options.subject.kind === "query" ? undefined : admissionEntry(cx)',
				why: "A read's statement holds no admission of a parameter its logic leaves unread, so the kept case's login, whose read's constant false filter leaves its relation parameter unread, compiles under a snapshot that installs no domain of it."
			},
			{
				file: "packages/engine/src/physical/ddl/domains.ts",
				original: "\t\t\tparamDomainDefinition(structural, b.names.types),",
				replacement:
					"\t\t\t{ ...paramDomainDefinition(structural, b.names.types), check: textDomainDefinition(regex.check).check },",
				why: "Every parameter's pattern domain gets its own CHECK, a second copy of its structural domain's; the property fails, no case reaching a parameter's pattern domain over a field's structural domain with no CHECK of its own."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					"\t\t\toutsideContracts(owned, fields, [...planned.contracts, ...planned.typed, ...own.contracts])\n",
				replacement: "\t\t\toutsideContracts(owned, fields, own.contracts)\n",
				why: "The contracts outside the base the served programs type a value by, their parameters' among them, are left out of the installation's outside contracts (physical/install/plan.ts planInstallation), so no domain of them is installed or recorded; the own-workload property fails, a login refused as UninstalledDomain under its own snapshot."
			}
		]
	})
