import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	contained,
	key,
	mirrors,
	on,
	pred,
	relation,
	type Selection,
	type Statement,
	schema,
	select
} from "#compiler/public/schema.ts"
import type {
	BinaryOperator,
	ColumnDef,
	Expr,
	ForeignKey,
	IndexKey,
	SqlStatement,
	TableConstraint,
	TypeRef
} from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { installationNamesOf, type Names } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

/**
 * Sides are partial projections, and fin.md §5.1 lowers every law over them by one set of rules, each read here from
 * the installation's DDL by structure, never by its text:
 *
 * - every term of a selected side, and every pred term, is a law column of its own, `GENERATED ALWAYS AS (CASE WHEN φ
 *   THEN t END) STORED`: its WHEN reads exactly the selection's fields, and for pred(x) x as well (x > 0), and its THEN
 *   reads exactly the term's field (x - 1 for pred). A field term of a side over every fact is its field's own column;
 * - a law column is typed by its field's base type, never a domain;
 * - a key is one UNIQUE over exactly its side's columns;
 * - a containment is one FOREIGN KEY from its left side's columns to its right side's, in term order, into a key over
 *   exactly the referenced columns, and an index leads with its referencing columns;
 * - a target selection that fixes a field to a constant is a constant law column on the source, NOT NULL and reading no
 *   field, which the reference carries into the target's superkey over its key and that field: one such UNIQUE however
 *   many constants reference it, so the target needs no index per constant;
 * - a foreign key on a cycle is DEFERRABLE INITIALLY DEFERRED, and one on no cycle into a target it cannot replace (one
 *   with no field beside the referenced key) is NOT DEFERRABLE;
 * - mirrors(a, b) is sugar: it installs exactly what contained(a, b) and contained(b, a) install.
 *
 * `NULLS DISTINCT` and `MATCH SIMPLE` are the printer's spelling of every UNIQUE and FOREIGN KEY node, so no structure
 * here holds them. A containment whose target a cascade feeds is deferred too; no W1 law cascades, so that rule waits for
 * the families that do.
 */

const Owner = relation("Owner", { id: uuid, rank: pg.int4, live: pg.boolean, slots: natural }, [
	"id"
])
const Item = relation(
	"Item",
	{ id: uuid, owner: uuid, code: pg.int4, live: pg.boolean, at: natural },
	["id"]
)
const Note = relation("Note", { id: uuid, owner: uuid }, ["id"])
/** Two relations of their keys alone, which no write replaces at a referenced key: only a cycle defers a key into them. */
const Profile = relation("Profile", { owner: uuid }, ["owner"])
const Seat = relation("Seat", { owner: uuid }, ["owner"])

/** A source selection: a boolean field, a comparison, or their conjunction. */
type Phi = "a boolean field" | "a comparison" | "a conjunction"
/** A target selection that fixes no field to a constant: a comparison, or a conjunction of two. */
type TargetPhi = "a comparison" | "a range"

/** The fields each selection reads. */
const phiFields: Readonly<Record<Phi, ReadonlyArray<string>>> = {
	"a boolean field": ["live"],
	"a comparison": ["code"],
	"a conjunction": ["live", "code"]
}
const targetPhiFields: Readonly<Record<TargetPhi, ReadonlyArray<string>>> = {
	"a comparison": ["rank"],
	"a range": ["rank"]
}

const itemsWhere = (phi: Phi): Selection<typeof Item> => {
	switch (phi) {
		case "a boolean field":
			return select(Item, (i) => i.eq(i.live, true))
		case "a comparison":
			return select(Item, (i) => i.gt(i.code, 0))
		case "a conjunction":
			return select(Item, (i) => i.and(i.eq(i.live, true), i.gt(i.code, 0)))
	}
}

const ownersWhere = (phi: TargetPhi): Selection<typeof Owner> => {
	switch (phi) {
		case "a comparison":
			return select(Owner, (o) => o.gt(o.rank, 0))
		case "a range":
			return select(Owner, (o) => o.and(o.gt(o.rank, 0), o.lt(o.rank, 9)))
	}
}

/** One rule of §5.1, stated over the four relations, with the selection it reads where it reads one. */
type Rule =
	| { readonly rule: "a key over fields" }
	| { readonly rule: "a key over a selected side"; readonly phi: Phi }
	| { readonly rule: "a key over a pred term" }
	| { readonly rule: "a key over a selected pred term"; readonly phi: Phi }
	| { readonly rule: "a containment" }
	| { readonly rule: "a containment into a superkey" }
	| { readonly rule: "a containment from a selected side"; readonly phi: Phi }
	| { readonly rule: "a containment into a selected side"; readonly phi: TargetPhi }
	| { readonly rule: "a containment into a constant selection" }
	| { readonly rule: "two constant selections of one target" }
	| { readonly rule: "a cycle" }
	| { readonly rule: "mirrors"; readonly over: "whole relations" | "a selected target" }

