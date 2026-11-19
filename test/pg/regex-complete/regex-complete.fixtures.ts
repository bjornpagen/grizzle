import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Option, String as Str } from "effect"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { type EncodingFailure } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { type ConstraintName } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { type Param } from "#compiler/core/wire.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import { StatementShare } from "#compiler/write/insert/statement.ts"
import { paramTextForm } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	type TemplateDeclarations,
	installedCodes,
	paramValues,
	realityWrite,
	testArtifacts,
	testCompile,
	workloadOver
} from "#test/support/compile.ts"
import { type OracleTemplate } from "#test/support/conservative.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import {
	type ColumnTextDomain,
	installationNamesOf,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { realizeConservative } from "#test/support/oracle/write/realize.ts"
import { type SqlError } from "#test/support/pg.ts"
import { checking, owning } from "#test/support/policy.ts"
import { scriptTemplate } from "#test/support/script-template.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { paramText } from "#test/support/wire.ts"

/**
 * The slug, of at most a DNS label's 63 characters (RFC 1035 2.3.4), and a spelling of the same language (domain
 * identity is the canonical pattern).
 */
const Slug = str.regex("^[a-z][a-z0-9-]{0,62}$")
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-){0,62}$")
const Prose = str.regex("^.*$", "su")
/** A length bound is a contract predicate; over the wildcard the CHECK holds only the bound. */
const limit = 5
const Note = contract("Note", Prose, (x) => Compute.le(Compute.charLength(x), limit))

const Tier = closed.ordered("Tier", ["Free", "Pro"])
const TierLabel = closed.relation(
	"TierLabel",
	{ tier: closedId(Tier), label: Slug },
	["tier"],
	[
		{ tier: "Free", label: "free" },
		{ tier: "Pro", label: "pro-plan" }
	]
)
const Article = relation("Article", { id: Id, slug: Slug, title: Prose }, ["id"])
const Draft = relation("Draft", { id: Id, slug: SlugAgain, note: Note }, ["id"])
const Comment = relation("Comment", { id: Id, article: Id, slug: Slug }, ["id"])
/** Numeric contracts: a bigint bound and an exact rate in the unit interval. */
const Cents = contract("Cents", pg.bigint, (x) => Compute.ge(x, 0n))
const Rate = contract("Rate", pg.numeric(7, 6), (x) => Compute.between(x, 0n, 1n))
const Price = relation("Price", { id: Id, amount: Cents, rate: Rate }, ["id"])
export const Content = schema(
	"Content",
	[Tier, TierLabel, Article, Draft, Comment, Price],
	[mutable(Draft)]
)

/** Content's codes as a fresh installation drafts them, from no codes: what every template of it binds under. */
const contentCodes = firstCodebook(rostersOf(owning(Content)))

export const id = (n: number): IdValue =>
	Id(`00000000-0000-4000-8000-${Str.padStart(12, "0")(n.toString(16))}`)

/** The articles: valid slugs, and titles that are valid slugs except where a test says otherwise. */
export const articles = (
	count: number
): ReadonlyArray<{ id: string; slug: string; title: string }> =>
	Arr.map(indices(count), (i) => ({
		id: id(i + 1),
		slug: `post-${i + 1}`,
		title: `title-${i + 1}`
	}))

/** An article lookup by slug. */
export const bySlug = query(Content).rule((r) => {
	const { id: article, slug } = v(Article, "article")
	return r
		.match(Article, { id: article, slug })
		.where(r.eq(slug, r.param("slug", Article.fields.slug)))
		.find({ id: article, slug })
})

/** The same lookup that also emits the compared parameter under the slug's refinement. */
export const echoSlug = query(Content).rule((r) => {
	const { id: article, slug } = v(Article, "article")
	return r
		.match(Article, { id: article, slug })
		.where(r.eq(slug, r.param("slug", Article.fields.slug)))
		.find({ id: article, echo: r.param("slug", Slug) })
})

