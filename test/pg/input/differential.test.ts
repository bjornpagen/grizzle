/**
 * The deleted host validators against PostgreSQL 19: every value the old bind-time check of a parameter's contract and
 * pattern refused (test/support/oracle/refinement.ts refinedMember, the test-only copy of codec/scalar.ts's deleted
 * check) PostgreSQL refuses through the new path, as it binds the parameter, by the same rule, and classified as the
 * refusal grizzle reports; and nothing else.
 *
 * - Differential: one schema declares a pattern on a stored field (Slug), a pattern no field declares (Tag), a bound
 *   contract over bigint (Cents) and an exact rate contract over numeric(7, 6) (Rate). Each lookup reads one of them as
 *   a scalar parameter or as a field of a relation parameter's facts, its placeholder cast to the parameter's own
 *   pattern domain or to the contract's domain, which installing the lookups' workload creates for every pattern a
 *   parameter names (physical/access/extension.ts workloadExtension). Every drawn value is of its base carrier, which the host
 *   parses and binds, refusing nothing a refinement refuses, and is run: PostgreSQL refuses it with 23514 exactly where the old check refused it, the reported data type the
 *   domain it was cast to, and the role's classifier (witness/classify.ts domainRefusal, through the served witness)
 *   reads the refusal as the one grizzle reports: a pattern's as ParamRejected naming the parameter (`<parameter>.<field>`
 *   for a relation parameter's) and the pattern as its type spells it, a contract's as LawRejected naming the
 *   contract's law, `every` of it. A value inside its rule matches exactly its rows.
 *
 * The one refusal the host made that PostgreSQL never makes is deleted on purpose and stated here, not searched: two
 * facts one stratum deletes at one key (README "A relation's rows are a set").
 *
 * Oracle: the old host check, run beside the new path; PostgreSQL's report and the classifier's reading of it.
 *
 * Plants (~/.cache/grizzle-release/LIVE-PARSE/plants): refinement-left-on-host (paramEncoder keeps the deleted host
 * check, so the old validator's refusal comes before any SQL, an EncodingFailure, where PostgreSQL's must), and
 * param-domain-uncast (a parameter's placeholder cast to its base, so PostgreSQL admits what the old check refused).
 *
 * Features: per lookup, "<lookup> refused alike" and "<lookup> admitted alike".
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
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
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { bigint } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option } from "effect"
import type { ServerError } from "#adapter/errors/failures.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { installationRefusals } from "#adapter/served/refusals.ts"
import type { DomainRefusal } from "#adapter/witness/classify.ts"
import { servedWitness } from "#adapter/witness/index.ts"
import { noLevelAbove } from "#adapter/witness/keylaw.ts"
import { identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { paramDomainsOf } from "#compiler/physical/ddl/domains.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import {
	compileTemplate,
	installationSql,
	paramValues,
	testArtifacts,
	testCompile,
	workloadOver
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { refinedMember } from "#test/support/oracle/refinement.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { serverError } from "#test/support/server-error.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A pattern a stored field declares. */
const Slug = str.regex("^[a-z]{1,8}$", "u")
/** A pattern no stored field declares: only a parameter's pattern domain checks it. */
const Tag = str.regex("^#[0-9]{1,3}$", "u")
const Cents = contract("Cents", pg.bigint, (x) => x.between(0n, 10_000n))
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))

const Article = relation("Article", { id: uuid, slug: Slug }, ["id"])
const Price = relation("Price", { id: uuid, amount: Cents, rate: Rate }, ["id"])
const Shop = schema("Shop", [Article, Price], [])
const shopCodes = firstCodebook(rostersOf(owning(Shop)))

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
 * The lookups' queries as the workload the installation installs, which installs the pattern domain of every pattern a
 * parameter names (physical/access/extension.ts workloadExtension), as a served workload's installation does.
 */
const lookupsWorkload = workload(Shop, { bySlug, tagged, byAmount, byRate, echoed })

/** One lookup: its query, the parameter it binds, and how a drawn value is bound to it. */
interface Lookup {
	readonly label: string
	readonly query: unknown
	readonly param: string
	readonly bind: (value: unknown) => Readonly<Record<string, unknown>>
	readonly values: Gen<unknown>
	/** The place a pattern's refusal names, or the contract a contract's names. */
	readonly rule:
		| { readonly kind: "pattern"; readonly place: string }
		| { readonly kind: "contract"; readonly contract: string }
}

const textGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 0, max: 10 }),
	map(int(0, 2000), (n) => `#${n}`),
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 })
])

