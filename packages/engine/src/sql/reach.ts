/**
 * What a statement reaches as PostgreSQL runs it, read off its AST: the installation's functions it calls, the relations
 * and the named types it names, and every write it makes, its data-modifying CTEs' among them, each by its relation and
 * the event PostgreSQL fires that relation's triggers for. A planned-queries bound (physical/planned/graph.ts) follows
 * each of them to what PostgreSQL plans behind the statement: the functions' bodies, a view's query, a type's domain
 * checks, a written relation's triggers, foreign keys and row checks.
 *
 * A name is its printed form (sql/print.ts printObjectName), `"<schema>"."<name>"`, one spelling of one object. A
 * builtin function, pg_catalog's, is no call here: none of grizzle's builtins plans a query of its own.
 */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type {
	Dml,
	Expr,
	Merge,
	ObjectName,
	OperandSelect,
	PerformQuery,
	Select,
	SqlStatement,
	TypeRef,
	With
} from "#compiler/sql/ast.ts"
import type { Assignments } from "#compiler/sql/generation.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	identityHooks,
	inertVisitor,
	Transform,
	visitDml,
	visitExpr,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * An event a write fires a relation's triggers for: a row inserted, deleted, or updated at `columns`, the columns its SET
 * assigns (an ON CONFLICT DO UPDATE's and a MERGE's among them); or a TRUNCATE.
 */
export type WriteEvent =
	| { readonly kind: "insert" | "delete" | "truncate" }
	| { readonly kind: "update"; readonly columns: NonEmptyReadonlyArray<string> }

/** One write a statement makes: the relation it writes, by its printed name, and the event it fires there. */
export interface Written {
	readonly relation: string
	readonly event: WriteEvent
}

/** What a statement reaches (see the header): every name in its printed form, each once. */
export interface Reach {
	readonly calls: ReadonlySet<string>
	readonly relations: ReadonlySet<string>
	readonly types: ReadonlySet<string>
	readonly writes: ReadonlyArray<Written>
}

/** The update event of an assignment list. */
const updateOf = (set: Assignments): WriteEvent => ({
	kind: "update",
	columns: [set[0].column, ...set.slice(1).map((a) => a.column)]
})

/** The events one data-modifying statement fires on the relation it writes, its own alone (none of its CTEs'). */
export const writeEvents = (
	s: Exclude<Dml, { readonly kind: "select" }>
): ReadonlyArray<WriteEvent> => {
	switch (s.kind) {
		case "insert":
			return s.onConflict?.kind === "columns" && s.onConflict.action.kind === "doUpdate"
				? [{ kind: "insert" }, updateOf(s.onConflict.action.set)]
				: [{ kind: "insert" }]
		case "update":
			return [updateOf(s.set)]
		case "delete":
			return [{ kind: "delete" }]
		case "merge":
			return s.whens.flatMap(mergeEvents)
	}
}

/** The events one WHEN of a MERGE fires on its target: its action's, none for DO NOTHING. */
const mergeEvents = (w: Merge["whens"][number]): ReadonlyArray<WriteEvent> => {
	switch (w.action.kind) {
		case "update":
			return [updateOf(w.action.set)]
		case "delete":
			return [{ kind: "delete" }]
		case "doNothing":
			return []
		case "insert":
		case "insertDefault":
			return [{ kind: "insert" }]
	}
}

/**
 * The reach of the pieces a caller adds (`expr`, `query`, `setQuery`, `dml`, `perform`), gathered as one: what a
 * statement of them reaches, or a PL/pgSQL body's.
 */
export class ReachOf {
	readonly #calls = new Set<string>()
	readonly #relations = new Set<string>()
	readonly #types = new Set<string>()
	readonly #writes: Array<Written> = []
	readonly #names = new Transform({
		...identityHooks,
		functionRef: (fn) => {
			this.#calls.add(printObjectName(fn))
			return fn
		},
		objectName: (name, namespace) => {
			switch (namespace) {
				case "relation":
					this.#relations.add(printObjectName(name))
					return name
				case "function":
					this.#calls.add(printObjectName(name))
					return name
				case "type":
				case "operatorClass":
					return name
			}
		},
		typeRef: (type) => {
			if (type.kind === "named") {
				this.#types.add(printObjectName(type))
			}
			return type
		}
	})

	/** Each data-modifying statement of a WITH, which the visit reaches at any depth, as a write. */
	readonly #with = (w: With): void => {
		for (const cte of w.ctes) {
			if (cte.query.kind !== "select") {
				this.#written(cte.query)
			}
		}
	}

	#written(s: Exclude<Dml, { readonly kind: "select" }>): void {
		const relation = printObjectName(s.table)
		for (const event of writeEvents(s)) {
			this.#writes.push({ relation, event })
		}
	}

	expr(e: Expr): this {
		this.#names.expr(e)
		visitExpr(e, { ...inertVisitor, with: this.#with })
		return this
	}

	query(q: OperandSelect): this {
		this.#names.select(q)
		visitSelect(q, { ...inertVisitor, with: this.#with })
		return this
	}

	setQuery(q: Select): this {
		return this.query(q)
	}

	dml(s: Dml): this {
		if (s.kind === "select") {
			return this.query(s)
		}
		this.#names.dml(s)
		this.#written(s)
		visitDml(s, { ...inertVisitor, with: this.#with })
		return this
	}

	perform(q: PerformQuery): this {
		return this.query(performedQuery(q))
	}

	/**
	 * A statement a client sends: a query or a data-modifying statement as `dml` reads it, any other the names it holds
	 * alone, since it writes no relation's rows.
	 */
	statement(s: SqlStatement): this {
		if (
			s.kind === "select" ||
			s.kind === "insert" ||
			s.kind === "update" ||
			s.kind === "delete" ||
			s.kind === "merge"
		) {
			return this.dml(s)
		}
		this.#names.statement(s)
		return this
	}

	/** A type a value is held as outside any expression: a column's, a domain's base. */
	type(type: TypeRef): this {
		this.#names.type(type)
		return this
	}

	/** A write the statement makes outside any data-modifying statement: a TRUNCATE. */
	write(relation: ObjectName, event: WriteEvent): this {
		this.#writes.push({ relation: printObjectName(relation), event })
		return this
	}

	reach(): Reach {
		return {
			calls: new Set(this.#calls),
			relations: new Set(this.#relations),
			types: new Set(this.#types),
			writes: [...this.#writes]
		}
	}
}

/** A PERFORM's query as the SELECT PL/pgSQL plans for it, its leading keyword SELECT. */
export const performedQuery = (q: PerformQuery): OperandSelect => ({
	kind: "select",
	with: undefined,
	body: q.body,
	orderBy: q.orderBy,
	limit: q.limit,
	offset: q.offset
})