/** Every title cast into the slug's refinement: a narrowing nothing proves of a title, which compilation refuses. */
export const titlesAsSlugs = query(Content).rule((r) => {
	const { id: article, title } = v(Article, "article")
	return r
		.match(Article, { id: article, title })
		.find({ id: article, slug: Compute.cast(title, Slug) })
})

/**
 * Every article with its comments other than the parameter, each echoing it: the child is fused into the parent
 * statement, and the emitted parameter is a refined field of the attachment's array.
 */
export const echoComments = query(Content)
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
export const slugsOrEcho = query(Content)
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
export const givenSlugs = query(Content).rule((r) => {
	const given = r.relation("given", { id: Id, slug: Slug })
	const { id: row, slug } = v(given, "given")
	return r.match(given, { id: row, slug }).find({ id: row, slug })
})

/** A refined query constant: a Compute.literal of the slug's refinement. */
export const withConstant = query(Content).rule((r) => {
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

export const compiling = (q: unknown, schemaIdent: string) =>
	compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schemaIdent))
	})

export const compiled = (q: unknown, schemaIdent: string): OracleTemplate =>
	succeeded(compiling(q, schemaIdent), "compile")

/** What paramTexts normalizes a template's relation inputs under: its declared parameters and Content's codes. */
export const declared = (template: OracleTemplate): TemplateDeclarations => ({
	params: template.params,
	codes: contentCodes
})

/** The text domain Article's slug field uses, with its constraint and its law, as the installation names them. */
export const slugDomain = (installation: Installation): ColumnTextDomain =>
	installationNamesOf(installation).textDomain({ name: "Article" }, "slug")

/** The Note contract domain's CHECK, as the installation names it. */
const noteCheckOf = (installation: Installation): ConstraintName => {
	const note = installationNamesOf(installation).contract("Note")
	if (note.kind !== "checked") {
		throw new Error("the Note contract's domain has a CHECK")
	}
	return note.constraint
}

export const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

type Plan = "generic" | "custom"

/**
 * Runs one statement under a forced plan, through PREPARE and EXECUTE, and checks in pg_prepared_statements which plan
 * PostgreSQL chose: the forced plan where the execution ran, and none where it failed. Every refusal these suites draw
 * is a parameter its domain refuses as it is bound, and EXECUTE binds its parameters before it chooses a plan
 * (commands/prepare.c ExecuteQuery: EvaluateParams, then GetCachedPlan, which counts the plan it returns), so a
 * failure that came with a plan chosen did not come at bind. A statement with no bound value is never given a custom
 * plan, so the check also refuses a case that could not exercise one. The execution's own outcome is returned. The
 * plan mode and the prepared statement are held in the call's scope, so both are released however the call ends, and
 * one name serves every call.
 */
export const runPlanned = (
	session: RawSession,
	sql: string,
	values: ReadonlyArray<string | Param>,
	plan: Plan
) =>
	Effect.gen(function* () {
		const name = "m14a_planned"
		yield* Effect.acquireRelease(
			session.query(`SET plan_cache_mode = force_${plan}_plan`, []),
			() => Effect.orDie(session.query("RESET plan_cache_mode", []))
		)
		yield* Effect.acquireRelease(session.query(`PREPARE ${name} AS ${sql}`, []), () =>
			Effect.orDie(session.query(`DEALLOCATE ${name}`, []))
		)
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
		if (Exit.isFailure(run)) {
			assert.deepEqual(
				counts[0],
				["0", "0"],
				`no plan chosen under force_${plan}_plan: refused at bind`
			)
			return yield* Effect.failCause(run.cause)
		}
		assert.deepEqual(
			counts[0],
			plan === "generic" ? ["1", "0"] : ["0", "1"],
			`the plan PostgreSQL used under force_${plan}_plan`
		)
		return run.value
	}).pipe(Effect.scoped)

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

