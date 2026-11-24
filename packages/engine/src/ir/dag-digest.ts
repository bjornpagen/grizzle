/**
 * A DAG's normal form, numbered once and written as share and evaluation keys from encoded templates (ir/dag.ts
 * normalizeWithin, dagDigestWithin; lower/shapes/share/index.ts shareKey, lower/conservative/call/keys.ts
 * EvaluationKeys), and the share planning's keys digested from blocks (ShareKeys; lower/shapes/share ShareIndex).
 *
 * The normal form names what roots reach by first occurrence, breadth-first from the roots in structural order (rel.ts
 * mapNode, then an expression's arguments in operand order and its column's node): nodes "n#i", expressions "e#i",
 * variables "v#i", occurrences "o#i" and scopes "s#i". ReachNumbering is that numbering, the one the table
 * (normalizeWithin) and the digests read.
 *
 * A digest of the claimed form (claimedNode, tableExprOf) is SHA-256 of its table's canonical text, a call of a
 * volatile function's form holding its label besides (templateForm), so no two calls are one. DagDigests writes
 * each node's and each expression's claimed form once for a DAG, as its canonical bytes with a hole where each name it
 * holds goes (core/canonical.ts writeTemplate), beside the names it gives in the numbering's order (its namings). A
 * digest numbers its reach by replaying those namings (numberReach), then streams the table's text into SHA-256 (core/
 * sha256.ts Sha256Messages): each entry's template copied, its holes filled with this digest's names, the entries in
 * their names' code unit order. The bytes are the table's canonical text, byte for byte, so a key is the digest it was;
 * the work of a digest is its reach's namings and the bytes copied, where it built, froze and walked its reach's whole
 * normal form, and each node's form is walked once for every digest of the DAG.
 */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Utf8Writer, WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import {
	boundCanonicalText,
	type CanonicalTemplate,
	catchRefusal,
	omitSourceLocs,
	Refusal,
	unwrap,
	writeCanonicalString,
	writeTemplate
} from "#compiler/core/canonical.ts"
import { type CompileError, within } from "#compiler/core/errors.ts"
import { fingerprintDomain, writeFrame } from "#compiler/core/fingerprint.ts"
import { ExprId, NodeId, OccurrenceId, ScopeId, VarId } from "#compiler/core/ids.ts"
import { messageChunk, Sha256Messages } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import {
	type ExprSpecOver,
	type LiveArgs,
	outsideSpec,
	type ScalarExpr,
	sortedUnique,
	type TableArgs,
	withArgs
} from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	inputsOf,
	type LiveRefs,
	mapNode,
	type RefMap,
	type RelNode,
	type Roots,
	type TableNode,
	type TableRefs
} from "#compiler/ir/rel.ts"
import * as S from "#compiler/ir/shape.ts"

const malformed = (path: S.Path, capability: string): CompileError =>
	S.malformedAt("relational DAG", path, capability)

/** Fresh positional names of one namespace, "<ns>#<i>", numbered by first occurrence of the label they rename. */
class Names<A extends string> {
	readonly #ns: string
	readonly #make: (s: string) => A
	readonly #indices = new Map<string, number>()
	/** Each index's name, made where it is first read. */
	readonly #names: Array<A | undefined> = []

	constructor(ns: string, make: (s: string) => A) {
		this.#ns = ns
		this.#make = make
	}

	has(id: string): boolean {
		return this.#indices.has(id)
	}

	/** How many labels are numbered. */
	get size(): number {
		return this.#indices.size
	}

	/** The index of `id`, numbered now when it has none. */
	index(id: string): number {
		const known = this.#indices.get(id)
		if (known !== undefined) {
			return known
		}
		const index = this.#indices.size
		this.#indices.set(id, index)
		return index
	}

	/** The index of `id`, which the numbering already holds; a label it never met is MalformedDescription. */
	indexed(id: string, path: S.Path): number {
		const known = this.#indices.get(id)
		if (known === undefined) {
			throw new Refusal(malformed(path, `a reachable reference, not ${id}`))
		}
		return known
	}

	/** The name of an index: "<ns>#<i>". */
	nameOf(index: number): A {
		const known = this.#names[index]
		if (known !== undefined) {
			return known
		}
		const name = this.#make(`${this.#ns}#${index}`)
		this.#names[index] = name
		return name
	}

	/** The name of `id`, numbered now when it has none. */
	name(id: string): A {
		return this.nameOf(this.index(id))
	}
}

/** A node or an expression the numbering met, waiting to be read in the order it was met. */
export type Reached =
	| { readonly kind: "node"; readonly node: RelNode }
	| { readonly kind: "expr"; readonly expr: ScalarExpr }

/**
 * What a normal form reads of a node outside what its roots reach by their inputs: the node, read through the context's
 * labels and numbered as the walk's own (`followed`); its label (`labelled`), so the form reads an enclosing node by
 * which it is, never by what it holds; or its place among the outside nodes the form names, "x#i" by first occurrence
 * (`positional`), so two sub-queries built alike, each correlated to rows of its own, are one form, which the place
 * names their outer rows by alike.
 */
export type OuterNames = "followed" | "labelled" | "positional"

/**
 * The OuterNames a normal form's table states (ir/dag.ts normalizeReach): all but `positional`, whose columns read
 * outside only a digest names by their places.
 */
export type TableOuterNames = Exclude<OuterNames, "positional">

/**
 * The numbering of a normal form (the module header): each label numbered on its first occurrence, each node and
 * expression queued where it is first met, to be read in that order (numberReach).
 */
