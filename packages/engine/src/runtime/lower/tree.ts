import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Heading, HeadingColumn, NodeOf } from "#compiler/ir/rel.ts"
import { plainType } from "#compiler/scalar/native.ts"

/** A parent key column: the parent statement's own column it reads, and its position `at` in that statement's heading. */
export interface KeyColumn extends HeadingColumn {
	readonly at: number
}

/**
 * What a statement delivers: the query's rows, or one heading group of a heterogeneous union delivered to the host (its
 * group index).
 */
export type RowsRole =
	| { readonly kind: "main" }
	| { readonly kind: "headingGroup"; readonly group: number }

/**
 * What a statement delivers, and so what it carries: rows, or an attachment's children. An attachment statement's output
 * columns are the parent key the children belong to, `parentKey`, named as the parent statement's own columns they read,
 * each at its position in the parent's heading, then its own, the child's heading (the statement's `heading`). The two
 * are separate namespaces: a child column may share a parent key column's name. The statement computes its parent's
 * rows itself, in the same snapshot; its parent is the statement whose tree holds it (StatementTree).
 */
export type StatementRole =
	| RowsRole
	| { readonly kind: "attachment"; readonly parentKey: ReadonlyArray<KeyColumn> }

/** The name of the private column a zero-column relation carries. */
export const unitColumn = "__unit"

const unitHeading: Heading = Object.freeze([{ name: unitColumn, type: plainType("bool") }])

/** The output columns of a delivered relation: its heading, or the private unit column. */
export const deliveredHeading = (heading: Heading): Heading =>
	heading.length === 0 ? unitHeading : heading

const noKey: ReadonlyArray<KeyColumn> = Object.freeze([])

/** The output columns a statement's role puts before its own: an attachment's parent key, none otherwise. */
export const keyColumns = (role: StatementRole): ReadonlyArray<KeyColumn> =>
	role.kind === "attachment" ? role.parentKey : noKey

/**
 * A statement's SQL output columns, position by position: the columns its role puts first (an attachment's parent key),
 * then its delivered relation's (deliveredHeading), which `heading` types and a decoder reads, then one array column
 * per attachment fused into it (none in a conservative statement). It is the one statement of a statement's columns:
 * every reader that names, counts, positions, casts or decodes them reads it.
 */
export interface StatementOutput<F> {
	readonly heading: Heading
	readonly fused: ReadonlyArray<F>
	/** Every output column's name, position by position: the heading's, then each fused attachment's. */
	readonly names: ReadonlyArray<string>
	/** The position of the delivered relation's i-th column, after the columns its role puts first. */
	readonly own: (i: number) => number
	/** The position of the j-th fused attachment's column, after the heading's. */
	readonly fusedAt: (j: number) => number
}

export const statementOutput = <F extends { readonly name: string }>(
	role: StatementRole,
	own: Heading,
	fused: ReadonlyArray<F>
): StatementOutput<F> => {
	const key = keyColumns(role)
	const delivered = deliveredHeading(own)
	const heading = key.length === 0 ? delivered : [...key, ...delivered]
	return {
		heading,
		fused,
		names: [...heading.map((c) => c.name), ...fused.map((f) => f.name)],
		own: (i) => key.length + i,
		fusedAt: (j) => heading.length + j
	}
}

/**
 * A delivered statement of a program, the main statement or a heading group's, or an attachment statement, with the
 * attachment statements stitched onto its rows, in emission order: each attachment's parent is the statement whose tree
 * holds it.
 */
export interface StatementTree<S> {
	readonly statement: S
	readonly attachments: ReadonlyArray<AttachedTree<S>>
}

/** An attachment statement under its parent's rows: the Attach node whose children it delivers. */
export interface AttachedTree<S> extends StatementTree<S> {
	readonly attach: NodeOf<"Attach">
}

/** A program's delivered statements, its main statement or one per heading group in group order, each with its tree. */
export type StatementRoots<S> = NonEmptyReadonlyArray<StatementTree<S>>

/** Each statement of `roots` mapped by `f`, with its position in flight order, the tree kept. */
export const mapTree = <A, B>(
	roots: StatementRoots<A>,
	f: (statement: A, position: number) => B
): StatementRoots<B> => {
	let position = 0
	const attached = (tree: AttachedTree<A>): AttachedTree<B> => {
		const statement = f(tree.statement, position++)
		return { statement, attach: tree.attach, attachments: tree.attachments.map(attached) }
	}
	return mapNonEmpty(roots, (tree): StatementTree<B> => {
		const statement = f(tree.statement, position++)
		return { statement, attachments: tree.attachments.map(attached) }
	})
}

/**
 * Each statement of `roots` mapped by `f`, with its position in flight order, the tree kept; or the first refusal, in
 * flight order.
 */
export const traverseTree = <A, B, E>(
	roots: StatementRoots<A>,
	f: (statement: A, position: number) => Result.Result<B, E>
): Result.Result<StatementRoots<B>, E> => {
	let position = 0
	const attached = (
		trees: ReadonlyArray<AttachedTree<A>>
	): Result.Result<ReadonlyArray<AttachedTree<B>>, E> => {
		const out: Array<AttachedTree<B>> = []
		for (const tree of trees) {
			const statement = f(tree.statement, position++)
			if (!statement.ok) {
				return statement
			}
			const attachments = attached(tree.attachments)
			if (!attachments.ok) {
				return attachments
			}
			out.push({ statement: statement.value, attach: tree.attach, attachments: attachments.value })
		}
		return Result.ok(out)
	}
	const tree = (root: StatementTree<A>): Result.Result<StatementTree<B>, E> => {
		const statement = f(root.statement, position++)
		if (!statement.ok) {
			return statement
		}
		return Result.map(attached(root.attachments), (attachments) => ({
			statement: statement.value,
			attachments
		}))
	}
	const [first, ...rest] = roots
	const head = tree(first)
	if (!head.ok) {
		return head
	}
	const out: [StatementTree<B>, ...Array<StatementTree<B>>] = [head.value]
	for (const root of rest) {
		const next = tree(root)
		if (!next.ok) {
			return next
		}
		out.push(next.value)
	}
	return Result.ok(out)
}
