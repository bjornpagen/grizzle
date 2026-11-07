/**
 * A containment whose source holds constants and reads a field twice, through grizzle's lowering on PostgreSQL 19rc1: a
 * document row states its node's context, the node being of kind `document`, its own document and at depth 0, as
 * `contained(on(Document, "node", constant("document"), "node", constant(0n)), on(Node, "id", "kind", "document",
 * "depth"))`. Each constant is a STORED generated column of Document holding it, and the foreign key lists `node`
 * twice, so the reference lands on the UNIQUE over Node's terms and adds no column to Node.
 *
 * - **The specification turned into a checker:** the containment's meaning, a constant selecting the node rows that
 *   hold it at the field it meets and a field read twice meeting both its target fields: a state commits exactly when
 *   every document row's node is a node of kind `document` whose document is itself and whose depth is 0. A refusal
 *   must be 23503 by Document's foreign key, reporting the containment's law.
 *
 * The box: nodes 0 and 1, each absent or of a kind, a document and a depth, and every subset of document rows over
 * them, nodes written first, in one transaction.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { codeOf } from "#compiler/ir/codes.ts"
import { closedId, natural, pg } from "#compiler/public/fields.ts"
import { closed, constant, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const NodeKind = closed("NodeKind", ["document", "element"])
const Node = relation(
	"Node",
	{ id: pg.int4, kind: closedId(NodeKind), document: pg.int4, depth: natural },
	["id"]
)
const Document = relation("Document", { node: pg.int4 }, ["node"])

const SourceTerms = schema("source_terms", { NodeKind, Node, Document }, [
	contained(
		on(Document, "node", constant("document"), "node", constant(0n)),
		on(Node, "id", "kind", "document", "depth")
	)
])

const RELATIONS = ["Node", "Document"] as const

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

type Kind = "document" | "element"

/** A node row of the box: its kind, its document and its depth. */
interface NodeRow {
	readonly kind: Kind
	readonly document: number
	readonly depth: number
}

/** A case: nodes 0 and 1 each absent or a row, and the document rows among their ids. */
interface Sketch {
	readonly nodes: ReadonlyArray<NodeRow | undefined>
	readonly documents: ReadonlyArray<number>
}

const IDS = [0, 1] as const

const SUBSETS: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [0], [1], [0, 1]]

const nodeGen: Gen<NodeRow | undefined> = (source) =>
	source.draw(element([false, true]))
		? {
				kind: source.draw(element<Kind>(["document", "element"])),
				document: source.draw(element([0, 1])),
				depth: source.draw(element([0, 1]))
			}
		: undefined

const sketchGen: Gen<Sketch> = (source) => ({
	nodes: Arr.map(IDS, () => source.draw(nodeGen)),
	documents: source.draw(element(SUBSETS))
})

/** What keeps a document row's node from meeting it: no node, or a node off one of the three terms it meets. */
type Missed = "no node" | "a node of another kind" | "a node of another document" | "a node deeper"

/** Why the document row `id` meets no node, by the containment's meaning; none where it meets its node. */
const missedOf = (s: Sketch, id: number): ReadonlyArray<Missed> => {
	const node = s.nodes[id]
	if (node === undefined) {
		return ["no node"]
	}
	return [
		...(node.kind === "document" ? [] : ["a node of another kind" as const]),
		...(node.document === id ? [] : ["a node of another document" as const]),
		...(node.depth === 0 ? [] : ["a node deeper" as const])
	]
}

type SourceTermsFeature = "committed" | "committed a document" | `refused for ${Missed}`

layer(Substrate.layer)(
	"a containment from constants and a field read twice on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"commit exactly the states whose every document row's node is of kind document, its own document and at depth 0, refusing the rest by the document's foreign key",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seat = yield* seatOf(SourceTerms, RELATIONS, "source_terms")
						const codec = Arr.findFirst(
							[...seat.installed.names.codes.rosters.values()],
							(r) => r.roster === NodeKind.name
						)
						const code = (k: Kind) => codeOf(Option.getOrThrow(codec), k)
						const laws = seat.lawsOf("containment")
						return yield* exhaust(
							{
								suite: "laws/source-terms",
								generator: sketchGen,
								literal: Formatter.format,
								limit: (1 + 2 * 2 * 2) ** IDS.length * SUBSETS.length,
								box: "nodes 0 and 1, each absent or of kind document or element, of document 0 or 1 and at depth 0 or 1, and every subset of document rows over them, nodes written first",
								oracle: {
									kind: "specification",
									name: "the containment's meaning as a checker: every document row's node of kind document, its own document, at depth 0"
								},
								coverage: requiredInSpace<SourceTermsFeature>([
									"committed",
									"committed a document",
									"refused for no node",
									"refused for a node of another kind",
									"refused for a node of another document",
									"refused for a node deeper"
								]),
								caseHang
							},
							(s, c) =>
								Effect.gen(function* () {
									const col = (r: string, f: string) => seat.column(r, f)
									const nodes = Arr.flatMap(s.nodes, (n, id) =>
										n === undefined ? [] : [`(${id}, ${code(n.kind)}, ${n.document}, ${n.depth})`]
									)
									const statements = [
										...(nodes.length === 0
											? []
											: [
													`INSERT INTO ${seat.table("Node")} (${col("Node", "id")}, ${col("Node", "kind")}, ${col("Node", "document")}, ${col("Node", "depth")}) VALUES ${Arr.join(nodes, ", ")}`
												]),
										...(s.documents.length === 0
											? []
											: [
													`INSERT INTO ${seat.table("Document")} (${col("Document", "node")}) VALUES ${Arr.join(
														Arr.map(s.documents, (id) => `(${id})`),
														", "
													)}`
												])
									]
									const real = yield* attempt(seat.session, statements)
									yield* seat.session.resetStatements
									const missed = Arr.flatMap(s.documents, (id) => missedOf(s, id))
									if (real.kind === "committed") {
										yield* cleared(seat, RELATIONS)
										if (missed.length > 0) {
											return yield* new Disagreed({
												message: `committed a state whose document rows meet no node (${Arr.join(missed, ", ")}): ${Formatter.format(s)}`
											})
										}
										c.note(s.documents.length > 0 ? "committed a document" : "committed")
										return
									}
									const named = seat.refusedBy(real.fields)
									if (
										real.fields.code !== "23503" ||
										missed.length === 0 ||
										!Option.exists(
											named,
											(k) =>
												k.kind === "foreign" &&
												k.relation === "Document" &&
												Option.exists(k.law, (l) => laws.includes(l))
										)
									) {
										return yield* new Disagreed({
											message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the state's document rows miss ${Formatter.format(missed)}: ${Formatter.format(s)}`
										})
									}
									for (const m of Arr.dedupe(missed)) {
										c.note(`refused for ${m}`)
									}
								})
						)
					})
				)
		)
	}
)
