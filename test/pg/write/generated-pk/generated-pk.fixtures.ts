/** What the property of generated-pk.test.ts reads: its schema and template, its space, and its host model. */

import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec, String as Str } from "effect"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto, Text } from "#compiler/public/compute.ts"
import { accumulated, drawn, generated, natural, pg, sha256 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	fin,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** A package's name, as pantry's PackageName is, bounded so a key holds it as itself. */
const Package = str.bytes(64, str.regex("^[A-Za-z_][A-Za-z0-9_.-]*$"))

/** A package entry's path, as pantry's EntryPath is: no leading slash, any length, so no key holds it as itself. */
const Path = str.regex("^[^/].*$", "su")

/** Any text, as pantry's anyText is. */
const AnyText = str.regex("^.*$", "su")

/**
 * A stimulus ref, keyed by its element (pantry's StimulusRef, qti/tests.ts): its document's package and path and the
 * element's start, its path read through its digest, a key generation (INTERFACE.md of lane GENPK §1), so a path past
 * PostgreSQL's B-tree entry limit keys it. Mutable, as every relation a stratum puts or deletes is.
 */
export const StimulusRef = relation.generated(
	"StimulusRef",
	{ identifier: AnyText, package: Package, path: Path, start: natural },
	["package", "pathDigest", "start"],
	(r) => ({ pathDigest: generated(sha256, Crypto.sha256(r.path)) })
)

/**
 * StimulusRef's shape over a generation many paths share: the digest of the path with its ASCII letters lowered, so
 * `A/x` and `a/x` meet at one key, where their texts differ (GENPK-B's non-injective box): key equality is not the
 * texts' equality. Mutable, so a put replaces a stored ref's path in place.
 */
export const FoldedRef = relation.generated(
	"FoldedRef",
	{ identifier: AnyText, package: Package, path: Path, start: natural },
	["package", "foldDigest", "start"],
	(r) => ({ foldDigest: generated(sha256, Crypto.sha256(Text.lowerAscii(r.path))) })
)

/**
 * A document of a package, keyed by its package and its path's digest, owning two ordered families: its lines, each
 * stating its path flat as the importer does, its digest its own key generation over it (form (a), INTERFACE.md §3),
 * and its notes, which state no path and hold the document's digest as the fill copies it (form (b)). Mutable: a put
 * of its title cascades the copy each line and note carries of it.
 */
export const Doc = relation.generated(
	"Doc",
	{ package: Package, path: Path, title: pg.integer, lines: drawn(natural), notes: drawn(natural) },
	["package", "pathDigest"],
	(r) => ({ pathDigest: generated(sha256, Crypto.sha256(r.path)) })
)

/** A line of a document: form (a), its digest its own generation over the path it states. */
export const Line = relation.generated(
	"Line",
	{
		package: Package,
		path: Path,
		at: drawn(natural),
		word: pg.integer,
		docTitle: accumulated(pg.integer, 0)
	},
	["package", "pathDigest", "at"],
	(r) => ({ pathDigest: generated(sha256, Crypto.sha256(r.path)) })
)

/** A note of a document: form (b), the document's digest copied as stored, no path of its own. */
const Note = relation(
	"Note",
	{
		package: Package,
		pathDigest: sha256,
		at: drawn(natural),
		word: pg.integer,
		docTitle: accumulated(pg.integer, 0)
	},
	["package", "pathDigest", "at"]
)

/**
 * A node of a document's tree, as pantry's Node is: keyed by its root fields, its package and its path's digest, and
 * its start, every member stating its path as the root does (INTERFACE.md §3, a self-family is form (a)).
 */
export const TreeNode = relation.generated(
	"TreeNode",
	{
		package: Package,
		path: Path,
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		label: pg.integer
	},
	["package", "pathDigest", "start"],
	(r) => ({ pathDigest: generated(sha256, Crypto.sha256(r.path)) })
)

/** A ledger variable's name, as edullm's ledger states it: bounded, so a key holds it as itself. */
const Variable = str.bytes(64, str.regex("^[A-Za-z_][A-Za-z0-9_.-]*$"))

/**
 * A set-like ledger relation, as edullm's TestOutcomeMultipleString, ItemSessionValueMultipleString and
 * SnapshotMultipleString are (GENPK-A, main's requirement): a child's values of a variable, several at once, each
 * keyed by its value's digest, so a value past the B-tree entry limit is a member; keyed by (child, variable,
 * valueDigest). `weight` is beside the value, so a described put of the relation's own facts changes a row it proves
 * stored (the ledger's relations hold the value alone beyond their key, whose put of its own facts changes nothing).
 */
export const SetString = relation.generated(
	"SetString",
	{ child: pg.integer, variable: Variable, value: AnyText, weight: pg.integer },
	["child", "variable", "valueDigest"],
	(r) => ({ valueDigest: generated(sha256, Crypto.sha256(r.value)) })
)

export const docLines = ordered(on(Line, "package", "pathDigest", "at"), fin(Doc, "lines"))
const docNotes = ordered(on(Note, "package", "pathDigest", "at"), fin(Doc, "notes"))
const lineTitle = contained(
	on(Line, "package", "pathDigest", "docTitle"),
	on(Doc, "package", "pathDigest", "title")
)
const noteTitle = contained(
	on(Note, "package", "pathDigest", "docTitle"),
	on(Doc, "package", "pathDigest", "title")
)
export const nodes = tree(on(TreeNode, "parent", "at"), fin(TreeNode, "children"), {
	root: ["package", "pathDigest"]
})

export const GeneratedKeys = schema(
	"GeneratedKeys",
	[StimulusRef, FoldedRef, Doc, Line, Note, TreeNode, SetString],
	[
		docLines,
		docNotes,
		lineTitle,
		noteTitle,
		nodes,
		mutable(StimulusRef),
		mutable(FoldedRef),
		mutable(Doc),
		mutable(Line),
		mutable(Note),
		mutable(TreeNode),
		mutable(SetString),
		unit("Bundle", { package: Package }),
		unit("Learner", { child: pg.integer })
	]
)

/** The flat relations a stratum writes by insert, put and delete. */
export const flatRelations = ["StimulusRef", "FoldedRef"] as const

export type FlatName = (typeof flatRelations)[number]

/**
 * The full world's workload: the stored state's insert; one stratum's every write, an insert, a put and a delete of
 * each flat relation, an insert and a delete of documents, and an insert and a delete of trees, each call's facts; a
 * put of documents, a stratum of its own, since a delete of an owner removes every row nested under it, which no put of
 * its stratum may write; a stratum of the flat relations' inserts and puts alone, whose puts no deletion of their relation nets, so a
 * mutable relation's put updates in place (ON CONFLICT DO UPDATE) where the full stratum's is the DELETE-then-insert
 * pair (write/put/choose.ts); and each relation's rows as grizzle reads them, key generations included.
 */
const programs = Object.freeze({
	seed: ChangeSet.empty(GeneratedKeys)
		.insert(StimulusRef, [])
		.insert(FoldedRef, [])
		.insert(Doc, [])
		.insert(TreeNode, []),
	stratum: ChangeSet.empty(GeneratedKeys)
		.insert(StimulusRef, [])
		.put(StimulusRef, [])
		.delete(StimulusRef, [])
		.insert(FoldedRef, [])
		.put(FoldedRef, [])
		.delete(FoldedRef, [])
		.insert(Doc, [])
		.delete(Doc, [])
		.insert(TreeNode, [])
		.delete(TreeNode, []),
	docPut: ChangeSet.empty(GeneratedKeys).put(Doc, []),
	upserts: ChangeSet.empty(GeneratedKeys)
		.insert(StimulusRef, [])
		.put(StimulusRef, [])
		.insert(FoldedRef, [])
		.put(FoldedRef, []),
	setSeed: ChangeSet.empty(GeneratedKeys).insert(SetString, []),
	setStratum: ChangeSet.empty(GeneratedKeys)
		.insert(SetString, [])
		.put(SetString, [])
		.delete(SetString, []),
	childDelete: ChangeSet.empty(GeneratedKeys).delete(
		SetString,
		query(GeneratedKeys).rule((r) => {
			const child = r.param("child", pg.integer)
			const { variable, value, weight } = v(SetString, "s")
			return r
				.match(SetString, { child, variable, value, weight })
				.find({ child, variable, value, weight })
		})
	),
	childReweigh: ChangeSet.empty(GeneratedKeys).put(
		SetString,
		query(GeneratedKeys).rule((r) => {
			const child = r.param("child", pg.integer)
			const { variable, value, weight } = v(SetString, "s")
			return r
				.match(SetString, { child, variable, value, weight })
				.find({ child, variable, value, weight: r.param("weight", pg.integer) })
		})
	),
	setByKey: SetString,
	setStrings: query(GeneratedKeys).rule((r) => {
		const { child, variable, value, weight, valueDigest } = v(SetString, "s")
		return r
			.match(SetString, { child, variable, value, weight, valueDigest })
			.find({ child, variable, value, weight, valueDigest })
	}),
	stimulusRefs: query(GeneratedKeys).rule((r) => {
		const { identifier, package: p, path, start, pathDigest } = v(StimulusRef, "s")
		return r
			.match(StimulusRef, { identifier, package: p, path, start, pathDigest })
			.find({ identifier, package: p, path, start, pathDigest })
	}),
	foldedRefs: query(GeneratedKeys).rule((r) => {
		const { identifier, package: p, path, start, foldDigest } = v(FoldedRef, "f")
		return r
			.match(FoldedRef, { identifier, package: p, path, start, foldDigest })
			.find({ identifier, package: p, path, start, foldDigest })
	}),
	docs: query(GeneratedKeys).rule((r) => {
		const { package: p, path, title, pathDigest } = v(Doc, "d")
		return r
			.match(Doc, { package: p, path, title, pathDigest })
			.find({ package: p, path, title, pathDigest })
	}),
	lines: query(GeneratedKeys).rule((r) => {
		const { package: p, path, at, word, docTitle, pathDigest } = v(Line, "l")
		return r
			.match(Line, { package: p, path, at, word, docTitle, pathDigest })
			.find({ package: p, path, at, word, docTitle, pathDigest })
	}),
	notes: query(GeneratedKeys).rule((r) => {
		const { package: p, pathDigest, at, word, docTitle } = v(Note, "n")
		return r
			.match(Note, { package: p, pathDigest, at, word, docTitle })
			.find({ package: p, pathDigest, at, word, docTitle })
	}),
	treeNodes: query(GeneratedKeys).rule((r) => {
		const { package: p, path, parent, start, label, pathDigest } = v(TreeNode, "t")
		return r
			.match(TreeNode, { package: p, path, parent, start, label, pathDigest })
			.find({ package: p, path, parent, start, label, pathDigest })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const generatedKeysInstall = Object.freeze({ label: "genpk", programs })

/** GeneratedKeys installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const generatedKeysTemplate = fixtureTemplate(
	import.meta,
	GeneratedKeys,
	generatedKeysInstall
)

/**
 * A text's SHA-256 over its UTF-8, in lowercase hex, as PostgreSQL's sha256(convert_to(t, 'UTF8')) computes it: the host
 * model's digest, apart from grizzle's generation, by the platform's encoder and core/sha256.ts sha256Hex over its
 * bytes (as fingerprint.fixtures.ts platformDigest), so every model keys its facts by the generations of their texts.
 */
const digestHex = (text: string): string => sha256Hex(new TextEncoder().encode(text))

/** A text with its ASCII letters lowered, as PostgreSQL's translate over A–Z does, every other character kept. */
const lowerAscii = (text: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(text), (c) => (c >= "A" && c <= "Z" ? Str.toLowerCase(c) : c)),
		""
	)

/** Each flat relation's key generation over a path, as the host computes it. */
const generationOf: Readonly<Record<FlatName, (path: string) => string>> = {
	StimulusRef: digestHex,
	FoldedRef: (path) => digestHex(lowerAscii(path))
}

/** A flat relation's fact as its caller writes it: the generation's read and the written fields, no digest. */
export interface RefRow {
	readonly package: "p" | "q"
	readonly path: string
	readonly start: bigint
	readonly identifier: string
}

/** The fact's identity, every written field: two facts are one exactly when they agree on each. */
const identityOf = (r: RefRow): string =>
	Arr.join([r.package, r.path, String(r.start), r.identifier], "\u0000")

/** The fact's key in relation `name`: its package, its path's generation and its start. */
export const keyOf = (name: FlatName, r: RefRow): string =>
	Arr.join([r.package, generationOf[name](r.path), String(r.start)], "\u0000")

/** One stratum's writes of one flat relation. */
export interface FlatWrites {
	readonly insert: ReadonlyArray<RefRow>
	readonly put: ReadonlyArray<RefRow>
	readonly delete: ReadonlyArray<RefRow>
}

/** A flat relation's state: its facts by key, a lawful state holding one fact at each. */
export type FlatState = ReadonlyMap<string, RefRow>

/**
 * What one stratum does to a flat relation (README "A relation's rows are a set"; GENPK-B's host semantics): its
 * deletions remove the stored facts they name exactly, each puts' key displaces its stored occupant, and its additions,
 * inserts and puts, identical facts collapsed into one, join the state that leaves; two facts left at one key are the
 * primary key's violation, the write refused, its witness the key. A deletion names its fact by every field, so one
 * stating another text of a stored key, which its generation meets, removes nothing.
 */
export type FlatOutcome =
	| { readonly kind: "refused"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "applied"; readonly state: FlatState; readonly changed: boolean }

export const flatAfter = (name: FlatName, before: FlatState, w: FlatWrites): FlatOutcome => {
	const deleted = new Set(Arr.map(w.delete, identityOf))
	const displaced = new Set(Arr.map(w.put, (r) => keyOf(name, r)))
	const kept = Arr.filter(
		[...before.values()],
		(r) => !deleted.has(identityOf(r)) && !displaced.has(keyOf(name, r))
	)
	const added = Arr.dedupeWith([...w.insert, ...w.put], (a, b) => identityOf(a) === identityOf(b))
	const after = [...Arr.dedupeWith([...kept, ...added], (a, b) => identityOf(a) === identityOf(b))]
	const byKey = Arr.groupBy(after, (r) => keyOf(name, r))
	const clashes = Arr.filter(Rec.toEntries(byKey), ([, rs]) => rs.length > 1)
	if (clashes.length > 0) {
		return { kind: "refused", keys: Arr.map(clashes, ([k]) => k) }
	}
	const state: FlatState = new Map(Arr.map(after, (r) => [keyOf(name, r), r] as const))
	const changed =
		state.size !== before.size ||
		Arr.some([...state.entries()], ([k, r]) => {
			const was = before.get(k)
			return was === undefined || identityOf(was) !== identityOf(r)
		})
	return { kind: "applied", state, changed }
}

/** A flat state's facts as rows of texts, sorted, each its written fields then its generation, as a read gives them. */
export const flatRowsOf = (name: FlatName, s: FlatState): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		Arr.map([...s.values()], (r) => [
			r.package,
			r.path,
			String(r.start),
			r.identifier,
			generationOf[name](r.path)
		]),
		Arr.makeOrder(Order.String)
	)

/**
 * The bytes past which a path's text could stand in no B-tree entry: PostgreSQL's BTMaxItemSize for the default 8 kB
 * page (schema/representability.ts btreeMaxItemSize, restated there from nbtree.h), one past it.
 */
export const pastEntryLimit = btreeMaxItemSize + 1

/**
 * The paths a case draws: two stems spelled in two cases each, `a/x`, `A/x`, `a/X` and `b/x`, which FoldedRef's
 * generation folds into two keys and StimulusRef's keeps four, and each stem's long form, its tail repeated to
 * pastEntryLimit bytes, in the same two cases.
 */
const shortPaths = ["a/x", "A/x", "a/X", "b/x"] as const

/** A path past the entry limit: `stem` then `tail` repeated until the path holds pastEntryLimit bytes. */
const longPath = (stem: string, tail: string): string =>
	`${stem}${Str.repeat(pastEntryLimit - stem.length)(tail)}`

const longPaths = [longPath("a/", "x"), longPath("A/", "x"), longPath("a/", "X")] as const

const pathGen: Gen<string> = weighted([
	[3, element(shortPaths)],
	[1, element(longPaths)]
])

const packageGen: Gen<"p" | "q"> = element(["p", "q"] as const)

const refGen: Gen<RefRow> = (source) => ({
	package: source.draw(packageGen),
	path: source.draw(pathGen),
	start: BigInt(source.draw(int(0, 1))),
	identifier: source.draw(element(["i", "j"] as const))
})

/** A fact near a stored one: the stored fact itself, the stored fact with another identifier, or with another path. */
const nearGen =
	(stored: ReadonlyArray<RefRow>): Gen<RefRow> =>
	(source) => {
		const [first, ...rest] = stored
		if (first === undefined) {
			return source.draw(refGen)
		}
		const r = source.draw(element([first, ...rest]))
		return source.draw(
			weighted<RefRow>([
				[2, () => r],
				[1, (s) => ({ ...r, identifier: s.draw(element(["i", "j"] as const)) })],
				[1, (s) => ({ ...r, path: s.draw(pathGen) })],
				[1, refGen]
			])
		)
	}

/** A lawful stored state of a flat relation: drawn facts, the first at each key kept. */
const storedFlatGen =
	(name: FlatName): Gen<FlatState> =>
	(source) => {
		const drawnRows = source.draw(array(refGen, { min: 0, max: 4 }))
		return new Map(
			Arr.map(
				Arr.dedupeWith(drawnRows, (a, b) => keyOf(name, a) === keyOf(name, b)),
				(r) => [keyOf(name, r), r] as const
			)
		)
	}

const flatWritesGen =
	(stored: FlatState): Gen<FlatWrites> =>
	(source) => {
		const near = nearGen([...stored.values()])
		const facts = array(near, { min: 0, max: 2 })
		return { insert: source.draw(facts), put: source.draw(facts), delete: source.draw(facts) }
	}

/** A case: each flat relation's stored state, and a history of one to three strata of writes over them. */
export interface FlatCase {
	readonly stored: Readonly<Record<FlatName, FlatState>>
	readonly strata: Arr.NonEmptyReadonlyArray<Readonly<Record<FlatName, FlatWrites>>>
}

export const flatCaseGen: Gen<FlatCase> = (source) => {
	const stored = {
		StimulusRef: source.draw(storedFlatGen("StimulusRef")),
		FoldedRef: source.draw(storedFlatGen("FoldedRef"))
	}
	const stratumGen: Gen<Readonly<Record<FlatName, FlatWrites>>> = (s) => ({
		StimulusRef: s.draw(flatWritesGen(stored.StimulusRef)),
		FoldedRef: s.draw(flatWritesGen(stored.FoldedRef))
	})
	const [first, ...rest] = source.draw(array(stratumGen, { min: 1, max: 3 }))
	return { stored, strata: first === undefined ? [source.draw(stratumGen)] : [first, ...rest] }
}

/** A line as its document's insert nests it: the path it states, its document's or another, and its word. */
export interface LineRow {
	readonly path: string
	readonly word: number
}

/** A document as its insert states it, its lines and notes nested in order. */
export interface DocRow {
	readonly package: "p" | "q"
	readonly path: string
	readonly title: number
	readonly lines: ReadonlyArray<LineRow>
	readonly notes: ReadonlyArray<{ readonly word: number }>
}

/** A tree's node as its root's insert nests it: the path it states, its label, and its children in order. */
export interface NodeRow {
	readonly path: string
	readonly label: number
	readonly children: ReadonlyArray<NodeRow>
}

/** A tree as its insert states it: its package, and its root node. */
export interface TreeRow {
	readonly package: "p" | "q"
	readonly root: NodeRow
}

/** A document's or a tree's key: its package and its path's digest. */
export const groupKey = (pkg: string, path: string): string => `${pkg}\u0000${digestHex(path)}`

/** The documents and trees stored, each by its key. */
export interface FamilyState {
	readonly docs: ReadonlyMap<string, DocRow>
	readonly trees: ReadonlyMap<string, TreeRow>
}

/**
 * One stratum over the families, documents inserted with their members nested, a stored document deleted by its own
 * fields, a tree inserted whole, and a stored tree deleted by its root's texts; then a stored document's title put.
 */
export interface FamilyWrites {
	readonly docInserts: ReadonlyArray<DocRow>
	readonly docPut: ReadonlyArray<{
		readonly package: "p" | "q"
		readonly path: string
		readonly title: number
	}>
	readonly docDelete: ReadonlyArray<{
		readonly package: "p" | "q"
		readonly path: string
		readonly title: number
	}>
	readonly treeInserts: ReadonlyArray<TreeRow>
	readonly treeDelete: ReadonlyArray<{ readonly package: "p" | "q"; readonly path: string }>
}

/** Every node of a tree in pre-order, each beside its parent's start (the root its own, 0) and its own start. */
const preorder = (
	t: TreeRow
): ReadonlyArray<{ readonly node: NodeRow; readonly start: number; readonly parent: number }> => {
	const out: Array<{ readonly node: NodeRow; readonly start: number; readonly parent: number }> = []
	const walk = (node: NodeRow, parent: number): void => {
		const start = out.length
		out.push({ node, start, parent })
		for (const child of node.children) {
			walk(child, start)
		}
	}
	walk(t.root, 0)
	return out
}

/**
 * Why a family stratum is refused, each the law the model names: a document inserted at a stored key it differs from,
 * a tree inserted at a stored key, or either at another inserted one's (the owner's primary key); a line, or a tree's member, whose path's digest is not its
 * owner's (the family's owner axis: the member's own key generation over its own path meets no owner); two lines at one
 * key, their package, the digest of the path each states and their place in their documents, of two documents, one of
 * which states a line off its own path (Line's primary key).
 */
export type FamilyBreach = "doc key" | "tree key" | "line axis" | "node axis" | "line key"

export type FamilyOutcome =
	| { readonly kind: "refused"; readonly breaches: Arr.NonEmptyReadonlyArray<FamilyBreach> }
	| { readonly kind: "applied"; readonly state: FamilyState; readonly changed: boolean }

/** Whether two documents are one fact with its groups: the same title, lines and notes, each in order. */
const sameDoc = (a: DocRow, b: DocRow): boolean =>
	a.title === b.title &&
	a.lines.length === b.lines.length &&
	Arr.every(a.lines, (l, i) => {
		const m = b.lines[i]
		return m !== undefined && m.path === l.path && m.word === l.word
	}) &&
	a.notes.length === b.notes.length &&
	Arr.every(a.notes, (n, i) => b.notes[i]?.word === n.word)

/**
 * What a family stratum does (familyCaseGen): its deletions first, then its inserts. An insert at a stored or another
 * inserted owner's key that differs from it is refused on the owner's primary key, and a member whose path's digest is
 * not its owner's on its family's law, and two lines at one key on Line's (FamilyBreach). An insert that repeats a stored document exactly, its title and
 * its groups, the lines and notes it nests, changes nothing and meets it (README "Rows an insertion met"). The stratum
 * changes a row where it inserts a fresh document or a tree, or deletes a stored document or tree.
 */
export const familyAfter = (before: FamilyState, w: FamilyWrites): FamilyOutcome => {
	const deletedDocs = Arr.filter([...before.docs.entries()], ([, d]) =>
		Arr.some(
			w.docDelete,
			(x) => x.package === d.package && x.path === d.path && x.title === d.title
		)
	)
	const docs = new Map(before.docs)
	for (const [k] of deletedDocs) {
		docs.delete(k)
	}
	const breaches: Array<FamilyBreach> = []
	/** Whether an insert changes a row: a fresh document. */
	let inserted = false
	/** The documents kept past the deletions and those inserted fresh, whose lines the stratum leaves stored. */
	const placed: Array<DocRow> = [...docs.values()]
	for (const d of w.docInserts) {
		const k = groupKey(d.package, d.path)
		const was = docs.get(k)
		if (Arr.some(d.lines, (l) => digestHex(l.path) !== digestHex(d.path))) {
			breaches.push("line axis")
		}
		if (was === undefined) {
			docs.set(k, d)
			placed.push(d)
			inserted = true
		} else if (!sameDoc(was, d)) {
			breaches.push("doc key")
		}
	}
	const lineKeys = Arr.flatMap(placed, (d) =>
		Arr.map(d.lines, (l, at) => `${d.package}\u0000${digestHex(l.path)}\u0000${String(at)}`)
	)
	if (new Set(lineKeys).size !== lineKeys.length) {
		breaches.push("line key")
	}
	const trees = new Map(before.trees)
	for (const x of w.treeDelete) {
		trees.delete(groupKey(x.package, x.path))
	}
	for (const t of w.treeInserts) {
		const k = groupKey(t.package, t.root.path)
		if (trees.has(k)) {
			breaches.push("tree key")
		}
		if (Arr.some(preorder(t), (n) => digestHex(n.node.path) !== digestHex(t.root.path))) {
			breaches.push("node axis")
		}
		trees.set(k, t)
	}
	if (Arr.isReadonlyArrayNonEmpty(breaches)) {
		return { kind: "refused", breaches }
	}
	const changed =
		inserted ||
		w.treeInserts.length > 0 ||
		deletedDocs.length > 0 ||
		Arr.some(w.treeDelete, (x) => before.trees.has(groupKey(x.package, x.path)))
	return { kind: "applied", state: { docs, trees }, changed }
}

/**
 * What a put of stored documents' titles does after the stratum, a stratum of its own (a delete of an owner removes the
 * rows nested under it, which no put of its stratum may write): each document at a put's key takes its title, and every
 * line and note carries it, the owner axis's ON UPDATE CASCADE; a put at no stored document's key inserts nothing here,
 * since the case puts stored documents alone.
 */
export const docPutAfter = (
	before: FamilyState,
	puts: FamilyWrites["docPut"]
): { readonly state: FamilyState; readonly changed: boolean } => {
	const docs = new Map(before.docs)
	let changed = false
	for (const p of puts) {
		const k = groupKey(p.package, p.path)
		const was = docs.get(k)
		if (was !== undefined && was.title !== p.title) {
			docs.set(k, { ...was, title: p.title })
			changed = true
		}
	}
	return { state: { docs, trees: before.trees }, changed }
}

/** Rows of texts in one order, as the property compares a read with the model. */
const sortedRows = (
	rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> => Arr.sort(rows, Arr.makeOrder(Order.String))

/** The documents, lines, notes and tree nodes a family state holds, as rows of texts, each with its digest. */
export const familyRowsOf = (s: FamilyState) => {
	const docs = [...s.docs.values()]
	return {
		docs: sortedRows(Arr.map(docs, (d) => [d.package, d.path, String(d.title), digestHex(d.path)])),
		lines: sortedRows(
			Arr.flatMap(docs, (d) =>
				Arr.map(d.lines, (l, at) => [
					d.package,
					l.path,
					String(at),
					String(l.word),
					String(d.title),
					digestHex(l.path)
				])
			)
		),
		notes: sortedRows(
			Arr.flatMap(docs, (d) =>
				Arr.map(d.notes, (n, at) => [
					d.package,
					digestHex(d.path),
					String(at),
					String(n.word),
					String(d.title)
				])
			)
		),
		treeNodes: sortedRows(
			Arr.flatMap([...s.trees.values()], (t) =>
				Arr.map(preorder(t), (n) => [
					t.package,
					n.node.path,
					String(n.parent),
					String(n.start),
					String(n.node.label),
					digestHex(n.node.path)
				])
			)
		)
	}
}

/** A member's path: its owner's, or, one draw in six, another path, whose digest meets no owner. */
const memberPathGen =
	(owner: string): Gen<string> =>
	(source) =>
		source.draw(
			weighted<string>([
				[5, constant(owner)],
				[1, pathGen]
			])
		)

const lineGen =
	(owner: string): Gen<LineRow> =>
	(source) => ({
		path: source.draw(memberPathGen(owner)),
		word: source.draw(int(0, 9))
	})

const docGen: Gen<DocRow> = (source) => {
	const path = source.draw(pathGen)
	return {
		package: source.draw(packageGen),
		path,
		title: source.draw(int(0, 9)),
		lines: source.draw(array(lineGen(path), { min: 0, max: 2 })),
		notes: source.draw(array((s) => ({ word: s.draw(int(0, 9)) }), { min: 0, max: 2 }))
	}
}

const nodeGen =
	(owner: string, depth: number): Gen<NodeRow> =>
	(source) => ({
		path: source.draw(memberPathGen(owner)),
		label: source.draw(int(0, 9)),
		children: depth === 0 ? [] : source.draw(array(nodeGen(owner, depth - 1), { min: 0, max: 2 }))
	})

const treeGen: Gen<TreeRow> = (source) => {
	const path = source.draw(pathGen)
	return {
		package: source.draw(packageGen),
		root: {
			path,
			label: source.draw(int(0, 9)),
			children: source.draw(array(nodeGen(path, 1), { min: 0, max: 2 }))
		}
	}
}

/** A tree whose every node states its root's path, as a stored tree is. */
const lawfulTree = (t: TreeRow): TreeRow => {
	const fix = (n: NodeRow): NodeRow => ({
		...n,
		path: t.root.path,
		children: Arr.map(n.children, fix)
	})
	return { ...t, root: fix(t.root) }
}

/** A family case: lawful stored documents and trees, the first at each key, and one stratum over them. */
export interface FamilyCase {
	readonly stored: FamilyState
	readonly writes: FamilyWrites
}

export const familyCaseGen: Gen<FamilyCase> = (source) => {
	const storedDocs = Arr.map(source.draw(array(docGen, { min: 0, max: 3 })), (d) => ({
		...d,
		lines: Arr.map(d.lines, (l) => ({ ...l, path: d.path }))
	}))
	const storedTrees = Arr.map(source.draw(array(treeGen, { min: 0, max: 2 })), lawfulTree)
	const stored: FamilyState = {
		docs: new Map(
			Arr.map(Arr.reverse(storedDocs), (d) => [groupKey(d.package, d.path), d] as const)
		),
		trees: new Map(
			Arr.map(Arr.reverse(storedTrees), (t) => [groupKey(t.package, t.root.path), t] as const)
		)
	}
	const docs = [...stored.docs.values()]
	const trees = [...stored.trees.values()]
	const [put, deleted] = docs
	const newDocs = Arr.dedupeWith(
		source.draw(array(docGen, { min: 0, max: 2 })),
		(a, b) => groupKey(a.package, a.path) === groupKey(b.package, b.path)
	)
	return {
		stored,
		writes: {
			docInserts: newDocs,
			docPut:
				put === undefined || !source.draw((s) => s.choose(0, 1) === 1)
					? []
					: [{ package: put.package, path: put.path, title: (put.title + 1) % 10 }],
			docDelete:
				deleted === undefined || !source.draw((s) => s.choose(0, 1) === 1)
					? []
					: [
							{
								package: deleted.package,
								path: deleted.path,
								title: source.draw(element([deleted.title, (deleted.title + 1) % 10]))
							}
						],
			treeInserts: source.draw(array(treeGen, { min: 0, max: 1 })),
			treeDelete: Arr.map(Arr.take(trees, source.draw(int(0, 1))), (t) => ({
				package: t.package,
				path: t.root.path
			}))
		}
	}
}

/** A ledger row as its caller writes it: its child, variable and value, never the digest, and its weight. */
export interface SetRow {
	readonly child: number
	readonly variable: "v" | "w"
	readonly value: string
	readonly weight: number
}

/** A ledger row's key heads, the texts a lookup states for (child, variable, valueDigest). */
export type SetHead = Pick<SetRow, "child" | "variable" | "value">

/** A ledger row's key: its child, its variable and its value's digest. */
export const setKey = (r: SetHead): string =>
	Arr.join([String(r.child), r.variable, digestHex(r.value)], "\u0000")

const setIdentity = (r: SetRow): string => `${setKey(r)}\u0000${String(r.weight)}`

/** One step of a ledger case: a stratum of inserts, puts and deletes; a whole child deleted; or a child reweighed. */
export type SetStep =
	| {
			readonly kind: "stratum"
			readonly writes: Readonly<Record<"insert" | "put" | "delete", ReadonlyArray<SetRow>>>
	  }
	| { readonly kind: "childDelete"; readonly child: number }
	| { readonly kind: "childReweigh"; readonly child: number; readonly weight: number }

export type SetState = ReadonlyMap<string, SetRow>

export type SetOutcome =
	| { readonly kind: "refused" }
	| { readonly kind: "applied"; readonly state: SetState; readonly changed: boolean }

/**
 * What a ledger step does (README "A relation's rows are a set"): a stratum as the flat model's, its deletions exact,
 * its puts displacing at the key, two facts left at one key refused; a whole child's delete removes every row of the
 * child; a reweigh puts every row of the child back at the weight it states, a described put of the relation's own
 * facts, which proves each row stored and updates it in place.
 */
export const setAfter = (before: SetState, step: SetStep): SetOutcome => {
	const rows = [...before.values()]
	switch (step.kind) {
		case "childDelete": {
			const kept = Arr.filter(rows, (r) => r.child !== step.child)
			return {
				kind: "applied",
				state: new Map(Arr.map(kept, (r) => [setKey(r), r] as const)),
				changed: kept.length !== rows.length
			}
		}
		case "childReweigh": {
			const next = Arr.map(rows, (r) =>
				r.child === step.child ? { ...r, weight: step.weight } : r
			)
			return {
				kind: "applied",
				state: new Map(Arr.map(next, (r) => [setKey(r), r] as const)),
				changed: Arr.some(rows, (r) => r.child === step.child && r.weight !== step.weight)
			}
		}
		case "stratum": {
			const w = step.writes
			const deleted = new Set(Arr.map(w.delete, setIdentity))
			const displaced = new Set(Arr.map(w.put, setKey))
			const kept = Arr.filter(
				rows,
				(r) => !deleted.has(setIdentity(r)) && !displaced.has(setKey(r))
			)
			const after = Arr.dedupeWith(
				[...kept, ...w.insert, ...w.put],
				(a, b) => setIdentity(a) === setIdentity(b)
			)
			const byKey = Arr.groupBy(after, setKey)
			if (Arr.some(Rec.values(byKey), (group) => group.length > 1)) {
				return { kind: "refused" }
			}
			const state: SetState = new Map(Arr.map(after, (r) => [setKey(r), r] as const))
			const changed =
				state.size !== before.size ||
				Arr.some([...state.entries()], ([k, r]) => {
					const was = before.get(k)
					return was === undefined || setIdentity(was) !== setIdentity(r)
				})
			return { kind: "applied", state, changed }
		}
	}
}

/** A ledger state's rows as texts, sorted, each its fields then its value's digest, as setStrings reads them. */
export const setRowsOf = (s: SetState): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		Arr.map([...s.values()], (r) => [
			String(r.child),
			r.variable,
			r.value,
			String(r.weight),
			digestHex(r.value)
		]),
		Arr.makeOrder(Order.String)
	)

/** The values a ledger case draws: two short ones and two past the entry limit, which differ only in their last byte. */
const setValues = ["a", "b", longPath("x", "y"), `${longPath("x", "y")}z`] as const

const setRowGen: Gen<SetRow> = (source) => ({
	child: source.draw(int(1, 2)),
	variable: source.draw(element(["v", "w"] as const)),
	value: source.draw(element(setValues)),
	weight: source.draw(int(0, 2))
})

/** A ledger row near the stored ones: a stored row, with another weight, or fresh. */
const nearSetGen =
	(stored: ReadonlyArray<SetRow>): Gen<SetRow> =>
	(source) => {
		const [first, ...rest] = stored
		if (first === undefined) {
			return source.draw(setRowGen)
		}
		const r = source.draw(element([first, ...rest]))
		return source.draw(
			weighted<SetRow>([
				[2, constant(r)],
				[1, (s) => ({ ...r, weight: s.draw(int(0, 2)) })],
				[1, setRowGen]
			])
		)
	}

/** A ledger case: a lawful stored state, then one to three steps, each followed by lookups of drawn key heads. */
export interface SetCase {
	readonly stored: SetState
	readonly steps: Arr.NonEmptyReadonlyArray<SetStep>
	readonly lookups: ReadonlyArray<SetHead>
}

export const setCaseGen: Gen<SetCase> = (source) => {
	const drawnRows = source.draw(array(setRowGen, { min: 0, max: 5 }))
	const stored: SetState = new Map(
		Arr.map(
			Arr.dedupeWith(drawnRows, (a, b) => setKey(a) === setKey(b)),
			(r) => [setKey(r), r] as const
		)
	)
	const near = nearSetGen([...stored.values()])
	const stepGen: Gen<SetStep> = weighted<SetStep>([
		[
			3,
			(s) => ({
				kind: "stratum",
				writes: {
					insert: s.draw(array(near, { min: 0, max: 2 })),
					put: s.draw(array(near, { min: 0, max: 2 })),
					delete: s.draw(array(near, { min: 0, max: 2 }))
				}
			})
		],
		[1, (s) => ({ kind: "childDelete", child: s.draw(int(1, 2)) })],
		[1, (s) => ({ kind: "childReweigh", child: s.draw(int(1, 2)), weight: s.draw(int(0, 2)) })]
	])
	const [first, ...rest] = source.draw(array(stepGen, { min: 1, max: 3 }))
	return {
		stored,
		steps: first === undefined ? [source.draw(stepGen)] : [first, ...rest],
		lookups: source.draw(array(near, { min: 1, max: 3 }))
	}
}
