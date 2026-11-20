/**
 * Refinement validation sites on PostgreSQL 19.
 *
 * One schema, installed by the fresh-install compiler once per member as a template (regex-complete.fixtures.ts
 * contentTemplate), carries a slug pattern, a
 * language-equivalent spelling of it, a contract bounding length with Text.charLength over the wildcard, and a
 * closed relation whose payload is a slug. The slug's pattern bounds its length, as text in any index grizzle installs
 * must (README, Text in a key): the installation installs the workload of the suites' parameterized queries, whose
 * lookups of Article and Comment by slug each ask for an index on the slug. Against it:
 *
 * - a parameter is checked against its pattern or contract by PostgreSQL as it binds it, its placeholder cast to its own
 *   pattern domain or its contract's domain, which the installation creates for every pattern a parameter names: the
 *   reader's bind (adapter/reader/relations.ts executionInputs) parses only its base carrier, a value outside its
 *   refinement is refused with 23514 on that domain, and a value inside them matches exactly its rows, under generic and custom plans and unprepared, in both artifacts, also
 *   where the query emits the parameter, a fused attachment's child emits it inside its array, or a union's arm emits
 *   it beside an arm that stores it; each forced plan is checked against pg_prepared_statements, and each refusal to
 *   come before PostgreSQL chooses any plan;
 * - a scalar parameter's and a relation parameter's refined values alike, a relation parameter's refined column, which
 *   the optimized delivery casts to its domain in the output list (lower/shapes/refined), included;
 * - a Type.cast into a refinement no value of its operand is proved to satisfy is refused by compilation
 *   (PartialOperation, precondition language), so no read raises 23514 on a delivered row;
 * - a refined write is refused before commit, by grizzle's compiled insert and by a direct SQL writer alike, with
 *   PostgreSQL's 23514 naming the domain's constraint;
 * - closed payloads are validated by PostgreSQL at installation, and the migration generate drafts and the snapshot
 *   admission derives hold the same validation; a refined query literal is validated wherever it is delivered.
 */
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { partRuns } from "#adapter/reader/execution.ts"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { refinedConstants } from "#compiler/check/refinement/index.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { constantValidationObjects } from "#compiler/lower/shapes/refined/index.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import {
	articles,
	articlesSql,
	bindRefusal,
	boundAgrees,
	type BoundFeature,
	bySlug,
	compiled,
	compiling,
	constantCases,
	Content,
	contentTemplate,
	decimal,
	declared,
	domainRefusal,
	echoComments,
	echoSlug,
	emittedCases,
	type EmittedFeature,
	featureOf,
	givenCases,
	givenSlugs,
	id,
	literal,
	loadArticles,
	numericCases,
	numericLookups,
	patternCases,
	readerSession,
	type RefinedFeature,
	refinedSend,
	refinedWriteGen,
	refusedAtBind,
	rows,
	runPlanned,
	slugAdmits,
	slugDomain,
	slugsOrEcho,
	titlesAsSlugs,
	withConstant
} from "#test/pg/regex-complete/regex-complete.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { paramTexts } from "#test/support/compile.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"

