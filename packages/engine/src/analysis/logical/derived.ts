import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type KeyProof, keyWith } from "#compiler/ir/keys.ts"
import { type HeadingColumn, type RelNode, unionArms } from "#compiler/ir/rel.ts"

/**
 * A key a derived or world relation inherits from its definition: its columns, columns of its heading in key order
 * (inheritedKeys),
 * and the proof that they are a key, whose factors' alternatives a Base over the view states beside it (ir/keys.ts
 * ViewKey alternatives): the root's proof has them, and a key one alternative away from it is proved alone.
 */
export interface InheritedKey<C extends HeadingColumn> {
	readonly columns: NonEmptyReadonlyArray<C>
	readonly proof: KeyProof
	/** The root's proof it is listed from: `proof` itself for the proof's own key, else the one it is an alternative of. */
	readonly root: KeyProof
}

/**
 * A definition's proved keys as a derived relation's keys, over its heading's columns: of each of the root's proofs
 * (logical/props.ts), its key, then each key one alternative away from it, each proved by its own derivation
 * (`prove`), each in key order, narrowest first, then by the key-order positions of their columns. Every other
 * minimal key of the definition chooses among its factors, which the first key's alternatives state, so a definition
 * of k independent factors of two keys each is k + 1 keys, each with its unique index, never 2^k. A key is over classes
 * of equal columns and states each class by its first column in heading order, so a view has one unique index per key
 * of its classes; another column of a class stands for its first (ViewKey members). When the root has the empty key,
 * at most one fact, the one key is the first heading column `representable` admits as a one-column key, or the whole
 * heading when it admits none (whose own check then refuses it), its proof the empty key's: every column of such a
 * relation is a key alone, so no order of its columns leads a read to one.
 *
 * Key order is the heading's with the columns the definition carries from a declared key first (keyCarried), every
 * other column after, each part in heading order. It is the order of the key's unique index and of the Base's key over
 * the view, so a read that binds the columns a definition takes from its sources' keys binds a prefix of every key it
 * holds them in, the per-key proof's (lower/optimize/cte-policy keyPrefixBound), whatever names its computed and value
 * columns have: pantry's MaxAttempts, keyed by its whole heading, led with `attempts`, a computed value, before the
 * package, path and scope its session control reads it at, so no read of it bound a prefix, and every child's item
 * sessions were derived for one sitting's resume (metis's `sitting`, cancelled at 20 minutes). The order changes no
 * key's columns, so no key's uniqueness.
 *
 * The keys a derived relation inherits from its definition.
 *
 * A derived relation is a Base over its stored table, and its keys are the ones its definition proves. The checker
 * types the Base by the definition's head, keys it by the whole heading under its own evidence, and stamps it with the
 * inherited keys (ir/rel.ts ViewBase view), which annotate (logical/annotate.ts) rewrites the Base to under evidence
 * that admits them. The checked schema computes them once, when it is built (analysis/derived/analyze.ts
 * analyzeDerivedRelation): it checks each definition, analyzes it with the lower levels' inherited keys, and reads the
 * root's keys, so the keys every compilation reads are the ones the view's unique indexes state. A root of one heading
 * group always proves its whole heading, so it has a minimal key; a definition proved to hold at most one fact proves
 * the empty key, which no unique index over plain columns states: every single column of it is then a key, and its
 * first column in heading order whose unique index entry is representable is the one key, so the index a query relies
 * on is the one the view has.
 */