const lookups: Arr.NonEmptyReadonlyArray<Lookup> = [
	{
		label: "a stored field's pattern",
		query: bySlug,
		param: "slug",
		bind: (slug) => ({ slug }),
		values: textGen,
		rule: { kind: "pattern", place: "slug" }
	},
	{
		label: "a parameter's own pattern",
		query: tagged,
		param: "tag",
		bind: (tag) => ({ tag }),
		values: textGen,
		rule: { kind: "pattern", place: "tag" }
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
		rule: { kind: "pattern", place: "rows.tag" }
	}
]

interface Case {
	readonly lookup: Lookup
	readonly values: ReadonlyArray<unknown>
}

const caseGen: Gen<Case> = (source) => {
	const lookup = source.draw(element(lookups))
	return { lookup, values: source.draw(array(lookup.values, { min: 1, max: 12 })) }
}

type DifferentialFeature = `${string} refused alike` | `${string} admitted alike`

/** The type the old check judged a lookup's value by: the scalar parameter's, or the relation parameter's field's. */
const judgedType = (template: OracleTemplate, lookup: Lookup) => {
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
const serverErrorOf = (failure: SqlError): ServerError | undefined =>
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
const readsAsRule = (lookup: Lookup, reading: DomainRefusal | undefined): boolean => {
	if (reading === undefined) {
		return false
	}
	switch (lookup.rule.kind) {
		case "pattern":
			return reading.kind === "param" && reading.param === lookup.rule.place
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

layer(Substrate.layer)("the deleted host validators against PostgreSQL 19", (it) => {
	it.effect(
		"PostgreSQL refuses exactly what the old host check refused, by the same rule, read as grizzle reports it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const name = yield* s.schema({ create: false, label: "differential" })
					const installationName = identity.schema(parsedSchemaName(name))
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
					const owned = owning(Shop)
					const options = installOptions(owned, s.owner.role)
					const installed = compileInstallation(owned, {
						...options,
						levels: [installationName],
						logins: [oracleOwnedLogin(owned.desc)],
						extensions: [
							...options.extensions,
							workloadOver([{ login: "differential", workloads: [lookupsWorkload] }])
						]
					})
					if (!installed.ok) {
						throw new Error(`install: ${Formatter.format(installed.error)}`)
					}
					const installation: Installation = installed.value
					yield* transaction(s.admin, installationSql(installation, s.database))
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
					const session = yield* s.session({ ...ownerSession(), label: "differential" })
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the old host check of a parameter's contract and pattern, and the classifier's reading of PostgreSQL's report"
							},
							suite: "pg/input/differential",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<DifferentialFeature>(
								nonEmpty(
									Arr.flatMap(lookups, (l): ReadonlyArray<DifferentialFeature> => [
										`${l.label} refused alike`,
										`${l.label} admitted alike`
									]),
									"the features"
								),
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ lookup, values }, c) =>
							Effect.gen(function* () {
								const template = templates.get(lookup)
								if (template === undefined) {
									throw new Error(`the template of ${lookup.label}`)
								}
								const old = refinedMember(judgedType(template, lookup), new CompilePatterns())
								if (old === undefined) {
									throw new Error(`${lookup.label} reads a refined type`)
								}
								const spec = template.optimized[0]
								if (spec === undefined) {
									throw new Error(`${lookup.label} holds a statement`)
								}
								for (const value of values) {
									const bound = lookup.bind(value)
									assert.equal(
										executionInputs(paramCodecs(template.params, shopCodes), bound)._tag,
										"Success",
										`${lookup.label}: the host parses ${Formatter.format(value)} as its base carrier alone, refusing nothing a refinement refuses`
									)
									const ran = yield* Effect.exit(
										session.values(
											spec.sql,
											paramValues(spec, bound, { params: template.params, codes: shopCodes })
										)
									)
									const oldRefused = !old(value)
									if (Exit.isSuccess(ran)) {
										assert.ok(
											!oldRefused,
											`${lookup.label}: PostgreSQL admits ${Formatter.format(value)}, which the old check refused`
										)
										c.note(`${lookup.label} admitted alike`)
										continue
									}
									const failure = Option.getOrUndefined(Exit.findErrorOption(ran))
									const reported = failure === undefined ? undefined : serverErrorOf(failure)
									assert.ok(
										oldRefused,
										`${lookup.label}: PostgreSQL refuses ${Formatter.format(value)}, which the old check admitted: ${Formatter.format(reported)}`
									)
									assert.equal(
										reported?.sqlstate,
										sqlstates.checkViolation,
										`${lookup.label}: a domain's refusal`
									)
									assert.ok(
										reported !== undefined && readsAsRule(lookup, witness.domain(reported)),
										`${lookup.label}: ${Formatter.format(reported)} reads as ${Formatter.format(
											reported === undefined ? undefined : witness.domain(reported)
										)}`
									)
									c.note(`${lookup.label} refused alike`)
								}
							})
					)
				})
			)
	)
})