/**
 * The SQLSTATE of a statement's refusal by a domain, as its ErrorResponse reports it with the domain's data type, or
 * undefined where it ran or another refused it.
 */
export const domainRefusal = (ran: Exit.Exit<unknown, SqlError>): string | undefined => {
	if (Exit.isSuccess(ran)) {
		return undefined
	}
	const failure = Option.getOrUndefined(Exit.findErrorOption(ran))
	return failure?.reason._tag === "ServerError" && Option.isSome(failure.reason.fields.dataType)
		? failure.reason.fields.code
		: undefined
}

/** What PostgreSQL makes of a case's parameters as it binds them: refused, or bound, matching `count` rows. */
type Bound = Readonly<{ kind: "refused" }> | Readonly<{ kind: "rows"; count: number }>

export const refusedAtBind: Bound = { kind: "refused" }

export const rows = (count: number): Bound => ({ kind: "rows", count })

/** The word a bind refuses with: its encoding failure's reason. */
type BindRefusal = EncodingFailure["reason"]["_tag"]

/**
 * The codec fault the reader's bind refuses `params` with before any SQL (adapter/reader/relations.ts
 * executionInputs, over the template's declared parameters), or undefined where it binds them.
 */
export const bindRefusal = (
	template: OracleTemplate,
	params: Readonly<Record<string, unknown>>
): BindRefusal | undefined => {
	const bound = executionInputs(paramCodecs(template.params, contentCodes), params)
	return bound._tag === "Success" ? undefined : bound.failure.reason._tag
}

/**
 * A case's parameters against the reader's bind, which parses each as its base carrier and binds every value the case
 * draws, and the first statement of `artifact` run as `run`: refused by PostgreSQL with 23514 on the parameter's own
 * pattern domain or its contract's domain as it binds it, or matching the rows `bound` states.
 */
export const boundAgrees = (
	session: RawSession,
	template: OracleTemplate,
	artifact: Artifact,
	params: Readonly<Record<string, unknown>>,
	bound: Bound,
	run: Run,
	what: string
) =>
	Effect.gen(function* () {
		assert.equal(bindRefusal(template, params), undefined, what)
		const spec = defined(template[artifact][0], "statement")
		const ran = yield* Effect.exit(
			runAs(session, spec.sql, paramValues(spec, params, declared(template)), run)
		)
		if (bound.kind === "refused") {
			assert.equal(domainRefusal(ran), "23514", what)
			return
		}
		if (Exit.isFailure(ran)) {
			return yield* Effect.failCause(ran.cause)
		}
		assert.equal(ran.value.length, bound.count, what)
	})

const changeSet = (value: unknown) => defined(changeSetDesc(value), "a ChangeSet value")

/**
 * The queries of these suites that declare parameters, as the workload the installation installs: installing it
 * installs the pattern domain of every pattern a parameter names (physical/access/extension.ts workloadExtension), as a
 * served workload's installation does.
 */
const parameterized = workload(Content, {
	bySlug,
	echoSlug,
	echoComments,
	slugsOrEcho,
	givenSlugs,
	byAmount,
	echoAmount,
	echoRate
})

/**
 * The fresh installation under the schema name `name`, whose Validate phase carries the closed payloads' validation
 * (physical/install), with the workload of the suites' parameterized queries (`parameterized`).
 */
const contentInstallation = (name: string): Installation => {
	const owned = owning(Content)
	const options = installOptions(owned)
	return succeeded(
		compileInstallation(owned, {
			...options,
			levels: [identity.schema(parsedSchemaName(name))],
			logins: [oracleOwnedLogin(owned.desc)],
			extensions: [
				...options.extensions,
				workloadOver([{ login: "reader", workloads: [parameterized] }])
			]
		}),
		"install"
	)
}

/**
 * The fresh installation as a template (script-template.ts scriptTemplate): installed once per member, where each
 * search installed it before its cases; a seat's reset empties every table after a case, so a case writes the rows it
 * reads.
 */
