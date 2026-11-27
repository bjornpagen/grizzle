/**
 * What the properties of derived-names.test.ts read: the words den spells its derived names from a flow's names with,
 * capitalized, so a name of several words is their concatenation at any length and names compose into each other
 * (`EssayItem` then `Input` is `Essay` then `ItemInput`); a level of drawn relations, generated relations and rosters,
 * each derived through the dynamic door's derivedName or declared through its constructors, every relation over the
 * level's first roster by a closed id and a set where it holds one; two names that convert alike, one spelled as its
 * words and one as its conversion; and the schema and query of records whose stem and path a derived relation of den's
 * names shares.
 */
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { array, element, type Gen, map, uniqueArray } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { conversionOf, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { closed, derivedName, relation } from "#compiler/public/dynamic.ts"
import { bits, closedId, generated, pg } from "#compiler/public/fields.ts"
import { relation as rootRelation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"

/**
 * The words den derives names from (a flow's, a step's, an item's, a choice's and a field's names), each capitalized,
 * some the concatenation of others' segments, so drawn names repeat and prefix each other.
 */
const denWords = [
	"Essay",
	"Item",
	"Input",
	"Value",
	"Status",
	"Sitting",
	"Key",
	"Choice",
	"Citation",
	"Scan",
	"Stimulus",
	"Document"
] as const

/** What a drawn name builds: a relation, a generated relation or an unordered roster. */
const kinds = ["relation", "generated", "roster"] as const

export type NamedKind = (typeof kinds)[number]

/** How a drawn name is named: through derivedName, or declared by the door's own constructor. */
const namings = ["derived", "declared"] as const

export type DrawnNaming = (typeof namings)[number]

/** One drawn name: what it builds, how it is named, and, derived, the stem and path its naming states. */
export interface Drawn {
	readonly name: string
	readonly kind: NamedKind
	readonly naming: DrawnNaming
	readonly stem: string
	readonly path: ReadonlyArray<string>
}

/** The name a conversion spells as its words, each segment capitalized: `essay_item` is `EssayItem`. */
const wordsOf = (conversion: string): string =>
	Arr.join(Arr.map(Str.split("_")(conversion), Str.capitalize), "")

/** The words of a name, up to `most`, as the conversion two names alike share. */
const conversionGen = (most: number): Gen<string> =>
	map(array(element(denWords), { min: 1, max: most }), (words) => conversionOf(Arr.join(words, "")))

/** A stem and a path of den's words, as derivedName states them. */
const stemGen: Gen<string> = element(denWords)
const pathGen: Gen<ReadonlyArray<string>> = array(element(denWords), { min: 0, max: 3 })

/**
 * A drawn name of conversion `conversion`, spelled as its words: derived past PostgreSQL's identifier, which no
 * declared name passes, derived or declared within it.
 */
const drawnOf =
	(conversion: string): Gen<Drawn> =>
	(source) => {
		const kind = source.draw(element(kinds))
		const naming =
			utf8Length(conversion) > maxIdentifierBytes ? "derived" : source.draw(element(namings))
		return {
			name: wordsOf(conversion),
			kind,
			naming,
			stem: source.draw(stemGen),
			path: source.draw(pathGen)
		}
	}

/**
 * The words a level's names take at most: sixteen of den's longest are past PostgreSQL's identifier twice over, and one
 * is within it.
 */
const mostWords = 16

/** A level's drawn names, one to six, of distinct conversions, each of one word to mostWords. */
export const levelGen: Gen<ReadonlyArray<Drawn>> = uniqueArray(conversionGen(mostWords), drawnOf, {
	min: 1,
	max: 6
})

/** Two namings of names that convert alike, one derived at least. */
const alikeNamings = [
	["derived", "derived"],
	["derived", "declared"],
	["declared", "derived"]
] as const

export type AlikeNaming = (typeof alikeNamings)[number]

/** Two drawn names that convert alike: the first spelled as its words, the second as its conversion. */
export interface Alike {
	readonly namings: AlikeNaming
	readonly first: Drawn
	readonly second: Drawn
}

/** The words a declared name of a pair takes at most: four of den's longest are within PostgreSQL's identifier. */
const declaredWords = 4

/** Two names that convert alike, each of a drawn kind, under a drawn pair of namings (Alike). */
export const alikeGen: Gen<Alike> = (source) => {
	const pair = source.draw(element(alikeNamings))
	const [one, two] = pair
	const conversion = source.draw(
		conversionGen(one === "declared" || two === "declared" ? declaredWords : mostWords)
	)
	const drawn = (name: string, naming: DrawnNaming): Drawn => ({
		name,
		kind: source.draw(element(kinds)),
		naming,
		stem: source.draw(stemGen),
		path: source.draw(pathGen)
	})
	return { namings: pair, first: drawn(wordsOf(conversion), one), second: drawn(conversion, two) }
}

/** The fields of a drawn relation beside its key and payload: a closed id and a set over `roster` where the level holds
 * one. */
const rosterFields = (roster: AnyRoster | undefined): Readonly<Record<string, FieldBase>> =>
	roster === undefined ? {} : { k: closedId(roster), s: bits(roster) }

/** The handles every drawn roster introduces. */
const handles = ["a", "b"] as const

/** A drawn roster, through the door: derived by derivedName(...).unordered, or declared by closed.unordered. */
const rosterOf = (d: Drawn): AnyRoster =>
	d.naming === "derived"
		? derivedName({ stem: d.stem, path: d.path }).unordered(d.name, handles)
		: closed.unordered(d.name, handles)

/**
 * A drawn relation over `roster`, through the door: derived by derivedName's relation or generated, or declared by the
 * door's relation or relation.generated; a generated one's field `m` its payload's value.
 */
const relationOf = (d: Drawn, roster: AnyRoster | undefined): AnyRelation => {
	const fields = { id: pg.integer, n: pg.integer, ...rosterFields(roster) }
	const builders =
		d.naming === "derived"
			? derivedName({ stem: d.stem, path: d.path })
			: { relation, generated: relation.generated }
	return d.kind === "generated"
		? builders.generated(d.name, fields, ["id"], (row) => ({ m: generated(pg.integer, row.n) }))
		: builders.relation(d.name, fields, ["id"])
}

/** A built drawn name: the value its builder made, by its name. */
export interface Built {
	readonly drawn: Drawn
	readonly value: AnyRelation | AnyRoster
}

/** Each drawn name built (relationOf, rosterOf), the rosters first, every relation over the first roster. */
export const builtOf = (drawn: ReadonlyArray<Drawn>): ReadonlyArray<Built> => {
	const rosters = Arr.map(
		Arr.filter(drawn, (d) => d.kind === "roster"),
		(d) => ({ drawn: d, value: rosterOf(d) })
	)
	const over = rosters[0]?.value
	return [
		...rosters,
		...Arr.map(
			Arr.filter(drawn, (d) => d.kind !== "roster"),
			(d) => ({ drawn: d, value: relationOf(d, over) })
		)
	]
}

/** The level of built names, a root schema of no statement. */
export const levelOf = (built: ReadonlyArray<Built>) =>
	schema(
		"Drawn",
		Arr.map(built, (b) => b.value),
		[]
	)

/**
 * The kept cases of a derived name's identity: two of den's relations of one stem and path and two names, and one of
 * den's beside the relation records of its stem derive at its path.
 */
export const keptCases = [
	"two derived relations of one stem and path",
	"a derived relation beside records of its stem and path"
] as const

export type KeptCase = (typeof keptCases)[number]

/** A key field and a payload, the fields of every relation the records' query reads. */
const K = pg.integer

/** The relation the records' root reads, and the one its attachment `key` reads, keyed by its parent's key. */
const Sitting = rootRelation("Sitting", { id: K, n: K }, ["id"])
const Answer = rootRelation("Answer", { p: K, w: K }, ["p"])

/** The schema the records' query is over. */
export const Sittings = schema("Sittings", [Sitting, Answer], [])

/**
 * The query records of den's stem `EssaySitting` hold: each sitting, and its answer attached as the option `key`, so
 * records derive `EssaySittingKey` at the path `key`.
 */
export const sittingsQuery: QueryValue = queryOver(Sittings)
	.rule((r: RuleValue) => {
		const { id, n } = varsOver(Sitting, "s")
		return r.match(Sitting, { id, n }).find({ id, n })
	})
	.attach(
		"key",
		(s: Readonly<Record<string, unknown>>) =>
			queryOver(Sittings).rule((r: RuleValue) => {
				const { w } = varsOver(Answer, "a")
				return r.match(Answer, { p: s["id"], w }).find({ p: s["id"], w })
			}),
		"option"
	)
