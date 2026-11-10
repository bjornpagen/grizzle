import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Formatter, Option, Order, String as Str } from "effect"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { refinedConstants } from "#compiler/check/refinement/index.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { indices } from "#compiler/core/array.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Param } from "#compiler/core/wire.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { constantValidationObjects } from "#compiler/lower/shapes/refined/index.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { StatementShare } from "#compiler/write/insert/statement.ts"
import { paramTextForm } from "#test/support/arrays.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import {
	compileTemplate,
	type Declared,
	installationSql,
	installedCodes,
	paramTexts,
	paramValues,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import {
	type ColumnTextDomain,
	installationNamesOf,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { realizeConservative } from "#test/support/oracle/write/realize.ts"
import { checking, owning } from "#test/support/policy.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { paramText } from "#test/support/wire.ts"
import { oracleWorld } from "#test/support/worlds.ts"

/**
 * Refinement validation sites on PostgreSQL 19.
 *
 * One schema, installed by the fresh-install compiler under a fresh schema name, carries a slug pattern, a
 * language-equivalent spelling of it, a contract bounding length with Compute.charLength over the wildcard, and a
 * closed relation whose payload is a slug. Against it:
 *
 * - a parameter is checked against its pattern or contract where the reader binds it (adapter/reader/relations.ts
 *   executionInputs): a value outside them is refused with the codec fault refinedValue before any SQL is sent, and a
 *   value inside them matches exactly its rows, under generic and custom plans and unprepared, in both artifacts, also
 *   where the query emits the parameter, a fused attachment's child emits it inside its array, or a union's arm emits
 *   it beside an arm that stores it; each forced plan is checked against pg_prepared_statements;
 * - a scalar parameter's and a relation parameter's refined values alike, a relation parameter's refined column, which
 *   the optimized delivery casts to its domain in the output list (lower/shapes/refined), included;
 * - a Compute.cast into a refinement no value of its operand is proved to satisfy is refused by compilation
 *   (PartialOperation, precondition language), so no read raises 23514 on a delivered row;
 * - a refined write is refused before commit, by grizzle's compiled insert and by a direct SQL writer alike, with
 *   PostgreSQL's 23514 naming the domain's constraint;
 * - closed payloads are validated by PostgreSQL at installation, and the migration generate drafts and the snapshot
 *   admission derives hold the same validation; a refined query literal is validated wherever it is delivered.
 *
 * The slug, and a spelling of the same language (domain identity is the canonical pattern).
 */
const Slug = str.regex("^[a-z][a-z0-9-]*$")
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-)*$")
const Prose = str.regex("^.*$", "su")
/** A length bound is a contract predicate; over the wildcard the CHECK holds only the bound. */
const limit = 5
const Note = contract("Note", Prose, (x) => Compute.charLength(x).le(limit))

const Tier = closed("Tier", ["Free", "Pro"])
const TierLabel = closed.relation(
	"TierLabel",
	{ tier: closedId(Tier), label: Slug },
	["tier"],
	[
		{ tier: "Free", label: "free" },
		{ tier: "Pro", label: "pro-plan" }
	]
)
const Article = relation("Article", { id: uuid, slug: Slug, title: Prose }, ["id"])
const Draft = relation("Draft", { id: uuid, slug: SlugAgain, note: Note }, ["id"])
const Comment = relation("Comment", { id: uuid, article: uuid, slug: Slug }, ["id"])
/** Numeric contracts: a bigint bound and an exact rate in the unit interval. */
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
const Price = relation("Price", { id: uuid, amount: Cents, rate: Rate }, ["id"])
const Content = schema("Content", { Tier, TierLabel, Article, Draft, Comment, Price }, [
	mutable(Draft)
])

/** Content's codes as a fresh installation drafts them, from no codes: what every template of it binds under. */
const contentCodes = firstCodebook(rostersOf(owning(Content)))

const id = (n: number): Uuid => `00000000-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`

/** The articles: valid slugs, and titles that are valid slugs except where a test says otherwise. */
const articles = (count: number): ReadonlyArray<{ id: string; slug: string; title: string }> =>
	Arr.map(indices(count), (i) => ({
		id: id(i + 1),
		slug: `post-${i + 1}`,
		title: `title-${i + 1}`
	}))

/** An article lookup by slug. */
const bySlug = query(Content).rule((r) => {
	const { id: article, slug } = v(Article, "article")
	return r
		.match(Article, { id: article, slug })
		.where(r.eq(slug, r.param("slug", Article.fields.slug)))
		.find({ id: article, slug })
})

