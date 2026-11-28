/**
 * Parameters' pattern domains migrated as the stored fields that share their patterns come and go, on PostgreSQL 19.
 *
 * A parameter's pattern domain is named by its place and the digest of its whole definition, a domain over its
 * pattern's structural text domain (physical/ddl/domains.ts paramDomainIdentity), which the installation creates for the
 * parameter where no stored field holds the pattern. So a domain of one name has one definition, and a migration never
 * changes one in place; the base-type refusal of a domain stored columns use (deploy/diff/diff.ts domainObject) is
 * unreachable for them.
 *
 * The box: a first version storing Code alone (test/support/migrate/param-domains.ts), drafted from nothing and
 * installed, then a draft to a target drawn by which of the two patterns it stores (versionOf), Coded dropped where it
 * no longer stores Code:
 *
 * - `code`'s domain stays over Code's text domain, whose stored field the target keeps or drops, the text domain then
 *   staying for the parameter alone;
 * - `slug`'s domain stays over Slug's text domain, which a stored field of the target comes to hold or none does.
 *
 * Properties, for every case:
 *
 * - the draft is drafted, no domain refused;
 * - it alters no domain, creates each parameter domain the target holds that the first version does not, and drops each
 *   the first version holds that the target does not;
 * - every parameter domain holds no CHECK of its own, and no two domains of the target installation share a CHECK body;
 * - the first version's folder and the draft, reviewed, apply under the installed-catalog checker, and the catalog is a
 *   fresh install's of the target.
 *
 * Oracle: PostgreSQL, which refuses a domain created under a taken name, over a missing base or dropped while a domain
 * stands over it; the installed-catalog checker against the target snapshot; and a fresh install's catalog.
 *
 * Features: a text domain under a parameter that stays stored, and one staying for the parameter once its stored field
 * is dropped; a parameter's text domain a stored field comes to hold, and one no stored field holds.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	bodyOf,
	caseGen,
	declaredFor,
	domainsOf,
	type Feature,
	isParamDomain,
	ofParam,
	required
} from "#test/pg/migrate/param-domains.fixtures.ts"
import { generatedDraft } from "#test/support/install-migrate.ts"
import { fullVersion } from "#test/support/installed.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	fromEmpty,
	fromSnapshot,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import {
	firstStored,
	passedOver,
	type Stored,
	versionOf
} from "#test/support/migrate/param-domains.ts"
import {
	apply,
	checkedAdmission,
	keeping,
	noFurther,
	openMigrator,
	sameCatalog
} from "#test/support/pg/migrate/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The version storing `stored` under the allocated name `name` with its full world's login, whose workload holds the
 * passed program, drafted `step` of its history from `previous` as `grizzle generate` drafts it (install-migrate.ts
 * generatedDraft), every placeholder kept at '0'.
 */
const draftedVersion = (
	stored: Stored,
	name: string,
	previous: Previous,
	step: number,
	declarations: Declarations
) => {
	const value = versionOf(stored)
	return generatedDraft(
		{ ...fullVersion(value, { passed: passedOver(value) }, [], name), declarations },
		{ installation: identity.schema(parsedSchemaName(name)), previous, step },
		{ kind: "values", value: keeping("'0'").value }
	)
}

