import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, generated, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { type HeadOf, query, v } from "#compiler/public/query.ts"
import { closed, type Fact, relation, schema } from "#compiler/public/schema.ts"
import type { Addition, Written } from "#compiler/types/changeset/changeset.ts"
import type { SqlOfTerm, TypeOfTerm } from "#compiler/types/core/phantom.ts"
import type { Bits as BitsOf } from "#compiler/types/fields/field.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/fields/support.ts"

/**
 * Generated fields and closed reads, as the public barrels type them. Typechecked only; every `@ts-expect-error --
 * TSnnnn` names the diagnostic the type-test batch requires on its next line.
 *
 * The oracle is the type checker: a generated field (relation.generated's callback, whose row is the written fields
 * alone) is in its relation's facts and in a query's head, and in no addition and no written fact; C.at and C.row are
 * typed by the closed relation's key, field by field, and C.row's set is over the roster of the one key field it leaves
 * open. A relation every field of which its caller writes, closed ids and sets among them, is inserted by its whole
 * facts. What a generation expression may read and be typed as (no generated field, its declared type, a name apart
 * from the written fields, no key over it) is test/types/schema/fixtures/generated.ts's.
 */
export const Kind = closed("Kind", ["element", "text"])
export const Flag = closed("Flag", ["on", "off"])
export const Level = closed("Level", ["low", "high"])
/** A roster whose handles are Kind's spellings: a handle's roster is its identity, never its text. */
export const Echo = closed("Echo", ["element", "text"])

/** A closed relation over a key of three closed ids, with an integer and a smallint payload. */
export const Rule = closed.relation(
	"Rule",
	{
		kind: closedId(Kind),
		flag: closedId(Flag),
		level: closedId(Level),
		weight: pg.integer,
		rank: pg.smallint
	},
	["kind", "flag", "level"],
	[
		{ kind: "element", flag: "on", level: "low", weight: 1, rank: 1 },
		{ kind: "text", flag: "off", level: "high", weight: 2, rank: 2 }
	]
)

/** C.at reads a payload field at a full key, of the field's type; C.row reads a key prefix as a set over the last. */
export const weightAt = () => Rule.at("weight", "element", "on", "low")
export const rankAt = () => Rule.at("rank", "text", "off", "high")
export const levelsOf = () => Rule.row("element", "on")
export type WeightValue = Expect<Equals<TypeOfTerm<ReturnType<typeof weightAt>>, number>>
export type WeightSql = Expect<Equals<SqlOfTerm<ReturnType<typeof weightAt>>, "integer">>
export type RankSql = Expect<Equals<SqlOfTerm<ReturnType<typeof rankAt>>, "smallint">>
export type LevelsValue = Expect<
	Equals<TypeOfTerm<ReturnType<typeof levelsOf>>, BitsOf<typeof Level>>
>

/** A key value stands at its own key field, of that field's roster. */
export const atSwapped = () =>
	// @ts-expect-error -- TS2345: a key value is a handle of its own key field's roster, in key order
	Rule.at("weight", "on", "element", "low")
export const atShort = () =>
	// @ts-expect-error -- TS2554: C.at takes one key value per key field
	Rule.at("weight", "element", "on")
/** C.at reads a payload field the closed relation declares. */
export const atMissing = () =>
	// @ts-expect-error -- TS2345: C.at reads a payload field the closed relation declares
	Rule.at("nope", "element", "on", "low")
export const rowShort = () =>
	// @ts-expect-error -- TS2554: C.row takes every key field but the last
	Rule.row("element")

/**
 * relation.generated: the callback reads the written fields alone, so a generation expression reads no generated
 * column. Its closed reads take the row's closed ids at their key fields.
 */
export const Node = relation.generated(
	"Node",
	{
		id: uuid,
		kind: closedId(Kind),
		flag: closedId(Flag),
		level: closedId(Level),
		depth: pg.integer
	},
	["id"],
	(r) => ({
		weight: generated(pg.integer, Rule.at("weight", r.kind, r.flag, r.level)),
		levels: generated(bits(Level), Rule.row(r.kind, r.flag)),
		next: generated(pg.integer, Compute.cast(Compute.add(r.depth, 1), pg.integer))
	})
)

/** A term is typed by its roster: a closed id of another roster with the same spellings stands at no key field of Kind. */
export const Echoed = relation.generated(
	"Echoed",
	{ id: uuid, echo: closedId(Echo), flag: closedId(Flag), level: closedId(Level) },
	["id"],
	(r) => ({
		// @ts-expect-error -- TS2345: a key term is of its key field's roster, whatever its handles' spellings
		weight: generated(pg.integer, Rule.at("weight", r.echo, r.flag, r.level))
	})
)

/** A fact holds every field; a written fact and an addition hold the written fields alone. */
type NodeWritten = "id" | "kind" | "flag" | "level" | "depth"
export type NodeFact = Expect<
	Equals<keyof Fact<typeof Node>, NodeWritten | "weight" | "levels" | "next">
>
export type NodeWeight = Expect<Equals<Fact<typeof Node>["weight"], number>>
export type NodeLevels = Expect<Equals<Fact<typeof Node>["levels"], BitsOf<typeof Level>>>
export type NodeWrittenKeys = Expect<Equals<keyof Written<typeof Node>, NodeWritten>>
export type NodeAddition = Expect<Equals<keyof Addition<typeof Node>, NodeWritten>>
export type NodeAdditionWeight = Expect<Not<IsAssignable<"weight", keyof Addition<typeof Node>>>>

/** A query reads a generated field as it reads every field, at its declared type. */
export const Plain = relation(
	"Plain",
	{ id: uuid, kind: closedId(Kind), flags: bits(Flag), n: pg.integer },
	["id"]
)
export const Nodes = schema("Nodes", { Kind, Flag, Level, Rule, Node, Plain }, [])
export const generatedHead = query(Nodes).rule((r) => {
	const { id, weight, levels } = v(Node, "node")
	return r.match(Node, { id, weight, levels }).find({ id, weight, levels })
})
export type GeneratedHead = Expect<
	Equals<
		HeadOf<typeof generatedHead>,
		{ readonly id: Uuid; readonly weight: number; readonly levels: BitsOf<typeof Level> }
	>
>

declare const someId: Uuid

/** An insert and a put of the generated relation take its written fields. */
export const nodeWrites = ChangeSet.empty(Nodes)
	.insert(Node, [{ id: someId, kind: "element", flag: "on", level: "low", depth: 1 }])
	.put(Node, [{ id: someId, kind: "text", flag: "off", level: "high", depth: 2 }])

/** No insert supplies a generated field. */
export const insertsGenerated = ChangeSet.empty(Nodes).insert(
	Node,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ id: someId, kind: "element", flag: "on", level: "low", depth: 1, weight: 1 }]
)

/** A relation every field of which its caller writes, closed ids and sets among them, is inserted by its whole facts. */
export const plainWrites = ChangeSet.empty(Nodes)
	.insert(Plain, [{ id: someId, kind: "element", flags: Bits.of(Flag, ["on"]), n: 1 }])
	.put(Plain, [{ id: someId, kind: "text", flags: Bits.of(Flag, []), n: 2 }])
	.delete(Plain, [{ id: someId, kind: "text", flags: Bits.of(Flag, []), n: 2 }])
