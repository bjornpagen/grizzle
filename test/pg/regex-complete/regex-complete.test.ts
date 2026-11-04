import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { refinedConstants } from "#compiler/check/refinement/index.ts"
import { indices } from "#compiler/core/array.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { constantValidationObjects } from "#compiler/lower/shapes/refined/index.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { realizeConservative } from "#compiler/write/conservative/realize.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { StatementShare } from "#compiler/write/insert/statement.ts"
import { assert, containsText, lacksText, unorderedEqual } from "#test/support/assert.ts"
import {
	compileTemplate,
	installationSql,
	paramTexts,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import {
	installationNamesOf,
	parsedSchemaName,
	type TextDomainNames
} from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { checking, owning } from "#test/support/policy.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { oracleWorld } from "#test/support/worlds.ts"

/**
 * Refinement validation sites on PostgreSQL 19.
 *
 * One schema, installed by the fresh-install compiler under a fresh schema name, carries a slug pattern, a
 * language-equivalent spelling of it, a contract bounding length with Compute.charLength over the wildcard, and a
 * closed relation whose payload is a slug. Against it:
 *
 * - an out-of-pattern comparison parameter is bound as text and matches nothing, without error, under generic and
 *   custom plans, also when the query emits the parameter too;
 * - a refined write is refused before commit, by grizzle's compiled insert and by a direct SQL writer alike, with
 *   PostgreSQL's 23514 naming the domain's constraint;
 * - a refined output cast is evaluated for every delivered row under generic and custom plans, each run checked
 *   against pg_prepared_statements for the plan PostgreSQL used: a Compute.cast into the slug domain, and a relation
 *   parameter's refined column, which the optimized delivery casts to its domain in the output list
 *   (lower/shapes/refined), refuse one invalid row wherever it sits; an emitted parameter
 *   a fused attachment's child delivers is cast inside the attachment's array, so it refuses a delivered element and
 *   claims nothing over empty arrays; a union whose arm emits the parameter runs with one explicit type per arm;
 * - closed payloads are validated by PostgreSQL at installation, and the migration generate drafts and the snapshot
 *   admission derives hold the same validation; a refined query literal is validated wherever it is delivered;
 * - a parameter compared with a numeric contract field is bound as the base and matches nothing outside the contract,
 *   without error, under generic and custom plans, in both artifacts.
 *
 * The slug, and a spelling of the same language (domain identity is the canonical pattern).
 */
const Slug = str.regex("^[a-z][a-z0-9-]*$")
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-)*$")
const Prose = str.regex("^.*$", "su")
/** A length bound is a contract predicate; over the wildcard the CHECK holds only the bound. */
const limit = 5
const Note = contract("Note", Prose, (x) => Compute.charLength(x).le(limit))

const Tier = closed("Tier", ["Free", "Pro"]).with(
	{ label: Slug },
	{ Free: { label: "free" }, Pro: { label: "pro-plan" } }
)
const Article = relation("Article", { id: uuid, slug: Slug, title: Prose }, ["id"])
const Draft = relation("Draft", { id: uuid, slug: SlugAgain, note: Note }, ["id"])
const Comment = relation("Comment", { id: uuid, article: uuid, slug: Slug }, ["id"])
/** Numeric contracts: a bigint bound and an exact rate in the unit interval. */
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
const Price = relation("Price", { id: uuid, amount: Cents, rate: Rate }, ["id"])
const Content = schema("Content", { Tier, Article, Draft, Comment, Price }, [mutable(Draft)])

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

/**
 * The same lookup that also emits the compared parameter under the slug's refinement: an empty result
 * delivers no value, so an out-of-pattern parameter still returns empty.
 */
const echoSlug = query(Content).rule((r) => {
	const { id: article, slug } = v(Article, "article")
	return r
		.match(Article, { id: article, slug })
		.where(r.eq(slug, r.param("slug", Article.fields.slug)))
		.find({ id: article, echo: r.param("slug", Slug) })
})