/** The same lookup that also emits the compared parameter under the slug's refinement. */
const echoSlug = query(Content).rule((r) => {
	const { id: article, slug } = v(Article, "article")
	return r
		.match(Article, { id: article, slug })
		.where(r.eq(slug, r.param("slug", Article.fields.slug)))
		.find({ id: article, echo: r.param("slug", Slug) })
})

/** Every title cast into the slug's refinement: a narrowing nothing proves of a title, which compilation refuses. */
const titlesAsSlugs = query(Content).rule((r) => {
	const { id: article, title } = v(Article, "article")
	return r
		.match(Article, { id: article, title })
		.find({ id: article, slug: Compute.cast(title, Slug) })
})

/**
 * Every article with its comments other than the parameter, each echoing it: the child is fused into the parent
 * statement, and the emitted parameter is a refined field of the attachment's array.
 */
const echoComments = query(Content)
	.rule((r) => {
		const { id: article, slug } = v(Article, "article")
		return r.match(Article, { id: article, slug }).find({ id: article, slug })
	})
	.attach(
		"comments",
		(p) =>
			query(Content).rule((r) => {
				const { id: comment, slug } = v(Comment, "comment")
				return r
					.match(Comment, { id: comment, article: p.id, slug })
					.where(r.ne(slug, r.param("slug", Comment.fields.slug)))
					.find({ id: comment, echo: r.param("slug", Slug) })
			}),
		"array"
	)

/** The articles' slugs and the comment slugs equal to the parameter, the second arm emitting the parameter. */
const slugsOrEcho = query(Content)
	.rule((r) => {
		const { id: row, slug } = v(Article, "article")
		return r.match(Article, { id: row, slug }).find({ id: row, slug })
	})
	.rule((r) => {
		const { id: row, slug } = v(Comment, "comment")
		return r
			.match(Comment, { id: row, slug })
			.where(r.eq(slug, r.param("slug", Comment.fields.slug)))
			.find({ id: row, slug: r.param("slug", Slug) })
	})

/** A relation parameter's slugs delivered under their refinement. */
const givenSlugs = query(Content).rule((r) => {
	const given = r.relation("given", { id: uuid, slug: Slug })
	const { id: row, slug } = v(given, "given")
	return r.match(given, { id: row, slug }).find({ id: row, slug })
})

/** A refined query constant: a Compute.literal of the slug's refinement. */
const withConstant = query(Content).rule((r) => {
	const { id: article } = v(Article, "article")
	return r
		.match(Article, { id: article })
		.find({ id: article, kind: Compute.literal(Slug, "article") })
})

/**
 * A price lookup by a contract field compared with a parameter, without and with emitting the parameter under the
 * contract.
 */
const byAmount = query(Content).rule((r) => {
	const { id: price, amount } = v(Price, "price")
	return r
		.match(Price, { id: price, amount })
		.where(r.eq(amount, r.param("amount", Cents)))
		.find({ id: price })
})

const echoAmount = query(Content).rule((r) => {
	const { id: price, amount } = v(Price, "price")
	return r
		.match(Price, { id: price, amount })
		.where(r.eq(amount, r.param("amount", Cents)))
		.find({ id: price, echo: r.param("amount", Cents) })
})

const echoRate = query(Content).rule((r) => {
	const { id: price, rate } = v(Price, "price")
	return r
		.match(Price, { id: price, rate })
		.where(r.eq(rate, r.param("rate", Rate)))
		.find({ id: price, echo: r.param("rate", Rate) })
})

/** A value the test needs present, failing the test where it is absent. */
const defined = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`${what}: absent`)
	}
	return value
}