export class ReachNumbering {
	readonly nodes = new Names("n", NodeId)
	readonly exprs = new Names("e", ExprId)
	readonly vars = new Names("v", VarId)
	readonly occurrences = new Names("o", OccurrenceId)
	readonly scopes = new Names("s", ScopeId)
	/** The nodes outside the reach a name holds, by first occurrence (`positional`). */
	readonly outer = new Names("x", NodeId)
	/** The columns of nodes outside the reach an expression reads, by first occurrence (`positional`), in that order. */
	readonly outerColumns = new Names("y", NodeId)
	readonly outerRead: Array<OuterRead> = []
	/** Every node and expression met, in the order it was met: each namespace's in its numbers' order. */
	readonly met: Array<Reached> = []
	/** The context's labels, read only where a name the walk has not met needs its node. */
	readonly #labels: () => ReadonlyMap<NodeId, RelNode>
	/** What the roots reach by their inputs, where a name of a node outside it is not followed (OuterNames). */
	readonly #reached: ReadonlySet<NodeId> | undefined
	readonly #outer: OuterNames

	constructor(labels: () => ReadonlyMap<NodeId, RelNode>, roots: Roots, outer: OuterNames) {
		this.#labels = labels
		this.#outer = outer
		this.#reached =
			outer === "followed" ? undefined : new Set(postorder(roots, inputsOf).map((node) => node.id))
	}

	/** A data edge's node, numbered and queued where it is new. */
	edge(node: RelNode): number {
		if (!this.nodes.has(node.id)) {
			this.met.push({ kind: "node", node })
		}
		return this.nodes.index(node.id)
	}

	/** Whether a name a node holds is of a node outside what the roots reach, which the form names by its label. */
	outside(id: NodeId): boolean {
		return this.#reached !== undefined && !this.#reached.has(id)
	}

	/**
	 * A name a node holds of a node inside the reach: numbered, and its node read through the context's labels and
	 * queued where the walk has not met it; a name the context does not hold is MalformedDescription.
	 */
	label(id: NodeId): number {
		if (!this.nodes.has(id)) {
			const node = this.#labels().get(id)
			if (node === undefined) {
				throw new Refusal(malformed(["nodes"], `a node named ${id} in the table`))
			}
			this.met.push({ kind: "node", node })
		}
		return this.nodes.index(id)
	}

	/** A name a node holds as the form writes it: outside the reach as OuterNames says, its number's name inside. */
	labelName(id: NodeId): NodeId {
		return this.outside(id) ? this.outsideName(id) : this.nodes.nameOf(this.label(id))
	}

	/** The name of a node outside the reach: its label, or its place among the outside nodes (`positional`). */
	outsideName(id: NodeId): NodeId {
		return this.#outer === "positional" ? this.outer.name(id) : id
	}

	/**
	 * The text of a column an expression reads of the node `id`: its name, or, of a node outside the reach, its place
	 * among the columns read outside (`positional`), numbered as the table's text first writes it, so a sub-query is one
	 * form whatever the names of the outer columns it reads, each typed as its expression is.
	 */
	columnName(id: NodeId, name: string): string {
		if (this.#outer !== "positional" || !this.outside(id)) {
			return name
		}
		const key = `${id}\u0000${name}`
		if (!this.outerColumns.has(key)) {
			this.outerRead.push({ node: id, column: name })
		}
		return this.outerColumns.name(key)
	}

	/** A name a node holds, numbered: inside the reach as `label` numbers it, outside it as `outsideName` names it. */
	name(id: NodeId): void {
		if (this.outside(id)) {
			this.outsideName(id)
		} else {
			this.label(id)
		}
	}

	/** An expression, numbered and queued where it is new. */
	expr(expr: ScalarExpr): number {
		if (!this.exprs.has(expr.id)) {
			this.met.push({ kind: "expr", expr })
		}
		return this.exprs.index(expr.id)
	}

	/**
	 * An expression's dependencies as the form names them, distinct and in code unit order: each node inside the reach
	 * by its number's name, which the numbering holds by now, one outside by its label; a dependency the numbering never
	 * met is MalformedDescription at the expression's.
	 */
	deps(expr: ScalarExpr): ReadonlyArray<NodeId> {
		const name = this.exprs.name(expr.id)
		return sortedUnique(
			expr.deps.nodes.map((label) =>
				this.outside(label)
					? this.outsideName(label)
					: this.nodes.nameOf(this.nodes.indexed(label, ["exprs", name, "deps"]))
			)
		)
	}
}

/**
 * Numbers what `roots` reach: each root as a data edge, then each node and expression in the order it was met, read by
 * `read`, which numbers the names it holds through the numbering, so what it meets is read in turn. The roots' numbers,
 * in order.
 */
export const numberReach = (
	numbering: ReachNumbering,
	roots: Roots,
	read: (met: Reached) => void
): ReadonlyArray<number> => {
	const numbered = roots.map((root) => numbering.edge(root))
	for (const met of numbering.met) {
		read(met)
	}
	return numbered
}

/**
 * A node's own fields as a digest reads them: a Delta's without its keys, a view Base's without the keys the checker
 * stamped on it, and a stored Base's without its generated fields' reads (rel.ts StoredBase generated), each its
 * relation's, named already; an Attach's without the delivered type its template's analysis judged, which no SQL reads
 * (rel.ts Attach judged).
 */
export const digestedFields = (node: TableNode): object => {
	if (node.kind === "Delta") {
		const { keys: _relations, ...digested } = node
		return digested
	}
	if (node.kind === "Attach") {
		const { judged: _judged, ...digested } = node
		return digested
	}
	if (node.kind === "Base" && node.relationKind !== "relation") {
		const { view: _views, ...digested } = node
		return digested
	}
	if (node.kind === "Base") {
		const { generated: _generated, ...digested } = node
		return digested
	}
	return node
}

/**
 * A node of a normal form as a share or evaluation key reads it: its own fields (digestedFields), its claimed keys as
 * the columns they claim. A key's proof is a value about the DAG its analysis ran over, naming that DAG's labels, which
 * no rename carries (rel.ts MetaSpec), so two sub-queries one template builds alike, each proved over its own nodes,
 * claim the same keys under different proofs.
 */
export const claimedNode = (node: TableNode): object => ({
	...digestedFields(node),
	meta: { ...node.meta, logicalKeys: node.meta.logicalKeys.map((k) => k.key) }
})

