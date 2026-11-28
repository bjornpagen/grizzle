import { Array as Arr, Result, String as Str } from "effect"
import { identifiers } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The parameter program: a child query a function builds, its parent's field taken as an input term,
 * `Term<IdDomain, unknown, InputOrigin, "uuid", IdValue>`, against the same child written inline over the parent's own variable. The
 * box is every schema of the probe and every delivery: Nodes of a Doc, each with Comments keyed by their node, where
 * the comments lie within the nodes (at most one per node) or every node has one (exactly one); and each delivery the
 * child's comment is attached by, array, option and one.
 *
 * The oracle is the inline child: the function's child proves a delivery exactly where the inline one does, raising the
 * same refusal where it does not (one twin label for both), and an app that attaches the function's query to its
 * parent's field has the head of the app that writes it inline. The inline verdicts are the evidence's: an array always,
 * an option over a key the parent fixes, and the one child where the schema also proves existence (Node.id within
 * Comment.node). A function generic over its parent's field, `<D extends Meets<IdDomain, "uuid">>`, defers the equality's
 * evidence until the call and proves neither option nor one: a known limit of the types, which this program does not
 * state.
 *
 * Beside the box, for each schema, the comment as a child a function builds over the node's id, taken as an input term
 * that an equality fixes the comment's key to (keyedBlock), attached as an option and as the one child, against the
 * same child inline over an equality with the node's own variable. The equality fixes the key in both, so both prove
 * the option, and those two apps have one head; neither proves the one child, refused by its Refusal in both schemas,
 * since existence is read only off the comment matched on the parent's own variable, as the box's comments are, which
 * prove it where the schema does (README, "grizzle knows each result's keys"). Only there does a delivery rest on the
 * equality with the input term itself.
 *
 * Each schema and delivery is a cell of the box, and so is each schema's keyed comment; the relations and the schemas
 * are the batch's own.
 */

/** A schema of the box: how the comments relate to the nodes. */
const schemas = [
	{ name: "atMostOne", label: "at-most-one", existence: false },
	{ name: "exactlyOne", label: "exactly-one", existence: true }
] as const

type Box = (typeof schemas)[number]

const deliveries = ["array", "option", "one"] as const

type Delivery = (typeof deliveries)[number]

/** The evidence's verdict on a delivery of the comment, in a schema of the box. */
const proved = (box: Box, delivery: Delivery): boolean =>
	delivery === "one" ? box.existence : true

const schemaBlock = (
	box: Box
): string => `export const ${box.name} = schema("Scan", [Doc, Node, Comment], [
	contained(on(Node, "document"), on(Doc, "id")),
	${box.existence ? 'contained(on(Node, "id"), on(Comment, "node"))' : 'contained(on(Comment, "node"), on(Node, "id"))'}
])
`

/** The comment's attachment, on one line, under its twin's directive where the evidence does not prove it. */
const comment = (box: Box, delivery: Delivery, parent: string): ReadonlyArray<string> => [
	...(proved(box, delivery)
		? []
		: [
				`\t\t// @ts-expect-error -- twin ${box.label}-${delivery}: a delivery the evidence does not prove`
			]),
	`\t\t.attach("comment", (node) => query(${box.name}).rule((r) => { const { value } = v(Comment, "comment"); return r.match(Comment, { node: ${parent}, value }).find({ value }) }), "${delivery}")`
]

/** The nodes of one document, its id taken from `document`. */
const nodesOf = (box: Box, document: string): string => `query(${box.name})
		.rule((r) => {
			const { id, document: d } = v(Node, "node")
			return r.match(Node, { id, document: d }).where(r.eq(d, ${document})).find({ id })
		})`

/** The documents, each with what `nodes` attaches to it. */
const appOf = (box: Box, nodes: string): string => `query(${box.name})
	.rule((r) => {
		const { id } = v(Doc, "doc")
		return r.match(Doc, { id }).find({ id })
	})
	.attach("nodes", (doc) => ${nodes}, "array")`

const cellBlock = (box: Box, delivery: Delivery): ReadonlyArray<string> => {
	const cell = `${box.name}_${delivery}`
	return [
		`/** ${box.name}, the comment delivered as ${delivery}: by a function, and inline. */`,
		`export const scan_${cell} = (document: Term<IdDomain, unknown, InputOrigin, "uuid", IdValue>) =>`,
		`\t${nodesOf(box, "document")}`,
		...comment(box, delivery, "node.id"),
		`export const builder_${cell} = ${appOf(box, `scan_${cell}(doc.id)`)}`,
		`export const inline_${cell} = query(${box.name})`,
		"\t.rule((r) => {",
		'\t\tconst { id } = v(Doc, "doc")',
		"\t\treturn r.match(Doc, { id }).find({ id })",
		"\t})",
		`\t.attach("nodes", (doc) =>`,
		`\t\t${nodesOf(box, "doc.id")}`,
		...comment(box, delivery, "node.id"),
		`\t, "array")`,
		...(proved(box, delivery)
			? [
					`export type Same_${cell} = Expect<Equals<HeadOf<typeof builder_${cell}>, HeadOf<typeof inline_${cell}>>>`
				]
			: []),
		""
	]
}

