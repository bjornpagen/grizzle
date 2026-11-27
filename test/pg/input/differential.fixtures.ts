/** What the properties of differential.test.ts read: its spaces, models and helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { ServerError } from "#adapter/errors/failures.ts"
import { installationRefusals } from "#adapter/served/refusals.ts"
import type { DomainRefusal } from "#adapter/witness/classify.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { identity, type ParamPlace } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { paramDomainsOf } from "#compiler/physical/ddl/domains.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { Id } from "#test/support/ids.ts"
import { appliedGenerated, generatedDraft, noPlaceholders } from "#test/support/install-migrate.ts"
import { fullVersion } from "#test/support/installed.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { serverError } from "#test/support/server-error.ts"
import { installTemplate } from "#test/support/substrate/substrate.ts"

/** A pattern a stored field declares. */
const Slug = str.regex("^[a-z]{1,8}$", "u")

/** A pattern no stored field declares: only a parameter's pattern domain checks it. */
const Tag = str.regex("^#[0-9]{1,3}$", "u")

const centsKey = Symbol("Cents")
const Cents = contract<typeof centsKey>()("Cents", pg.bigint, (x) => Logic.between(x, 0n, 10_000n))

const rateKey = Symbol("Rate")
const Rate = contract<typeof rateKey>()("Rate", pg.numeric(7, 6), (x) => Logic.between(x, 0n, 1n))

const Article = relation("Article", { id: Id, slug: Slug }, ["id"])

const Price = relation("Price", { id: Id, amount: Cents, rate: Rate }, ["id"])

const Shop = schema("Shop", [Article, Price], [])

export const shopCodes = firstCodebook(rostersOf(owning(Shop)))

/** The articles a slug matches. */
const bySlug = query(Shop).rule((r) => {
	const { id, slug } = v(Article, "article")
	return r
		.match(Article, { id, slug })
		.where(r.eq(slug, r.param("slug", Slug)))
		.find({ id })
})

/** Every article beside the tag a parameter holds. */
const tagged = query(Shop).rule((r) => {
	const { id } = v(Article, "article")
	return r.match(Article, { id }).find({ id, tag: r.param("tag", Tag) })
})

/** The prices of an amount. */
const byAmount = query(Shop).rule((r) => {
	const { id, amount } = v(Price, "price")
	return r
		.match(Price, { id, amount })
		.where(r.eq(amount, r.param("amount", Cents)))
		.find({ id })
})

/** The prices of a rate. */
const byRate = query(Shop).rule((r) => {
	const { id, rate } = v(Price, "price")
	return r
		.match(Price, { id, rate })
		.where(r.eq(rate, r.param("rate", Rate)))
		.find({ id })
})

/** The slugs and tags a relation parameter's facts carry, delivered as they are. */
const echoed = query(Shop).rule((r) => {
	const rows = r.relation("rows", { slug: Slug, tag: Tag })
	const { slug, tag } = v(rows, "row")
	return r.match(rows, { slug, tag }).find({ slug, tag })
})

/**
 * Shop under the allocated name `name` with its full world's login, whose workload holds every lookup, drafted as
 * `grizzle generate` drafts its first migration (install-migrate.ts generatedDraft): the installation installs the
 * pattern domain of every pattern a parameter names (physical/access/extension.ts servedWorkloadExtension), as a
 * served workload's installation does.
 */
const shopDraft = (name: string) =>
	generatedDraft(
		{
			...fullVersion(Shop, { bySlug, tagged, byAmount, byRate, echoed }, [], name),
			declarations: noDeclarations
		},
		{ installation: identity.schema(parsedSchemaName(name)), previous: fromEmpty, step: 0 },
		noPlaceholders
	)

/** One lookup: its query, the parameter it binds, and how a drawn value is bound to it. */
export interface Lookup {
	readonly label: string
	readonly query: unknown
	readonly param: string
	readonly bind: (value: unknown) => Readonly<Record<string, unknown>>
	readonly values: Gen<unknown>
	/** The place a pattern's refusal names, or the contract a contract's names. */
	readonly rule:
		| { readonly kind: "pattern"; readonly place: ParamPlace }
		| { readonly kind: "contract"; readonly contract: string }
}

const textGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 0, max: 10 }),
	map(int(0, 2000), (n) => `#${n}`),
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 })
])

export const lookups: Arr.NonEmptyReadonlyArray<Lookup> = [
	{
		label: "a stored field's pattern",
		query: bySlug,
		param: "slug",
		bind: (slug) => ({ slug }),
		values: textGen,
		rule: { kind: "pattern", place: { kind: "scalar", name: "slug" } }
	},
	{
		label: "a parameter's own pattern",
		query: tagged,
		param: "tag",
		bind: (tag) => ({ tag }),
		values: textGen,
		rule: { kind: "pattern", place: { kind: "scalar", name: "tag" } }
	},
	{
		label: "a bigint contract",
		query: byAmount,
		param: "amount",
		bind: (amount) => ({ amount }),
		values: bigint(-20n, 10_020n),
		rule: { kind: "contract", contract: "Cents" }
	},
	{
		label: "a numeric contract",
		query: byRate,
		param: "rate",
		bind: (rate) => ({ rate }),
		values: map(int(-1_000_100, 2_000_100), (n) => Decimal.of(`${n}e-6`)),
		rule: { kind: "contract", contract: "Rate" }
	},
	{
		label: "a relation parameter's field",
		query: echoed,
		param: "rows",
		bind: (tag) => ({ rows: [{ slug: "ok", tag }] }),
		values: textGen,
		rule: { kind: "pattern", place: { kind: "field", name: "rows", field: "tag" } }
	}
]