/** Parameters' pattern domains as the stored fields that share their patterns come and go the first version migrates to every target: no domain refused or altered, every parameter domain over its text domain, the catalog a fresh install's. */
export const paramDomains = property.exhaust(finite(caseGen), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: required satisfies ReadonlyArray<Reached<Feature>>,
	check:
		({ caseSubstrate }, k: Case<Feature>) =>
		(t) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const allocated = yield* substrate.schema({ create: false, label: "param_domains" })
					const first = yield* draftedVersion(firstStored, allocated, fromEmpty, 1, noDeclarations)
					const m = yield* openMigrator(substrate, substrate.owner)
					yield* apply(m, { snapshot: first.snapshot, folders: [first.folder] }, noFurther)
					const second = yield* draftedVersion(
						t,
						allocated,
						fromSnapshot(first.snapshot),
						2,
						declaredFor(t)
					)
					const installation = second.plan.installation
					const statements = Arr.flatMap(second.generated.plan.steps, (s) =>
						s.draft.kind === "statement" ? [s.draft.statement] : []
					)
					assert.deepEqual(
						Arr.filter(statements, (s) => s.kind === "alterDomain"),
						[],
						"the draft alters no domain"
					)
					const before = domainsOf(first.snapshot.manifest.objects)
					const after = domainsOf(installation.manifest.objects)
					const created = new Set(
						Arr.flatMap(statements, (s) =>
							s.kind === "createDomain" ? [printObjectName(s.name)] : []
						)
					)
					const dropped = new Set(
						Arr.flatMap(statements, (s) =>
							s.kind === "drop" && s.object === "DOMAIN" ? [printObjectName(s.name)] : []
						)
					)
					for (const name of after.keys()) {
						if (isParamDomain(name) && !before.has(name)) {
							assert.ok(created.has(name), `the draft creates ${name}`)
						}
					}
					for (const name of before.keys()) {
						if (isParamDomain(name) && !after.has(name)) {
							assert.ok(dropped.has(name), `the draft drops ${name}`)
						}
					}
					for (const [name, d] of after) {
						if (!isParamDomain(name)) {
							continue
						}
						assert.ok(d.constraints.length === 0, `${name} holds no CHECK of its own`)
						const base = d.base.kind === "named" ? d.base.name : ""
						const stored = Arr.some(installation.manifest.objects, (o) =>
							Arr.some(
								o.ddl,
								(st) =>
									st.kind === "createTable" &&
									Arr.some(st.columns, (c) => c.type.kind === "named" && c.type.name === base)
							)
						)
						if (ofParam("slug")(name)) {
							k.note(
								stored
									? "a parameter's text domain a stored field comes to hold"
									: "a parameter's text domain no stored field holds"
							)
						}
						if (ofParam("code")(name)) {
							k.note(
								stored
									? "a text domain under a parameter that stays stored"
									: "a text domain staying for a parameter once its stored field is dropped"
							)
						}
					}
					const checked = Arr.filter([...after.values()], (d) => d.constraints.length > 0)
					for (const [i, d] of checked.entries()) {
						const twin = Arr.findFirst(Arr.drop(checked, i + 1), (e) =>
							canonicalEquals(bodyOf(d), bodyOf(e))
						)
						assert.ok(
							Option.isNone(twin),
							`no two installed domains share a CHECK body: ${printObjectName(d.name)}`
						)
					}
					yield* apply(
						m,
						{
							snapshot: second.snapshot,
							folders: [first.folder, second.folder]
						},
						checkedAdmission(installation, substrate.admin)
					)
					const fresh = yield* substrate.schema({ create: false, label: "param_domains_fresh" })
					const freshDraft = yield* draftedVersion(t, fresh, fromEmpty, 1, noDeclarations)
					yield* apply(
						m,
						{ snapshot: freshDraft.snapshot, folders: [freshDraft.folder] },
						noFurther
					)
					yield* sameCatalog(installation, freshDraft.plan.installation, "the target")
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL applies the draft; the installed-catalog checker matches the target snapshot; the catalog is a fresh install's"
	},
	box: "a first version storing Code alone, drafted to a version storing Code or not and Slug or not",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/install/plan.ts",
			original:
				"[...own.texts, ...fields.flatMap((f) => typeRefinements(f.type)), ...planned.texts]",
			replacement: "[...own.texts, ...fields.flatMap((f) => typeRefinements(f.type))]",
			why: "A parameter's text domain no stored field holds is never created, the served programs' refinements, the parameters' among them, left out of the installation's text domains, so its parameter domain stands over no base and the install fails."
		}
	]
})
