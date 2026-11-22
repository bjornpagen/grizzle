/**
 * A DAG's normal form, numbered once and written as share and evaluation keys from encoded templates (ir/dag.ts
 * normalizeWithin, dagDigestWithin; lower/shapes/share ShareIndex, lower/conservative/call/keys.ts EvaluationKeys).
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

import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import {
	boundCanonicalText,
	type CanonicalTemplate,
	catchRefusal,
	omitSourceLocs,
	Refusal,
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
 * labels and numbered as the walk's own (`followed`); or its label (`labelled`), so the form reads an enclosing node by
 * which it is, never by what it holds.
 */
export type OuterNames = "followed" | "labelled"

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
	/** Every node and expression met, in the order it was met: each namespace's in its numbers' order. */
	readonly met: Array<Reached> = []
	/** The context's labels, read only where a name the walk has not met needs its node. */
	readonly #labels: () => ReadonlyMap<NodeId, RelNode>
	/** What the roots reach by their inputs, where a name of a node outside it is its label (`labelled`). */
	readonly #reached: ReadonlySet<NodeId> | undefined

	constructor(labels: () => ReadonlyMap<NodeId, RelNode>, roots: Roots, outer: OuterNames) {
		this.#labels = labels
		this.#reached =
			outer === "labelled" ? new Set(postorder(roots, inputsOf).map((node) => node.id)) : undefined
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

	/** A name a node holds as the form writes it: its label outside the reach, its number's name inside. */
	labelName(id: NodeId): NodeId {
		return this.outside(id) ? id : this.nodes.nameOf(this.label(id))
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
					? label
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
	| { readonly kind: "expr"; readonly expr: ScalarExpr }
	| { readonly kind: "var"; readonly id: VarId }
	| { readonly kind: "occurrence"; readonly id: OccurrenceId }
	| { readonly kind: "scope"; readonly id: ScopeId }

/** Gives a naming its number in `numbering`, as normalizeReach numbers the name it holds. */
const numbered = (numbering: ReachNumbering, naming: Naming): void => {
	switch (naming.kind) {
		case "edge":
			numbering.edge(naming.node)
			return
		case "label":
			if (!numbering.outside(naming.label)) {
				numbering.label(naming.label)
			}
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

/** An expression's template (nodeTemplateOf): its arguments, its column's node, its own name and its dependencies. */
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
								name: args.column.name
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

/** A node's or an expression's structural signature (DagDigests signature), undefined where a template is refused. */
export type Signature = string | undefined

/**
 * Two FNV-1a 32-bit hashes of different offsets over a signature's bytes and parts, each part closed by a unit no part
 * holds: a signature's collisions cost a digest each, never a wrong class, so a fast hash suffices.
 */
class SignatureHash {
	#a = 0x811c9dc5
	#b = 0x01000193

	bytes(bytes: Uint8Array): void {
		for (const byte of bytes) {
			this.#unit(byte)
		}
	}

	text(part: string): void {
		for (let i = 0; i < part.length; i++) {
			this.#unit(part.charCodeAt(i))
		}
		this.#unit(0x10000)
	}

	#unit(unit: number): void {
		this.#a = Math.imul(this.#a ^ unit, 0x01000193)
		this.#b = Math.imul(this.#b ^ unit, 0x01000193) ^ (this.#b >>> 15)
	}

	done(): string {
		return `${(this.#a >>> 0).toString(36)}.${(this.#b >>> 0).toString(36)}`
	}
}

/**
 * The claimed-form digests of one DAG's sub-queries (share and evaluation keys), each node's and expression's
 * template written once, and every digest written by one writer (Sha256Messages), so a digest copies its reach's bytes
 * and builds no text. Its lifetime is its DAG's: a ShareIndex's, an EvaluationKeys'.
 */
export class DagDigests {
	/** The context's labels, read where a name a node holds is of a node the walk has not met. */
	readonly #labels: () => ReadonlyMap<NodeId, RelNode>
	#index: ReadonlyMap<NodeId, RelNode> | undefined
	readonly #nodes = new Map<RelNode, Template>()
	readonly #exprs = new Map<ScalarExpr, Template>()
	/** Each node's and expression's signature (signature), worked out on its first read. */
	readonly #signatures = new Map<RelNode | ScalarExpr, Signature>()
	readonly #messages = new Sha256Messages(messageChunk)
	/** The longest table text a digest writes, past which it is refused: V8's longest string in production. */
	readonly #limit: number
	#written = 0

	constructor(labels: () => ReadonlyMap<NodeId, RelNode>, limit: number) {
		this.#labels = labels
		this.#limit = limit
	}

	/** How many templates are written: one for each node and expression any digest reached, at most. */
	get written(): number {
		return this.#written
	}

	/** The digest under `domain` of what `roots` reach, its enclosing nodes read as `outer` says (OuterNames). */
	digest(roots: Roots, domain: string, outer: OuterNames): Result.Result<string, CompileError> {
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
	): Result.Result<string, CompileError> {
		return catchRefusal(() => {
			const numbering = new ReachNumbering(() => this.#context(), roots, outer)
			const rootNumbers = numberReach(numbering, roots, (met) => {
				const template =
					met.kind === "node" ? this.#nodeTemplate(met.node) : this.#exprTemplate(met.expr)
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
			const out = this.#messages.out
			writeFrame(out, line)
			const start = out.units
			out.ascii('{"exprs":{')
			for (const [at, index] of nameOrder(exprs.length).entries()) {
				const expr = defined(exprs[index], "an expression the numbering met")
				const template = this.#exprTemplate(expr)
				this.#entry(numbering, "e", index, at, template, defined(deps[index], "its dependencies"))
				boundCanonicalText(out.units - start, this.#limit)
			}
			out.ascii('},"nodes":{')
			for (const [at, index] of nameOrder(nodes.length).entries()) {
				const node = defined(nodes[index], "a node the numbering met")
				this.#entry(numbering, "n", index, at, this.#nodeTemplate(node), [])
				boundCanonicalText(out.units - start, this.#limit)
			}
			out.ascii('},"roots":[')
			for (const [at, index] of rootNumbers.entries()) {
				if (at > 0) {
					out.ascii(",")
				}
				this.#name("n", index)
			}
			out.ascii("]}")
			boundCanonicalText(out.units - start, this.#limit)
			return this.#messages.hex()
		})
	}

	/**
	 * A node's structural signature: its template's text with each hole read as what it names, the signature of a data
	 * input or of an expression, and the kind of any other name, folded into a hash. Two nodes of one digest have tables
	 * that correspond entry for entry, so their templates are one text and their inputs and expressions correspond: they
	 * have one signature. Two nodes of two signatures are of two digests, and need no digest to be told apart; two of one
	 * may still be of two, and are digested apart. Undefined where a template it reads is refused, so its reader digests
	 * the node, which refuses as it did. Each node's and expression's is worked out once, its inputs' and arguments'
	 * first, deepest first, so a chain of any depth signs with no deeper call stack.
	 */
	signature(node: RelNode): Signature {
		const known = this.#signatures.get(node)
		if (known !== undefined || this.#signatures.has(node)) {
			return known
		}
		const edges = (at: RelNode): ReadonlyArray<RelNode> =>
			this.#nodeTemplate(at).namings.flatMap((n) =>
				n.kind === "edge" && !this.#signatures.has(n.node) ? [n.node] : []
			)
		for (const at of postorder([node], edges)) {
			const template = this.#nodeTemplate(at)
			for (const naming of template.namings) {
				if (naming.kind === "expr") {
					this.#exprSignature(naming.expr)
				}
			}
			this.#signatures.set(at, this.#signed(template))
		}
		return this.#signatures.get(node)
	}

	/** An expression's signature (signature): its template's, its arguments' first. */
	#exprSignature(expr: ScalarExpr): void {
		if (this.#signatures.has(expr)) {
			return
		}
		const args = (at: ScalarExpr): ReadonlyArray<ScalarExpr> =>
			at.args.filter((arg) => !this.#signatures.has(arg))
		for (const at of postorder([expr], args)) {
			this.#signatures.set(at, this.#signed(this.#exprTemplate(at)))
		}
	}

	/**
	 * A template's signature: its pieces' bytes and, at each hole, the signature of the input or expression it names
	 * (each signed already) or the kind of the name, folded into two FNV-1a hashes; undefined where the template, or
	 * one it names, is refused.
	 */
	#signed(template: Template): Signature {
		const text = template.text
		if (!text.ok) {
			return undefined
		}
		const hash = new SignatureHash()
		const { pieces, holes } = text.value
		for (const [k, hole] of holes.entries()) {
			hash.bytes(defined(pieces[k], "a piece before each hole"))
			const naming = template.namings[hole]
			const part =
				naming === undefined
					? hole === template.namings.length
						? "own"
						: "deps"
					: naming.kind === "edge"
						? this.#signatures.get(naming.node)
						: naming.kind === "expr"
							? this.#signatures.get(naming.expr)
							: naming.kind
			if (part === undefined) {
				return undefined
			}
			hash.text(part)
		}
		hash.bytes(defined(pieces[holes.length], "the piece after the last hole"))
		return hash.done()
	}

	/** The context's labels, read once, where a digest first needs them. */
	#context(): ReadonlyMap<NodeId, RelNode> {
		const index = this.#index ?? this.#labels()
		this.#index = index
		return index
	}

	/** A node's template, written on its first read. */
	#nodeTemplate(node: RelNode): Template {
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
	#exprTemplate(expr: ScalarExpr): Template {
		const known = this.#exprs.get(expr)
		if (known !== undefined) {
			return known
		}
		const template = exprTemplateOf(expr)
		this.#exprs.set(expr, template)
		this.#written += 1
		return template
	}

	/**
	 * One entry of the table's text, the `at`-th of its record: its name, then its template's pieces, each hole filled
	 * with the name this digest gives it, its own name, or its dependencies; a template whose form is refused is
	 * refused here, at its entry.
	 */
	#entry(
		numbering: ReachNumbering,
		ns: "n" | "e",
		index: number,
		at: number,
		template: Template,
		deps: ReadonlyArray<NodeId>
	): void {
		const out = this.#messages.out
		if (at > 0) {
			out.ascii(",")
		}
		this.#name(ns, index)
		out.ascii(":")
		const text = template.text
		if (!text.ok) {
			const name = ns === "n" ? numbering.nodes.nameOf(index) : numbering.exprs.nameOf(index)
			throw new Refusal(within(text.error, [ns === "n" ? "nodes" : "exprs", name]))
		}
		const { pieces, units, holes } = text.value
		for (const [k, hole] of holes.entries()) {
			out.encoded(defined(pieces[k], "a piece before each hole"), defined(units[k], "its units"))
			const naming = template.namings[hole]
			if (naming !== undefined) {
				this.#naming(numbering, naming)
			} else if (hole === template.namings.length) {
				this.#name(ns, index)
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

	/** The name this digest gives what a naming names. */
	#naming(numbering: ReachNumbering, naming: Naming): void {
		switch (naming.kind) {
			case "edge":
				this.#name("n", numbering.nodes.index(naming.node.id))
				return
			case "label":
				if (numbering.outside(naming.label)) {
					writeCanonicalString(this.#messages.out, wellFormed(naming.label))
				} else {
					this.#name("n", numbering.nodes.index(naming.label))
				}
				return
			case "expr":
				this.#name("e", numbering.exprs.index(naming.expr.id))
				return
			case "var":
				this.#name("v", numbering.vars.index(naming.id))
				return
			case "occurrence":
				this.#name("o", numbering.occurrences.index(naming.id))
				return
			case "scope":
				this.#name("s", numbering.scopes.index(naming.id))
				return
		}
	}

	/** A name "<ns>#<i>" written as its JSON string, no text of it built. */
	#name(ns: Namespace, index: number): void {
		const out = this.#messages.out
		out.ascii(quoted[ns])
		out.jsonNumber(index)
		out.ascii('"')
	}
}