interface Case {
	readonly lookup: Lookup
	readonly values: ReadonlyArray<unknown>
}

export const caseGen: Gen<Case> = (source) => {
	const lookup = source.draw(element(lookups))
	return { lookup, values: source.draw(array(lookup.values, { min: 1, max: 12 })) }
}

export type DifferentialFeature = `${string} refused alike` | `${string} admitted alike`

/** The type the old check judged a lookup's value by: the scalar parameter's, or the relation parameter's field's. */
export const judgedType = (template: OracleTemplate, lookup: Lookup) => {
	const decl = Option.getOrUndefined(Arr.findFirst(template.params, (p) => p.name === lookup.param))
	if (decl === undefined) {
		throw new Error(`the lookup ${lookup.label} declares no parameter ${lookup.param}`)
	}
	if (decl.kind === "scalar") {
		return decl.type
	}
	const field = Option.getOrUndefined(Arr.findFirst(decl.heading, (c) => c.name === "tag"))
	if (field === undefined) {
		throw new Error("the relation parameter carries a tag")
	}
	return field.type
}

/** A test connection's refusal as the wire parses a server's report (support/server-error.ts), each field it named. */
export const serverErrorOf = (failure: SqlError): ServerError | undefined =>
	failure.reason._tag === "ServerError"
		? serverError({
				sqlstate: failure.reason.fields.code,
				constraint: failure.reason.fields.constraint,
				schema: Option.getOrUndefined(failure.reason.fields.schema),
				table: Option.getOrUndefined(failure.reason.fields.table),
				column: Option.getOrUndefined(failure.reason.fields.column),
				dataType: Option.getOrUndefined(failure.reason.fields.dataType),
				detail: Option.getOrUndefined(failure.reason.fields.detail)
			})
		: undefined

/** Whether the classifier's reading is the refusal grizzle reports for the lookup's rule. */
export const readsAsRule = (lookup: Lookup, reading: DomainRefusal | undefined): boolean => {
	if (reading === undefined) {
		return false
	}
	switch (lookup.rule.kind) {
		case "pattern":
			return reading.kind === "param" && deepEquals(reading.param, lookup.rule.place)
		case "contract": {
			const contractName = lookup.rule.contract
			return (
				reading.kind === "laws" &&
				reading.refused.kind === "every" &&
				Arr.every(
					reading.refused.laws,
					(l) => l.law.kind === "contract" && l.law.contract === contractName
				)
			)
		}
	}
}

/**
 * Shop installed with every lookup's workload under the template's name, and what a case over it reads: each lookup's
 * template compiled for that name and the witness that reads PostgreSQL's refusals of the installation. Planned once per
 * worker (the compiles, all pure) and installed once per member, as the test installed it once before its cases; every
 * case runs in one rolled-back transaction on the worker's clone of it (Substrate.rolledBack), so a case writes nothing.
 */
export const shopTemplate = installTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "shop",
	content: {
		schema: "Shop",
		login: "server",
		workloads: ["bySlug", "tagged", "byAmount", "byRate", "echoed"]
	},
	plan: (names) =>
		Effect.gen(function* () {
			const installationName = identity.schema(parsedSchemaName(names.schema))
			const templates = new Map(
				Arr.map(lookups, (l): readonly [Lookup, OracleTemplate] => {
					const compiled = compileTemplate(l.query, undefined, {
						...testCompile,
						installation: installationName
					})
					if (!compiled.ok) {
						throw new Error(`${l.label}: ${Formatter.format(compiled.error)}`)
					}
					return [l, compiled.value]
				})
			)
			const params = Arr.flatMap([...templates.values()], (t) => t.params)
			const drafted = yield* shopDraft(names.schema)
			const artifacts = testArtifacts(Shop, {
				installation: installationName,
				codes: testCompile.codes
			})
			if (!artifacts.ok) {
				throw new Error(`artifacts: ${Formatter.format(artifacts.error)}`)
			}
			const witness = servedWitness(
				{ ...installationRefusals(artifacts.value), params: paramDomainsOf(params) },
				noLevelAbove,
				shopCodes
			)
			return { names, drafted, templates, witness }
		}),
	install: ({ names, drafted }) =>
		Effect.asVoid(
			appliedGenerated([drafted], names.schema, ordinarySession, (fresh) =>
				Effect.map(shopDraft(fresh), (again) => again.plan)
			)
		),
	bind: ({ templates, witness }) => ({ templates, witness })
})