/**
 * A slug parameter outside its pattern is refused at bind, and one inside it matches its rows, generic and custom, each
 * case on the worker's seat of the installation, three articles loaded.
 *
 * Its pre-conversion budget: runs 32, coverage cases 48 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const aParameterOutsideItsPatternIsRefusedAtBindAndOneInsideItMatchesItsRows =
	property.explore(patternCases, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: ["refused at bind", "no row", "a row"] satisfies ReadonlyArray<
			Reached<BoundFeature>
		>,
		check:
			({ content }, c: Case<BoundFeature>) =>
			({ lookup, artifact, slug, run }) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name } = seat.value
								yield* loadArticles(name, articles(3))
								const session = yield* readerSession
								const template = compiled(lookup === "the lookup" ? bySlug : echoSlug, name)
								const loaded = new Set(Arr.map(articles(3), (a) => a.slug))
								const bound = slugAdmits(slug) ? rows(loaded.has(slug) ? 1 : 0) : refusedAtBind
								c.note(featureOf(bound))
								yield* boundAgrees(
									session,
									template,
									artifact,
									{ slug },
									bound,
									run,
									`${slug} in ${lookup}, ${artifact}, run ${run}`
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's match of the slug's pattern, and the loaded articles' slugs"
		},
		show: Formatter.format,
		budget: { runs: 32, steered: 48 },
		kept: [],
		kills: []
	})

/**
 * A parameter outside a numeric contract is refused at bind, and one inside it matches its rows, generic and custom,
 * each case on the worker's seat of the installation, one price stored.
 *
 * Its pre-conversion budget: runs 36, coverage cases 60 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const aParameterOutsideANumericContractIsRefusedAtBindAndOneInsideItMatchesItsRows =
	property.explore(numericCases, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: ["refused at bind", "no row", "a row"] satisfies ReadonlyArray<
			Reached<BoundFeature>
		>,
		check:
			({ content }, c: Case<BoundFeature>) =>
			({ lookup, artifact, value, run }) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name } = seat.value
								const s = yield* Substrate
								yield* s.admin.query(
									`INSERT INTO ${quoteIdent(name)}."price" ("id", "amount", "rate") VALUES ('${id(1)}', 100, 0.062)`,
									[]
								)
								const session = yield* readerSession
								const stored = { amount: 100n, rate: decimal("0.062") }
								/** Each lookup, the parameter it compares and its contract, and the stored value its rows match. */
								const { query: lookedUp, param } = numericLookups[lookup]
								const template = compiled(lookedUp, name)
								const bound =
									value.kind === "amount"
										? value.amount < 0n
											? refusedAtBind
											: rows(value.amount === stored.amount ? 1 : 0)
										: value.rate.compare(decimal("0")) < 0 || value.rate.compare(decimal("1")) > 0
											? refusedAtBind
											: rows(value.rate.compare(stored.rate) === 0 ? 1 : 0)
								c.note(featureOf(bound))
								const given = value.kind === "amount" ? value.amount : value.rate
								yield* boundAgrees(
									session,
									template,
									artifact,
									{ [param]: given },
									bound,
									run,
									`${param} ${Formatter.format(given)} in the ${artifact} artifact, run ${run}`
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the contracts' predicates (amount ≥ 0, 0 ≤ rate ≤ 1) and the stored price"
		},
		show: Formatter.format,
		budget: { runs: 36, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * A refined write is refused before commit with its refinement identity exactly when its value is outside the
 * refinement, by grizzle's compiled insert and a direct SQL writer alike, each case on the worker's seat of the
 * installation, one draft stored.
 *
 * Its pre-conversion budget: runs 48, coverage cases 96 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const aRefinedWriteIsRefusedBeforeCommitExactlyWhenItsValueIsOutsideTheRefinement =
	property.explore(refinedWriteGen, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: [
			"grizzle's compiled insert: refused",
			"grizzle's compiled insert: admitted",
			"a direct insert of an article's slug: refused",
			"a direct insert of an article's slug: admitted",
			"a direct update of a draft's slug: refused",
			"a direct update of a draft's slug: admitted",
			"a direct update of a draft's note: refused",
			"a direct update of a draft's note: admitted"
		] satisfies ReadonlyArray<Reached<RefinedFeature>>,
		check:
			({ content }, c: Case<RefinedFeature>) =>
			(w) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name, installation, world } = seat.value
								const s = yield* Substrate
								const session = yield* s.session({ ...worldSession(world), label: "writer" })
								const table = (t: string) => `${quoteIdent(name)}.${quoteIdent(t)}`
								yield* session.query(
									`INSERT INTO ${table("draft")} ("id", "slug", "note") VALUES ('${id(3)}', 'fine', 'ok')`,
									[]
								)
								const { send, check, admitted } = refinedSend(name, installation, session, w)
								if (admitted) {
									yield* inTransaction(session, send)
									c.note(`${w.path}: admitted`)
								} else {
									yield* expectConstraint(inTransaction(session, send), check, "23514")
									c.note(`${w.path}: refused`)
								}
								yield* session.rollback
								const committed = yield* s.admin.queryValues(
									`SELECT (SELECT count(*) FROM ${table("article")})::text, (SELECT count(*) FROM ${table("draft")} WHERE "slug" = 'fine' AND "note" = 'ok')::text`,
									[]
								)
								assert.deepEqual(committed, [["0", "1"]], "nothing was committed")
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's match of the slug's pattern and the note's length in characters, against the domain's CHECK"
		},
		show: Formatter.format,
		budget: { runs: 48, steered: 96 },
		kept: [],
		kills: []
	})

