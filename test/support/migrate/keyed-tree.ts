/**
 * A tree re-rooted: the stored tree, keyed by its document and start and rooted at its document (docTreeOf), which a
 * migration suite drafts from nothing and stores before drafting the keyed tree it becomes, rooted at a package and a
 * path, pantry's Node's shape (keyedTreeOf); the stored rows of each document's tree as a direct writer inserts them
 * (storedInsert), and the reviewer's data step that maps each document onto its new root (treeDataStep), placed where
 * the draft's own SET CONSTRAINTS ALL IMMEDIATE says (withDataStep). test/pg/migrate/cutover.test.ts migrates drawn
 * forests and judges every row; test/unit/deploy/backfill.test.ts drafts the keyed tree, whose backfill owes a check of
 * the key its derivations meet rows at; and test/pg/migrate/backfill-cost.test.ts prices its backfill over forests of
 * growing size.
 */
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, String as Str } from "effect"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	onBuilder,
	predBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { type KeyedRow, numbered, treeOfParents } from "#test/support/families/tree.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { type Placeholder, review } from "#test/support/migrate/review.ts"

/** A quoted identifier. */
export const q = quoteIdent

/** The installed column of a declared field, quoted. */
export const column = (field: string): string => q(identifierOf(identity.column(parsedName(field))))

/** Typed SQL literals of a uuid, a text and a bigint, as the drafts name their types. */
export const uuidLiteral = (value: string): string => `${quoteString(value)}::"pg_catalog"."uuid"`
export const textLiteral = (value: string): string => `${quoteString(value)}::"pg_catalog"."text"`
export const int8Literal = (value: string): string => `${value}::"pg_catalog"."int8"`

/** VALUES of rows, each its literals. */
export const valuesOf = (rows: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>): string =>
	`(VALUES ${Arr.join(
		Arr.map(rows, (row) => `(${Arr.join(row, ", ")})`),
		", "
	)})`

/** The statement the draft makes every data step follow (the slot structure.immediate), as it spells it. */
const immediate = "SET CONSTRAINTS ALL IMMEDIATE;"

/** One stored document's tree: its parents as the testing library draws them and each node's kind. */
export interface StoredDocument {
	readonly parents: ReadonlyArray<number>
	readonly kinds: ReadonlyArray<number>
}

/**
 * A tree case: the stored forest, one tree per document, and the new root each document maps onto, which the data step
 * fills: each document its own, or two documents onto one, which no keyed tree holds.
 */
export interface TreeCase {
	readonly documents: Arr.NonEmptyReadonlyArray<StoredDocument>
	readonly roots: Arr.NonEmptyReadonlyArray<number>
}

/** The widths of the keyed tree's root texts, `package` and `path`. */
const rootWidth = 40

/** A root text of the keyed tree, any text up to its width in UTF-8 bytes. */
const rootText = str.bytes(rootWidth, str.regex("^.*$", "su"))

/** A document's stored tree in pre-order (families/tree.ts numbered), under its document's index as its root value. */
const storedRows = (d: number, doc: StoredDocument): ReadonlyArray<KeyedRow> =>
	numbered([{ root: [String(d)], tree: treeOfParents(doc.parents, doc.kinds) }])

/** A new root's package and path, each its texts. */
const packageOf = (root: number): string => `package-${root}`
const pathOf = (root: number): string => `path/${root}.xml`

/** The schema both trees are installed under, by its declared name; and their one table, quoted and qualified. */
const forest = "Forest"
export const nodeTable = (snapshot: DeploySnapshot): string =>
	`${q(snapshot.schema)}.${q(identifierOf(identity.table(parsedName("Node"))))}`

/**
 * The stored tree: Node keyed by its document and start, rooted at `doc`, its parent the parent's start, its count
 * fold over each node's children, and its parent's kind copied along the parent axis, as the keyed tree holds them under
 * its other root.
 */
const docTreeOf = () => {
	const Node = relation(
		"Node",
		{
			doc: natural,
			parent: drawnField(natural),
			at: drawnField(natural),
			children: drawnField(natural),
			start: drawnField(natural),
			end: drawnField(natural),
			kind: pg.integer,
			parentKind: accumulated(pg.integer, 0),
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n),
			total: accumulated(natural, 0n)
		},
		["doc", "start"],
		[]
	)
	const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: ["doc"]
	})
	return schema(
		forest,
		[Node],
		[
			nodes,
			foldBuilder(
				nodes,
				monoids.count,
				onBuilder(Node, ["doc", "parent", "before", "after"]),
				onBuilder(Node, ["doc", "start", "total"])
			),
			containedBuilder(
				onBuilder(
					select(Node, (n) => n.gt(n.start, 0n)),
					["doc", "parent", "parentKind"]
				),
				onBuilder(Node, ["doc", "start", "kind"])
			)
		]
	)
}

