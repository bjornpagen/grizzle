import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { compareIdentities, type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { IdentityKind, LawId } from "#compiler/core/ids.ts"
import {
	combineAll,
	type Comparator,
	compareNumbers,
	compareStrings,
	mapInput,
	thenBy
} from "#compiler/core/order.ts"

import {
	type DeployPhase,
	type InstallationManifest,
	type PhysicalKind,
	type PhysicalObject,
	type PhysicalReason,
	physicalKinds
} from "#compiler/ir/products.ts"
import {
	type ObjectName,
	type QualifiedFunctionRef,
	type SqlStatement,
	stubBody,
	type TypeRef
} from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	type NameSpace,
	transformStatement
} from "#compiler/sql/transform.ts"

/** A graph identity as the manifest spells it, the key of an object in the manifest: `<kind>:<name>` for a schema, an
 * extension, a role, a role's membership in its login or a role's privileges; `<kind>:<schema>.<name>` for an object
 * of a schema, a view in a schema of views among them, and for a table's row security; `<kind>:<schema>.<relation>.<name>` for
 * a column, a constraint, a trigger or a policy of a relation. PostgreSQL never sees them. The graph spells its nodes'
 * identities (`NodeIdent`) through `identText`, the snapshot's own objects through namedIdent, qualifiedIdent and
 * innerIdent, and a manifest read back is parsed through parseIdent, so the format has one spelling. Any other
 * spelling, such as a validation's identity, which names no kind, parses as other. */
type NamedKind = "schema" | "extension" | "role" | "membership" | "privileges" | "publication"
export type QualifiedKind =
	| "domain"
	| "type"
	| "table"
	| "view"
	| "index"
	| "statistics"
	| "function"
	| "rowSecurity"
	| "replicaIdentity"
type InnerKind = "column" | "constraint" | "trigger" | "policy"

export type GraphIdent =
	| { readonly kind: NamedKind; readonly name: string }
	| { readonly kind: QualifiedKind; readonly schema: string; readonly name: string }
	| {
			readonly kind: InnerKind
			readonly schema: string
			readonly relation: string
			readonly name: string
	  }
	| { readonly kind: "other"; readonly text: string }

export const namedIdent = (kind: NamedKind, name: string): string => `${kind}:${name}`

export const qualifiedIdent = (kind: QualifiedKind, schema: string, name: string): string =>
	`${kind}:${schema}.${name}`

export const innerIdent = (
	kind: InnerKind,
	schema: string,
	relation: string,
	name: string
): string => `${kind}:${schema}.${relation}.${name}`

const namedKinds: ReadonlyArray<NamedKind> = [
	"schema",
	"extension",
	"role",
	"membership",
	"privileges",
	"publication"
]

const qualifiedKinds: ReadonlyArray<QualifiedKind> = [
	"domain",
	"type",
	"table",
	"view",
	"index",
	"statistics",
	"function",
	"rowSecurity",
	"replicaIdentity"
]
const innerKinds: ReadonlyArray<InnerKind> = ["column", "constraint", "trigger", "policy"]

const isOneOf = <K extends string>(kinds: ReadonlyArray<K>, text: string): text is K =>
	kinds.some((k) => k === text)

/** A graph identity read once. */
export const parseIdent = (ident: string): GraphIdent => {
	const colon = ident.indexOf(":")
	const kind = ident.slice(0, Math.max(0, colon))
	const rest = ident.slice(colon + 1)
	const dot = rest.indexOf(".")
	if (colon > 0 && isOneOf(namedKinds, kind)) {
		return { kind, name: rest }
	}
	if (colon > 0 && dot > 0 && isOneOf(qualifiedKinds, kind)) {
		return { kind, schema: rest.slice(0, dot), name: rest.slice(dot + 1) }
	}
	const inner = rest.indexOf(".", dot + 1)
	if (colon > 0 && dot > 0 && inner > dot + 1 && isOneOf(innerKinds, kind)) {
		return {
			kind,
			schema: rest.slice(0, dot),
			relation: rest.slice(dot + 1, inner),
			name: rest.slice(inner + 1)
		}
	}
	return { kind: "other", text: ident }
}