/**
 * A cast into a refinement nothing proves is refused at compile, and a relation parameter outside its pattern at bind,
 * generic and custom, each case on the worker's seat of the installation.
 *
 * Its pre-conversion budget: runs 20, coverage cases 32 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const aCastIntoARefinementNothingProvesIsRefusedAtCompileAndARelationParameterOutsideItsPatternAtBind =
	property.explore(givenCases, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: ["refused at bind", "a row", "an empty relation"] satisfies ReadonlyArray<
			Reached<BoundFeature | "an empty relation">
		>,
		check:
			({ content }, c: Case<BoundFeature | "an empty relation">) =>
			({ slugs, artifact, plan }) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name } = seat.value
								const session = yield* readerSession
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
										Option.getOrThrow(Arr.findFirst(given.heading, (h) => h.name === "slug")).type
									),
									true
								)
								const facts = Arr.map(slugs, (slug, i) => ({ id: id(100 + i), slug }))
								const bound = Arr.every(slugs, slugAdmits) ? rows(facts.length) : refusedAtBind
								c.note(featureOf(bound))
								if (facts.length === 0) {
									c.note("an empty relation")
								}
								yield* boundAgrees(
									session,
									given,
									artifact,
									{ given: facts },
									bound,
									plan,
									`${facts.length} facts in the ${artifact} artifact under a ${plan} plan`
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's match of the slug's pattern over every given fact"
		},
		show: Formatter.format,
		budget: { runs: 20, steered: 32 },
		kept: [],
		kills: []
	})

/**
 * An attachment's and a union arm's emitted parameter is refused outside its pattern, and delivered inside it, each case
 * on the worker's seat of the installation, writing the articles and comments it reads.
 *
 * Its pre-conversion budget: runs 32, coverage cases 48 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const anAttachmentsAndAUnionArmsEmittedParameterIsRefusedOutsideItsPatternAndDeliveredInsideIt =
	property.explore(emittedCases, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: [
			"refused at bind",
			"no comment",
			"a comment the parameter excludes",
			"a comment the union matches"
		] satisfies ReadonlyArray<Reached<EmittedFeature>>,
		check:
			({ content }, c: Case<EmittedFeature>) =>
			({ comments, slug, plan }) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name, installation } = seat.value
								const s = yield* Substrate
								const tables = installationGroup(installationNamesOf(installation))
								const session = yield* readerSession
								/**
								 * An attachment over exact parents is a part of its own of the read's one statement (lower/shapes/index.ts
								 * OptimizedDelivery, R36): the parent's rows, then the attachment's, each a parent's key then a child's
								 * fields, behind its part's tag (adapter/reader/execution.ts partRuns).
								 */
								const attached = compiled(echoComments, name)
								assert.equal(attached.optimized.length, 1)
								const spec = defined(attached.optimized[0], "the read's statement")
								const attachment = defined(
									Option.getOrUndefined(
										Arr.findFirst(flight(attached.run.roots), (p) => p.role.kind === "attachment")
									),
									"the attachment's part"
								)
								const union = compiled(slugsOrEcho, name)
								const unionSpec = defined(union.optimized[0], "statement")
								const conservative = defined(union.conservative[0], "statement")
								const articleSlugs = Arr.map(articles(3), (a) => a.slug)
								if (!slugAdmits(slug)) {
									assert.equal(bindRefusal(attached, { slug }), undefined, slug)
									assert.equal(bindRefusal(union, { slug }), undefined, slug)
									const refusedAttached = yield* Effect.exit(
										runPlanned(
											session,
											spec.sql,
											paramTexts(spec, { slug }, declared(attached)),
											plan
										)
									)
									const refusedUnion = yield* Effect.exit(
										runPlanned(
											session,
											unionSpec.sql,
											paramTexts(unionSpec, { slug }, declared(union)),
											plan
										)
									)
									assert.equal(domainRefusal(refusedAttached), "23514", slug)
									assert.equal(domainRefusal(refusedUnion), "23514", slug)
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
								const sent = yield* runPlanned(
									session,
									spec.sql,
									paramTexts(spec, { slug }, declared(attached)),
									plan
								)
								const delivered = defined(
									partRuns(
										attached.run.parts,
										outputRows(Arr.map(sent, (r) => Arr.map(r, String)))
									)[attachment.answer],
									"the attachment's run"
								)
								unorderedEqual(
									Arr.map(delivered, (r): ReadonlyArray<string> => r),
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the queries' meaning over the drawn comments: the attachment's comments but the parameter's, echoing it; the union's slugs and the parameter where a comment holds it"
		},
		show: Formatter.format,
		budget: { runs: 32, steered: 48 },
		kept: [],
		kills: []
	})