const ok = <A, E>(r: Result.Result<A, E>, what: string): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${Formatter.format(r.error)}`)
	}
	return r.value
}

const compiling = (q: unknown, schemaIdent: string) =>
	compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schemaIdent))
	})

const compiled = (q: unknown, schemaIdent: string): OracleTemplate =>
	ok(compiling(q, schemaIdent), "compile")

/** What paramTexts normalizes a template's relation inputs under: its declared parameters and Content's codes. */
const declared = (template: OracleTemplate): Declared => ({
	params: template.params,
	codes: contentCodes
})

/** The text domain Article's slug field uses, with its constraint and its law, as the installation names them. */
const slugDomain = (installation: Installation): ColumnTextDomain =>
	installationNamesOf(installation).textDomain({ name: "Article" }, "slug")

/** The Note contract domain's CHECK, as the installation names it. */
const noteCheckOf = (installation: Installation): ConstraintName => {
	const note = installationNamesOf(installation).contract("Note")
	if (note.kind !== "checked") {
		throw new Error("the Note contract's domain has a CHECK")
	}
	return note.constraint
}

const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

type Plan = "generic" | "custom"

let prepared = 0

/**
 * Runs one statement under a forced plan, through PREPARE and EXECUTE, and checks in pg_prepared_statements that
 * PostgreSQL used that plan, whether the execution succeeded or failed: PostgreSQL counts the plan it chose before
 * it runs it. A statement with no bound value is never given a custom plan, so the check also refuses a case that
 * could not exercise one. The execution's own outcome is returned.
 */
const runPlanned = (
	session: RawSession,
	sql: string,
	values: ReadonlyArray<string | Param>,
	plan: Plan
) =>
	Effect.gen(function* () {
		const name = `m14a_${++prepared}`
		yield* session.query(`SET plan_cache_mode = force_${plan}_plan`, [])
		yield* session.query(`PREPARE ${name} AS ${sql}`, [])
		const run = yield* Effect.exit(
			session.values(
				values.length === 0
					? `EXECUTE ${name}`
					: `EXECUTE ${name}(${Arr.join(
							Arr.map(values, (value) => literal(paramTextForm(value))),
							", "
						)})`,
				[]
			)
		)
		const counts = yield* session.values(
			`SELECT generic_plans::text, custom_plans::text FROM pg_catalog.pg_prepared_statements WHERE name = '${name}'`,
			[]
		)
		yield* session.query(`DEALLOCATE ${name}`, [])
		yield* session.query("RESET plan_cache_mode", [])
		assert.deepEqual(
			counts[0],
			plan === "generic" ? ["1", "0"] : ["0", "1"],
			`the plan PostgreSQL used under force_${plan}_plan`
		)
		if (Exit.isFailure(run)) {
			return yield* Effect.failCause(run.cause)
		}
		return run.value
	})

const plans: Arr.NonEmptyReadonlyArray<Plan> = ["generic", "custom"]

/** How a case runs a statement: prepared under a forced plan, or sent unprepared. */
type Run = Plan | "unprepared"

const runs: Arr.NonEmptyReadonlyArray<Run> = ["generic", "custom", "unprepared"]

/**
 * The rows a statement returns run as a case says: under a forced plan through `runPlanned`, which names each
 * placeholder by its text in EXECUTE (paramTextForm), or unprepared, each placeholder sent as its statement binds it.
 */
const runAs = (session: RawSession, sql: string, values: ReadonlyArray<string | Param>, run: Run) =>
	run === "unprepared" ? session.values(sql, values) : runPlanned(session, sql, values, run)

/** The two artifacts of a compiled template. */
type Artifact = "optimized" | "conservative"

const artifacts: Arr.NonEmptyReadonlyArray<Artifact> = ["optimized", "conservative"]

/** What the reader's bind makes of a case's parameters: refused before any SQL, or bound, matching `count` rows. */
type Bound = Readonly<{ kind: "refused" }> | Readonly<{ kind: "rows"; count: number }>

const refused: Bound = { kind: "refused" }

const rows = (count: number): Bound => ({ kind: "rows", count })

/** The word a bind refuses with: its encoding failure's reason. */
type BindRefusal = EncodingFailure["reason"]["_tag"]

/**
 * The codec fault the reader's bind refuses `params` with before any SQL (adapter/reader/relations.ts
 * executionInputs, over the template's declared parameters), or undefined where it binds them.
 */
const bindRefusal = (
	template: OracleTemplate,
	params: Readonly<Record<string, unknown>>
): BindRefusal | undefined => {
	const bound = executionInputs(
		paramCodecs(template.params, contentCodes, new CompilePatterns()),
		params
	)
	return bound._tag === "Success" ? undefined : bound.failure.reason._tag
}

/**
 * A case's parameters against the reader's bind and, where it binds them, the first statement of `artifact` run as
 * `run`: refused with refinedValue, or matching the rows `bound` states.
 */
const boundAgrees = (
	session: RawSession,
	template: OracleTemplate,
	artifact: Artifact,
	params: Readonly<Record<string, unknown>>,
	bound: Bound,
	run: Run,
	what: string
) =>
	Effect.gen(function* () {
		const refusal = bindRefusal(template, params)
		if (bound.kind === "refused") {
			assert.equal(refusal, "refinedValue", what)
			return
		}
		assert.equal(refusal, undefined, what)
		const spec = defined(template[artifact][0], "statement")
		const matched = yield* runAs(
			session,
			spec.sql,
			paramValues(spec, params, declared(template)),
			run
		)
		assert.equal(matched.length, bound.count, what)
	})

const changeSet = (value: unknown) => defined(changeSetDesc(value), "a ChangeSet value")

/** The fresh installation, whose Validate phase carries the closed payloads' validation (physical/install). */
const install = () =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = yield* s.schema({ create: false, label: "refined" })
		const owned = owning(Content)
		const installation: Installation = ok(
			compileInstallation(owned, {
				...installOptions(owned, s.owner.role),
				levels: [identity.schema(parsedSchemaName(name))],
				logins: [oracleOwnedLogin(owned.desc)]
			}),
			"install"
		)
		yield* transaction(s.admin, installationSql(installation))
		return { schema: name, installation }
	})

/** What a bind's case reaches: refused before any SQL, or bound and matching no row or some. */
type BoundFeature = "refused at bind" | "no row" | "a row"

const featureOf = (bound: Bound): BoundFeature =>
	bound.kind === "refused" ? "refused at bind" : bound.count === 0 ? "no row" : "a row"

/** A slug parameter given to a lookup, in an artifact, run as drawn. */
interface PatternCase {
	readonly lookup: "the lookup" | "the echoing lookup"
	readonly artifact: Artifact
	readonly slug: string
	readonly run: Run
}

/** A numeric contract's parameter given to a lookup, in an artifact, run as drawn. */
interface NumericCase {
	readonly lookup: "amount compared" | "amount echoed" | "rate echoed"
	readonly artifact: Artifact
	readonly value:
		| Readonly<{ kind: "amount"; amount: bigint }>
		| Readonly<{ kind: "rate"; rate: Decimal }>
	readonly run: Run
}

/** A text written as a refined constant, and the artifact a delivered constant is read through. */
interface ConstantCase {
	readonly text: string
	readonly artifact: Artifact
}

/** Comments over the loaded articles, the slug parameter the attachment excludes and the union matches, and a plan. */
interface EmittedCase {
	readonly comments: ReadonlyArray<Readonly<{ article: number; slug: string }>>
	readonly slug: string
	readonly plan: Plan
}

type EmittedFeature =
	| "refused at bind"
	| "no comment"
	| "a comment the parameter excludes"
	| "a comment the union matches"

/** A relation parameter's slugs given in an artifact, under a forced plan. */
interface GivenCase {
	readonly slugs: ReadonlyArray<string>
	readonly artifact: Artifact
	readonly plan: Plan
}

/** Where a refined value is written: grizzle's insert sent past the host codec, or a direct SQL writer's statement. */
type RefinedPath =
	| "grizzle's compiled insert"
	| "a direct insert of an article's slug"
	| "a direct update of a draft's slug"
	| "a direct update of a draft's note"

/** A refined value written along a path: a slug, or the note for the note's path. */
interface RefinedWrite {
	readonly path: RefinedPath
	readonly value: string
}

type RefinedFeature = `${RefinedPath}: ${"refused" | "admitted"}`

/** The slug's own pattern, as ECMAScript reads it: the oracle the domain's CHECK must agree with. */
const slugPattern = regex("^[a-z][a-z0-9-]*$")

const slugAdmits = (value: string): boolean => slugPattern.test(value)

/** Short texts over the slug's class edges and its outside: lowercase ends, digits, the hyphen, a capital, a space, é. */
const slugTextGen = string(characterOf(["a", "z", "0", "9", "-", "A", " ", "é"]), {
	min: 0,
	max: 4
})

/** Texts around the note's length bound, in characters: one-byte, two-byte and four-byte ones, and a newline. */
const noteTextGen = string(characterOf(["a", "é", "\n", "\u{1F600}"]), { min: 0, max: limit + 2 })

const refinedWriteGen: Gen<RefinedWrite> = (source) => {
	const path = source.draw(
		element([
			"grizzle's compiled insert",
			"a direct insert of an article's slug",
			"a direct update of a draft's slug",
			"a direct update of a draft's note"
		] as const)
	)
	return {
		path,
		value: source.draw(path === "a direct update of a draft's note" ? noteTextGen : slugTextGen)
	}
}

layer(Substrate.layer)("refinement validation sites on PostgreSQL 19", (it) => {
	const articlesSql = (
		schemaName: string,
		rows: ReadonlyArray<{ id: string; slug: string; title: string }>
	): string =>
		`INSERT INTO ${quoteIdent(schemaName)}."article" ("id", "slug", "title") VALUES ${Arr.join(
			Arr.map(rows, (a) => `('${a.id}'::uuid, ${literal(a.slug)}, ${literal(a.title)})`),
			", "
		)}`

	const loadArticles = (
		schemaName: string,
		rows: ReadonlyArray<{ id: string; slug: string; title: string }>
	) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			yield* s.admin.query(articlesSql(schemaName, rows), [])
		})

	it.effect(
		"a parameter outside its pattern is refused at bind, and one inside it matches its rows, generic and custom",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name } = yield* install()
					yield* loadArticles(name, articles(3))
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const lookups = {
						"the lookup": compiled(bySlug, name),
						"the echoing lookup": compiled(echoSlug, name)
					}
					const loaded = new Set(Arr.map(articles(3), (a) => a.slug))
					return yield* explore(
						{
							suite: "pg/regex-complete/pattern parameter",
							draw: drawn<PatternCase>((source) => ({
								lookup: source.draw(element(["the lookup", "the echoing lookup"] as const)),
								artifact: source.draw(element(artifacts)),
								slug: source.draw(
									weighted([
										[1, map(int(1, 5), (n) => `post-${n}`)],
										[2, slugTextGen]
									])
								),
								run: source.draw(element(runs))
							})),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "ECMAScript's match of the slug's pattern, and the loaded articles' slugs"
							},
							coverage: required<BoundFeature>(["refused at bind", "no row", "a row"], {
								cases: 48,
								sense: notesOnly
							}),
							kept: [],
							runs: 32,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ lookup, artifact, slug, run }, c) => {
							const bound = slugAdmits(slug) ? rows(loaded.has(slug) ? 1 : 0) : refused
							c.note(featureOf(bound))
							return boundAgrees(
								session,
								lookups[lookup],
								artifact,
								{ slug },
								bound,
								run,
								`${slug} in ${lookup}, ${artifact}, run ${run}`
							)
						}
					)
				})
			)
	)

	it.effect(
		"a parameter outside a numeric contract is refused at bind, and one inside it matches its rows, generic and custom",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name } = yield* install()
					yield* s.admin.query(
						`INSERT INTO ${quoteIdent(name)}."price" ("id", "amount", "rate") VALUES ('${id(1)}', 100, 0.062)`,
						[]
					)
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const decimal = (text: string): Decimal => ok(Decimal.fromString(text), text)
					const stored = { amount: 100n, rate: decimal("0.062") }
					/** Each lookup, the parameter it compares and its contract, and the stored value its rows match. */
					const lookups = {
						"amount compared": { template: compiled(byAmount, name), param: "amount" },
						"amount echoed": { template: compiled(echoAmount, name), param: "amount" },
						"rate echoed": { template: compiled(echoRate, name), param: "rate" }
					} as const
					/** An amount near the contract's bound or the stored one; a rate of six places near the unit interval's ends
					 * or the stored one. */
					const amountGen = weighted<bigint>([
						[1, map(int(-3, 3), BigInt)],
						[1, map(int(99, 101), BigInt)]
					])
					const rateGen = weighted<Decimal>([
						[
							1,
							map(int(-2_000_000, 2_000_000), (micro) => decimal((micro / 1_000_000).toFixed(6)))
						],
						[1, map(int(61_999, 62_001), (micro) => decimal((micro / 1_000_000).toFixed(6)))]
					])
					return yield* explore(
						{
							suite: "pg/regex-complete/numeric contract parameter",
							draw: drawn<NumericCase>((source) => {
								const lookup = source.draw(
									element(["amount compared", "amount echoed", "rate echoed"] as const)
								)
								return {
									lookup,
									artifact: source.draw(element(artifacts)),
									value:
										lookup === "rate echoed"
											? { kind: "rate", rate: source.draw(rateGen) }
											: { kind: "amount", amount: source.draw(amountGen) },
									run: source.draw(element(runs))
								}
							}),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the contracts' predicates (amount ≥ 0, 0 ≤ rate ≤ 1) and the stored price"
							},
							coverage: required<BoundFeature>(["refused at bind", "no row", "a row"], {
								cases: 60,
								sense: notesOnly
							}),
							kept: [],
							runs: 36,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ lookup, artifact, value, run }, c) => {
							const { template, param } = lookups[lookup]
							const bound =
								value.kind === "amount"
									? value.amount < 0n
										? refused
										: rows(value.amount === stored.amount ? 1 : 0)
									: value.rate.compare(decimal("0")) < 0 || value.rate.compare(decimal("1")) > 0
										? refused
										: rows(value.rate.compare(stored.rate) === 0 ? 1 : 0)
							c.note(featureOf(bound))
							const given = value.kind === "amount" ? value.amount : value.rate
							return boundAgrees(
								session,
								template,
								artifact,
								{ [param]: given },
								bound,
								run,
								`${param} ${Formatter.format(given)} in the ${artifact} artifact, run ${run}`
							)
						}
					)
				})
			)
	)

	it.effect(
		"a refined write is refused before commit with its refinement identity exactly when its value is outside the refinement, by grizzle's compiled insert and a direct SQL writer alike",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name, installation } = yield* install()
					const reality = realityWrite(
						ok(
							testArtifacts(Content, {
								installation: identity.schema(parsedSchemaName(name)),
								codes: installedCodes(installation.names.codes)
							}),
							"artifacts"
						)
					)
					const frontend = ok(
						compileChangeSet(
							checking(Content),
							changeSet(
								ChangeSet.empty(Content).insert(Article, [
									{ id: id(1), slug: "a-slug", title: "anything" }
								])
							),
							{
								claims: reality.claims,
								laws: reality.laws,
								derived: reality.derived,
								world: reality.world,
								codes: installation.names.codes
							}
						),
						"changeset"
					)
					const write = ok(
						realizeConservative(frontend, {
							names: reality.names,
							reads: reality.reads,
							share: new StatementShare()
						}),
						"realize"
					)
					const found = Arr.findFirst(
						write.steps,
						(x) => x.kind === "action" && x.statement.result.kind === "insert"
					)
					if (Option.isNone(found) || found.value.kind !== "action") {
						throw new Error("an insert step")
					}
					const step = found.value
					/** The enumerated member's facts as the insert's member placeholders, one array of the facts per column, each
					 * placeholder carrying the array of its part. The arrays are written straight from the facts' texts
					 * (arrayTexts), past the host codec, whose admission refuses a slug outside the pattern before any SQL: what
					 * reaches PostgreSQL is a value the slug's domain alone judges, as a writer that skipped the codec would send
					 * it. */
					const arraysOf = (fact: Readonly<Record<string, string>>) =>
						Arr.map(step.statement.params, (slot) => {
							if (slot.kind !== "member") {
								throw new Error(`a member placeholder, not ${slot.kind}`)
							}
							const fields = Arr.map(slot.columns, (c) => c.name)
							const written = arrayTexts(
								slot.relation,
								fields,
								[Arr.map(fields, (f) => paramText(defined(fact[f], `the fact's ${f}`)))],
								maxStringLength.value
							)
							if (!written.ok) {
								throw new Error(`arrays: ${written.error._tag}`)
							}
							return defined(
								written.value[slot.part.kind === "column" ? slot.part.index : 0],
								`the array of placeholder ${slot.number}`
							)
						})
					const world = yield* oracleWorld(installation)
					const session = yield* s.session({ ...worldSession(world), label: "writer" })
					const slugCheck = slugDomain(installation).constraint
					const noteCheck = noteCheckOf(installation)
					const table = (t: string) => `${quoteIdent(name)}.${quoteIdent(t)}`
					yield* session.query(
						`INSERT INTO ${table("draft")} ("id", "slug", "note") VALUES ('${id(3)}', 'fine', 'ok')`,
						[]
					)
					/** The statement a case sends, the constraint that judges its value, and whether the value is admitted. */
					const sent = (w: RefinedWrite) => {
						switch (w.path) {
							case "grizzle's compiled insert":
								return {
									send: Effect.asVoid(
										session.values(
											step.statement.sql.text,
											arraysOf({ id: id(1), slug: w.value, title: "anything" })
										)
									),
									check: slugCheck,
									admitted: slugAdmits(w.value)
								}
							case "a direct insert of an article's slug":
								return {
									send: Effect.asVoid(
										session.query(
											`INSERT INTO ${table("article")} ("id", "slug", "title") VALUES ('${id(2)}', ${literal(w.value)}, 't')`,
											[]
										)
									),
									check: slugCheck,
									admitted: slugAdmits(w.value)
								}
							case "a direct update of a draft's slug":
								return {
									send: Effect.asVoid(
										session.query(
											`UPDATE ${table("draft")} SET "slug" = ${literal(w.value)} WHERE "id" = '${id(3)}'`,
											[]
										)
									),
									check: slugCheck,
									admitted: slugAdmits(w.value)
								}
							case "a direct update of a draft's note":
								return {
									send: Effect.asVoid(
										session.query(
											`UPDATE ${table("draft")} SET "note" = ${literal(w.value)} WHERE "id" = '${id(3)}'`,
											[]
										)
									),
									check: noteCheck,
									admitted: Arr.fromIterable(w.value).length <= limit
								}
						}
					}
					const count = s.admin.queryValues(
						`SELECT (SELECT count(*) FROM ${table("article")})::text, (SELECT count(*) FROM ${table("draft")} WHERE "slug" = 'fine' AND "note" = 'ok')::text`,
						[]
					)
					return yield* explore(
						{
							suite: "pg/regex-complete/refined-write",
							draw: drawn(refinedWriteGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "ECMAScript's match of the slug's pattern and the note's length in characters, against the domain's CHECK"
							},
							coverage: required<RefinedFeature>(
								[
									"grizzle's compiled insert: refused",
									"grizzle's compiled insert: admitted",
									"a direct insert of an article's slug: refused",
									"a direct insert of an article's slug: admitted",
									"a direct update of a draft's slug: refused",
									"a direct update of a draft's slug: admitted",
									"a direct update of a draft's note: refused",
									"a direct update of a draft's note: admitted"
								],
								{ cases: 96, sense: notesOnly }
							),
							kept: [],
							runs: 48,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(w, c) =>
							Effect.gen(function* () {
								const { send, check, admitted } = sent(w)
								if (admitted) {
									yield* inTransaction(session, send)
									c.note(`${w.path}: admitted`)
								} else {
									yield* expectConstraint(inTransaction(session, send), check, "23514")
									c.note(`${w.path}: refused`)
								}
								yield* session.rollback
								const committed = yield* count
								assert.deepEqual(committed, [["0", "1"]], "nothing was committed")
							})
					)
				})
			)
	)

	it.effect(
		"a cast into a refinement nothing proves is refused at compile, and a relation parameter outside its pattern at bind, generic and custom",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name } = yield* install()
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const cast = compiling(titlesAsSlugs, name)
					assert.equal(
						cast.ok
							? "compiled"
							: cast.error.reason._tag === "PartialOperation"
								? `PartialOperation, precondition ${cast.error.reason.precondition}`
								: cast.error.reason._tag,
						"PartialOperation, precondition language",
						"a title cast into the slug's refinement"
					)
					/** A relation parameter's refined column is cast to its domain in the delivered output list. */
					const given = compiled(givenSlugs, name)
					assert.equal(
						isRefined(
							Option.getOrThrow(Arr.findFirst(given.heading, (c) => c.name === "slug")).type
						),
						true
					)
					return yield* explore(
						{
							suite: "pg/regex-complete/relation parameter",
							draw: drawn<GivenCase>((source) => ({
								slugs: source.draw(
									array(
										weighted([
											[3, map(int(0, 9), (n) => `given-${n}`)],
											[1, slugTextGen]
										]),
										{ min: 0, max: 10 }
									)
								),
								artifact: source.draw(element(artifacts)),
								plan: source.draw(element(plans))
							})),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "ECMAScript's match of the slug's pattern over every given fact"
							},
							coverage: required<BoundFeature | "an empty relation">(
								["refused at bind", "a row", "an empty relation"],
								{ cases: 32, sense: notesOnly }
							),
							kept: [],
							runs: 20,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						({ slugs, artifact, plan }, c) => {
							const facts = Arr.map(slugs, (slug, i) => ({ id: id(100 + i), slug }))
							const bound = Arr.every(slugs, slugAdmits) ? rows(facts.length) : refused
							c.note(featureOf(bound))
							if (facts.length === 0) {
								c.note("an empty relation")
							}
							return boundAgrees(
								session,
								given,
								artifact,
								{ given: facts },
								bound,
								plan,
								`${facts.length} facts in the ${artifact} artifact under a ${plan} plan`
							)
						}
					)
				})
			)
	)

	it.effect(
		"an attachment's and a union arm's emitted parameter is refused outside its pattern, and delivered inside it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name, installation } = yield* install()
					const tables = installationGroup(installationNamesOf(installation))
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					/**
					 * An attachment over exact parents is its own statement in the flight (lower/shapes/attach R36): the parent's
					 * rows, then the attachment's, each a parent's key then a child's fields.
					 */
					const attached = compiled(echoComments, name)
					assert.equal(attached.optimized.length, 2)
					const spec = defined(attached.optimized[1], "the attachment statement")
					const union = compiled(slugsOrEcho, name)
					const unionSpec = defined(union.optimized[0], "statement")
					const conservative = defined(union.conservative[0], "statement")
					const articleSlugs = Arr.map(articles(3), (a) => a.slug)
					return yield* explore(
						{
							suite: "pg/regex-complete/attachment and union",
							draw: drawn<EmittedCase>((source) => ({
								comments: source.draw(
									array(
										(s2) => ({
											article: s2.draw(int(1, 3)),
											slug: `c-${s2.draw(int(0, 3))}`
										}),
										{ min: 0, max: 3 }
									)
								),
								slug: source.draw(
									weighted([
										[2, map(int(0, 4), (n) => `c-${n}`)],
										[1, slugTextGen]
									])
								),
								plan: source.draw(element(plans))
							})),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the queries' meaning over the drawn comments: the attachment's comments but the parameter's, echoing it; the union's slugs and the parameter where a comment holds it"
							},
							coverage: required<EmittedFeature>(
								[
									"refused at bind",
									"no comment",
									"a comment the parameter excludes",
									"a comment the union matches"
								],
								{ cases: 48, sense: notesOnly }
							),
							kept: [],
							runs: 32,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ comments, slug, plan }, c) =>
							Effect.gen(function* () {
								if (!slugAdmits(slug)) {
									assert.equal(bindRefusal(attached, { slug }), "refinedValue", slug)
									assert.equal(bindRefusal(union, { slug }), "refinedValue", slug)
									c.note("refused at bind")
									return
								}
								const facts = Arr.map(comments, (comment, i) => ({ ...comment, id: id(50 + i) }))
								yield* replaceRows(s.admin, tables, [
									{ sql: articlesSql(name, articles(3)), params: [] },
									...Arr.map(facts, (fact) => ({
										sql: `INSERT INTO ${quoteIdent(name)}."comment" ("id", "article", "slug") VALUES ('${fact.id}', '${id(fact.article)}', ${literal(fact.slug)})`,
										params: []
									}))
								])
								const excluded = Arr.filter(facts, (fact) => fact.slug !== slug)
								const delivered = yield* runPlanned(
									session,
									spec.sql,
									paramTexts(spec, { slug }, declared(attached)),
									plan
								)
								unorderedEqual(
									Arr.map(delivered, (r) => Arr.map(r, String)),
									Arr.map(excluded, (fact) => [id(fact.article), id(fact.article), slug, fact.id]),
									`the attachment under ${slug}, ${plan}`
								)
								const expectedSlugs = Arr.sort(
									[
										...articleSlugs,
										...Arr.map(
											Arr.filter(facts, (fact) => fact.slug === slug),
											() => slug
										)
									],
									Order.String
								)
								const out = yield* runPlanned(
									session,
									unionSpec.sql,
									paramTexts(unionSpec, { slug }, declared(union)),
									plan
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(out, (r) => String(r[1])),
										Order.String
									),
									expectedSlugs,
									`the union under ${slug}, ${plan}`
								)
								const agreed = yield* session.values(
									conservative.sql,
									paramTexts(conservative, { slug }, declared(union))
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(agreed, (r) => String(r[1])),
										Order.String
									),
									expectedSlugs,
									`the conservative union under ${slug}`
								)
								c.note(
									Arr.isReadonlyArrayNonEmpty(facts)
										? "a comment the parameter excludes"
										: "no comment"
								)
								if (Arr.some(facts, (fact) => fact.slug === slug)) {
									c.note("a comment the union matches")
								}
							})
					)
				})
			)
	)

	it.effect(
		"closed payloads are validated by PostgreSQL at installation, and a refined query constant where it is delivered",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const owned = owning(Content)
					const checked = ok(checkedSchema(owned, everySlice(owned)), "checked")
					const constants = refinedConstants(checked)
					unorderedEqual(
						Arr.map(constants, (c) => c.literal),
						[
							{ kind: "text", value: "free" },
							{ kind: "text", value: "pro-plan" }
						]
					)
					const { schema: name, installation } = yield* install()
					assert.ok(Arr.some(installation.manifest.objects, (o) => o.kind === "validation"))
					const template = compiled(withConstant, name)
					yield* loadArticles(name, articles(2))
					const constantType = defined(constants[0], "constant").type
					return yield* explore(
						{
							suite: "pg/regex-complete/refined constant",
							draw: drawn<ConstantCase>((source) => ({
								text: source.draw(slugTextGen),
								artifact: source.draw(element(artifacts))
							})),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "ECMAScript's match of the slug's pattern, against the domain's CHECK on a constant"
							},
							coverage: required<"a constant refused" | "a constant admitted">(
								["a constant refused", "a constant admitted"],
								{ cases: 32, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						({ text, artifact }, c) =>
							Effect.gen(function* () {
								/** A closed payload's validation statement over the constants and the drawn one, and the cast of the
								 * drawn text into the slug's domain: both fail with the domain's constraint exactly when the
								 * pattern refuses the text. */
								const validation = ok(
									constantValidationObjects(installation.names, [
										...constants,
										{ literal: { kind: "text", value: text }, type: constantType, site: "a test" }
									]),
									"validation"
								)
								const [statement] = validation[0]?.ddl ?? []
								const sql = ok(
									emit(defined(statement, "validation statement"), emptyNameMap),
									"emit"
								).text
								const cast = `SELECT ${literal(text)}::text::${quoteIdent(name)}.${quoteIdent(slugDomain(installation).domain)}`
								if (slugAdmits(text)) {
									yield* s.admin.queryValues(sql, [])
									yield* s.admin.queryValues(cast, [])
									c.note("a constant admitted")
								} else {
									yield* expectConstraint(
										s.admin.queryValues(sql, []),
										slugDomain(installation).constraint,
										"23514"
									)
									yield* expectSqlstate(s.admin.queryValues(cast, []), "23514")
									c.note("a constant refused")
								}
								const delivered = yield* s.admin.queryValues(
									defined(template[artifact][0], "statement").sql,
									[]
								)
								assert.deepEqual(
									Arr.map(delivered, (r) => r[1]),
									["article", "article"],
									`the ${artifact} artifact delivers the constant`
								)
							})
					)
				})
			)
	)
})
