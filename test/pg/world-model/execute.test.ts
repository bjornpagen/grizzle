import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { sameValue, valueText } from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import type { LeakField } from "#test/support/worlds/execute/leak.ts"
import { knownNonEmpty, pool, pooled } from "#test/support/worlds/generate/domain.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { keyShown } from "#test/support/worlds/model/session/catalog.ts"
import type {
	Action,
	DirectStatement,
	FieldDomain,
	HostFact,
	HostSchema,
	HostState,
	HostValue,
	RelationSpec
} from "#test/support/worlds/model/types.ts"

/**
 * The executor's leak scan, the oracle every worlds suite's "no hidden value" rests on, held to real refusals with a
 * planted hidden value: a value a refusal does spell, named hidden, is reported as a leak in the field that spells it,
 * whatever the refusal's shape. Over the documents installation (model/bases/docs.ts) and a drawn reality, a case
 * plants one value in one refusal:
 * - a direct writer acting as its login, which holds no table, sends a statement on a relation's table (a select, an
 *   insert, a delete, an update or a truncate), which PostgreSQL refuses with 42501 naming the table in its message;
 * - the admin, a direct writer that took on a role holding the relation whole, inserts a stored fact again, which
 *   PostgreSQL refuses with 23505 naming the fact's key values in its DETAIL, on a relation whose key it shows the
 *   admin (session/catalog.ts keyShown): on a table under row security it omits the DETAIL, whatever the role's
 *   policy, so that refusal spells no value to plant;
 * - the admin's Db inserts a stored document's id with another owner and a word count its organization's documents
 *   leave free, which grizzle answers invariant-rejected on the primary key alone, its witness the submitted id.
 * The table, the key value or the id is the planted value: a scan that stopped reading a field, or read it under
 * another name, would let a real leak pass every suite unseen.
 */

/** A statement a direct writer sends on a relation's table. */
type TableStatement = Extract<
	DirectStatement["kind"],
	"select-table" | "insert" | "delete" | "update" | "truncate"
>

const tableStatements: Arr.NonEmptyReadonlyArray<TableStatement> = [
	"select-table",
	"insert",
	"delete",
	"update",
	"truncate"
]

/**
 * Where a case plants its value, with the fact its statement names: a 42501's message, by its statement; a 23505's
 * DETAIL, of a stored fact inserted again; or a Db refusal's witness, of a stored document's id.
 */
type Planted =
	| {
			readonly kind: "message"
			readonly statement: TableStatement
			readonly relation: RelationSpec
			readonly fact: HostFact
	  }
	| { readonly kind: "detail"; readonly relation: RelationSpec; readonly fact: HostFact }
	| {
			readonly kind: "witness"
			readonly doc: HostFact
			readonly owner: HostValue
			readonly words: HostValue
	  }

/** A case: the reality the world is reset to, and the planted value. */
interface LeakCase {
	readonly reality: HostState
	readonly planted: Planted
}

/** Where the leak scan reported a planted value: the field that spelled it, by what refused. */
type Reported = `message:${TableStatement}` | "detail:insert" | "witness:apply"

const situations: Arr.NonEmptyReadonlyArray<Reported> = [
	"message:select-table",
	"message:insert",
	"message:delete",
	"message:update",
	"message:truncate",
	"detail:insert",
	"witness:apply"
]

/** The relations of the base none of whose fields is serial, so a direct insert names every field it stores. */
const plain: Arr.NonEmptyReadonlyArray<RelationSpec> = knownNonEmpty(
	Arr.filter(docsInstall.base.relations, (r) =>
		Arr.every(r.fields, (f) => f.domain.kind !== "serial")
	),
	"the documents base's relations without a serial field"
)

/** The role the admin's direct writer takes on and its Db opens as: it holds every relation of the base whole. */
const admin = "admin"

/**
 * The relations without a serial field whose key PostgreSQL shows the admin in a DETAIL: those under no row security,
 * since the admin holds SELECT on every table.
 */
const spelling: ReadonlyArray<RelationSpec> = Arr.filter(plain, (r) =>
	keyShown(docsInstall, admin, r.name, r.key)
)

/** The relations of `spelling` a reality holds facts of, each with its facts: where a DETAIL can be planted. */
const heldIn = (
	reality: HostState
): ReadonlyArray<readonly [RelationSpec, Arr.NonEmptyReadonlyArray<HostFact>]> =>
	Arr.flatMap(spelling, (relation) =>
		Arr.match(factsOf(reality, relation), {
			onEmpty: () => [],
			onNonEmpty: (facts) => [[relation, facts] as const]
		})
	)

