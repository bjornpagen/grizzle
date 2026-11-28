import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { type TextsId, TextsMap } from "#compiler/core/text.ts"
import type { ListChange } from "#compiler/live/events.ts"
import { formOf, type KeyFields, keyOf, type RowKey } from "#compiler/live/key.ts"

/** One row of a read's value: its key, the key's form, and the row. */
export interface Entry<Row> {
	readonly key: RowKey
	readonly form: TextsId
	readonly row: Row
}

/** An entry as its value links it into order, which only the value that holds it changes, before it is shared. */
interface Node<Row> extends Entry<Row> {
	prev: Node<Row> | undefined
	next: Node<Row> | undefined
}

/**
 * A read's value: its rows by key (keyOf under its key fields), in the read's order, its key's where it states none. A
 * value is never changed once shared: applying changes to it answers a new value (applying), so a caller may hold every
 * value it was given.
 */
export class KeyedList<Row extends object> implements Iterable<Row> {
	readonly fields: KeyFields
	readonly #nodes = new TextsMap<Node<Row>>()
	#head: Node<Row> | undefined = undefined
	#tail: Node<Row> | undefined = undefined

	private constructor(fields: KeyFields) {
		this.fields = fields
	}

	/** The value with no row, keyed by `fields`. */
	static empty<Row extends object>(fields: KeyFields): KeyedList<Row> {
		return new KeyedList<Row>(fields)
	}

	/**
	 * The value keyed by `fields` holding `rows`, in their order: a run's rows, which its key keys, so two rows of one
	 * key are a defect of the key the served file names.
	 */
	static of<Row extends object>(fields: KeyFields, rows: Iterable<Row>): KeyedList<Row> {
		const value = new KeyedList<Row>(fields)
		for (const row of rows) {
			const key = keyOf(fields, row)
			const form = formOf(key)
			if (value.#nodes.has(form)) {
				defect("a read delivered two rows of one key: its served key fields are no key")
			}
			value.#link({ key, form, row, prev: undefined, next: undefined }, value.#tail)
		}
		return value
	}

	get size(): number {
		return this.#nodes.size
	}

	/** The entry whose key has the form `form`, none where no row's does. */
	at(form: TextsId): Entry<Row> | undefined {
		return this.#nodes.get(form)
	}

	/** Every entry, in order. */
	*entries(): IterableIterator<Entry<Row>> {
		for (let node = this.#head; node !== undefined; node = node.next) {
			yield node
		}
	}

	/**
	 * The value as JSON reads it: its rows, in its order, so `JSON.stringify(value)` and `Response.json(value)` send the
	 * array of its rows, never the list's own members.
	 */
	toJSON(): ReadonlyArray<Row> {
		return [...this]
	}

	*[Symbol.iterator](): IterableIterator<Row> {
		for (let node = this.#head; node !== undefined; node = node.next) {
			yield node.row
		}
	}

	/**
	 * This value with `changes` applied in order, a new value: a remove takes its key's row out, where there is one; an
	 * upsert places its row after the row of its `after` key, first for null, the row of its key moved there if present.
	 * An `after` no row of the value has, or the upserted row's own, is a defect of the stream.
	 */
	applying(changes: Iterable<ListChange<Row>>): KeyedList<Row> {
		const value = new KeyedList<Row>(this.fields)
		for (let node = this.#head; node !== undefined; node = node.next) {
			value.#link({ ...node, prev: undefined, next: undefined }, value.#tail)
		}
		for (const change of changes) {
			switch (change._tag) {
				case "remove":
					value.#remove(formOf(change.key))
					break
				case "upsert":
					value.#place(change.row, change.after)
					break
			}
		}
		return value
	}

	/** Links `node` after `prev`, first where none, and indexes it. */
	#link(node: Node<Row>, prev: Node<Row> | undefined): void {
		const next = prev === undefined ? this.#head : prev.next
		node.prev = prev
		node.next = next
		if (prev === undefined) {
			this.#head = node
		} else {
			prev.next = node
		}
		if (next === undefined) {
			this.#tail = node
		} else {
			next.prev = node
		}
		this.#nodes.set(node.form, node)
	}

	/** Unlinks `node` and drops its index. */
	#unlink(node: Node<Row>): void {
		if (node.prev === undefined) {
			this.#head = node.next
		} else {
			node.prev.next = node.next
		}
		if (node.next === undefined) {
			this.#tail = node.prev
		} else {
			node.next.prev = node.prev
		}
		this.#nodes.delete(node.form)
	}

	#remove(form: TextsId): void {
		const node = this.#nodes.get(form)
		if (node !== undefined) {
			this.#unlink(node)
		}
	}

	#place(row: Row, after: RowKey | null): void {
		const key = keyOf(this.fields, row)
		const form = formOf(key)
		this.#remove(form)
		const prev = after === null ? undefined : this.#nodes.get(formOf(after))
		if (after !== null && prev === undefined) {
			defect("an upsert follows a key its value does not hold")
		}
		this.#link({ key, form, row, prev: undefined, next: undefined }, prev)
	}
}