/**
 * The stored tree's installation as its first migration reaches it: that migration's snapshot and folder, and the one
 * law column of its table a writer fills, the parent's count its family copies (‹n›), every other one generated.
 */
export interface DocTree {
	readonly snapshot: DeploySnapshot
	readonly folder: FolderTexts
	readonly copy: string
}

/** The law columns of `snapshot`'s installation that PostgreSQL does not generate, by their names. */
const filledLawColumns = (snapshot: DeploySnapshot): ReadonlyArray<string> =>
	Arr.flatMap(snapshot.manifest.objects, (o) =>
		o.kind === "lawColumn"
			? Arr.flatMap(o.ddl, (statement) =>
					statement.kind === "alterTable"
						? Arr.flatMap(statement.actions, (a) =>
								a.kind === "addColumn" && a.column.generated === undefined ? [a.column.name] : []
							)
						: []
				)
			: []
	)

/** The stored tree drafted from nothing, as `grizzle generate` drafts a first migration, and its folder as written. */
export const docTree = (): DocTree => {
	const g = succeeded(
		generate({
			previous: fromEmpty,
			installation: compile(docTreeOf(), asDrafted),
			name: "first",
			timestamp: draftedAt(0),
			workload: noWorkload,
			declared: noDeclarations
		}),
		"the stored tree drafts from nothing"
	)
	const [copy, ...more] = filledLawColumns(g.snapshot)
	assert.ok(more.length === 0, "the stored tree's one filled law column, its parent's count")
	return {
		snapshot: g.snapshot,
		copy: defined(copy, "the stored tree's copy of its parent's count"),
		folder: {
			name: g.folder.name,
			metaText: g.folder.metaText,
			files: review(g, { losses: "written", value: treePlaceholder }).files
		}
	}
}

/**
 * The stored tree's rows as a direct writer inserts them at SERIALIZABLE, every drawn value stated as its laws fix it:
 * a root its own parent at slot 0, the parent's kind (a root's own 0), the count fold over each node's children:
 * `before` its slot, `after` one more, `total` its count, and ‹n›, the parent's count (a root's own).
 */
export const storedInsert = (tree: DocTree, c: TreeCase): string => {
	const fields = [
		"doc",
		"parent",
		"at",
		"children",
		"start",
		"end",
		"kind",
		"parentKind",
		"before",
		"after",
		"total"
	]
	const rows = Arr.flatMap(c.documents, (doc, d) =>
		Arr.map(storedRows(d, doc), (row) =>
			Arr.join(
				[
					int8Literal(String(d)),
					int8Literal(String(row.parent)),
					int8Literal(String(row.at)),
					int8Literal(String(row.children)),
					int8Literal(String(row.start)),
					int8Literal(String(row.end)),
					`${row.kind}::"pg_catalog"."int4"`,
					`${row.parentKind}::"pg_catalog"."int4"`,
					int8Literal(String(row.at)),
					int8Literal(String(row.at + 1)),
					int8Literal(String(row.children)),
					int8Literal(String(row.copy))
				],
				", "
			)
		)
	)
	return `INSERT INTO ${nodeTable(tree.snapshot)} (${Arr.join(
		[...Arr.map(fields, column), q(tree.copy)],
		", "
	)}) VALUES ${Arr.join(
		Arr.map(rows, (row) => `(${row})`),
		", "
	)}`
}

/**
 * The keyed tree the stored one becomes: rooted at (package, path), keyed by them and its start, its count fold kept,
 * and pantry's Node's shape over its parent copies: its parent's kind copied along the parent axis, as the stored tree
 * copied it, now under the keyed tree's root, so the migration draws it anew, and its grandparent's
 * kind, the parent's own copy, both the root's own; and a count fold over each node's children whose selection reads
 * both copies, the children whose parent's kind is not their grandparent's (`turns`, its planes named), which the
 * migration draws after the copies it reads. And pantry's Instance's shape (tests.ts, `children` held to its
 * TestDocument's `sites`): a second family over Node, counted by the node each names as its `anchor` (`uses`), whose
 * owner axis carries the tree's own count, `children`, from the anchor's `sites`, so one migration draws `children` as
 * the tree's count beside that family's axis.
 */