/**
 * The namespaces a statement names an object of each qualified kind in (sql/transform.ts NameSpace): a table and a view
 * also as the row type PostgreSQL creates under its name. A row security, a replica identity and a table's declared
 * statistics, which hold no catalog object of their own, are named by no statement but their own.
 */
const namedIn: Readonly<Record<QualifiedKind, ReadonlyArray<NameSpace>>> = {
	domain: ["type"],
	type: ["type"],
	table: ["relation", "type"],
	view: ["relation", "type"],
	index: ["relation"],
	statistics: [],
	function: ["function"],
	rowSecurity: [],
	replicaIdentity: []
}

/** A schema object's name in the namespace a statement names it in. */
const nameKey = (namespace: NameSpace, schema: string, name: string): string =>
	`${namespace}\u0000${schema}\u0000${name}`

/** An object of a manifest by its identity (the `<kind>:<names>` key) and its statements. */
interface Stated {
	readonly ident: string
	readonly ddl: ReadonlyArray<SqlStatement>
}

/** An edge of a manifest: `to` is created after `from`. */
interface Edge {
	readonly from: string
	readonly to: string
}

/**
 * The edges of what each object of `of` names among `objects`: `from` each other object of `objects` a statement of
 * `to` names, as PostgreSQL resolves the statement when it runs it, by every name sql/transform.ts walks (an object's
 * name in its namespace, a table's, a view's row type among them, a named type a column, a
 * cast or a literal names, a qualified function) and the schema of each, a PL/pgSQL function by its header alone.
 * PostgreSQL resolves each such name as it creates the object, so each named object is one it is created after,
 * whatever the object's addition states: a table whose CHECK casts a literal to a roster's bits domain, which no column
 * of it is typed by, is created after the domain. The one source of the edges no addition states, which the install
 * order reads (ObligationGraph order) and every manifest records (deploy/snapshot/build.ts targetState).
 */
export const namedEdges = (
	objects: ReadonlyArray<Stated>,
	of: ReadonlyArray<Stated>
): ReadonlyArray<Edge> => {
	const schemas = new Map<string, string>()
	const byName = new Map<string, string>()
	for (const o of objects) {
		const ident = parseIdent(o.ident)
		switch (ident.kind) {
			case "schema":
				schemas.set(ident.name, o.ident)
				break
			case "domain":
			case "type":
			case "table":
			case "view":
			case "index":
			case "statistics":
			case "function":
			case "rowSecurity":
			case "replicaIdentity":
				for (const namespace of namedIn[ident.kind]) {
					byName.set(nameKey(namespace, ident.schema, ident.name), o.ident)
				}
				break
			case "extension":
			case "role":
			case "membership":
			case "privileges":
			case "publication":
			case "column":
			case "constraint":
			case "trigger":
			case "policy":
			case "other":
				break
		}
	}
	return of.flatMap((o) => {
		const from = new Set<string>()
		const named = (namespace: NameSpace, schema: string, name: string): void => {
			for (const ident of [byName.get(nameKey(namespace, schema, name)), schemas.get(schema)]) {
				if (ident !== undefined && ident !== o.ident) {
					from.add(ident)
				}
			}
		}
		const hooks: AstHooks = {
			...identityHooks,
			objectName: (n: ObjectName, namespace: NameSpace): ObjectName => {
				named(namespace, n.schema, n.name)
				return n
			},
			typeRef: (t: TypeRef): TypeRef => {
				if (t.kind === "named") {
					named("type", t.schema, t.name)
				}
				return t
			},
			functionRef: (f: QualifiedFunctionRef): QualifiedFunctionRef => {
				named("function", f.schema, f.name)
				return f
			}
		}
		for (const s of o.ddl) {
			transformStatement(
				s.kind === "createFunction" && s.language === "plpgsql" ? { ...s, body: stubBody } : s,
				hooks
			)
		}
		return [...from].map((f) => ({ from: f, to: o.ident }))
	})
}

/** A name the naming door minted, with the identity it was minted from. */
type Minted = Identity<IdentityKind>

/**
 * The identity of an object of the graph, each name it spells carried with the identity the naming door minted it from:
 * a schema, a role, a role's membership in its login or a role's privileges by its name; an object of a schema by the
 * schema's and its own; a column, a constraint, a trigger or a policy by its schema's, its relation's and its own; an
 * extension by the name PostgreSQL knows it by; and an object no kind names (a database default, a validation) by its
 * text. It spells the manifest's `<kind>:<names>` key (`identText`).
 */