/**
 * Whether a node calls a volatile function, a declared function's rows (Fn.rows), the one volatile evaluation a DAG
 * holds: its expressions are immutable or stable (ir/expr.ts Volatility), a volatile function never a term or a read of
 * a row's field. Each call draws its own rows, so two equal calls are two evaluations, never one set.
 */
const callsVolatile = (node: RelNode): boolean =>
	node.kind === "Call" &&
	node.function.kind === "declared" &&
	node.function.volatility === "volatile"

/**
 * A node's claimed form (claimedNode) as its template writes it: a call of a volatile function (callsVolatile) holds its
 * own label as its `evaluation`, which no other node holds, so two equal calls, and every node above either, are of two
 * keys, and one call read twice is of one, its one evaluation.
 */
const templateForm = (node: RelNode, entry: TableNode): object =>
	callsVolatile(node) ? { ...claimedNode(entry), evaluation: node.id } : claimedNode(entry)

/**
 * An expression of a normal form: its spec with its arguments named, its volatility, its own name, and its
 * dependencies, its parameters and the names of the nodes it reads (ReachNumbering.deps).
 */
export const tableExprOf = <Id, Nodes>(
	expr: ScalarExpr,
	spec: ExprSpecOver<TableArgs>,
	id: Id,
	nodes: Nodes
) => ({ ...spec, volatility: expr.volatility, id, deps: { params: expr.deps.params, nodes } })

/** The namespaces a name of a normal form is in, each written "<ns>#<i>" (Names). */
type Namespace = "n" | "e" | "v" | "o" | "s"

/**
 * A name a node's or an expression's normal form holds, as the numbering gives it (ReachNumbering): a data edge's
 * node, a node a name reads, an expression, a variable, declared or read, an occurrence, or a scope.
 */
type Naming =
	| { readonly kind: "edge"; readonly node: RelNode }
	| { readonly kind: "label"; readonly label: NodeId }
	| { readonly kind: "column"; readonly label: NodeId; readonly name: string }
	| { readonly kind: "expr"; readonly expr: ScalarExpr }
	| { readonly kind: "var"; readonly id: VarId }
	| { readonly kind: "occurrence"; readonly id: OccurrenceId }
	| { readonly kind: "scope"; readonly id: ScopeId }

/**
 * A node's or an expression's template: its namings in the numbering's order, and its claimed form's canonical text
 * with a hole for each naming's name (hole i, the i-th naming's), its own name (hole `namings.length`) and an
 * expression's dependencies (hole `namings.length + 1`); or the refusal its form's text is.
 */
interface Template {
	readonly namings: ReadonlyArray<Naming>
	readonly text: Result.Result<CanonicalTemplate, CompileError>
}

/**
 * A template's form written with a marker for each name: "~slot<g>:<i>", the i-th name's of family g, a string the
 * canonical text writes with its "~" doubled, as it writes a plain string's (canonical.ts escapeString). Each name the
 * form holds is written once, its own and an expression's dependencies among them (`holes` of them), so a hole read
 * twice is a string of the form's own that spells a marker, and the form is written again under the next family, which
 * no string of it spells as the first did.
 */
const markedTemplate = (
	mark: (family: number, marker: (naming: Naming) => string) => object,
	holes: (namings: number) => number,
	namings: Array<Naming>
): Template => {
	for (let family = 0; ; family++) {
		namings.length = 0
		const prefix = `~slot${family}:`
		const marker = (naming: Naming): string => `${prefix}${namings.push(naming) - 1}`
		const form = mark(family, marker)
		const expected = holes(namings.length)
		const read = `~${prefix}`
		const text = writeTemplate(form, { omit: omitSourceLocs }, (scalar) => {
			if (!scalar.startsWith(read)) {
				return undefined
			}
			const digits = scalar.slice(read.length)
			const hole = Number(digits)
			return Number.isSafeInteger(hole) && hole < expected && String(hole) === digits
				? hole
				: undefined
		})
		if (!text.ok) {
			return { namings: [...namings], text }
		}
		const seen = new Set(text.value.holes)
		if (seen.size === text.value.holes.length) {
			if (seen.size !== expected) {
				throw defect("a template's text writes each name its form holds")
			}
			return { namings: [...namings], text }
		}
	}
}

/** The marker a naming's family writes, typed as the name it stands for, which the canonical text writes as a string. */
const nodeTemplateOf = (node: RelNode): Template => {
	const namings: Array<Naming> = []
	return markedTemplate(
		(family, marker) => {
			const refs: RefMap<LiveRefs, TableRefs> = {
				expr: (expr) => ExprId(marker({ kind: "expr", expr })),
				var: (ref) => VarId(marker({ kind: "var", id: ref.id })),
				decl: (d) => ({ ...d, id: VarId(marker({ kind: "var", id: d.id })) }),
				occurrence: (id) => OccurrenceId(marker({ kind: "occurrence", id })),
				scope: (id) => ScopeId(marker({ kind: "scope", id })),
				name: (label) => NodeId(marker({ kind: "label", label })),
				meta: (meta) => meta
			}
			const entry = drive(mapNode<LiveRefs, TableRefs>(node, refs), (input) =>
				NodeId(marker({ kind: "edge", node: input }))
			)
			return templateForm(node, { ...entry, id: NodeId(`~slot${family}:${namings.length}`) })
		},
		(count) => count + 1,
		namings
	)
}

/**
 * An expression's template (nodeTemplateOf): its arguments, its column's node and name, its own name and its
 * dependencies.
 */
const exprTemplateOf = (expr: ScalarExpr): Template => {
	const namings: Array<Naming> = []
	return markedTemplate(
		(family, marker) => {
			const args = withArgs<LiveArgs, TableArgs>(outsideSpec(expr), (arg) =>
				ExprId(marker({ kind: "expr", expr: arg }))
			)
			const spec: ExprSpecOver<TableArgs> =
				args.kind === "column"
					? {
							...args,
							column: {
								node: NodeId(marker({ kind: "label", label: args.column.node })),
								name: marker({ kind: "column", label: args.column.node, name: args.column.name })
							}
						}
					: args
			const own = namings.length
			return tableExprOf(expr, spec, ExprId(`~slot${family}:${own}`), `~slot${family}:${own + 1}`)
		},
		(count) => count + 2,
		namings
	)
}

