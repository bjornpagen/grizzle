/**
 * Every view grizzle names a role's reads through states the relation it is to isolation certification
 * (program/isolation/member-facts.ts extractNames, over the role's named views, physical/ddl/names.ts NamedRole
 * `views`): a declared whole entry's whole view, and the whole view of each stored derived relation the role reads in
 * full though it holds no entry of it (schema/own.ts OwnedRole `wholeDerived`), in its level's schema of whole views,
 * `__<level>`. Before, the extractor resolved the declared whole entries' views alone, so a role that read a stored
 * derived relation it sees whole, by the view worldNames names it by, read a table the certifier stated no fact of and
 * was certified SERIALIZABLE by it: qti-pie's result suite at candidate 83aaa65f (lane LEDGER-VALUECELL's probe), whose
 * role result_runner reported "facts 54", every line a view of `__delivery`, `__qti_queries`, `__ledger`, `__qti_views`
 * or `__registry`, "the installation states no fact of it".
 *
 * The box: T and U, and Rows, a stored derived relation joining them within a package under a check, declared in the
 * level the login is over or in the level beneath it; and one role holding T and U whole, whose change member reads
 * Rows at a package, compiled for READ
 * COMMITTED as generate compiles it, then certified.
 *
 * Oracle: the specification: the role reads Rows in full through its whole view, no reason the certificate gives is
 * `facts` or names an object the certifier reads no fact of (`?...`), and the role is certified READ COMMITTED, the
 * level its other facts allow: it writes nothing and reads one package's rows of a relation no role writes but
 * grizzle's upkeep.
 *
 * Features: each level.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { reasonsOf } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import { readCommittedChanges } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	derivedLoginOf,
	type Level,
	levelGen
} from "#test/unit/program/isolation/derived-facts.fixtures.ts"

/** A role that reads a stored derived relation in full through its whole view is certified over that relation's facts. */
export const aRoleReadingAStoredDerivedRelationThroughItsWholeViewIsCertifiedOverItsFacts =
	property.exhaust(finite(levelGen), {
		box: "one role holding T and U whole, whose change member reads at a package Rows, a stored derived relation joining them it holds no entry of, declared in the login's level or the level beneath",
		needs: {},
		situations: ["the login's level", "the level beneath"] satisfies ReadonlyArray<Reached<Level>>,
		check: (_, c: Case<Level>) => (level: Level) =>
			Effect.sync(() => {
				c.note(level)
				const login = derivedLoginOf(level)
				const writer = login.named.roles[0]
				assert.deepEqual(
					writer?.owned.wholeDerived,
					["Rows"],
					"the writer reads Rows in full, holding no entry of it"
				)
				assert.ok(
					Arr.some(login.artifacts.derived.order, (d) => d.name === "Rows"),
					"Rows is stored"
				)
				const roles = succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
				const certified = succeeded(
					certification(login.artifacts, new Map([["app", roles]])),
					"certification"
				)
				for (const { role, certificate } of certified.certificates) {
					const reasons = certificate.level === "serializable" ? reasonsOf(certificate.why) : []
					assert.deepEqual(
						Arr.filter(
							reasons,
							(r) =>
								r.condition === "facts" ||
								(r.at.kind !== "role" && Str.startsWith("?")(r.at.relation))
						),
						[],
						`role ${role} (${level}): no reason names a relation the certifier reads no fact of`
					)
					assert.equal(
						certificate.level,
						"readCommitted",
						`role ${role} (${level}): certified at the level its other facts allow, where it is refused by ${Formatter.format(reasons)}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every view a role reads through stated to certification as its relation, a stored derived relation's whole view among them, and the role certified READ COMMITTED"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: "\t\tfor (const view of role.named.views.values()) {\n",
				replacement:
					'\t\tfor (const view of [...role.named.views.values()].filter((v) => v.relation !== "Rows")) {\n',
				why: "The extractor resolves no whole view of a relation the role holds no entry of, as before: the read of Rows reads `__<level>`.rows, a table the certifier states no fact of, and the role is certified SERIALIZABLE by `facts`, as qti-pie's result_runner was by 54; the property fails."
			}
		]
	})