type RuleFeature = Rule["rule"] | `selection: ${Phi | TargetPhi}`

const phis: Arr.NonEmptyReadonlyArray<Phi> = ["a boolean field", "a comparison", "a conjunction"]
const targetPhis: Arr.NonEmptyReadonlyArray<TargetPhi> = ["a comparison", "a range"]

const rules: Arr.NonEmptyReadonlyArray<Rule> = [
	{ rule: "a key over fields" },
	...Arr.map(phis, (phi): Rule => ({ rule: "a key over a selected side", phi })),
	{ rule: "a key over a pred term" },
	...Arr.map(phis, (phi): Rule => ({ rule: "a key over a selected pred term", phi })),
	{ rule: "a containment" },
	{ rule: "a containment into a superkey" },
	...Arr.map(phis, (phi): Rule => ({ rule: "a containment from a selected side", phi })),
	...Arr.map(targetPhis, (phi): Rule => ({ rule: "a containment into a selected side", phi })),
	{ rule: "a containment into a constant selection" },
	{ rule: "two constant selections of one target" },
	{ rule: "a cycle" },
	{ rule: "mirrors", over: "whole relations" },
	{ rule: "mirrors", over: "a selected target" }
]

const features: Arr.NonEmptyReadonlyArray<RuleFeature> = nonEmpty([
	...new Set<RuleFeature>([
		...Arr.map(rules, (r) => r.rule),
		...Arr.map([...phis, ...targetPhis], (phi): RuleFeature => `selection: ${phi}`)
	])
])

/** The rule's statements: what the schema states beside its four relations. */
const statementsOf = (r: Rule): ReadonlyArray<Statement> => {
	switch (r.rule) {
		case "a key over fields":
			return [key(on(Item, "owner", "code"))]
		case "a key over a selected side":
			return [key(on(itemsWhere(r.phi), "owner", "code"))]
		case "a key over a pred term":
			return [key(on(Item, "owner", pred("at")))]
		case "a key over a selected pred term":
			return [key(on(itemsWhere(r.phi), "owner", pred("at")))]
		case "a containment":
			return [
				contained(on(Item, "owner"), on(Owner, "id")),
				contained(on(Note, "owner"), on(Seat, "owner"))
			]
		case "a containment into a superkey":
			return [contained(on(Item, "owner", "code"), on(Owner, "id", "rank"))]
		case "a containment from a selected side":
			return [contained(on(itemsWhere(r.phi), "owner"), on(Owner, "id"))]
		case "a containment into a selected side":
			return [contained(on(Item, "owner"), on(ownersWhere(r.phi), "id"))]
		case "a containment into a constant selection":
			return [
				contained(
					on(Item, "owner"),
					on(
						select(Owner, (o) => o.eq(o.live, true)),
						"id"
					)
				)
			]
		case "two constant selections of one target":
			return [
				contained(
					on(Item, "owner"),
					on(
						select(Owner, (o) => o.eq(o.live, true)),
						"id"
					)
				),
				contained(
					on(Note, "owner"),
					on(
						select(Owner, (o) => o.eq(o.live, false)),
						"id"
					)
				)
			]
		case "a cycle":
			return [
				contained(on(Profile, "owner"), on(Seat, "owner")),
				contained(on(Seat, "owner"), on(Profile, "owner"))
			]
		case "mirrors":
			return r.over === "whole relations"
				? [mirrors(on(Owner, "id"), on(Profile, "owner"))]
				: [mirrors(on(itemsWhere("a comparison"), "id"), on(Profile, "owner"))]
	}
}

/** mirrors' two containments, written out. */
const containmentsOf = (over: "whole relations" | "a selected target"): ReadonlyArray<Statement> =>
	over === "whole relations"
		? [
				contained(on(Owner, "id"), on(Profile, "owner")),
				contained(on(Profile, "owner"), on(Owner, "id"))
			]
		: [
				contained(on(itemsWhere("a comparison"), "id"), on(Profile, "owner")),
				contained(on(Profile, "owner"), on(itemsWhere("a comparison"), "id"))
			]