export const contentTemplate = scriptTemplate({
	declaredIn: import.meta,
	name: "refined content",
	label: "refined",
	compile: contentInstallation
})

/** The INSERT of `rows` into the installation's articles. */
export const articlesSql = (
	schemaName: string,
	rows: ReadonlyArray<{ id: string; slug: string; title: string }>
): string =>
	`INSERT INTO ${quoteIdent(schemaName)}."article" ("id", "slug", "title") VALUES ${Arr.join(
		Arr.map(rows, (a) => `('${a.id}'::Id, ${literal(a.slug)}, ${literal(a.title)})`),
		", "
	)}`

/** `rows` written into the installation's articles. */
export const loadArticles = (
	schemaName: string,
	rows: ReadonlyArray<{ id: string; slug: string; title: string }>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		yield* s.admin.query(articlesSql(schemaName, rows), [])
	})

/** An owner's session, the one the read suites read as. */
export const readerSession = Effect.flatMap(Substrate, (s) =>
	s.session({ ...ownerSession(), label: "reader" })
)

/** What a bind's case reaches: refused before any SQL, or bound and matching no row or some. */
export type BoundFeature = "refused at bind" | "no row" | "a row"

export const featureOf = (bound: Bound): BoundFeature =>
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

export type EmittedFeature =
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

export type RefinedFeature = `${RefinedPath}: ${"refused" | "admitted"}`

/** The slug's own pattern, as ECMAScript reads it: the oracle the domain's CHECK must agree with. */
const slugPattern = regex("^[a-z][a-z0-9-]{0,62}$")

export const slugAdmits = (value: string): boolean => slugPattern.test(value)

/** Short texts over the slug's class edges and its outside: lowercase ends, digits, the hyphen, a capital, a space, é. */
const slugTextGen = string(characterOf(["a", "z", "0", "9", "-", "A", " ", "é"]), {
	min: 0,
	max: 4
})

/** Texts around the note's length bound, in characters: one-byte, two-byte and four-byte ones, and a newline. */
const noteTextGen = string(characterOf(["a", "é", "\n", "\u{1F600}"]), { min: 0, max: limit + 2 })