/** The lexicographic order of 0 to `count` - 1 as decimal texts: the code unit order of the names "<ns>#<i>". */
const nameOrder = (count: number): ReadonlyArray<number> => {
	const order: Array<number> = []
	if (count === 0) {
		return order
	}
	order.push(0)
	/**
	 * The preorder of the decimal trie of 1 to count - 1 (LeetCode 386, Lexicographical Numbers): from i, its first child
	 * i * 10 where there is one, otherwise its next sibling, climbing past each last child.
	 */
	let at = 1
	for (let n = 1; n < count; n++) {
		order.push(at)
		if (at * 10 < count) {
			at *= 10
			continue
		}
		while (at % 10 === 9 || at + 1 >= count) {
			at = Math.floor(at / 10)
		}
		at += 1
	}
	return order
}

/** Each namespace's quoted prefix, the bytes a name's text begins with: a quotation mark, its letter and "#". */
const quoted: { readonly [N in Namespace]: string } = {
	n: '"n#',
	e: '"e#',
	v: '"v#',
	o: '"o#',
	s: '"s#'
}

/**
 * The names a table's entries are written with: a digest's numbering of its reach (ReachNumbering), or a share key's of
 * its block (BlockNumbering). A name of a node outside what the roots reach (`outside`) is written as its label.
 */
interface EntryNames {
	readonly nodes: Names<NodeId>
	readonly exprs: Names<ExprId>
	readonly vars: Names<VarId>
	readonly occurrences: Names<OccurrenceId>
	readonly scopes: Names<ScopeId>
	/** The text a name of a node is written as where the numbering gives it no number of its own: undefined for none. */
	nodeText(id: NodeId): string | undefined
	/** The text a name of an occurrence is written as where the numbering gives it no number of its own. */
	occurrenceText(id: OccurrenceId): string | undefined
	/** The text a column an expression reads of the node `id` is written as. */
	columnText(id: NodeId, name: string): string
}

/** A numbering that names what it meets as it meets it: a reach's (ReachNumbering) or a block's (BlockNumbering). */
interface Numbering {
	readonly vars: Names<VarId>
	readonly occurrences: Names<OccurrenceId>
	readonly scopes: Names<ScopeId>
	edge(node: RelNode): number
	/** A name a node holds, numbered where the numbering numbers it. */
	name(id: NodeId): void
	expr(expr: ScalarExpr): number
}

/** Gives a naming its number in `numbering`, as normalizeReach numbers the name it holds. */
const numbered = (numbering: Numbering, naming: Naming): void => {
	switch (naming.kind) {
		case "edge":
			numbering.edge(naming.node)
			return
		case "label":
			numbering.name(naming.label)
			return
		case "column":
			return
		case "expr":
			numbering.expr(naming.expr)
			return
		case "var":
			numbering.vars.index(naming.id)
			return
		case "occurrence":
			numbering.occurrences.index(naming.id)
			return
		case "scope":
			numbering.scopes.index(naming.id)
			return
	}
}

/**
 * The templates of nodes and expressions (nodeTemplateOf, exprTemplateOf), each written on its first read and kept for
 * every key and digest that reaches it, whichever reads it: a template is a function of its node or expression alone,
 * never of a DAG's labels or of what reads it, so one store serves every reader of one compile's nodes, the share
 * planning's keys (ShareKeys), the lowering's evaluation keys (lower/conservative/call/keys.ts EvaluationKeys), a
 * delivery's attachment share keys (lower/shapes/share/index.ts shareKey) and a read-back's digest
 * (write/readback/lower.ts QueryDigest), where each held a store of its own and wrote each node's template again (on
 * edullm's qti, 213,278 of the changes phase's first 400,000 template writes wrote one written before). Its lifetime is
 * its holder's: one write compile (write/program/compile.ts compileAt), or one reader's own.
 */
export class DagTemplates {
	readonly #nodes = new Map<RelNode, Template>()
	readonly #exprs = new Map<ScalarExpr, Template>()
	#written = 0

	/** How many templates are written: one for each node and expression any key reached, at most. */
	get written(): number {
		return this.#written
	}

	/** A node's template, written on its first read. */
	node(node: RelNode): Template {
		const known = this.#nodes.get(node)
		if (known !== undefined) {
			return known
		}
		const template = nodeTemplateOf(node)
		this.#nodes.set(node, template)
		this.#written += 1
		return template
	}

	/** An expression's template, written on its first read. */
	expr(expr: ScalarExpr): Template {
		const known = this.#exprs.get(expr)
		if (known !== undefined) {
			return known
		}
		const template = exprTemplateOf(expr)
		this.#exprs.set(expr, template)
		this.#written += 1
		return template
	}
}

/** A DAG's labels, read once, where a name first needs its node (`of`). */
class LabelIndex {
	readonly #labels: () => ReadonlyMap<NodeId, RelNode>
	#index: ReadonlyMap<NodeId, RelNode> | undefined

	constructor(labels: () => ReadonlyMap<NodeId, RelNode>) {
		this.#labels = labels
	}

	of(): ReadonlyMap<NodeId, RelNode> {
		const index = this.#index ?? this.#labels()
		this.#index = index
		return index
	}
}

/** A name "<ns>#<i>" written as its JSON string, no text of it built. */
const writeName = (out: Utf8Writer, ns: Namespace, index: number): void => {
	out.ascii(quoted[ns])
	out.jsonNumber(index)
	out.ascii('"')
}