export type NodeIdent =
	| { readonly kind: Exclude<NamedKind, "extension">; readonly name: Minted }
	| { readonly kind: "extension"; readonly name: string }
	| { readonly kind: QualifiedKind; readonly schema: Minted; readonly name: Minted }
	| {
			readonly kind: InnerKind
			readonly schema: Minted
			readonly relation: Minted
			readonly name: Minted
	  }
	| { readonly kind: "text"; readonly text: string }

/** The manifest key `ident` spells. */
export const identText = (ident: NodeIdent): string => {
	switch (ident.kind) {
		case "schema":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
			return namedIdent(ident.kind, identifierOf(ident.name))
		case "extension":
			return namedIdent(ident.kind, ident.name)
		case "text":
			return ident.text
		case "domain":
		case "type":
		case "table":
		case "view":
		case "index":
		case "statistics":
		case "function":
		case "rowSecurity":
		case "replicaIdentity":
			return qualifiedIdent(ident.kind, identifierOf(ident.schema), identifierOf(ident.name))
		case "column":
		case "constraint":
		case "trigger":
		case "policy":
			return innerIdent(
				ident.kind,
				identifierOf(ident.schema),
				identifierOf(ident.relation),
				identifierOf(ident.name)
			)
	}
}

/**
 * A name a graph identity spells, as the installation orders it: a hashed name by the identity it was minted from,
 * whose digest is no order and differs between installations; a readable one by its text, which spells its identity
 * (a declared name's conversion, `<schema>__<name>`, a fixed grizzle name, or PostgreSQL's own name for an extension)
 * and so orders the objects of any installation alike.
 */
type OrderedName =
	| { readonly kind: "hashed"; readonly identity: Minted }
	| { readonly kind: "readable"; readonly name: string }

const ordered = (name: Minted): OrderedName =>
	name.form === "hashed"
		? { kind: "hashed", identity: name }
		: { kind: "readable", name: identifierOf(name) }

/** An object's place among the objects of its phase and kind: its graph identity's kind, then its names. */
interface ObjectKey {
	readonly kind: NodeIdent["kind"]
	readonly names: ReadonlyArray<OrderedName>
}

const keyOf = (ident: NodeIdent): ObjectKey => {
	switch (ident.kind) {
		case "schema":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
			return { kind: ident.kind, names: [ordered(ident.name)] }
		case "extension":
			return { kind: ident.kind, names: [{ kind: "readable", name: ident.name }] }
		case "text":
			return { kind: ident.kind, names: [{ kind: "readable", name: ident.text }] }
		case "domain":
		case "type":
		case "table":
		case "view":
		case "index":
		case "statistics":
		case "function":
		case "rowSecurity":
		case "replicaIdentity":
			return { kind: ident.kind, names: [ordered(ident.schema), ordered(ident.name)] }
		case "column":
		case "constraint":
		case "trigger":
		case "policy":
			return {
				kind: ident.kind,
				names: [ordered(ident.schema), ordered(ident.relation), ordered(ident.name)]
			}
	}
}

const compareOrderedNames = (a: OrderedName, b: OrderedName): number =>
	a.kind === "hashed"
		? b.kind === "hashed"
			? compareIdentities(a.identity, b.identity)
			: 1
		: b.kind === "hashed"
			? -1
			: compareStrings(a.name, b.name)

const compareKeys = (a: ObjectKey, b: ObjectKey): number => {
	const kind = compareStrings(a.kind, b.kind)
	if (kind !== 0) {
		return kind
	}
	for (const [i, x] of a.names.entries()) {
		const y = b.names[i]
		if (y === undefined) {
			return 1
		}
		const order = compareOrderedNames(x, y)
		if (order !== 0) {
			return order
		}
	}
	return a.names.length === b.names.length ? 0 : -1
}

export const phaseOrder: ReadonlyArray<DeployPhase> = [
	"setup",
	"structure",
	"indexes",
	"validate",
	"publish"
]

/** The phases an object of each phase may be created after: its own and every earlier one. */
interface AtOrBefore {
	readonly setup: "setup"
	readonly structure: "setup" | "structure"
	readonly indexes: "setup" | "structure" | "indexes"
	readonly validate: "setup" | "structure" | "indexes" | "validate"
	readonly publish: DeployPhase
}