/** The documents: a relation the base references (a note's document), so every reality holds one. */
const docs: RelationSpec = defined(
	Option.getOrUndefined(Arr.findFirst(plain, (r) => r.name === "Doc")),
	"the documents base's Doc"
)

/** The domain of a field of a relation. */
const fieldDomain = (relation: RelationSpec, field: string): FieldDomain =>
	defined(
		Option.getOrUndefined(Arr.findFirst(relation.fields, (f) => f.name === field)),
		`${relation.name}.${field}`
	).domain

/** A relation's facts in a reality. */
const factsOf = (reality: HostState, relation: RelationSpec): ReadonlyArray<HostFact> =>
	reality.get(relation.name) ?? []

/** A fact of a relation from its fields' pools, each at its first value. */
const pooledFact = (relation: RelationSpec): HostFact =>
	Rec.fromEntries(Arr.map(relation.fields, (f) => [f.name, pooled(f.domain, 0)] as const))

/** A fact's values at its relation's primary key. */
const keyOf = (relation: RelationSpec, fact: HostFact): HostFact =>
	Rec.filter(fact, (_, field) => relation.key.includes(field))

/** The statement a planted 42501 is refused at, on a relation's table, naming one of its facts. */
const statementOf = (
	statement: TableStatement,
	relation: RelationSpec,
	fact: HostFact
): DirectStatement => {
	switch (statement) {
		case "select-table":
			return { kind: "select-table", relation: relation.name, filter: { kind: "none" } }
		case "insert":
			return { kind: "insert", relation: relation.name, fact }
		case "delete":
			return { kind: "delete", relation: relation.name, key: keyOf(relation, fact) }
		case "update":
			return { kind: "update", relation: relation.name, key: keyOf(relation, fact), set: fact }
		case "truncate":
			return { kind: "truncate", relation: relation.name }
	}
}

/**
 * Where a case plants its value over a reality, one arm per situation the scan reports it in, each fact a stored one
 * where the reality holds one: a message's, one arm per statement, of any relation without a serial field (from the
 * pools where it holds none); a DETAIL's of a relation the reality holds facts of whose key PostgreSQL shows the admin
 * (heldIn), an arm only where there is one; a witness's of a document, inserted with another owner and a word count no
 * document of its organization holds.
 */
const plantedGen = (reality: HostState): Gen<Planted> => {
	const stored = (relation: RelationSpec): Gen<HostFact> =>
		Arr.match(factsOf(reality, relation), {
			onEmpty: () => () => pooledFact(relation),
			onNonEmpty: (facts) => element(facts)
		})
	const message =
		(statement: TableStatement): Gen<Planted> =>
		(source) => {
			const relation = source.draw(element(plain))
			return { kind: "message", statement, relation, fact: source.draw(stored(relation)) }
		}
	const detail =
		(
			held: Arr.NonEmptyReadonlyArray<readonly [RelationSpec, Arr.NonEmptyReadonlyArray<HostFact>]>
		): Gen<Planted> =>
		(source) => {
			const [relation, facts] = source.draw(element(held))
			return { kind: "detail", relation, fact: source.draw(element(facts)) }
		}
	const witness: Gen<Planted> = (source) => {
		const doc = source.draw(stored(docs))
		const owners = Arr.filter(pool(fieldDomain(docs, "owner")), (o) => !sameValue(o, doc["owner"]))
		const taken = Arr.flatMap(factsOf(reality, docs), (d) =>
			sameValue(d["org"], doc["org"]) ? [d["words"]] : []
		)
		const words = Arr.filter(pool(fieldDomain(docs, "words")), (w) =>
			Arr.every(taken, (t) => !sameValue(w, t))
		)
		return {
			kind: "witness",
			doc,
			owner: source.draw(element(knownNonEmpty(owners, "another owner"))),
			words: source.draw(
				element(knownNonEmpty(words, "a word count the organization's documents leave free"))
			)
		}
	}
	return oneOf(
		Arr.appendAll(Arr.map(tableStatements, message), [
			...Arr.match(heldIn(reality), {
				onEmpty: (): ReadonlyArray<Gen<Planted>> => [],
				onNonEmpty: (held) => [detail(held)]
			}),
			witness
		])
	)
}