const installed = (statements: ReadonlyArray<Statement>): Installation => {
	const owned = owning(schema("Projections", { Owner, Item, Note, Profile, Seat }, statements))
	const result = compileInstallation(owned, installOptions(owned, owner))
	if (!result.ok) {
		throw result.error
	}
	return result.value
}

/** A table as its DDL builds it: its columns, the column sets of its keys, its foreign keys and its indexes' keys. */
interface Table {
	readonly columns: ReadonlyArray<ColumnDef>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly foreignKeys: ReadonlyArray<ForeignKey>
	readonly indexes: ReadonlyArray<ReadonlyArray<IndexKey["key"]>>
}

const emptyTable: Table = { columns: [], keys: [], foreignKeys: [], indexes: [] }

/** Every table of the installation, by its bare identifier, gathered from its CREATE TABLE, ALTER TABLEs and indexes. */
const tablesOf = (statements: ReadonlyArray<SqlStatement>): ReadonlyMap<string, Table> => {
	const tables = new Map<string, Table>()
	const edit = (name: string, f: (t: Table) => Table) => {
		tables.set(name, f(tables.get(name) ?? emptyTable))
	}
	const constrain = (name: string, c: TableConstraint) => {
		switch (c.kind) {
			case "primaryKey":
			case "unique":
				return edit(name, (t) => ({
					...t,
					keys: [...t.keys, Arr.map(c.columns, (k) => k.column)]
				}))
			case "foreignKey":
				return edit(name, (t) => ({ ...t, foreignKeys: [...t.foreignKeys, c] }))
			case "check":
			case "exclude":
				return
		}
	}
	for (const s of statements) {
		if (s.kind === "createTable") {
			edit(s.table.name, (t) => ({ ...t, columns: [...t.columns, ...s.columns] }))
			constrain(s.table.name, s.primaryKey)
			for (const c of s.secondary) {
				constrain(s.table.name, c)
			}
		} else if (s.kind === "alterTable") {
			for (const a of s.actions) {
				if (a.kind === "addColumn") {
					edit(s.table.name, (t) => ({ ...t, columns: [...t.columns, a.column] }))
				} else if (a.kind === "addConstraint") {
					constrain(s.table.name, a.constraint)
				}
			}
		} else if (s.kind === "createIndex") {
			edit(s.table.name, (t) => ({
				...t,
				indexes: [...t.indexes, Arr.map(s.keys, (k) => k.key)]
			}))
		}
	}
	return tables
}

/** The columns and binary operators an expression reads. */
const readsOf = (
	e: Expr
): { readonly columns: ReadonlySet<string>; readonly operators: ReadonlySet<BinaryOperator> } => {
	const columns = new Set<string>()
	const operators = new Set<BinaryOperator>()
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column") {
				columns.add(x.column)
			} else if (x.kind === "binary") {
				operators.add(x.op)
			}
			return x
		}
	})
	return { columns, operators }
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
	const [x, y] = [new Set(a), new Set(b)]
	return x.size === y.size && Arr.every([...x], (v) => y.has(v))
}

type ColumnKey = Extract<IndexKey["key"], { readonly kind: "column" }>
const isColumnKey = (k: IndexKey["key"]): k is ColumnKey => k.kind === "column"

/** One rule's installation, read through the naming door. */
class Reading {
	readonly #tables: ReadonlyMap<string, Table>
	readonly #names: Names

	constructor(installation: Installation) {
		this.#tables = tablesOf(installation.statements)
		this.#names = installationNamesOf(installation)
	}

	table(relation: string): Table {
		return defined(
			this.#tables.get(this.#names.tableIdent({ name: relation })),
			`${relation}'s table`
		)
	}

	column(relation: string, field: string): string {
		return this.#names.columnIdent({ name: relation }, field)
	}

	/** The columns a law adds to `relation`: every generated column but an identity. */
	lawColumns(relation: string): ReadonlyArray<ColumnDef> {
		return Arr.filter(
			this.table(relation).columns,
			(c) => c.generated !== undefined && c.generated.kind !== "identity"
		)
	}

