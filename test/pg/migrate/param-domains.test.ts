/**
 * Parameters' pattern domains migrated across a change of their definition, on PostgreSQL 19.
 *
 * A parameter's pattern domain is named by its place and the digest of its whole definition, a domain over its
 * pattern's structural text domain (physical/ddl/domains.ts paramDomainIdentity). So a domain of one name has one
 * definition, and a migration never changes one in place: a changed definition is another domain, created in Setup, the
 * old one dropped at the end of the migration. The base-type refusal of a domain stored columns use (deploy/diff/diff.ts
 * domainObject) is unreachable for them.
 *
 * The box: the frozen first version (test/support/migrate/param-domains.ts), installed as grizzle installed it before
 * parameter domains were named by their whole definition, `code`'s domain over Code's text domain and `slug`'s with a
 * CHECK of its own, each named by its pattern's definition alone; then a draft by the current compiler to each target:
 *
 * - the first version again, as pantry's next generate on a new grizzle drafts it: `slug`'s own CHECK becomes a domain
 *   over a text domain created for the parameters, the shape pantry's three domains held at fa30bb28 met by main;
 * - the second version, Coded dropped and Tagged stored: `code`'s text domain loses the stored field under it and stays
 *   for the parameter, and `slug`'s own CHECK becomes a domain over the text domain Tagged's field now stores.
 *
 * Properties, for every case:
 *
 * - the draft is drafted, no domain refused;
 * - it alters no domain, creates each parameter domain the target holds that the first version does not, and drops each
 *   the first version holds that the target does not;
 * - no two domains of the target installation share a CHECK body;
 * - the first version's folder and the draft, reviewed, apply under the installed-catalog checker, and the catalog is a
 *   fresh install's of the target.
 *
 * Oracle: PostgreSQL, which refuses a domain created under a taken name or dropped while a domain stands over it; the
 * installed-catalog checker against the target snapshot; and a fresh install's catalog.
 *
 * Features: each target; a parameter domain's own CHECK moved over a text domain created for the parameters, and over a
 * stored text domain; a text domain staying for a parameter once its stored field is dropped.
 *
 * Plants (~/.cache/grizzle-release/CONTRACTDOMAIN/plants): param-domain-identity-alone.patch names a parameter's domain
 * by its place and its pattern's definition alone, as the first version was named, so `slug`'s domain keeps its name
 * across the change of its base, and the draft is refused as UnsupportedOperation, changing the base type of a domain.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { type Reached, requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { CreateDomain } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	apply,
	checkedAdmission,
	kept,
	noFurther,
	openMigrator,
	reviewedSource,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { paramsOver } from "#test/support/compile.ts"
import { atName, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import {
	firstVersion,
	frozenFirst,
	passedOver,
	secondVersion
} from "#test/support/migrate/param-domains.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const targets = ["the first version again", "the second version"] as const
type Target = (typeof targets)[number]

type Feature =
	| Target
	| "an own CHECK moved over a text domain created for the parameters"
	| "an own CHECK moved over a stored text domain"
	| "a text domain staying for a parameter once its stored field is dropped"

/** Each target's schema, and what its draft declares. */
const targetOf = (t: Target) => {
	switch (t) {
		case "the first version again":
			return { value: firstVersion, declared: { renames: [], drops: [] } satisfies Declarations }
		case "the second version":
			return {
				value: secondVersion,
				declared: {
					renames: [],
					drops: [{ kind: "relation", relation: parsedName("Coded") }]
				} satisfies Declarations
			}
	}
}

/** The installer extension of a version's one program: its parameters' types, nothing else of its workload. */
const servedParams = (value: typeof firstVersion | typeof secondVersion) =>
	paramsOver([{ login: "server", workloads: [workload(value, { passed: passedOver(value) })] }])

/** The domains `objects` create, by name. */
const domainsOf = (
	objects: Installation["manifest"]["objects"]
): ReadonlyMap<string, CreateDomain> =>
	new Map(
		Arr.flatMap(objects, (o) =>
			Arr.flatMap(o.ddl, (st) =>
				st.kind === "createDomain" ? [[printObjectName(st.name), st] as const] : []
			)
		)
	)

/** Whether a printed domain name is a parameter's pattern domain, and the parameter's, `code` or `slug`. */
const isParamDomain = Str.includes(`."__param_`)
const ofParam = (param: "code" | "slug") => Str.includes(`."__param_${param}_`)