export const inheritedKeys = <C extends HeadingColumn>(
	definition: RelNode,
	heading: NonEmptyReadonlyArray<C>,
	proved: ReadonlyArray<KeyProof>,
	prove: (columns: ReadonlyArray<string>) => KeyProof | undefined,
	representable: (column: C) => boolean
): ReadonlyArray<InheritedKey<C>> => {
	const carried = keyCarried(definition)
	const ordered = [
		...heading.filter((c) => carried.has(c.name)),
		...heading.filter((c) => !carried.has(c.name))
	]
	const keyOrder = isNonEmpty(ordered) ? ordered : heading
	const empty = proved.find((k) => k.key.length === 0)
	if (empty !== undefined) {
		const single = heading.find((c) => representable(c))
		return [{ columns: single === undefined ? heading : [single], proof: empty, root: empty }]
	}
	const position = new Map(keyOrder.map((c, i) => [c.name, i]))
	const at = (c: C) => defined(position.get(c.name), "a key's column is a column of its heading")
	const listed = proved.flatMap((root) => [
		{ proof: root, root },
		...root.factors.flatMap((f) =>
			f.alternatives.flatMap((a) => {
				const swapped = prove(keyWith(root, f, a))
				return swapped === undefined ? [] : [{ proof: swapped, root }]
			})
		)
	])
	return listed
		.flatMap(({ proof, root }): ReadonlyArray<InheritedKey<C>> => {
			const columns = keyOrder.filter((c) => proof.key.includes(c.name))
			return isNonEmpty(columns) ? [{ columns, proof, root }] : []
		})
		.toSorted((a, b) => {
			if (a.columns.length !== b.columns.length) {
				return a.columns.length - b.columns.length
			}
			for (const [i, c] of a.columns.entries()) {
				const d = at(c) - at(defined(b.columns[i], "two keys of one width"))
				if (d !== 0) {
					return d
				}
			}
			return 0
		})
}

/** Each node's key-carried columns (keyCarried), for as long as the node lives. */
const carriedOf = new WeakMap<RelNode, ReadonlySet<string>>()

/** No column. */
const none: ReadonlySet<string> = new Set()

/**
 * The columns of `node`'s heading its rows carry from a declared key of a relation it reads: a stored relation's
 * primary key and keys, a view's proven keys, a fold's grouping keys; through a region, each variable an occurrence binds
 * at such a column of its source; through a projection, each output that copies such a column of its input; through a
 * node keeping its input's rows (a filter, a step, a take, an ordered result, an existence test's or a set difference's
 * left side, an intersection's left side, an attachment's parent), its input's; through a union, those every arm
 * carries. Every other column, a computed value, a value column of a source, an aggregate, carries none: a set the
 * statement holds, a call's rows, a window's, a recursion's and a produced fact's columns among them.
 */
export const keyCarried = (node: RelNode): ReadonlySet<string> => {
	const known = carriedOf.get(node)
	if (known !== undefined) {
		return known
	}
	const own = new Set(node.heading.map((c) => c.name))
	const kept = (input: RelNode): ReadonlySet<string> =>
		new Set([...keyCarried(input)].filter((c) => own.has(c)))
	const carried = ((): ReadonlySet<string> => {
		switch (node.kind) {
			case "Base":
				return new Set(
					node.relationKind === "relation"
						? [...node.primaryKey, ...node.keys.flat()]
						: node.view.flatMap((k) => k.fields)
				)
			case "MatchRegion":
				return new Set(
					node.vars.flatMap((v) =>
						node.occurrences.some((o) =>
							o.bindings.some((b) => b.var === v && keyCarried(o.source).has(b.column))
						)
							? [v.name]
							: []
					)
				)
			case "ProjectSet":
				return new Set(
					node.out.flatMap((o) =>
						o.expr.kind === "column" &&
						o.expr.column.node === node.input.id &&
						keyCarried(node.input).has(o.expr.column.name)
							? [o.name]
							: []
					)
				)
			case "Filter":
			case "Step":
			case "Take":
			case "OrderedResult":
				return kept(node.input)
			case "SemiJoin":
			case "AntiJoin":
			case "Intersect":
			case "Difference":
				return kept(node.left)
			case "Attach":
				return kept(node.parent)
			case "Union": {
				const [arm, ...arms] = unionArms(node.groups)
				return new Set([...kept(arm)].filter((c) => arms.every((a) => keyCarried(a).has(c))))
			}
			case "Group":
				return new Set(node.keys)
			case "ApproximateNearest":
			case "Call":
			case "Closed":
			case "Context":
			case "Delta":
			case "Forbid":
			case "InputSet":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Window":
				return none
		}
	})()
	carriedOf.set(node, carried)
	return carried
}