	/**
	 * The one law column of `relation` holding `CASE WHEN <when> THEN <term> END`, its WHEN reading exactly `when` and
	 * its THEN exactly the term's field: x - 1 under x > 0 for pred, the field itself for a field term.
	 */
	partial(
		relation: string,
		term: { readonly kind: "field" | "pred"; readonly field: string },
		when: ReadonlyArray<string>,
		type: TypeRef
	): string {
		const field = this.column(relation, term.field)
		const whenColumns = Arr.map(term.kind === "pred" ? [...when, term.field] : when, (f) =>
			this.column(relation, f)
		)
		const found = Arr.filter(this.lawColumns(relation), (c) => {
			if (c.generated?.kind !== "partial") {
				return false
			}
			const [w, t] = [readsOf(c.generated.when), readsOf(c.generated.expr)]
			return (
				sameSet(t.columns, [field]) &&
				sameSet(w.columns, whenColumns) &&
				(term.kind === "field" || (t.operators.has("-") && w.operators.has(">")))
			)
		})
		const [only, ...more] = found
		if (only === undefined || more.length > 0) {
			return assert.fail(
				`${relation} has ${found.length} law columns of ${term.kind}(${term.field}) where ${Arr.join(when, ", ")}`
			)
		}
		assert.deepEqual(only.type, type, `${only.name} is typed by its field's base`)
		return only.name
	}

	/** The constant law columns of `relation`: each a STORED expression of no field, NOT NULL by its generation. */
	constants(relation: string): ReadonlyArray<ColumnDef> {
		return Arr.filter(
			this.lawColumns(relation),
			(c) => c.generated?.kind === "stored" && readsOf(c.generated.expr).columns.size === 0
		)
	}

	/** The one constant law column of `relation`, typed by its field's base. */
	constant(relation: string, type: TypeRef): string {
		const found = this.constants(relation)
		assert.equal(found.length, 1, `${relation}'s one constant law column`)
		const only = defined(found[0])
		assert.deepEqual(only.type, type, `${only.name} is typed by its field's base`)
		return only.name
	}

	/** `relation` has exactly `count` keys over the column set `columns`. */
	keys(relation: string, columns: ReadonlyArray<string>, count: number): void {
		assert.equal(
			Arr.filter(this.table(relation).keys, (k) => sameSet(k, columns)).length,
			count,
			`${relation}'s keys over (${Arr.join(columns, ", ")})`
		)
	}

	/**
	 * The one foreign key of `from` over `columns` exactly, in order, into `to`'s `referenced`: `to` has a key over
	 * exactly those columns, and an index of `from` leads with `columns`, but for a constant law column among them,
	 * which holds one value in every row of `from` and so narrows no probe.
	 */
	reference(
		from: string,
		columns: ReadonlyArray<string>,
		to: string,
		referenced: ReadonlyArray<string>
	): ForeignKey {
		const target = this.table(to)
		const into = this.#names.tableIdent({ name: to })
		const found = Arr.filter(
			this.table(from).foreignKeys,
			(fk) =>
				fk.references.name === into &&
				fk.columns.length === columns.length &&
				Arr.every(fk.columns, (c, k) => c.column === columns[k])
		)
		assert.equal(
			found.length,
			1,
			`${from}(${Arr.join(columns, ", ")}) has one foreign key into ${to}`
		)
		const fk = defined(found[0])
		assert.deepEqual<ReadonlyArray<string>>(
			Arr.map(fk.referencedColumns, (c) => c.column),
			referenced,
			"the referenced columns, in term order"
		)
		assert.ok(
			Arr.some(target.keys, (k) => sameSet(k, referenced)),
			`${to} has a key over exactly (${Arr.join(referenced, ", ")})`
		)
		const constant = new Set(Arr.map(this.constants(from), (c) => c.name))
		const probed = Arr.filter(columns, (c) => !constant.has(c))
		const leads = (columnsOf: ReadonlyArray<string>) =>
			sameSet(columnsOf.slice(0, probed.length), probed)
		/** An index's leading column keys: an expression key ends what it leads with. */
		const leading = (index: ReadonlyArray<IndexKey["key"]>): ReadonlyArray<string> =>
			Arr.map(Arr.takeWhile(index, isColumnKey), (k) => k.column)
		const source = this.table(from)
		assert.ok(
			Arr.some(source.indexes, (index) => leads(leading(index))) || Arr.some(source.keys, leads),
			`an index of ${from} leads with (${Arr.join(probed, ", ")})`
		)
		return fk
	}
}