/** The name `names` gives what a naming names. */
const writeNaming = (out: Utf8Writer, names: EntryNames, naming: Naming): void => {
	switch (naming.kind) {
		case "edge":
			writeName(out, "n", names.nodes.index(naming.node.id))
			return
		case "label": {
			const text = names.nodeText(naming.label)
			if (text !== undefined) {
				writeCanonicalString(out, wellFormed(text))
			} else {
				writeName(out, "n", names.nodes.index(naming.label))
			}
			return
		}
		case "column":
			writeCanonicalString(out, wellFormed(names.columnText(naming.label, naming.name)))
			return
		case "expr":
			writeName(out, "e", names.exprs.index(naming.expr.id))
			return
		case "var":
			writeName(out, "v", names.vars.index(naming.id))
			return
		case "occurrence": {
			const text = names.occurrenceText(naming.id)
			if (text !== undefined) {
				writeCanonicalString(out, wellFormed(text))
			} else {
				writeName(out, "o", names.occurrences.index(naming.id))
			}
			return
		}
		case "scope":
			writeName(out, "s", names.scopes.index(naming.id))
			return
	}
}

/**
 * One entry of a table's text, the `at`-th of its record: its name, then its template's pieces, each hole filled with
 * the name `names` gives it, its own name, or its dependencies; a template whose form is refused is refused here, at
 * its entry.
 */
const writeEntry = (
	out: Utf8Writer,
	names: EntryNames,
	ns: "n" | "e",
	index: number,
	at: number,
	template: Template,
	deps: ReadonlyArray<string>
): void => {
	if (at > 0) {
		out.ascii(",")
	}
	writeName(out, ns, index)
	out.ascii(":")
	const text = template.text
	if (!text.ok) {
		const name = ns === "n" ? names.nodes.nameOf(index) : names.exprs.nameOf(index)
		throw new Refusal(within(text.error, [ns === "n" ? "nodes" : "exprs", name]))
	}
	const { pieces, units, holes } = text.value
	for (const [k, hole] of holes.entries()) {
		out.encoded(defined(pieces[k], "a piece before each hole"), defined(units[k], "its units"))
		const naming = template.namings[hole]
		if (naming !== undefined) {
			writeNaming(out, names, naming)
		} else if (hole === template.namings.length) {
			writeName(out, ns, index)
		} else {
			out.ascii("[")
			for (const [d, dep] of deps.entries()) {
				if (d > 0) {
					out.ascii(",")
				}
				writeCanonicalString(out, wellFormed(dep))
			}
			out.ascii("]")
		}
	}
	out.encoded(
		defined(pieces[holes.length], "the piece after the last hole"),
		defined(units[holes.length], "its units")
	)
}

/**
 * The claimed-form digests of one DAG's sub-queries (evaluation keys, a DAG's digest), each node's and expression's
 * template read from a store (DagTemplates) that writes it once for every reader of the store, and every digest written
 * by one writer (Sha256Messages), so a digest copies its reach's bytes and builds no text. Its lifetime is its DAG's: an
 * EvaluationKeys'.
 */
export class DagDigests {
	readonly #templates: DagTemplates
	readonly #labels: LabelIndex
	readonly #messages = new Sha256Messages(messageChunk)
	/**
	 * The longest table text a digest writes, past which it is refused: V8's longest string in production. The table text
	 * is hashed and never built, as a digest's text is (core/canonical.ts ByteSink, which has no bound), but this digest
	 * is a claimed form's, which must refuse where `encode` refuses the form it claims to be (test/unit/ir/dag-digest),
	 * so it keeps the bound a built text has.
	 */
	readonly #limit: number

	/** The digests of the DAG labelled `labels`, every template read from `templates`. */
	constructor(labels: () => ReadonlyMap<NodeId, RelNode>, limit: number, templates: DagTemplates) {
		this.#templates = templates
		this.#labels = new LabelIndex(labels)
		this.#limit = limit
	}

	/** The digest under `domain` of what `roots` reach, its enclosing nodes read as `outer` says (OuterNames). */
	digest(roots: Roots, domain: string, outer: OuterNames): Result.Result<string, CompileError> {
		return Result.map(this.#framed(roots, domain, outer), (d) => d.digest)
	}

	/**
	 * The digest under `domain` of what `roots` reach, each node outside it and each column read of one by its place
	 * (`positional`), and those columns in their places' order: what two sub-queries built alike share, and what each
	 * reads outside.
	 */
	positional(roots: Roots, domain: string): Result.Result<PositionalDigest, CompileError> {
		return this.#framed(roots, domain, "positional")
	}

	/** The digest of a framed table under `domain`, refused where its form is (#digest). */
	#framed(
		roots: Roots,
		domain: string,
		outer: OuterNames
	): Result.Result<PositionalDigest, CompileError> {
		return Result.flatMap(fingerprintDomain(domain), (line) => {
			const digested = this.#digest(roots, line, outer)
			if (!digested.ok) {
				this.#messages.discard()
			}
			return digested
		})
	}

