/** What the property of execute.test.ts reads: the leak cases, their plants and actions, and the docs world. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { sameValue, valueText } from "#test/support/laws/model.ts"
import type { LeakField } from "#test/support/worlds/execute/leak.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { worldTemplate } from "#test/support/worlds/execute/template.ts"
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
export type Reported = `message:${TableStatement}` | "detail:insert" | "witness:apply"

export const situations: Arr.NonEmptyReadonlyArray<Reported> = [
	"message:select-table",
	"message:insert",
	"message:delete",
	"message:update",
	"message:truncate",
	"detail:insert",
	"witness:apply"
]

/** The relations of the base, each of whose facts a direct insert names every field of. */
const plain: Arr.NonEmptyReadonlyArray<RelationSpec> = knownNonEmpty(
	docsInstall.base.relations,
	"the documents base's relations"
)

/** The role the admin's direct writer takes on and its Db opens as: it holds every relation of the base whole. */
const admin = "admin"

/**
 * The relations whose key PostgreSQL shows the admin in a DETAIL, spelling a value the scan can recognize: those under no
 * row security, since the admin holds SELECT on every table, that hold a uuid field, a value no other text of a refusal
 * spells by chance (plantedTokens). Visit, keyed by its integers since grizzle mints no ids (10a0cd919), is none: a
 * DETAIL planted on it planted no token, so its scan could report nothing (TEST_SEED=1759120296's steered case 15).
 */
const spelling: ReadonlyArray<RelationSpec> = Arr.filter(
	plain,
	(r) =>
		keyShown(docsInstall, admin, r.name, r.key) &&
		Arr.some(r.fields, (f) => f.domain.kind === "uuid")
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
 * where the reality holds one: a message's, one arm per statement, of any relation (from the
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
export const plantedTokens = (
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
export const actionsOf = (planted: Planted): readonly [Action, Action] => {
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

/** Cases: each resets the worker's seated world, so they are cheap. */
export const cases = 21

/**
 * The cases, over the host schema of the documents installation under its declared names, from its compilation alone
 * (execute/names.ts installedNames), where the search read the names off its realized world: a reality names relations
 * by the base's names, never an installation's (300 realities drawn alike under the declared names and under a name of
 * the test's own).
 */
export const leakCases = caseGen(hostSchemaOf(docsInstall.base, installedNames(docsInstall)))

/**
 * The documents installation's world as a template (execute/template.ts worldTemplate), installed once per member, each
 * case taking a fresh clone of it (Substrate.freshOf): a case's reset refreshes the world's derived relation OrgDocs
 * (execute/index.ts RealWorld reset), a materialized view whose rows no seat's reset empties, so a seat would hold the
 * clone unlike its template after the first case whose reality holds a document, and refuse the next case's take.
 */
export const docsWorld = worldTemplate({
	declaredIn: import.meta,
	name: "leak scan docs",
	install: docsInstall,
	ambient: ordinarySession
})