/** The phases an object of phase `P` may be created after: those at or before every phase `P` admits, so an object
 * whose phase is known only as a union may be created after nothing later than the earliest of them. */
export type Before<P extends DeployPhase> = (
	P extends DeployPhase ? (phase: AtOrBefore[P]) => void : never
) extends (phase: infer B extends DeployPhase) => void
	? B
	: never

const phaseRank = (phase: DeployPhase): number => phaseOrder.indexOf(phase)
/** Each kind's rank among the objects of one phase, the kinds' order (`physicalKinds`). */
const kindRank = (kind: PhysicalKind): number => physicalKinds.indexOf(kind)

type InstallObject = PhysicalObject<SqlStatement>

export interface ObjectSpec<P extends DeployPhase> {
	readonly kind: PhysicalKind
	readonly ident: NodeIdent
	readonly ddl: ReadonlyArray<SqlStatement>
	readonly reasons: ReadonlyArray<PhysicalReason>
	readonly phase: P
}

const reasonKey = (r: PhysicalReason): string => {
	switch (r.kind) {
		case "law":
			return `law\u0000${r.law}`
		case "access":
			return "access"
		case "enforcement":
			return `enforcement\u0000${r.of}`
		case "proof":
			return `proof\u0000${r.premises.join("\u0000")}`
	}
}