/**
 * Closed payloads are validated by PostgreSQL at installation, and a refined query constant where it is delivered, each
 * case on the worker's seat of the installation, two articles loaded.
 *
 * Its pre-conversion budget: runs 24, coverage cases 32 (test/pg/regex-complete/regex-complete.test.ts at 41a9e7062).
 */
export const closedPayloadsAreValidatedByPostgresqlAtInstallationAndARefinedQueryConstantWhereItIsDelivered =
	property.explore(constantCases, {
		needs: { content: Substrate.seat(contentTemplate) },
		situations: ["a constant refused", "a constant admitted"] satisfies ReadonlyArray<
			Reached<"a constant refused" | "a constant admitted">
		>,
		check:
			({ content }, c: Case<"a constant refused" | "a constant admitted">) =>
			({ text, artifact }) =>
				Effect.scoped(
					Effect.flatMap(content, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema: name, installation } = seat.value
								const s = yield* Substrate
								const owned = owning(Content)
								const checked = succeeded(checkedSchema(owned, everySlice(owned)), "checked")
								const constants = refinedConstants(checked)
								unorderedEqual(
									Arr.map(constants, (k) => k.literal),
									[
										{ kind: "text", value: "free" },
										{ kind: "text", value: "pro-plan" }
									]
								)
								assert.ok(Arr.some(installation.manifest.objects, (o) => o.kind === "validation"))
								const template = compiled(withConstant, name)
								yield* loadArticles(name, articles(2))
								const constantType = defined(constants[0], "constant").type
								/**
								 * A closed payload's validation statement over the constants and the drawn one, and the cast of the drawn text
								 * into the slug's domain: both fail with the domain's constraint exactly when the pattern refuses the text.
								 */
								const validation = succeeded(
									constantValidationObjects(installation.names, [
										...constants,
										{
											literal: { kind: "text", value: text },
											type: constantType,
											site: { relation: "Drawn", field: "text", key: [] }
										}
									]),
									"validation"
								)
								const [statement] = validation[0]?.ddl ?? []
								const sql = succeeded(
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
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's match of the slug's pattern, against the domain's CHECK on a constant"
		},
		show: Formatter.format,
		budget: { runs: 24, steered: 32 },
		kept: [],
		kills: []
	})