export const keyedTreeOf = () => {
	const Node = relation(
		"Node",
		{
			package: rootText,
			path: rootText,
			parent: drawnField(natural),
			at: drawnField(natural),
			children: drawnField(natural),
			start: drawnField(natural),
			end: drawnField(natural),
			kind: pg.integer,
			parentKind: accumulated(pg.integer, 0),
			parentParentKind: accumulated(pg.integer, 0),
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n),
			total: accumulated(natural, 0n),
			turnsBefore: accumulated(natural, 0n),
			turnsAfter: accumulated(natural, 0n),
			turns: accumulated(natural, 0n),
			anchor: natural,
			sites: natural,
			uses: drawnField(natural),
			was: accumulated(pg.integer, 0)
		},
		["package", "path", "start"],
		[]
	)
	const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: ["package", "path"]
	})
	return schema(
		forest,
		[Node],
		[
			nodes,
			foldBuilder(
				nodes,
				monoids.count,
				onBuilder(Node, ["package", "path", "parent", "before", "after"]),
				onBuilder(Node, ["package", "path", "start", "total"])
			),
			containedBuilder(
				onBuilder(
					select(Node, (n) => n.gt(n.start, 0n)),
					["package", "path", "parent", "parentKind", "parentParentKind"]
				),
				onBuilder(Node, ["package", "path", "start", "kind", "parentKind"])
			),
			foldBuilder(
				nodes,
				monoids.count,
				onBuilder(
					select(Node, (n) => n.and([n.gt(n.start, 0n), n.ne(n.parentKind, n.parentParentKind)])),
					["package", "path", "parent", "turnsBefore", "turnsAfter"]
				),
				onBuilder(Node, ["package", "path", "start", "turns"])
			),
			containedBuilder(
				onBuilder(
					select(Node, (n) => n.gt(n.start, 0n)),
					["package", "path", "parent", predBuilder("at"), "was"]
				),
				onBuilder(
					select(Node, (n) => n.gt(n.start, 0n)),
					["package", "path", "parent", "at", "kind"]
				)
			),
			countedBuilder(onBuilder(Node, ["package", "path", "anchor"]), finBuilder(Node, "uses")),
			containedBuilder(
				onBuilder(Node, ["package", "path", "anchor", "children"]),
				onBuilder(Node, ["package", "path", "start", "sites"])
			)
		]
	)
}

/** The keyed tree's visible fields, in the order the model states them. */
export const keyedFields = [
	"package",
	"path",
	"start",
	"parent",
	"at",
	"children",
	"end",
	"kind",
	"parentKind",
	"parentParentKind",
	"before",
	"after",
	"total",
	"turnsBefore",
	"turnsAfter",
	"turns",
	"anchor",
	"sites",
	"uses",
	"was"
] as const

/**
 * The anchor family of one document's rows: each row's anchor, the start of the first row in pre-order whose count is
 * its own, so its `sites` (each row's own count) is the row's count, and each row's `uses`, the rows anchored at it.
 */
const anchorsOf = (rows: ReadonlyArray<KeyedRow>) => {
	const anchor = (row: KeyedRow): number =>
		defined(
			Option.getOrUndefined(Arr.findFirst(rows, (r) => r.children === row.children)),
			`a row of ${row.children} children`
		).start
	return {
		anchor,
		uses: (row: KeyedRow): number => Arr.filter(rows, (r) => anchor(r) === row.start).length
	}
}

/** The value each placeholder of the keyed tree's new caller fields takes until the data step writes it: the empty text
 * of a root text, 0 of the naturals `anchor` and `sites`. */
export const treePlaceholder = (p: Placeholder): string =>
	Arr.some(
		["anchor", "sites"],
		(f) => p.column.name === identifierOf(identity.column(parsedName(f)))
	)
		? "0"
		: "''"

/** The data step of the tree's migration: each node's new root from its document, by the case's map, and each node's
 * anchor and sites (anchorsOf). */
export const treeDataStep = (tree: DocTree, c: TreeCase): ReadonlyArray<string> => {
	const table = nodeTable(tree.snapshot)
	const rows = Arr.map(c.documents, (_, d) => {
		const root = defined(c.roots[d], "a document's new root")
		return [int8Literal(String(d)), textLiteral(packageOf(root)), textLiteral(pathOf(root))]
	})
	const nodes = Arr.flatMap(c.documents, (doc, d) => {
		const stored = storedRows(d, doc)
		const { anchor } = anchorsOf(stored)
		return Arr.map(stored, (row) => [
			int8Literal(String(d)),
			int8Literal(String(row.start)),
			int8Literal(String(anchor(row))),
			int8Literal(String(row.children))
		])
	})
	return [
		`UPDATE ${table} AS "t" SET ${column("package")} = "m"."k0", ${column("path")} = "m"."k1" FROM ${valuesOf(
			nonEmpty(rows, "the documents' roots")
		)} AS "m" ("doc", "k0", "k1") WHERE "t".${column("doc")} = "m"."doc";`,
		`UPDATE ${table} AS "t" SET ${column("anchor")} = "m"."a", ${column("sites")} = "m"."s" FROM ${valuesOf(
			nonEmpty(nodes, "the documents' nodes")
		)} AS "m" ("doc", "start", "a", "s") WHERE "t".${column("doc")} = "m"."doc" AND "t".${column("start")} = "m"."start";`
	]
}

