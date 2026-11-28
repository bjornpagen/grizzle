/**
 * What the properties of record-names.test.ts read: a schema whose relations a query attaches as options at one and two
 * levels below its root, the positions a records relation's name is derived at (the root's, an attachment's of a name
 * the tree holds once, a repeated name's under its parent, and a repeated name's under a parent whose name is stated),
 * each built so its derived name's conversion takes a given count of bytes, and a name of as many bytes stated at its
 * path; and a document read in the shape metis reads an item's documents in (an item's scan and each stimulus's,
 * pantry's documentScanOf below each) under a stem den derives (a flow's, a step's and a read's names).
 */
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, String as Str } from "effect"
import { conversionOf, maxIdentifierBytes } from "#compiler/core/identity.ts"
import { int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"

/** The positions a records relation's name is derived at (see the header). */
export const positions = ["root", "attachment", "repeated", "under a stated parent"] as const

export type Position = (typeof positions)[number]

/**
 * How a cell names the relation it measures: as records derive it, or by a name its author states at the relation's
 * path, which the root has none of.
 */
export type CellNaming = "derived" | "stated"

/** The namings a cell at `position` takes: the root's derived alone, an attachment's either. */
export const namingsAt = (position: Position): readonly [CellNaming, ...Array<CellNaming>] =>
	position === "root" ? ["derived"] : ["derived", "stated"]

/** The faults of records' options a caller can write, each refused where the options are read. */
export const optionFaults = [
	"a stray path",
	"an overlong stated name",
	"options that are no record",
	"a sixth argument"
] as const

export type OptionFault = (typeof optionFaults)[number]

/** A parent's variables, as an attachment's callback receives them. */
type Vars = Readonly<Record<string, unknown>>

/** A key field and a payload, the fields of every relation the queries read. */
const K = int4

/** The root's relation, and the relations its options and their options read, each keyed by its parent's key. */
const P = relation("P", { id: K, n: K }, ["id"])
const A1 = relation("A1", { p: K, w: K }, ["p"])
const A2 = relation("A2", { p: K, w: K }, ["p"])
const B1 = relation("B1", { p: K, w: K }, ["p"])
const B2 = relation("B2", { p: K, w: K }, ["p"])

/** The relations a document's scan reads (documentScanOf's shape), and a stimulus's reference from an item. */
const Doc = relation("Doc", { id: K, n: K }, ["id"])
const Ref = relation("Ref", { p: K, k: K, t: K }, ["p", "k"])
const Node = relation("Node", { p: K, s: K, x: K }, ["p", "s"])
const Opt = relation("Opt", { p: K, s: K, w: K }, ["p", "s"])
const Row = relation("DocRow", { p: K, w: K }, ["p"])
const Decl = relation("Decl", { p: K, w: K }, ["p"])
const Enc = relation("Enc", { p: K, w: K }, ["p"])
const Sd = relation("Sd", { p: K, w: K }, ["p"])
const Attr = relation("Attr", { p: K, s: K, k: K, w: K }, ["p", "s", "k"])
const Ent = relation("Ent", { p: K, s: K, k: K, o: K, w: K }, ["p", "s", "k", "o"])
const Ns = relation("Ns", { p: K, s: K, k: K, w: K }, ["p", "s", "k"])

/** The schema every query of the properties is over. */
export const Names = schema(
	"Names",
	[P, A1, A2, B1, B2, Doc, Ref, Node, Opt, Row, Decl, Enc, Sd, Attr, Ent, Ns],
	[]
)

/** One rule over `rel`, its parent's key bound at `p`, finding `p` and `w`, an option of the parent. */
const optionOf = (rel: unknown, scope: string, p: unknown): QueryValue =>
	queryOver(Names).rule((r: RuleValue) => {
		const { w } = varsOver(rel, scope)
		return r.match(rel, { p, w }).find({ p, w })
	})

/** The identifier's bytes of a name: its conversion's, the declared-name rule's (core/identity.ts conversionOf). */
export const identifierBytes = (name: string): number => utf8Length(conversionOf(name))

/** A name with its first character upper case, as records capitalize an attachment's name. */
const capitalized = (name: string): string => Str.capitalize(name)

/**
 * `base` followed by as many `y`s as make the identifier of its name, by `named`, take exactly `bytes`: each `y` past a
 * base that ends in a lower case letter adds one byte.
 */
const fitted = (base: string, named: (word: string) => string, bytes: number): string =>
	`${base}${Str.repeat(bytes - identifierBytes(named(base)))("y")}`

/**
 * One cell of the box: the records' stem, the query, the stated names, the path of the relation the cell measures, and
 * its name as records derive it (the README's rule: `${stem}Row`; `${stem}${Name}` for a name the tree holds once;
 * `${parent}${Name}` for a repeated one), whose identifier takes the cell's bytes. A repeated name's other relation, under
 * `tw`, takes a byte less than it under `one` and fits wherever the measured one does, or is one byte past.
 */
export interface NamedCell {
	readonly stem: string
	readonly query: QueryValue
	readonly names: Readonly<Record<string, string>>
	readonly path: ReadonlyArray<string>
	readonly derived: string
}

/** The name a parent states in the cell whose parent's name is stated. */
const statedParent = "Stated"

/** A name stated for a relation whose conversion takes exactly `bytes`: `Sx` and as many `y`s as make it. */
export const statedOfBytes = (bytes: number): string => fitted("Sx", (word) => word, bytes)

/** The cell of a position and a count of bytes (NamedCell). */
export const namedCell = (position: Position, bytes: number): NamedCell => {
	const root = queryOver(Names).rule((r: RuleValue) => {
		const { id, n } = varsOver(P, "p")
		return r.match(P, { id, n }).find({ id, n })
	})
	switch (position) {
		case "root": {
			const stem = fitted("S", (word) => `${word}Row`, bytes)
			return { stem, query: root, names: {}, path: [], derived: `${stem}Row` }
		}
		case "attachment": {
			const name = fitted("xy", (word) => `S${capitalized(word)}`, bytes)
			return {
				stem: "S",
				query: root.attach(name, (p: Vars) => optionOf(A1, "a1", p["id"]), "option"),
				names: {},
				path: [name],
				derived: `S${capitalized(name)}`
			}
		}
		case "repeated":
		case "under a stated parent": {
			const parent = position === "repeated" ? "SOne" : statedParent
			const name = fitted("xy", (word) => `${parent}${capitalized(word)}`, bytes)
			const below = (rel: unknown, scope: string) => (o: Vars) => optionOf(rel, scope, o["p"])
			const query = root
				.attach(
					"one",
					(p: Vars) => optionOf(A1, "a1", p["id"]).attach(name, below(B1, "b1"), "option"),
					"option"
				)
				.attach(
					"tw",
					(p: Vars) => optionOf(A2, "a2", p["id"]).attach(name, below(B2, "b2"), "option"),
					"option"
				)
			return {
				stem: "S",
				query,
				names: position === "repeated" ? {} : { one: statedParent },
				path: ["one", name],
				derived: `${parent}${capitalized(name)}`
			}
		}
	}
}

/** A document's scan below the parent key `p` (documentScanOf's shape, as test/types/schema/budget/records-fragment.ts). */
const scanOf = (p: unknown): QueryValue => {
	const optionAt =
		(rel: unknown, scope: string) =>
		(n: Vars): QueryValue =>
			queryOver(Names).rule((r: RuleValue) => {
				const { w } = varsOver(rel, scope)
				return r.match(rel, { p: n["p"], s: n["s"], w }).find({ w })
			})
	const keyed = (rel: unknown, scope: string) => (o: Vars) =>
		queryOver(Names).rule((r: RuleValue) => {
			const { w } = varsOver(rel, scope)
			return r.match(rel, { p: o["p"], w }).find({ p: o["p"], w })
		})
	const arrayOf =
		(scope: string) =>
		(n: Vars): QueryValue =>
			queryOver(Names)
				.rule((r: RuleValue) => {
					const { k, w } = varsOver(Attr, scope)
					return r.match(Attr, { p: n["p"], s: n["s"], k, w }).find({ p: n["p"], s: n["s"], k, w })
				})
				.attach(
					"entities",
					(a: Vars) =>
						queryOver(Names).rule((r: RuleValue) => {
							const { o, w } = varsOver(Ent, `${scope}Entity`)
							return r.match(Ent, { p: a["p"], s: a["s"], k: a["k"], o, w }).find({ o, w })
						}),
					"array"
				)
	return queryOver(Names)
		.rule((r: RuleValue) => {
			const { s, x } = varsOver(Node, "node")
			return r.match(Node, { p, s, x }).find({ p, s, x })
		})
		.attach("comment", optionAt(Opt, "comment"), "option")
		.attach(
			"documentRow",
			(n: Vars) =>
				keyed(
					Row,
					"documentRow"
				)(n).attach(
					"declaration",
					(d: Vars) =>
						keyed(
							Decl,
							"declaration"
						)(d)
							.attach("encoding", keyed(Enc, "encoding"), "option")
							.attach("standalone", keyed(Sd, "standalone"), "option"),
					"option"
				),
			"option"
		)
		.attach("attributes", arrayOf("attribute"), "array")
		.attach("openAttributes", arrayOf("openAttribute"), "array")
		.attach(
			"namespaces",
			(n: Vars) =>
				queryOver(Names).rule((r: RuleValue) => {
					const { k, w } = varsOver(Ns, "namespace")
					return r.match(Ns, { p: n["p"], s: n["s"], k, w }).find({ k, w })
				}),
			"array"
		)
}

/**
 * An item's documents as metis reads them in one step: the item's document, its scan attached as `item`, and each
 * stimulus it cites attached as `stimuli`, each with its document's scan attached as `document`, so every name of the
 * scan repeats and each is qualified by its parent's.
 */
export const documentsRead: QueryValue = queryOver(Names)
	.rule((r: RuleValue) => {
		const { id, n } = varsOver(Doc, "doc")
		return r.match(Doc, { id, n }).find({ id, n })
	})
	.attach("item", (d: Vars) => scanOf(d["id"]), "array")
	.attach(
		"stimuli",
		(d: Vars) =>
			queryOver(Names)
				.rule((r: RuleValue) => {
					const { k, t } = varsOver(Ref, "ref")
					return r.match(Ref, { p: d["id"], k, t }).find({ p: d["id"], k, t })
				})
				.attach("document", (s: Vars) => scanOf(s["t"]), "array"),
		"array"
	)

/** A stem den derives for a step's read of the documents: the flow's, the step's (`step` letters past its first) and the read's names. */
export const denStem = (step: number): string => `EssayE${Str.repeat(step)("s")}ReadDocuments`

/**
 * The most letters past its first a step's name takes in den's stems the box reads: as many as leave the records'
 * root's conversion, `${stem}Row`'s, within PostgreSQL's identifier, the stems den could write before records' derived
 * names were hashed, every one of whose reads held a derived name past the bound.
 */
export const longestStep: number = maxIdentifierBytes - identifierBytes(`${denStem(0)}Row`)

/** The relations a document read's records hold, by name: a records value's own (its `relations`). */
export const relationNames = (
	relations: ReadonlyArray<{ readonly name: string }>
): ReadonlyArray<string> => Arr.map(relations, (r) => r.name)