/**
 * Every title cast into the slug's refinement: a computed refined output, validated for every delivered row. The
 * parameter excludes a title no row has, so every row is delivered; it gives PostgreSQL a bound value, without which
 * a custom plan is never chosen.
 */
const titlesAsSlugs = query(Content).rule((r) => {
	const { id: article, title } = v(Article, "article")
	return r
		.match(Article, { id: article, title })
		.where(r.ne(title, r.param("except", Article.fields.title)))
		.find({ id: article, slug: Compute.cast(title, Slug) })
})
const noTitle = "no such title"

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

const compiled = (q: unknown, schemaIdent: string): QueryTemplate =>
	ok(
		compileTemplate(q, undefined, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schemaIdent))
		}),
		"compile"
	)

/** The text domain Article's slug field uses, with its constraint and its law, as the installation names them. */
const slugDomain = (installation: Installation): TextDomainNames =>
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
 * could not exercise one. The execution's own outcome is returned. A run whose binding may fail states it: such a
 * failure comes before any plan is chosen.
 */
type Binding = "planned" | "may fail at bind"

const runPlanned = (
	session: RawSession,
	sql: string,
	values: ReadonlyArray<string>,
	plan: Plan,
	binding: Binding
) =>
	Effect.gen(function* () {
		const name = `m14a_${++prepared}`
		yield* session.query(`SET plan_cache_mode = force_${plan}_plan`, [])
		yield* session.query(`PREPARE ${name} AS ${sql}`, [])
		const run = yield* Effect.exit(
			session.values(
				values.length === 0
					? `EXECUTE ${name}`
					: `EXECUTE ${name}(${Arr.join(Arr.map(values, literal), ", ")})`,
				[]
			)
		)
		const counts = yield* session.values(
			`SELECT generic_plans::text, custom_plans::text FROM pg_catalog.pg_prepared_statements WHERE name = '${name}'`,
			[]
		)
		yield* session.query(`DEALLOCATE ${name}`, [])
		yield* session.query("RESET plan_cache_mode", [])
		/**
		 * A failure raised while PostgreSQL binds the parameters comes before any plan is chosen and is no row's
		 * evaluation; where a caller allows it, it is returned as it is.
		 */
		const unplanned = Exit.isFailure(run) && counts[0]?.[0] === "0" && counts[0][1] === "0"
		if (!(unplanned && binding === "may fail at bind")) {
			assert.deepEqual(
				counts[0],
				plan === "generic" ? ["1", "0"] : ["0", "1"],
				`the plan PostgreSQL used under force_${plan}_plan`
			)
		}
		if (Exit.isFailure(run)) {
			return yield* Effect.failCause(run.cause)
		}
		return run.value
	})

const plans: Arr.NonEmptyReadonlyArray<Plan> = ["generic", "custom"]

/** How a case runs a statement: prepared under a forced plan, or sent unprepared. */
type Run = Plan | "unprepared"

const runs: Arr.NonEmptyReadonlyArray<Run> = ["generic", "custom", "unprepared"]

/** The rows a statement returns run as a case says: under a forced plan through `runPlanned`, or unprepared. */
const runAs = (
	session: RawSession,
	sql: string,
	values: ReadonlyArray<string>,
	run: Run,
	binding: Binding
) =>
	run === "unprepared"
		? session.values(sql, values)
		: runPlanned(session, sql, values, run, binding)

/** Every case of a finite space, checked against the installation a test set up. */
const everyCase = <A, E, R>(
	suite: string,
	generator: Gen<A>,
	limit: number,
	property: (value: A) => Effect.Effect<void, E, R>
) =>
	exhaust(
		{
			suite: `pg/regex-complete/${suite}`,
			generator,
			literal: Formatter.format,
			limit,
			coverage: noCoverage,
			caseHang: Duration.minutes(2)
		},
		property
	)

/** What a relation parameter is given: valid facts, facts with one invalid slug at a position, or none. */
type Given =
	| Readonly<{ kind: "valid" }>
	| Readonly<{ kind: "invalid"; at: number }>
	| Readonly<{ kind: "empty" }>

/** The two artifacts of a compiled template. */
type Artifact = "optimized" | "conservative"