	/** The digest of a framed table (digest), refused where its form is, its message then left half written. */
	#digest(
		roots: Roots,
		line: WellFormedText,
		outer: OuterNames
	): Result.Result<PositionalDigest, CompileError> {
		return catchRefusal(() => {
			const templates = this.#templates
			const labels = this.#labels
			const numbering = new ReachNumbering(() => labels.of(), roots, outer)
			const rootNumbers = numberReach(numbering, roots, (met) => {
				const template = met.kind === "node" ? templates.node(met.node) : templates.expr(met.expr)
				for (const naming of template.namings) {
					numbered(numbering, naming)
				}
			})
			const nodes: Array<RelNode> = []
			const exprs: Array<ScalarExpr> = []
			for (const met of numbering.met) {
				if (met.kind === "node") {
					nodes.push(met.node)
				} else {
					exprs.push(met.expr)
				}
			}
			const deps = exprs.map((expr) => numbering.deps(expr))
			/** The reach's names, a node outside it by its label (OuterNames). */
			const names: EntryNames = {
				nodes: numbering.nodes,
				exprs: numbering.exprs,
				vars: numbering.vars,
				occurrences: numbering.occurrences,
				scopes: numbering.scopes,
				nodeText: (id) => (numbering.outside(id) ? numbering.outsideName(id) : undefined),
				columnText: (id, name) => numbering.columnName(id, name),
				occurrenceText: () => undefined
			}
			const out = this.#messages.out
			writeFrame(out, line)
			const start = out.units
			out.ascii('{"exprs":{')
			for (const [at, index] of nameOrder(exprs.length).entries()) {
				const expr = defined(exprs[index], "an expression the numbering met")
				writeEntry(
					out,
					names,
					"e",
					index,
					at,
					templates.expr(expr),
					defined(deps[index], "its dependencies")
				)
				boundCanonicalText(out.units - start, this.#limit)
			}
			out.ascii('},"nodes":{')
			for (const [at, index] of nameOrder(nodes.length).entries()) {
				const node = defined(nodes[index], "a node the numbering met")
				writeEntry(out, names, "n", index, at, templates.node(node), [])
				boundCanonicalText(out.units - start, this.#limit)
			}
			out.ascii('},"roots":[')
			for (const [at, index] of rootNumbers.entries()) {
				if (at > 0) {
					out.ascii(",")
				}
				writeName(out, "n", index)
			}
			out.ascii("]}")
			boundCanonicalText(out.units - start, this.#limit)
			return { digest: this.#messages.hex(), outer: numbering.outerRead }
		})
	}
}

/** A column a sub-query reads of a node outside it. */
export interface OuterRead {
	readonly node: NodeId
	readonly column: string
}

/**
 * A digest (DagDigests) and the columns it reads of nodes outside its reach, in their places' order: none but under
 * `positional`, whose form names them by those places.
 */
export interface PositionalDigest {
	readonly digest: string
	readonly outer: ReadonlyArray<OuterRead>
}

/** A node a block numbers, by its number: read by the block, or sealed, an entry its own share key fills. */
interface BlockEntry {
	readonly node: RelNode
	readonly sealed: boolean
}

/**
 * A share key's block (ShareKeys): what its root reaches by data edges without entering a sealed node, numbered by first
 * occurrence as a digest numbers its reach (ReachNumbering). Each sealed node it meets is numbered beside its nodes, an
 * entry its own share key fills, and read no further. A name of a node no data edge of the block meets is numbered
 * nowhere in it (`named`): it lies under a sealed node, an attachment's child reading a node of its parent's delivered
 * rows below the parent, and is written as its place there (ShareKeys #place, `texts`).
 */
class BlockNumbering implements Numbering, EntryNames {
	readonly nodes = new Names("n", NodeId)
	readonly exprs = new Names("e", ExprId)
	readonly vars = new Names("v", VarId)
	readonly occurrences = new Names("o", OccurrenceId)
	readonly scopes = new Names("s", ScopeId)
	/** Every node and expression the block reads, in the order it was met: each namespace's in its numbers' order. */
	readonly met: Array<Reached> = []
	/** Every node numbered, in its numbers' order. */
	readonly entries: Array<BlockEntry> = []
	/** The nodes a name holds that no data edge of the block meets, in the order first named. */
	readonly named: Array<RelNode> = []
	readonly #named = new Set<NodeId>()
	/** The text each such node, and each occurrence the block reads by and none of its nodes declares, is written as. */
	readonly nodeTexts = new Map<NodeId, string>()
	readonly occurrenceTexts = new Map<OccurrenceId, string>()
	readonly #root: RelNode
	readonly #labels: () => ReadonlyMap<NodeId, RelNode>
	readonly #sealed: (node: RelNode) => boolean

	constructor(
		root: RelNode,
		labels: () => ReadonlyMap<NodeId, RelNode>,
		sealed: (node: RelNode) => boolean
	) {
		this.#root = root
		this.#labels = labels
		this.#sealed = sealed
		this.edge(root)
	}

	/** A data edge's node, numbered, and read where it is new and not sealed. */
	edge(node: RelNode): number {
		if (!this.nodes.has(node.id)) {
			const sealed = node !== this.#root && this.#sealed(node)
			this.entries.push({ node, sealed })
			if (!sealed) {
				this.met.push({ kind: "node", node })
			}
		}
		return this.nodes.index(node.id)
	}

	/**
	 * A name a node holds, every one the block's own: its node, read through the context's labels, named where no data
	 * edge has met it; a name the context does not hold is MalformedDescription.
	 */
	name(id: NodeId): void {
		if (this.nodes.has(id) || this.#named.has(id)) {
			return
		}
		const node = this.#labels().get(id)
		if (node === undefined) {
			throw new Refusal(malformed(["nodes"], `a node named ${id} in the table`))
		}
		this.#named.add(id)
		this.named.push(node)
	}

	/** A node no data edge of the block met is written as its place (`nodeTexts`). */
	nodeText(id: NodeId): string | undefined {
		if (this.nodes.has(id)) {
			return undefined
		}
		return defined(this.nodeTexts.get(id), "the place of a node the block names")
	}

	/** A column is written as its name: a block names no node outside it. */
	columnText(_id: NodeId, name: string): string {
		return name
	}

	/** An occurrence a node of another block declares is written as its place there (`occurrenceTexts`). */
	occurrenceText(id: OccurrenceId): string | undefined {
		return this.occurrenceTexts.get(id)
	}

	/** An expression, numbered and read where it is new. */
	expr(expr: ScalarExpr): number {
		if (!this.exprs.has(expr.id)) {
			this.met.push({ kind: "expr", expr })
		}
		return this.exprs.index(expr.id)
	}

	/**
	 * An expression's dependencies as the block names them, distinct and in code unit order: each node by its number's
	 * name, or by its place where no data edge of the block met it (ReachNumbering.deps).
	 */
	deps(expr: ScalarExpr): ReadonlyArray<string> {
		return sortedUnique(
			expr.deps.nodes.map((label) =>
				this.nodes.has(label)
					? this.nodes.nameOf(this.nodes.index(label))
					: defined(this.nodeTexts.get(label), "the place of a node an expression reads")
			)
		)
	}
}

/** Where a node stands under a block: the names of the sealed entries descended to it, and the block that numbers it. */
interface Place {
	readonly path: string
	readonly block: BlockNumbering
}

/**
 * The share keys of one DAG's sub-queries, each digested from its own block, never from its whole reach: a Merkle
 * digest. A sealed node (`sealed`) reads nothing outside what it reaches, so its rows are its own whatever reads it; a
 * sub-query's block is what it reaches without entering a sealed node, numbered as a digest numbers its reach
 * (BlockNumbering), and its key is SHA-256 of the block's table under the share domain, each sealed node it meets an
 * entry its own key fills. Keys are worked out children first, each once for the DAG, so the bytes digested are the
 * blocks', each written once, where a digest of every reach wrote each node again for every key above it.
 *
 * A name a block holds of a node under a sealed node, which no data edge of the block meets, is written as its place:
 * the names of the sealed entries descended to it, each in the block above it, then its name in the block that numbers
 * it, "n#3/n#0/n#2" (#place); a key fixes its block's numbering, so the place names one position of the rows the key
 * stands for. An occurrence a node of the block reads by and no node of it declares is written as its declarer's place
 * and its name there. So a key names everything its block reads.
 *
 * Two sub-queries of one key are the same rows under the same parameters: their blocks are one table and their sealed
 * nodes are, entry for entry, of one key. A key is coarser than a digest of the whole reach in one way alone: whether
 * two sealed nodes met in different blocks are one node or two built alike, which no table of a block states. Two
 * sealed nodes built alike are the same rows, a call of a volatile function aside, whose template names its label
 * (templateForm), so the two are of two keys.
 */
export class ShareKeys {
	readonly #templates: DagTemplates
	readonly #labels: LabelIndex
	readonly #sealed: (node: RelNode) => boolean
	readonly #messages = new Sha256Messages(messageChunk)
	/** The share domain's frame line. */
	readonly #line: WellFormedText
	/** The longest block text a key writes, past which it is refused: V8's longest string in production. */
	readonly #limit: number
	/** Each node's key, worked out once. */
	readonly #keys = new Map<RelNode, string>()
	/** Each keyed node's block, which a place under it reads. */
	readonly #blocks = new Map<RelNode, BlockNumbering>()
	/** Each node a place was asked for, by the nodes known to reach it or not. */
	readonly #reaching = new Map<RelNode, Map<RelNode, boolean>>()
	/** The longest path from each node to a leaf, folded from its inputs'. */
	readonly #heights = new Map<RelNode, number>()
	/** The scans and regions that declare each occurrence, indexed on the first occurrence a place is asked for. */
	#declarers: ReadonlyMap<OccurrenceId, ReadonlyArray<RelNode>> | undefined
	#digested = 0
	#units = 0

	constructor(
		labels: () => ReadonlyMap<NodeId, RelNode>,
		limit: number,
		sealed: (node: RelNode) => boolean,
		templates: DagTemplates
	) {
		this.#templates = templates
		this.#labels = new LabelIndex(labels)
		this.#limit = limit
		this.#sealed = sealed
		this.#line = unwrap(fingerprintDomain("share"))
	}

	/** How many blocks are digested: one for each node keyed, its own or a sealed node's under it. */
	get blocks(): number {
		return this.#digested
	}

	/** How many code units the blocks' tables hold, every block's once: the keying's work. */
	get units(): number {
		return this.#units
	}

	/** The share key of `node`: its block's digest (the class doc); a DAG it cannot key is refused. */
	key(node: RelNode): Result.Result<string, CompileError> {
		const keyed = catchRefusal(() => this.#key(node))
		if (!keyed.ok) {
			this.#messages.discard()
		}
		return keyed
	}

	/**
	 * The key of `root`, each sealed node its block meets keyed first, deepest first, so a chain of any depth keys with no
	 * deeper call stack; each block numbered once.
	 */
	#key(root: RelNode): string {
		const pending: Array<RelNode> = [root]
		for (let at = pending.at(-1); at !== undefined; at = pending.at(-1)) {
			if (this.#keys.has(at)) {
				pending.pop()
				continue
			}
			const block = this.#blocks.get(at) ?? this.#block(at)
			this.#blocks.set(at, block)
			const unkeyed = block.entries.flatMap((e) =>
				e.sealed && !this.#keys.has(e.node) ? [e.node] : []
			)
			if (unkeyed.length > 0) {
				appendAll(pending, unkeyed)
				continue
			}
			pending.pop()
			this.#keys.set(at, this.#digest(block))
		}
		return defined(this.#keys.get(root), "the key of the node asked")
	}

	/** The block of `root` (BlockNumbering), every node and expression it reads numbered. */
	#block(root: RelNode): BlockNumbering {
		const templates = this.#templates
		const labels = this.#labels
		const block = new BlockNumbering(root, () => labels.of(), this.#sealed)
		for (const met of block.met) {
			const template = met.kind === "node" ? templates.node(met.node) : templates.expr(met.expr)
			for (const naming of template.namings) {
				numbered(block, naming)
			}
		}
		return block
	}

	/**
	 * Where `node` stands under `block`: the block itself where it numbers the node; otherwise under the first sealed
	 * entry, in the block's numbering, that reaches it, there. Undefined where no sealed entry reaches it: a node outside
	 * what the block's root reaches.
	 */
	#place(block: BlockNumbering, node: RelNode): Place | undefined {
		let path = ""
		for (let at = block; ;) {
			if (at.nodes.has(node.id)) {
				return { path, block: at }
			}
			const seal = at.entries.find((e) => e.sealed && this.#reaches(e.node, node))
			if (seal === undefined) {
				return undefined
			}
			path = `${path}${at.nodes.nameOf(at.nodes.index(seal.node.id))}/`
			at = defined(this.#blocks.get(seal.node), "a sealed node's block, keyed first")
		}
	}

	/** The text a node `block` names but no data edge of it meets is written as: its place, or its label outside. */
	#nodeText(block: BlockNumbering, node: RelNode): string {
		const place = this.#place(block, node)
		return place === undefined
			? node.id
			: `${place.path}${place.block.nodes.nameOf(place.block.nodes.index(node.id))}`
	}

	/**
	 * The text an occurrence a node of `block` reads by, and no node it reads declares, is written as: its declarer's
	 * place, then its name in the block that reads the declarer, the least such text where several nodes declare it;
	 * undefined where no declarer stands under the block, so the block numbers it as its own.
	 */
	#occurrenceText(block: BlockNumbering, id: OccurrenceId): string | undefined {
		const texts = this.#declarersOf(id).flatMap((declarer) => {
			const place = this.#place(block, declarer)
			if (place === undefined) {
				return []
			}
			const at = place.block
			const index = at.nodes.index(declarer.id)
			const sealed = defined(at.entries[index], "the declarer's entry").sealed
			const reader = sealed
				? defined(this.#blocks.get(declarer), "a sealed declarer's block, keyed first")
				: at
			const path = sealed ? `${place.path}${at.nodes.nameOf(index)}/` : place.path
			return [`${path}${reader.occurrences.nameOf(reader.occurrences.index(id))}`]
		})
		return texts.toSorted().at(0)
	}

	/** Whether `node` lies under `from`: it is a node `from`'s inputs reach, every answer for `node` kept. */
	#reaches(from: RelNode, node: RelNode): boolean {
		if (this.#height(from) <= this.#height(node)) {
			return false
		}
		const known = this.#reaching.getOrInsertComputed(node, () => new Map([[node, true]]))
		const unknown = (n: RelNode): ReadonlyArray<RelNode> =>
			inputsOf(n).filter((i) => !known.has(i) && this.#height(i) >= this.#height(node))
		for (const at of postorder([from], unknown)) {
			known.set(
				at,
				inputsOf(at).some((i) => known.get(i) === true)
			)
		}
		return known.get(from) === true
	}

	/** The longest path from a node to a leaf, its inputs' worked out first. */
	#height(node: RelNode): number {
		const known = this.#heights.get(node)
		if (known !== undefined) {
			return known
		}
		const unknown = (n: RelNode): ReadonlyArray<RelNode> =>
			inputsOf(n).filter((i) => !this.#heights.has(i))
		for (const at of postorder([node], unknown)) {
			this.#heights.set(
				at,
				inputsOf(at).reduce(
					(h, i) => Math.max(h, defined(this.#heights.get(i), "an input's height") + 1),
					0
				)
			)
		}
		return defined(this.#heights.get(node), "the height asked")
	}

	/** The scans and regions of the DAG that declare an occurrence: a scan's own, and each of a region's. */
	#declarersOf(id: OccurrenceId): ReadonlyArray<RelNode> {
		const index =
			this.#declarers ??
			(() => {
				const made = new Map<OccurrenceId, Array<RelNode>>()
				for (const node of this.#labels.of().values()) {
					if (node.kind === "Base") {
						made.getOrInsertComputed(node.occurrence, () => []).push(node)
					} else if (node.kind === "MatchRegion") {
						for (const o of node.occurrences) {
							made.getOrInsertComputed(o.id, () => []).push(node)
						}
					}
				}
				return made
			})()
		this.#declarers = index
		return index.get(id) ?? []
	}

	/**
	 * The texts of what a block names under its sealed nodes: each node no data edge met (`named`), and each occurrence
	 * a node it reads reads by that none of them declares.
	 */
	#placed(block: BlockNumbering): void {
		for (const node of block.named) {
			if (!block.nodes.has(node.id)) {
				block.nodeTexts.set(node.id, this.#nodeText(block, node))
			}
		}
		const read = block.met.flatMap((m) => (m.kind === "node" ? [m.node] : []))
		const declared = new Set(
			read.flatMap((node) =>
				node.kind === "Base"
					? [node.occurrence]
					: node.kind === "MatchRegion"
						? node.occurrences.map((o) => o.id)
						: []
			)
		)
		for (const node of read) {
			for (const naming of this.#templates.node(node).namings) {
				if (
					naming.kind !== "occurrence" ||
					block.occurrenceTexts.has(naming.id) ||
					declared.has(naming.id)
				) {
					continue
				}
				const text = this.#occurrenceText(block, naming.id)
				if (text !== undefined) {
					block.occurrenceTexts.set(naming.id, text)
				}
			}
		}
	}

	/** A block's digest: its table, each sealed node's entry its key, under the share domain's frame. */
	#digest(block: BlockNumbering): string {
		this.#placed(block)
		const templates = this.#templates
		const exprs = block.met.flatMap((m) => (m.kind === "expr" ? [m.expr] : []))
		const deps = exprs.map((expr) => block.deps(expr))
		const out = this.#messages.out
		writeFrame(out, this.#line)
		const start = out.units
		out.ascii('{"exprs":{')
		for (const [at, index] of nameOrder(exprs.length).entries()) {
			const expr = defined(exprs[index], "an expression the block met")
			writeEntry(
				out,
				block,
				"e",
				index,
				at,
				templates.expr(expr),
				defined(deps[index], "its dependencies")
			)
			boundCanonicalText(out.units - start, this.#limit)
		}
		out.ascii('},"nodes":{')
		for (const [at, index] of nameOrder(block.entries.length).entries()) {
			const entry = defined(block.entries[index], "a node the block numbered")
			if (entry.sealed) {
				if (at > 0) {
					out.ascii(",")
				}
				writeName(out, "n", index)
				out.ascii(':"')
				out.ascii(defined(this.#keys.get(entry.node), "a sealed node's key, worked out first"))
				out.ascii('"')
			} else {
				writeEntry(out, block, "n", index, at, templates.node(entry.node), [])
			}
			boundCanonicalText(out.units - start, this.#limit)
		}
		out.ascii('},"roots":[')
		writeName(out, "n", 0)
		out.ascii("]}")
		boundCanonicalText(out.units - start, this.#limit)
		this.#digested += 1
		this.#units += out.units - start
		return this.#messages.hex()
	}
}