/**
 * The comment by an equality with the node's id, attached as an option and as the one child: built by a function that
 * takes the id as an input term, and inline over the node's own variable. The one child stands under its Refusal.
 */
/** The Refusal of the one child where the evidence proves no comment exists for each node. */
const oneRefused = "the one child needs a child the evidence proves exactly one per parent"

const keyedBlock = (box: Box): ReadonlyArray<string> => {
	const child = (node: string): string =>
		`query(${box.name}).rule((r) => { const { node: n, value } = v(Comment, "comment"); return r.match(Comment, { node: n, value }).where(r.eq(n, ${node})).find({ value }) })`
	const nodes = `query(${box.name}).rule((r) => { const { id, document: d } = v(Node, "node"); return r.match(Node, { id, document: d }).find({ id }) })`
	return [
		`/** ${box.name}, the comment by an equality with the node's id: by a function, and inline. */`,
		`export const comment_${box.name} = (node: Term<IdDomain, unknown, InputOrigin, "uuid", IdValue>) => ${child("node")}`,
		`export const keyed_${box.name} = ${nodes}.attach("comment", (node) => comment_${box.name}(node.id), "option")`,
		`export const keyedInline_${box.name} = ${nodes}.attach("comment", (node) => ${child("node.id")}, "option")`,
		`export type SameKeyed_${box.name} = Expect<Equals<HeadOf<typeof keyed_${box.name}>, HeadOf<typeof keyedInline_${box.name}>>>`,
		`// @ts-expect-error -- refusal: ${oneRefused}`,
		`export const keyedOne_${box.name} = ${nodes}.attach("comment", (node) => comment_${box.name}(node.id), "one")`,
		`// @ts-expect-error -- refusal: ${oneRefused}`,
		`export const keyedInlineOne_${box.name} = ${nodes}.attach("comment", (node) => ${child("node.id")}, "one")`,
		""
	]
}

/** A cell of the box: a schema's comment delivered as one delivery, or the schema's keyed comment. */
type ParameterCell =
	| Readonly<{ kind: "delivery"; box: Box; delivery: Delivery }>
	| Readonly<{ kind: "keyed"; box: Box }>

/** The cells of parameterBox, minted as a dictionary in its door (test/types/evidence/parameter.dictionary.ts). */
export const parameterBoxItems: Arr.NonEmptyReadonlyArray<ParameterCell> = Arr.appendAll(
	Arr.flatMap(schemas, (box) =>
		Arr.map(deliveries, (delivery): ParameterCell => ({ kind: "delivery", box, delivery }))
	),
	Arr.map(schemas, (box): ParameterCell => ({ kind: "keyed", box }))
)

/** The package's public names the program may read, each a value or a type. */
const publicNames: ReadonlyArray<readonly [string, "value" | "type"]> = [
	["contained", "value"],
	["contract", "value"],
	["DomainOf", "type"],
	["HeadOf", "type"],
	["Infer", "type"],
	["InputOrigin", "type"],
	["on", "value"],
	["pg", "value"],
	["query", "value"],
	["relation", "value"],
	["schema", "value"],
	["Term", "type"],
	["uuid", "value"],
	["v", "value"]
]

/** The relations and schemas every cell reads, the batch's own. */
const parameterHeader: ReadonlyArray<string> = [
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	"",
	'export const idKey = Symbol("Id")',
	'export const Id = domain<typeof idKey>()("Id", uuid)',
	"export type IdDomain = DomainOf<typeof Id>",
	"export type IdValue = Infer<typeof Id>",
	'export const Doc = relation("Doc", { id: Id }, ["id"])',
	'export const Node = relation("Node", { id: Id, document: Id }, ["id"])',
	'export const Comment = relation("Comment", { node: Id, value: int8 }, ["node"])',
	...Arr.flatMap(schemas, (box) => Str.split(schemaBlock(box), "\n")),
	""
]

/**
 * The program over a batch's cells, every name read from the package's public entry, as a reader imports it: the import
 * names those the program reads.
 */
export const parameterProgram = (cells: Arr.NonEmptyReadonlyArray<ParameterCell>): Program => {
	const parts = [
		{ owner: batchOwned, lines: parameterHeader },
		...Arr.map(cells, (cell, at) => ({
			owner: caseOwned(at),
			lines: Arr.flatMap(
				cell.kind === "delivery" ? cellBlock(cell.box, cell.delivery) : keyedBlock(cell.box),
				(line) => Str.split(line, "\n")
			)
		}))
	]
	const read = identifiers(
		Arr.join(
			Arr.flatMap(parts, (part) => part.lines),
			"\n"
		)
	)
	const imported = Arr.filterMap(publicNames, ([name, kind]) =>
		read.has(name) ? Result.succeed(kind === "type" ? `type ${name}` : name) : Result.failVoid
	)
	return [
		{
			file: "index.ts",
			parts: [
				{
					owner: batchOwned,
					lines: [
						"// Generated by test/types/evidence/parameter.ts: a child query a function builds over its parent's field, against the same child inline.",
						`import { ${Arr.join(imported, ", ")} } from "@bjornpagen/grizzle"`,
						""
					]
				},
				...parts
			]
		}
	]
}