/** The DDL each rule must install, read from its installation. */
const checkRule = (r: Rule, i: Installation): void => {
	const at = new Reading(i)
	const col = (relation: string, field: string) => at.column(relation, field)
	switch (r.rule) {
		case "a key over fields":
			assert.deepEqual(at.lawColumns("Item"), [], "a side over every fact adds no column")
			at.keys("Item", [col("Item", "owner"), col("Item", "code")], 1)
			return
		case "a key over a selected side": {
			const when = phiFields[r.phi]
			const owners = at.partial("Item", { kind: "field", field: "owner" }, when, types.uuid)
			const codes = at.partial("Item", { kind: "field", field: "code" }, when, types.integer)
			assert.equal(at.lawColumns("Item").length, 2, "one law column per term")
			at.keys("Item", [owners, codes], 1)
			return
		}
		case "a key over a pred term": {
			const prior = at.partial("Item", { kind: "pred", field: "at" }, [], types.bigint)
			assert.equal(at.lawColumns("Item").length, 1, "a law column for the pred term alone")
			at.keys("Item", [col("Item", "owner"), prior], 1)
			return
		}
		case "a key over a selected pred term": {
			const when = phiFields[r.phi]
			const owners = at.partial("Item", { kind: "field", field: "owner" }, when, types.uuid)
			const prior = at.partial("Item", { kind: "pred", field: "at" }, when, types.bigint)
			assert.equal(at.lawColumns("Item").length, 2, "one law column per term")
			at.keys("Item", [owners, prior], 1)
			return
		}
		case "a containment": {
			assert.deepEqual(at.lawColumns("Item"), [], "a side over every fact adds no column")
			at.reference("Item", [col("Item", "owner")], "Owner", [col("Owner", "id")])
			const immediate = at.reference("Note", [col("Note", "owner")], "Seat", [col("Seat", "owner")])
			assert.equal(immediate.deferrable, undefined, "off every cycle, into a key no write replaces")
			return
		}
		case "a containment into a superkey":
			at.keys("Owner", [col("Owner", "id"), col("Owner", "rank")], 1)
			at.reference("Item", [col("Item", "owner"), col("Item", "code")], "Owner", [
				col("Owner", "id"),
				col("Owner", "rank")
			])
			return
		case "a containment from a selected side": {
			const owners = at.partial(
				"Item",
				{ kind: "field", field: "owner" },
				phiFields[r.phi],
				types.uuid
			)
			at.reference("Item", [owners], "Owner", [col("Owner", "id")])
			return
		}
		case "a containment into a selected side": {
			const ids = at.partial(
				"Owner",
				{ kind: "field", field: "id" },
				targetPhiFields[r.phi],
				types.uuid
			)
			assert.deepEqual(at.lawColumns("Item"), [], "the source's side adds no column")
			at.keys("Owner", [ids], 1)
			at.reference("Item", [col("Item", "owner")], "Owner", [ids])
			return
		}
		case "a containment into a constant selection": {
			const tag = at.constant("Item", types.boolean)
			assert.deepEqual(at.lawColumns("Owner"), [], "the target holds no law column")
			at.keys("Owner", [col("Owner", "id"), col("Owner", "live")], 1)
			at.reference("Item", [col("Item", "owner"), tag], "Owner", [
				col("Owner", "id"),
				col("Owner", "live")
			])
			return
		}
		case "two constant selections of one target": {
			const superkey = [col("Owner", "id"), col("Owner", "live")]
			at.keys("Owner", superkey, 1)
			at.reference(
				"Item",
				[col("Item", "owner"), at.constant("Item", types.boolean)],
				"Owner",
				superkey
			)
			at.reference(
				"Note",
				[col("Note", "owner"), at.constant("Note", types.boolean)],
				"Owner",
				superkey
			)
			return
		}
		case "a cycle": {
			const there = at.reference("Profile", [col("Profile", "owner")], "Seat", [
				col("Seat", "owner")
			])
			const back = at.reference("Seat", [col("Seat", "owner")], "Profile", [
				col("Profile", "owner")
			])
			assert.deepEqual(
				[there.deferrable, back.deferrable],
				["INITIALLY DEFERRED", "INITIALLY DEFERRED"]
			)
			return
		}
		case "mirrors":
			assert.deepEqual(i.statements, installed(containmentsOf(r.over)).statements)
			return
	}
}

describe("partial projections lower by §5.1's rules", () => {
	it.effect(
		"every rule installs its DDL: generated CASE columns, keys and references over them, constant columns, deferral, and mirrors as its containments",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/projection",
						generator: element(rules),
						literal: Formatter.format,
						/** The space is the rules: 7 unselected, 3 selections for each of 3 selected rules, 2 for the selected target, and 2 mirrors. */
						limit: 20,
						coverage: requiredInSpace<RuleFeature>(features),
						caseHang
					},
					(r, c) =>
						Effect.sync(() => {
							c.note(r.rule)
							if ("phi" in r) {
								c.note(`selection: ${r.phi}`)
							}
							checkRule(r, installed(statementsOf(r)))
						})
				)
			)
	)
})