const artifacts: Arr.NonEmptyReadonlyArray<Artifact> = ["optimized", "conservative"]

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
				installation: identity.schema(parsedSchemaName(name)),
				logins: [oracleOwnedLogin(owned.desc)]
			}),
			"install"
		)
		yield* transaction(s.admin, installationSql(installation))
		return { schema: name, installation }
	})

layer(Substrate.layer)("refinement validation sites on PostgreSQL 19", (it) => {
	const loadArticles = (
		schemaName: string,
		rows: ReadonlyArray<{ id: string; slug: string; title: string }>
	) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const values = Arr.join(
				Arr.map(rows, (a) => `('${a.id}'::uuid, ${literal(a.slug)}, ${literal(a.title)})`),
				", "
			)
			yield* s.admin.query(
				`INSERT INTO ${quoteIdent(schemaName)}."article" ("id", "slug", "title") VALUES ${values}`,
				[]
			)
		})

	it.effect(
		"an out-of-pattern comparison parameter returns empty without error, generic and custom",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name } = yield* install()
					yield* loadArticles(name, articles(3))
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					/**
					 * The lookup's two artifacts, and the optimized artifact of the lookup that emits its parameter too: there the
					 * emitted placeholder is bound as text and cast to the domain only in the delivered output list
					 * (lower/shapes/refined), so an empty result validates nothing. The conservative artifact of that lookup is
					 * held to the same gate by the case below.
					 */
					const lookup = compiled(bySlug, name)
					const echo = compiled(echoSlug, name)
					const statements = {
						"the lookup, optimized": lookup.optimized,
						"the lookup, conservative": lookup.conservative,
						"the echoing lookup, optimized": echo.optimized
					}
					return yield* everyCase(
						"out-of-pattern parameter",
						(source) => ({
							artifact: source.draw(
								element([
									"the lookup, optimized",
									"the lookup, conservative",
									"the echoing lookup, optimized"
								] as const)
							),
							slug: source.draw(
								element<readonly [string, number]>([
									["Not A Slug!", 0],
									["", 0],
									["post-2", 1]
								] as const)
							),
							run: source.draw(element(runs))
						}),
						27,
						({ artifact, slug: [value, expected], run }) =>
							Effect.gen(function* () {
								const spec = defined(statements[artifact][0], "statement")
								const values = paramTexts(spec, { slug: value })
								const rows = yield* runAs(session, spec.sql, values, run, "planned")
								assert.equal(rows.length, expected, `${value} in ${artifact}, run ${run}`)
							})
					)
				})
			)
	)

	it.effect(
		"the conservative artifact of a lookup that emits its parameter returns empty without error",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name } = yield* install()
					yield* loadArticles(name, articles(3))
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const echo = compiled(echoSlug, name)
					const spec = defined(echo.conservative[0], "statement")
					const values = paramTexts(spec, { slug: "Not A Slug!" })
					return yield* everyCase("conservative echo", element(plans), plans.length, (plan) =>
						Effect.gen(function* () {
							const rows = yield* runPlanned(session, spec.sql, values, plan, "may fail at bind")
							assert.equal(rows.length, 0, plan)
						})
					)
				})
			)
	)

	it.effect(
		"a parameter outside a numeric contract matches nothing without error, generic and custom",
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
					/** Each lookup, the parameter it compares and the values it is given, with the rows each matches. */
					const lookups: Readonly<
						Record<
							"amount compared" | "amount echoed" | "rate echoed",
							{
								readonly template: QueryTemplate
								readonly param: string
								readonly values: Arr.NonEmptyReadonlyArray<readonly [bigint | Decimal, number]>
							}
						>
					> = {
						"amount compared": {
							template: compiled(byAmount, name),
							param: "amount",
							values: [
								[-5n, 0],
								[100n, 1]
							]
						},
						"amount echoed": {
							template: compiled(echoAmount, name),
							param: "amount",
							values: [
								[-5n, 0],
								[100n, 1]
							]
						},
						"rate echoed": {
							template: compiled(echoRate, name),
							param: "rate",
							values: [
								[decimal("2"), 0],
								[decimal("-0.5"), 0],
								[decimal("0.062"), 1]
							]
						}
					}
					return yield* everyCase(
						"numeric contract parameter",
						(source) => {
							const lookup = source.draw(
								element(["amount compared", "amount echoed", "rate echoed"] as const)
							)
							return {
								lookup,
								artifact: source.draw(element(artifacts)),
								value: source.draw(element(lookups[lookup].values)),
								run: source.draw(element(runs))
							}
						},
						42,
						({ lookup, artifact, value: [value, expected], run }) =>
							Effect.gen(function* () {
								const { template, param } = lookups[lookup]
								const spec = defined(template[artifact][0], "statement")
								const bound = paramTexts(spec, { [param]: value })
								const matched = yield* runAs(session, spec.sql, bound, run, "planned")
								assert.equal(
									matched.length,
									expected,
									`${param} ${Formatter.format(value)} in the ${artifact} artifact, run ${run}`
								)
							})
					)
				})
			)
	)

	it.effect("a refined write is refused before commit with its refinement identity", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const { schema: name, installation } = yield* install()
			const reality = realityWrite(
				ok(
					testArtifacts(Content, {
						installation: identity.schema(parsedSchemaName(name)),
						vectorSchema: undefined
					}),
					"artifacts"
				)
			)
			const frontend = ok(
				compileChangeSet(
					checking(Content),
					changeSet(
						ChangeSet.empty(Content).insert(Article, [
							{ id: id(1), slug: "Not A Slug", title: "anything" }
						])
					),
					{
						claims: reality.claims,
						meter: new BudgetMeter(compileBudgets),
						laws: reality.laws,
						derived: reality.derived,
						world: reality.world
					}
				),
				"changeset"
			)
			const write = ok(
				realizeConservative(frontend, {
					names: reality.names,
					reads: reality.reads,
					meter: new BudgetMeter(compileBudgets),
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
			/** The enumerated member's facts fill the insert's one placeholder, the member slot. */
			const slot = step.statement.params[0]
			if (slot?.kind !== "member") {
				throw new Error("a member slot")
			}
			const fact: Record<string, string> = { id: id(1), slug: "Not A Slug", title: "anything" }
			const json = jsonText([
				Rec.fromEntries(
					Arr.map(slot.columns, (c) => [
						c.definition.name,
						defined(fact[c.name], `the fact's ${c.name}`)
					])
				)
			])
			const world = yield* oracleWorld(installation)
			const session = yield* s.session({ ...worldSession(world), label: "writer" })
			const slug = slugDomain(installation)
			const slugCheck = slug.constraint
			yield* expectConstraint(
				inTransaction(session, session.values(step.statement.sql.text, [json])),
				slugCheck,
				"23514"
			)
			yield* session.rollback
			/** Nothing was committed. */
			const count = yield* s.admin.queryValues(
				`SELECT count(*)::text FROM ${quoteIdent(name)}."article"`,
				[]
			)
			assert.deepEqual(count, [["0"]])
			/** A direct SQL writer's INSERT and UPDATE meet the same domain. */
			const table = (t: string) => `${quoteIdent(name)}.${quoteIdent(t)}`
			yield* expectConstraint(
				session.query(
					`INSERT INTO ${table("article")} ("id", "slug", "title") VALUES ('${id(2)}', 'Bad Slug', 't')`,
					[]
				),
				slugCheck,
				"23514"
			)
			yield* session.query(
				`INSERT INTO ${table("draft")} ("id", "slug", "note") VALUES ('${id(3)}', 'fine', 'ok')`,
				[]
			)
			yield* expectConstraint(
				session.query(`UPDATE ${table("draft")} SET "slug" = 'NOT OK' WHERE "id" = '${id(3)}'`, []),
				slugCheck,
				"23514"
			)
			yield* expectConstraint(
				session.query(
					`UPDATE ${table("draft")} SET "note" = 'too long' WHERE "id" = '${id(3)}'`,
					[]
				),
				noteCheckOf(installation),
				"23514"
			)
		})
	)

	it.effect(
		"a refined output cast is evaluated for every delivered row, generic and custom",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name, installation } = yield* install()
					const rows = articles(40)
					yield* loadArticles(name, rows)
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const table = `${quoteIdent(name)}."article"`
					const template = compiled(titlesAsSlugs, name)
					yield* everyCase(
						"output cast",
						(source) => ({
							artifact: source.draw(element(artifacts)),
							/**
							 * Under every artifact and plan, every title valid or one invalid title at the first, a middle or
							 * the last row, restored after.
							 */
							victim: source.draw(
								element([Option.none(), Option.some(0), Option.some(20), Option.some(39)])
							),
							plan: source.draw(element(plans))
						}),
						16,
						({ artifact, victim, plan }) =>
							Effect.gen(function* () {
								const spec = defined(template[artifact][0], "statement")
								const values = paramTexts(spec, { except: noTitle })
								if (Option.isNone(victim)) {
									const delivered = yield* runPlanned(session, spec.sql, values, plan, "planned")
									assert.equal(delivered.length, rows.length, `every row under a ${plan} plan`)
									return
								}
								const position = victim.value
								const bad = defined(rows[position], "article")
								yield* s.admin.query(
									`UPDATE ${table} SET "title" = 'Bad Title' WHERE "id" = '${bad.id}'`,
									[]
								)
								yield* expectConstraint(
									runPlanned(session, spec.sql, values, plan, "planned"),
									slugDomain(installation).constraint,
									"23514"
								)
								yield* s.admin.query(
									`UPDATE ${table} SET "title" = 'title-${position + 1}' WHERE "id" = '${bad.id}'`,
									[]
								)
							})
					)
					/** A relation parameter's refined column is cast to its domain in the delivered output list. */
					const given = compiled(givenSlugs, name)
					const spec = defined(given.optimized[0], "statement")
					assert.equal(
						isRefined(
							Option.getOrThrow(Arr.findFirst(given.heading, (c) => c.name === "slug")).type
						),
						true
					)
					const facts = (bad: number | undefined) =>
						Arr.map(indices(10), (i) => ({
							id: id(100 + i),
							slug: i === bad ? "BAD" : `given-${i}`
						}))
					return yield* everyCase(
						"relation parameter",
						(source) => ({
							/** Ten valid slugs, one invalid slug at the first, a middle or the last fact, or none given. */
							given: source.draw(
								element<Given>([
									{ kind: "valid" },
									{ kind: "invalid", at: 0 },
									{ kind: "invalid", at: 5 },
									{ kind: "invalid", at: 9 },
									{ kind: "empty" }
								] as const)
							),
							plan: source.draw(element(plans))
						}),
						10,
						({ given, plan }) =>
							Effect.gen(function* () {
								switch (given.kind) {
									case "valid": {
										const delivered = yield* runPlanned(
											session,
											spec.sql,
											paramTexts(spec, { given: facts(undefined) }),
											plan,
											"planned"
										)
										assert.equal(delivered.length, 10, `every given fact under a ${plan} plan`)
										return
									}
									case "invalid":
										yield* expectConstraint(
											runPlanned(
												session,
												spec.sql,
												paramTexts(spec, { given: facts(given.at) }),
												plan,
												"planned"
											),
											slugDomain(installation).constraint,
											"23514"
										)
										return
									case "empty": {
										const delivered = yield* runPlanned(
											session,
											spec.sql,
											paramTexts(spec, { given: [] }),
											plan,
											"planned"
										)
										assert.equal(delivered.length, 0, `no given fact under a ${plan} plan`)
										return
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"a fused attachment's emitted parameter is cast inside its array, and a union's arms agree",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const { schema: name, installation } = yield* install()
					yield* loadArticles(name, articles(3))
					const session = yield* s.session({ ...ownerSession(), label: "reader" })
					const fused = compiled(echoComments, name)
					assert.equal(fused.optimized.length, 1)
					const spec = defined(fused.optimized[0], "statement")
					const run = (slug: string, plan: Plan) =>
						runPlanned(session, spec.sql, paramTexts(spec, { slug }), plan, "planned")
					/** No comment exists: every array is empty, so no element is delivered and nothing is claimed. */
					const everyPlan = element(plans)
					yield* everyCase("fused attachment without comments", everyPlan, plans.length, (plan) =>
						Effect.gen(function* () {
							const empty = yield* run("Not A Slug!", plan)
							assert.deepEqual(
								Arr.sort(
									Arr.map(empty, (r) => String(r[2])),
									Order.String
								),
								["{}", "{}", "{}"],
								plan
							)
						})
					)
					yield* s.admin.query(
						`INSERT INTO ${quoteIdent(name)}."comment" ("id", "article", "slug")
				VALUES ('${id(50)}', '${id(1)}', 'first'), ('${id(51)}', '${id(1)}', 'second')`,
						[]
					)
					/**
					 * The union's stored arm is cast to text explicitly where the other arm emits the text-bound parameter, so
					 * PostgreSQL resolves no type across the arms; an out-of-pattern parameter matches no comment and the
					 * delivered slugs are the articles'.
					 */
					const union = compiled(slugsOrEcho, name)
					const unionSpec = defined(union.optimized[0], "statement")
					const withComments = yield* everyCase(
						"fused attachment and union with comments",
						element(plans),
						plans.length,
						(plan) =>
							Effect.gen(function* () {
								yield* expectConstraint(
									run("Not A Slug!", plan),
									slugDomain(installation).constraint,
									"23514"
								)
								/** A valid parameter is delivered in every element but the comment it excludes. */
								const rows = yield* run("first", plan)
								const arrays = new Map(Arr.map(rows, (r) => [r[0], r[2]]))
								assert.equal(arrays.get(id(2)), "{}", plan)
								containsText(String(arrays.get(id(1))), "first", plan)
								containsText(String(arrays.get(id(1))), id(51), plan)
								lacksText(String(arrays.get(id(1))), id(50), plan)
								const out = yield* runPlanned(
									session,
									unionSpec.sql,
									paramTexts(unionSpec, { slug: "Not A Slug!" }),
									plan,
									"planned"
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(out, (r) => String(r[1])),
										Order.String
									),
									["post-1", "post-2", "post-3"],
									plan
								)
								const matched = yield* runPlanned(
									session,
									unionSpec.sql,
									paramTexts(unionSpec, { slug: "second" }),
									plan,
									"planned"
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(matched, (r) => String(r[1])),
										Order.String
									),
									["post-1", "post-2", "post-3", "second"],
									plan
								)
							})
					)
					/** The conservative artifact agrees on an in-pattern parameter. */
					const conservative = defined(union.conservative[0], "statement")
					const agreed = yield* session.values(
						conservative.sql,
						paramTexts(conservative, { slug: "second" })
					)
					assert.deepEqual(
						Arr.sort(
							Arr.map(agreed, (r) => String(r[1])),
							Order.String
						),
						["post-1", "post-2", "post-3", "second"]
					)
					return withComments
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
					const checked = ok(checkedSchema(owning(Content)), "checked")
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
					/** An invalid constant fails that statement with the domain's constraint. */
					const invalid = ok(
						constantValidationObjects(installation.names, [
							...constants,
							{
								literal: { kind: "text", value: "Pro Plan" },
								type: defined(constants[0], "constant").type,
								site: "a test"
							}
						]),
						"validation"
					)
					const [statement] = invalid[0]?.ddl ?? []
					const sql = ok(
						emit(defined(statement, "validation statement"), emptyNameMap, unmetered),
						"emit"
					).text
					yield* expectConstraint(
						s.admin.queryValues(sql, []),
						slugDomain(installation).constraint,
						"23514"
					)
					const template = compiled(withConstant, name)
					yield* expectSqlstate(
						s.admin.queryValues(
							`SELECT 'Not Valid'::text::${quoteIdent(name)}.${quoteIdent(slugDomain(installation).domain)}`,
							[]
						),
						"23514"
					)
					yield* loadArticles(name, articles(2))
					return yield* everyCase(
						"refined query constant",
						element(artifacts),
						artifacts.length,
						(artifact) =>
							Effect.gen(function* () {
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