export const refinedWriteGen: Gen<RefinedWrite> = (source) => {
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

/** A slug given to a lookup, in an artifact, run as drawn: a loaded article's slug, or a short text over the slug's class edges. */
export const patternCases: Gen<PatternCase> = (source) => ({
	lookup: source.draw(element(["the lookup", "the echoing lookup"] as const)),
	artifact: source.draw(element(artifacts)),
	slug: source.draw(
		weighted([
			[1, map(int(1, 5), (n) => `post-${n}`)],
			[2, slugTextGen]
		])
	),
	run: source.draw(element(runs))
})

/** A decimal the text spells, which the suite's own literal guarantees. */
export const decimal = (text: string): Decimal => succeeded(Decimal.fromString(text), text)

/** An amount near the contract's bound or the stored one. */
const amountGen = weighted<bigint>([
	[1, map(int(-3, 3), BigInt)],
	[1, map(int(99, 101), BigInt)]
])

/** A rate of six places near the unit interval's ends or the stored one. */
const rateGen = weighted<Decimal>([
	[1, map(int(-2_000_000, 2_000_000), (micro) => decimal((micro / 1_000_000).toFixed(6)))],
	[1, map(int(61_999, 62_001), (micro) => decimal((micro / 1_000_000).toFixed(6)))]
])

/** A numeric contract's parameter given to a lookup, in an artifact, run as drawn. */
export const numericCases: Gen<NumericCase> = (source) => {
	const lookup = source.draw(element(["amount compared", "amount echoed", "rate echoed"] as const))
	return {
		lookup,
		artifact: source.draw(element(artifacts)),
		value:
			lookup === "rate echoed"
				? { kind: "rate", rate: source.draw(rateGen) }
				: { kind: "amount", amount: source.draw(amountGen) },
		run: source.draw(element(runs))
	}
}

/** A relation parameter's slugs, mostly admitted, given in an artifact under a forced plan. */
export const givenCases: Gen<GivenCase> = (source) => ({
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
})

/** Comments over the loaded articles, a slug parameter, and a plan. */
export const emittedCases: Gen<EmittedCase> = (source) => ({
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
})

/** A text written as a refined constant, and the artifact a delivered constant is read through. */
export const constantCases: Gen<ConstantCase> = (source) => ({
	text: source.draw(slugTextGen),
	artifact: source.draw(element(artifacts))
})

/** Each numeric lookup, and the parameter it compares under its contract. */
export const numericLookups = {
	"amount compared": { query: byAmount, param: "amount" },
	"amount echoed": { query: echoAmount, param: "amount" },
	"rate echoed": { query: echoRate, param: "rate" }
} as const

/**
 * The insert step grizzle's conservative realization compiles for an article's insert under the installation `name`
 * names, its codes the installation's.
 */
const articleInsert = (name: string, installation: Installation) => {
	const reality = realityWrite(
		succeeded(
			testArtifacts(Content, {
				installation: identity.schema(parsedSchemaName(name)),
				codes: installedCodes(installation.names.codes)
			}),
			"artifacts"
		)
	)
	const frontend = succeeded(
		compileChangeSet(
			checking(Content),
			changeSet(
				ChangeSet.empty(Content).insert(Article, [{ id: id(1), slug: "a-slug", title: "anything" }])
			),
			{
				claims: reality.claims,
				laws: reality.laws,
				derived: reality.derived,
				world: reality.world,
				codes: installation.names.codes,
				clock: noClock
			}
		),
		"changeset"
	)
	const write = succeeded(
		realizeConservative(frontend, {
			names: reality.names,
			reads: reality.reads,
			share: new StatementShare(),
			level: "serializable"
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
	return found.value
}

/**
 * The statement a refined write sends in `session`, the constraint that judges its value, and whether the value is
 * admitted. grizzle's insert sends the enumerated member's facts as its member placeholders, one array of the facts per
 * column, each placeholder carrying the array of its part, written straight from the facts' texts (arrayTexts), past
 * the host codec, whose admission refuses a slug outside the pattern before any SQL: what reaches PostgreSQL is a value
 * the slug's domain alone judges, as a writer that skipped the codec would send it.
 */
export const refinedSend = (
	name: string,
	installation: Installation,
	session: RawSession,
	w: RefinedWrite
) => {
	const slugCheck = slugDomain(installation).constraint
	const table = (t: string) => `${quoteIdent(name)}.${quoteIdent(t)}`
	switch (w.path) {
		case "grizzle's compiled insert": {
			const step = articleInsert(name, installation)
			const fact: Readonly<Record<string, string>> = { id: id(1), slug: w.value, title: "anything" }
			const arrays = Arr.map(step.statement.params, (slot) => {
				if (slot.kind !== "member") {
					throw new Error(`a member placeholder, not ${slot.kind}`)
				}
				const fields = Arr.map(slot.columns, (c) => c.name)
				const written = arrayTexts(
					slot.relation,
					fields,
					[Arr.map(fields, (f) => paramText(defined(fact[f], `the fact's ${f}`)))],
					maxStringLength
				)
				if (!written.ok) {
					throw new Error(`arrays: ${written.error._tag}`)
				}
				return defined(
					written.value[slot.part.kind === "column" ? slot.part.index : 0],
					`the array of placeholder ${slot.number}`
				)
			})
			return {
				send: Effect.asVoid(session.values(step.statement.sql.text, arrays)),
				check: slugCheck,
				admitted: slugAdmits(w.value)
			}
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
				check: noteCheckOf(installation),
				admitted: Arr.fromIterable(w.value).length <= limit
			}
	}
}