/** A case over the host schema the installation's names give: a lawful reality, then where to plant. */
const caseGen =
	(host: HostSchema): Gen<LeakCase> =>
	(source) => {
		const reality = source.draw(realityGen(docsInstall.base, host))
		return { reality, planted: source.draw(plantedGen(reality)) }
	}

/**
 * The hidden values a case plants and the field the scan must report one of them in: a message's table; a DETAIL's
 * uuids of the fact inserted again, one of which names whichever of its keys PostgreSQL meets first; a witness's id.
 */
const plantedTokens = (
	planted: Planted,
	tables: Readonly<Record<string, ObjectName>>
): {
	readonly tokens: ReadonlySet<string>
	readonly field: LeakField
	readonly reported: Reported
} => {
	switch (planted.kind) {
		case "message":
			return {
				tokens: new Set([
					defined(tables[planted.relation.name], `${planted.relation.name}'s table`).name
				]),
				field: "message",
				reported: `message:${planted.statement}`
			}
		case "detail":
			return {
				tokens: new Set(
					Arr.flatMap(planted.relation.fields, (f) => {
						const value = planted.fact[f.name]
						return f.domain.kind === "uuid" && value !== undefined ? [valueText(value)] : []
					})
				),
				field: "detail",
				reported: "detail:insert"
			}
		case "witness":
			return {
				tokens: new Set([valueText(defined(planted.doc["id"], "the document's id"))]),
				field: "witness",
				reported: "witness:apply"
			}
	}
}

/**
 * The two actions that bring a case's refusal about, the first performed with nothing hidden: a direct writer's
 * BEGIN as its login and its statement on the table; the admin's BEGIN, as the role it took on, and its insert of the
 * stored fact; or the admin's Db opened, and its insert of the document's id with another owner.
 */
const actionsOf = (planted: Planted): readonly [Action, Action] => {
	switch (planted.kind) {
		case "message":
			return [
				{
					kind: "direct-begin",
					login: "web",
					isolation: "serializable",
					start: { current: { kind: "login" }, claims: { kind: "none" } }
				},
				{
					kind: "direct",
					session: 0,
					statement: statementOf(planted.statement, planted.relation, planted.fact)
				}
			]
		case "detail":
			return [
				{
					kind: "direct-begin",
					login: "ops",
					isolation: "serializable",
					start: { current: { kind: "role", role: admin }, claims: { kind: "none" } }
				},
				{
					kind: "direct",
					session: 0,
					statement: { kind: "insert", relation: planted.relation.name, fact: planted.fact }
				}
			]
		case "witness":
			return [
				{
					kind: "open-db",
					role: { kind: "own", role: admin },
					token: { kind: "none" },
					snapshot: "current"
				},
				{
					kind: "apply",
					session: 0,
					strata: [
						[
							{
								relation: "Doc",
								kind: "insert",
								facts: [{ ...planted.doc, owner: planted.owner, words: planted.words }]
							}
						]
					],
					reads: []
				}
			]
	}
}

/** Cases: each resets the one realized world, so they are cheap. */
const cases = 21

layer(Substrate.layer, { excludeTestServices: true })("the worlds model: the leak scan", (it) => {
	it.effect("reports every hidden value a refusal spells, in the field that spells it", (ctx) =>
		searched(
			ctx,
			Effect.scoped(
				Effect.gen(function* () {
					const world = yield* realize(docsInstall, ordinarySession)
					const host = hostSchemaOf(docsInstall.base, world.names)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/world-model/leak-scan",
							draw: drawn(caseGen(host)),
							literal: Formatter.format,
							coverage: required<Reported>(situations, { cases: 4 * cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: { kind: "bounded", candidates: 100 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ reality, planted }, c) =>
							Effect.gen(function* () {
								yield* world.reset(reality)
								const expected = plantedTokens(planted, world.names.tables)
								const [opening, refused] = actionsOf(planted)
								const opened = yield* world.perform(opening, new Set())
								assert.equal(opened.kind, "opened", "the session the refusal comes through opens")
								const observed = yield* world.perform(refused, expected.tokens)
								if (observed.kind !== "leak") {
									return assert.fail(
										`${Formatter.format(refused)} answered ${Formatter.format(observed)}, and the scan reported none of the planted values`
									)
								}
								assert.equal(
									observed.field,
									expected.field,
									"the scan reports the field that spells it"
								)
								assert.ok(expected.tokens.has(observed.token), "the scan reports a planted value")
								c.note(expected.reported)
							})
					)
				})
			)
		)
	)
})