/** A domain's CHECK body: its base, its collation and its predicates. */
const bodyOf = (d: CreateDomain) => ({
	base: d.base,
	collation: d.collation,
	checks: Arr.map(d.constraints, (c) => c.predicate)
})

const caseGen: Gen<Target> = element(targets)

const required: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	...targets,
	"an own CHECK moved over a text domain created for the parameters",
	"an own CHECK moved over a stored text domain",
	"a text domain staying for a parameter once its stored field is dropped"
]

layer(Substrate.layer)("parameters' pattern domains across a change of their definition", (it) => {
	it.effect(
		"the frozen first version migrates to each target: no domain refused or altered, each changed definition another domain, the catalog a fresh install's",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "the frozen first version, `code` over Code's text domain and `slug` with its own CHECK, each named by its pattern alone, drafted to itself and to the version dropping Code's field and storing Slug",
						oracle: {
							kind: "postgresql",
							name: "PostgreSQL applies the draft; the installed-catalog checker matches the target snapshot; the catalog is a fresh install's"
						},
						suite: "pg/migrate/param-domains",
						generator: caseGen,
						literal: (t) => t,
						coverage: requiredInSpace<Feature>(required),
						caseHang,
						concurrency: 1
					},
					(t, k) =>
						Effect.gen(function* () {
							k.note(t)
							const substrate = yield* Substrate
							const first = yield* frozenFirst
							yield* Effect.addFinalizer(() =>
								Effect.orDie(
									substrate.admin.query(
										`DROP SCHEMA IF EXISTS "${first.snapshot.schema}" CASCADE`,
										[]
									)
								)
							)
							const m = yield* openMigrator(substrate, substrate.owner)
							yield* apply(m, { snapshot: first.snapshot, folders: [first.folder] }, noFurther)
							const { value, declared } = targetOf(t)
							const installation = compile(value, {
								...asDrafted,
								extensions: [servedParams(value)]
							})
							const g = succeeded(
								generate({
									previous: fromSnapshot(first.snapshot),
									installation,
									name: "second",
									timestamp: draftedAt(2),
									workload: noWorkload,
									declared
								}),
								"the target drafts from the frozen first version"
							)
							const statements = Arr.flatMap(g.plan.steps, (s) =>
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
								const ownBefore = Arr.some(
									[...before],
									([n, b]) => ofParam("slug")(n) && b.constraints.length > 0
								)
								if (ofParam("slug")(name) && ownBefore) {
									k.note(
										stored
											? "an own CHECK moved over a stored text domain"
											: "an own CHECK moved over a text domain created for the parameters"
									)
								}
								if (t === "the second version" && ofParam("code")(name) && !stored) {
									k.note("a text domain staying for a parameter once its stored field is dropped")
								}
							}
							const checked = Arr.filter([...after.values()], (d) => d.constraints.length > 0)
							for (const [i, d] of checked.entries()) {
								const twin = Arr.findFirst(Arr.drop(checked, i + 1), (e) =>
									canonicalEquals(bodyOf(d), bodyOf(e), everyProperty)
								)
								assert.ok(
									Option.isNone(twin),
									`no two installed domains share a CHECK body: ${printObjectName(d.name)}`
								)
							}
							yield* apply(
								m,
								{
									snapshot: g.snapshot,
									folders: [first.folder, reviewedSource(g, kept)]
								},
								checkedAdmission(installation, substrate.admin)
							)
							const fresh = yield* substrate.schema({ create: false, label: "param_domains_fresh" })
							const freshInstallation = compile(value, {
								...asDrafted,
								schema: atName(fresh),
								extensions: [servedParams(value)]
							})
							const freshDraft = succeeded(
								generate({
									previous: fromEmpty,
									installation: freshInstallation,
									name: "fresh",
									timestamp: draftedAt(1),
									workload: noWorkload,
									declared: noDeclarations
								}),
								"a fresh install of the target drafts"
							)
							yield* apply(
								m,
								{ snapshot: freshDraft.snapshot, folders: [reviewedSource(freshDraft, kept)] },
								noFurther
							)
							yield* sameCatalog(installation, freshInstallation, t)
						}).pipe(Effect.scoped)
				)
			)
	)
})