/** `reasons`, each once, in the order first given. */
const distinct = (reasons: ReadonlyArray<PhysicalReason>): ReadonlyArray<PhysicalReason> => {
	const seen = new Set<string>()
	return reasons.filter((r) => {
		const key = reasonKey(r)
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
}

export const lawReasons = (laws: ReadonlyArray<LawId>): ReadonlyArray<PhysicalReason> =>
	laws.map((law) => ({ kind: "law", law }))

export const enforcement = (of: string): PhysicalReason => ({ kind: "enforcement", of })

/**
 * An object of an obligation graph in phase `P`: the handle `add` returns, which a later object names as one it is
 * created after. Only `add` mints one, so every node an object names is in its graph, and was added before it.
 */
class GraphNode<P extends DeployPhase> {
	readonly kind: PhysicalKind
	readonly ident: NodeIdent
	/** Its manifest key (`identText`). */
	readonly text: string
	readonly key: ObjectKey
	readonly ddl: ReadonlyArray<SqlStatement>
	readonly reasons: ReadonlyArray<PhysicalReason>
	readonly phase: P
	/** The nodes it is created after, each once: every one added before it, of its phase or an earlier one. */
	readonly after: ReadonlySet<GraphNode<DeployPhase>>

	constructor(spec: ObjectSpec<P>, after: ReadonlyArray<GraphNode<DeployPhase>>) {
		this.kind = spec.kind
		this.ident = spec.ident
		this.text = identText(spec.ident)
		this.key = keyOf(spec.ident)
		this.ddl = spec.ddl
		this.reasons = spec.reasons
		this.phase = spec.phase
		this.after = new Set(after)
	}
}

export type Node<P extends DeployPhase> = GraphNode<P>

/** The install order's priority among the objects ready at once: phase, then kind, then identity. */
const priority: Comparator<Node<DeployPhase>> = combineAll([
	mapInput(compareNumbers, (o: Node<DeployPhase>) => phaseRank(o.phase)),
	mapInput(compareNumbers, (o: Node<DeployPhase>) => kindRank(o.kind)),
	mapInput(compareKeys, (o: Node<DeployPhase>) => o.key)
])

/** The obligation graph, the source of the InstallationManifest. The schema pass emits a deterministic dependency graph
 * of physical objects, not DDL strings. Each object carries its DDL as SQL AST statements, the reasons it exists (a law
 * identity, the workload's access, or the enforcement of a declaration such as a relation's table), its state, and the
 * deployment phase its DDL belongs to. One law can require several objects, and an object a later request reuses (a
 * key index serving a law's probe) takes that request's reasons (`addReasons`).
 *
 * Each object is added after the objects it is created after (`to` depends on `from`) that its statements do not name,
 * each named by the handle its own addition returned and each of its phase or an earlier one; every object its
 * statements name it is created after too (namedEdges), which the graph reads off the statements, so no addition can
 * leave one out, and one of a later phase is refused as a defect of the additions. So the graph is acyclic and its
 * edges follow the phase order by construction. The install order is a topological order of the edges that is also
 * ordered by phase, Setup, Structure, Indexes, Validate, Publish, which refines the dependency order: namespaces;
 * constants, domains and helper types; tables, columns and identities; native references; the refusal function, law
 * functions and their triggers; stored tables; key, law and workload indexes; validation; grants and publication.
 * Ties are broken by a fixed kind rank and then by the objects' names, a hashed name by the identity it was minted
 * from, never by its digest, which is no order: equal inputs produce one order byte for byte, and two installations of
 * one schema one order.
 *
 * A freshly compiled object is `needed`: only installation and catalog validation establish the later states, created,
 * building, validated and trusted, which the deployment package records. The manifest holds the objects in install
 * order with every edge, the PUBLIC revokes and the role defaults. */
/** A ready object, and the place it took among the ready ones, which breaks a tie of `priority`. */
interface Ready {
	readonly node: Node<DeployPhase>
	readonly at: number
}

/** The first of two ready objects: by `priority`, then by when it became ready. */
const readyFirst = (a: Ready, b: Ready): number => priority(a.node, b.node) || a.at - b.at

/** The ready objects of an install order, a binary heap under `readyFirst`: its least on top. */
class ReadyHeap {
	readonly #heap: Array<Ready> = []
	#pushed = 0

	/** The object at a place the heap holds. */
	#at(i: number): Ready {
		return defined(this.#heap[i], "a ready object at a place within the heap")
	}

	#swap(i: number, j: number): void {
		const a = this.#at(i)
		this.#heap[i] = this.#at(j)
		this.#heap[j] = a
	}

	push(node: Node<DeployPhase>): void {
		this.#heap.push({ node, at: this.#pushed })
		this.#pushed += 1
		let i = this.#heap.length - 1
		while (i > 0) {
			const up = (i - 1) >> 1
			if (readyFirst(this.#at(i), this.#at(up)) >= 0) {
				return
			}
			this.#swap(i, up)
			i = up
		}
	}

	/** The least ready object, taken off the heap; none once the heap is empty. */
	pop(): Node<DeployPhase> | undefined {
		const top = this.#heap[0]
		if (top === undefined) {
			return undefined
		}
		const last = this.#at(this.#heap.length - 1)
		this.#heap.pop()
		if (this.#heap.length > 0) {
			this.#heap[0] = last
			this.#sink(0)
		}
		return top.node
	}

	#sink(from: number): void {
		const size = this.#heap.length
		let i = from
		for (;;) {
			const left = 2 * i + 1
			const right = left + 1
			let least = i
			if (left < size && readyFirst(this.#at(left), this.#at(least)) < 0) {
				least = left
			}
			if (right < size && readyFirst(this.#at(right), this.#at(least)) < 0) {
				least = right
			}
			if (least === i) {
				return
			}
			this.#swap(i, least)
			i = least
		}
	}
}

export class ObligationGraph {
	/** Every object by its manifest key (`identText`), each identity once (`add`), in the order they were added. */
	readonly #nodes = new Map<string, Node<DeployPhase>>()
	readonly #reasons = new Map<Node<DeployPhase>, Array<PhysicalReason>>()

	/**
	 * Adds an object, created after each of `after`. An identity names one object PostgreSQL installs, so a second object
	 * of an identity the graph holds is a defect of the additions, never an object: the manifest would hold the identity
	 * twice, the later statements replacing the earlier, and the drift check would record two proofs of one object,
	 * which its proofs' key refuses (deploy/ledger/ledger.ts proofsTable; qti's judge, whose every block of a
	 * containment of one relation's selection in another of it stood twice).
	 */
	add<P extends DeployPhase>(
		spec: ObjectSpec<P>,
		after: ReadonlyArray<Node<Before<NoInfer<P>>>>
	): Node<P> {
		const node = new GraphNode(spec, after)
		if (this.#nodes.has(node.text)) {
			throw defect(`physical: two objects of the identity ${node.text}`)
		}
		this.#nodes.set(node.text, node)
		return node
	}

	/** Adds reasons to an object: a law-maintenance request a key index already serves. */
	addReasons(node: Node<DeployPhase>, reasons: ReadonlyArray<PhysicalReason>): void {
		appendAll(
			this.#reasons.getOrInsertComputed(node, () => []),
			reasons
		)
	}

	/**
	 * What each object is created after: each object its addition states, and each its statements name (namedEdges),
	 * whether or not its addition states it. A named object stands in the object's phase or an earlier one, as every
	 * stated one does; one of a later phase is a defect of the graph's additions, which no phase's file could create.
	 */
	#createdAfter(): ReadonlyMap<Node<DeployPhase>, ReadonlySet<Node<DeployPhase>>> {
		const nodes = [...this.#nodes.values()]
		const after = new Map(nodes.map((n) => [n, new Set(n.after)] as const))
		const stated = nodes.map((n) => ({ ident: n.text, ddl: n.ddl }))
		for (const e of namedEdges(stated, stated)) {
			const from = defined(this.#nodes.get(e.from), "a named object of the graph")
			const to = defined(this.#nodes.get(e.to), "an object of the graph")
			if (phaseRank(from.phase) > phaseRank(to.phase)) {
				throw defect(
					`physical: ${e.to}, of phase ${to.phase}, names ${e.from}, of phase ${from.phase}`
				)
			}
			defined(after.get(to), "an object of the graph").add(from)
		}
		return after
	}

	/**
	 * Every object in install order: Kahn's order over what each is created after (#createdAfter), each step taking the
	 * ready object first by `priority`, two equal ones in the order they became ready, from a heap of the ready objects,
	 * so the order costs n log n in its objects.
	 */
	order(): ReadonlyArray<InstallObject> {
		return this.#orderOver(this.#createdAfter())
	}

	#orderOver(
		after: ReadonlyMap<Node<DeployPhase>, ReadonlySet<Node<DeployPhase>>>
	): ReadonlyArray<InstallObject> {
		const waiting = new Map<Node<DeployPhase>, number>()
		const next = new Map<Node<DeployPhase>, Array<Node<DeployPhase>>>()
		const afterOf = (node: Node<DeployPhase>): ReadonlySet<Node<DeployPhase>> =>
			defined(after.get(node), "an object of the graph")
		for (const node of this.#nodes.values()) {
			waiting.set(node, afterOf(node).size)
			for (const from of afterOf(node)) {
				next.getOrInsertComputed(from, () => []).push(node)
			}
		}
		const ready = new ReadyHeap()
		for (const node of [...this.#nodes.values()]
			.filter((n) => afterOf(n).size === 0)
			.toSorted(priority)) {
			ready.push(node)
		}
		const out: Array<InstallObject> = []
		for (let node = ready.pop(); node !== undefined; node = ready.pop()) {
			out.push(this.#object(node))
			for (const to of next.get(node) ?? []) {
				const n = (waiting.get(to) ?? 0) - 1
				waiting.set(to, n)
				if (n === 0) {
					ready.push(to)
				}
			}
		}
		return out
	}

	/** The manifest: the objects in install order with every edge (#createdAfter), ordered by their objects'
	 * identities, the PUBLIC revokes and the role defaults. */
	manifest(extra: {
		readonly roleDefaults: ReadonlyArray<SqlStatement>
		readonly publicRevokes: ReadonlyArray<SqlStatement>
	}): Omit<InstallationManifest<SqlStatement>, "comments"> {
		const after = this.#createdAfter()
		return {
			objects: this.#orderOver(after),
			edges: [...this.#nodes.values()]
				.flatMap((to) =>
					[...defined(after.get(to), "an object of the graph")].map((from) => ({ from, to }))
				)
				.toSorted(
					thenBy(
						mapInput(compareKeys, (e) => e.from.key),
						mapInput(compareKeys, (e) => e.to.key)
					)
				)
				.map((e) => ({ from: e.from.text, to: e.to.text })),
			roleDefaults: extra.roleDefaults,
			publicRevokes: extra.publicRevokes
		}
	}

	#object(node: Node<DeployPhase>): InstallObject {
		return {
			kind: node.kind,
			ident: node.text,
			ddl: node.ddl,
			reasons: distinct([...node.reasons, ...(this.#reasons.get(node) ?? [])]),
			/** A compiled object is needed: the deploy's phases, not the compiler, move it on. */
			state: "needed",
			phase: node.phase
		}
	}
}