/**
 * A drafted folder with the data step where the placeholder marker says it goes: right after the draft's own
 * `SET CONSTRAINTS ALL IMMEDIATE;`, which follows every table's alteration and every new column's DROP DEFAULT and comes
 * before every set-aside column's fill, the backfill and the constraints that read what the data step writes. A data
 * step the draft gives no such place to is a failure of the property.
 */
export const withDataStep = (g: GenerateResult, step: ReadonlyArray<string>): GenerateResult => {
	if (step.length === 0) {
		return g
	}
	const at = (text: string): Option.Option<number> =>
		Arr.findFirstIndex(Str.split(text, "\n"), (l) => Str.trim(l) === immediate)
	assert.ok(
		Arr.some(g.folder.files, (f) => Option.isSome(at(joined(f.text)))),
		`the draft ${g.folder.name} drafts no ${immediate} for its data step to follow`
	)
	const files = Arr.map(g.folder.files, (f) =>
		Option.match(at(joined(f.text)), {
			onNone: () => f,
			onSome: (end) => {
				const lines = Str.split(joined(f.text), "\n")
				return {
					...f,
					text: chunked(
						Arr.join([...lines.slice(0, end + 1), "", ...step, ...lines.slice(end + 1)], "\n")
					)
				}
			}
		})
	)
	return { ...g, folder: { ...g.folder, files } }
}

/**
 * The copies and the turns fold of one document's rows, read off the direct pre-order numbering alone: each row's
 * grandparent's kind its parent's own parentKind (a root's own), whether the turns fold selects it (a member whose
 * parent's kind is not its grandparent's), and its planes, the selected siblings before it and through it in slot
 * order, the root alone at slot 0, its end its selected children.
 */
const turnsOf = (rows: ReadonlyArray<KeyedRow>) => {
	const parentOf = (row: KeyedRow): KeyedRow =>
		defined(
			Option.getOrUndefined(Arr.findFirst(rows, (r) => r.start === row.parent)),
			`the parent of the node at ${row.start}`
		)
	const parentParentKind = (row: KeyedRow): number => parentOf(row).parentKind
	const selected = (row: KeyedRow): boolean =>
		row.start > 0 && row.parentKind !== parentParentKind(row)
	const siblings = (row: KeyedRow): ReadonlyArray<KeyedRow> =>
		row.start === 0 ? [row] : Arr.filter(rows, (r) => r.start > 0 && r.parent === row.parent)
	const selectedThrough = (row: KeyedRow, through: boolean): number =>
		Arr.filter(siblings(row), (r) => selected(r) && (through ? r.at <= row.at : r.at < row.at))
			.length
	return {
		parentParentKind,
		selected,
		before: (row: KeyedRow): number => selectedThrough(row, false),
		after: (row: KeyedRow): number => selectedThrough(row, true),
		end: (row: KeyedRow): number =>
			Arr.filter(rows, (r) => r.start > 0 && r.parent === row.start && selected(r)).length
	}
}

/** A row's copy of the kind of the sibling before it along the tree's predecessor axis: a member past slot 0 holds
 * its predecessor's kind, and a member at slot 0 and the root, which is no member, hold the base, 0. */
const wasOf = (rows: ReadonlyArray<KeyedRow>, row: KeyedRow): number =>
	row.start > 0 && row.at > 0
		? defined(
				Option.getOrUndefined(
					Arr.findFirst(rows, (r) => r.start > 0 && r.parent === row.parent && r.at === row.at - 1)
				),
				`the sibling before the node at ${row.start}`
			).kind
		: 0

/** The model's rows of the keyed tree: each stored row under its document's new root, its parent the stored parent's
 * start, every slot, count, interval, kind and count fold value as the stored tree held it, its copies and turns fold as the
 * direct numbering states them (turnsOf), and its anchor, its sites (its own count) and its uses (anchorsOf). */
export const keyedRows = (c: TreeCase): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.flatMap(c.documents, (doc, d) => {
		const root = defined(c.roots[d], "a document's new root")
		const rows = storedRows(d, doc)
		const turns = turnsOf(rows)
		const anchors = anchorsOf(rows)
		return Arr.map(rows, (row) =>
			Arr.map(
				[
					packageOf(root),
					pathOf(root),
					row.start,
					row.parent,
					row.at,
					row.children,
					row.end,
					row.kind,
					row.parentKind,
					turns.parentParentKind(row),
					row.at,
					row.at + 1,
					row.children,
					turns.before(row),
					turns.after(row),
					turns.end(row),
					anchors.anchor(row),
					row.children,
					anchors.uses(row),
					wasOf(rows, row)
				],
				String
			)
		)
	})
