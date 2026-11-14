import { Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	counted,
	derived,
	fin,
	fold,
	key,
	login,
	Monoid,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"

/**
 * The schemas the isolation oracle installs, each a function of its installed name (test/support/schedules/rig.ts),
 * with its roles and its login `app`, whose workloads hold its members. None draws an always-new parent with its children:
 * a nested write states its owner's key, an identity's too (runtime/write/nesting.ts refuses an owner that leaves it
 * out, `factShape`), so no call inserts a family under a key the database draws.
 *
 * Positives, every run of which must be serial at the levels generate certifies:
 * - `point`: `start(id, g, k)` inserts Parent(id), a DO SELECT no-change where an equal row is stored, and Child(id,
 *   k) joined to it by key; `save(parent, k, at, v)` inserts Save joined to the Child at its whole key.
 * - `sitting`: an `importer` writes a Doc and its Pool rows whole in one call (`import1`, `import2`); with the members
 *   "start", the `learner`'s `start(id, doc, child)` reads the Doc's group in its first statement, counting its pools
 *   into Sitting, and again in its second, inserting a Served row per pool joined through its own Sitting; with
 *   "named", its `begin1` and `begin2` name every value of a Sitting and its Served rows, read nothing, and are checked
 *   by native foreign keys alone.
 * - `fold`: an immutable Invoice owns a counted family of Line rows whose amounts sum into its `total`, which a CHECK
 *   holds to its `amount`; `post` inserts an Invoice with its Lines, each call's facts, in one stratum. Two calls of one
 *   Invoice meet at its key: the proposed owner's CHECK runs before the arbiter, so a call whose Lines do not sum to
 *   its amount is refused there, and an exact repeat waits for the arbiter's DO SELECT. The `auditor`'s `copy(id)`
 *   copies one Invoice's Lines, a counted family's group under an immutable owner: the counted seal.
 *
 * Counterexamples, each of which a flawed certifier passes (certify.ts flawedCertificates), so the oracle must find
 * a run no serial order explains:
 * - `partial`: `join(id, k)` inserts Parent(id), maybe a no-change, and Child(id, k), then copies every Child of the
 *   parent, a group many calls write.
 * - `copies`, counterexample (a): `m1` inserts A(v) and copies every B into P; `m2` inserts B(v) and copies every A
 *   into Q.
 * - `pointCopies`, (a) by point reads: `m1(x, y)` inserts A(x) and copies B(y) into P; `m2(x, y)` inserts B(y) and
 *   copies A(x) into Q.
 * - `readers`: the SERIALIZABLE `writer`'s members pivot among themselves through absence reads (`m1` inserts A(v)
 *   where B(v) is absent, `m2` inserts B(v) where A(v) is absent, `m3` inserts B(v)); its role `spanning`, anomaly
 *   (b), copies A(v) and B(v), rows of two writer calls; its role `single` copies A(v), one writer call's row, which
 *   NEGATION's first history shows a strict serial order cannot place.
 * - `sitting` with `extend`, which adds a Pool to a stored Doc in a call of its own, so a Doc's group is not written
 *   whole by one call.
 */

const Parent = relation("Parent", { id: uuid, g: pg.integer }, ["id"])
const PointChild = relation("Child", { parent: uuid, k: pg.integer, g: pg.integer }, [
	"parent",
	"k"
])
const Save = relation("Save", { parent: uuid, k: pg.integer, at: pg.integer, v: pg.integer }, [
	"parent",
	"k",
	"at"
])

/** The point shape under the name `name`. */
export const pointShape = (name: string) => {
	const relations = { Parent, Child: PointChild, Save } as const
	const base = schema(name, Rec.values(relations), [
		contained(on(PointChild, "parent"), on(Parent, "id")),
		contained(on(Save, "parent", "k"), on(PointChild, "parent", "k"))
	])
	const learner = role(base, "learner", relations, { insert: ["Parent", "Child", "Save"] })
	const mine = learner.relations
	const start = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(
			mine.Parent,
			query(learner).rule((r) => r.find({ id: r.param("id", uuid), g: r.param("g", pg.integer) }))
		),
		ChangeSet.empty(learner).insert(
			mine.Child,
			query(learner).rule((r) => {
				const { id, g } = v(mine.Parent, "parent")
				return r
					.match(mine.Parent, { id, g })
					.where(r.eq(id, r.param("id", uuid)))
					.find({ parent: id, k: r.param("k", pg.integer), g })
			})
		)
	)
	const save = ChangeSet.empty(learner).insert(
		mine.Save,
		query(learner).rule((r) => {
			const { parent, k } = v(mine.Child, "child")
			return r
				.match(mine.Child, { parent, k })
				.where(r.eq(parent, r.param("parent", uuid)), r.eq(k, r.param("k", pg.integer)))
				.find({ parent, k, at: r.param("at", pg.integer), v: r.param("v", pg.integer) })
		})
	)
	const workloads = [workload(learner, { start, save })] as const
	return {
		schema: base,
		roles: { learner },
		login: login(base, "app", [learner], { workload: workloads })
	}
}

const Doc = relation("Doc", { node: uuid, n: pg.integer }, ["node"])
const Pool = relation("Pool", { doc: uuid, pool: pg.integer, size: pg.integer }, ["doc", "pool"])
const Sitting = relation("Sitting", { id: uuid, doc: uuid, child: pg.integer, pools: pg.bigint }, [
	"id"
])
const Served = relation(
	"Served",
	{ sitting: uuid, doc: uuid, pool: pg.integer, size: pg.integer },
	["sitting", "pool"]
)

/**
 * The sitting shape under the name `name`, its learner's members `members`, with the importer's `extend` where
 * `extended`: a Pool added to a stored Doc in a call of its own.
 */
export const sittingShape = (name: string, members: "start" | "named", extended: boolean) => {
	const relations = { Doc, Pool, Sitting, Served } as const
	const base = schema(name, Rec.values(relations), [
		contained(on(Pool, "doc"), on(Doc, "node")),
		contained(on(Sitting, "doc"), on(Doc, "node")),
		contained(on(Served, "sitting", "doc"), on(Sitting, "id", "doc")),
		contained(on(Served, "doc", "pool", "size"), on(Pool, "doc", "pool", "size"))
	])
	const importer = role(base, "importer", relations, { insert: ["Doc", "Pool"] })
	const learner = role(base, "learner", relations, { insert: ["Sitting", "Served"] })
	const theirs = importer.relations
	const mine = learner.relations
	const docOf = (n: number) =>
		query(importer).rule((r) => r.find({ node: r.param("node", uuid), n }))
	const poolOf = (pool: number, size: "a" | "b") =>
		query(importer).rule((r) =>
			r.find({ doc: r.param("node", uuid), pool, size: r.param(size, pg.integer) })
		)
	const import1 = ChangeSet.empty(importer)
		.insert(theirs.Doc, docOf(1))
		.insert(theirs.Pool, poolOf(0, "a"))
	const import2 = ChangeSet.empty(importer)
		.insert(theirs.Doc, docOf(2))
		.insert(
			theirs.Pool,
			poolOf(0, "a").rule((r) =>
				r.find({ doc: r.param("node", uuid), pool: 1, size: r.param("b", pg.integer) })
			)
		)
	const extend = ChangeSet.empty(importer).insert(
		theirs.Pool,
		query(importer).rule((r) => {
			const { node } = v(theirs.Doc, "doc")
			return r
				.match(theirs.Doc, { node })
				.where(r.eq(node, r.param("node", uuid)))
				.find({ doc: node, pool: r.param("pool", pg.integer), size: r.param("a", pg.integer) })
		})
	)
	const counted = query(learner).rule((r) => {
		const { pool } = v(mine.Pool, "pool")
		return r.match(mine.Pool, { doc: r.param("doc", uuid), pool }).find({ pools: r.count() })
	})
	const start = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(
			mine.Sitting,
			query(learner).rule((r) => {
				const count = counted.bind({ doc: r.param("doc", uuid) })
				const { pools } = v(count, "count")
				return r
					.match(mine.Doc, { node: r.param("doc", uuid) })
					.match(count, { pools })
					.find({
						id: r.param("id", uuid),
						doc: r.param("doc", uuid),
						child: r.param("child", pg.integer),
						pools
					})
			})
		),
		ChangeSet.empty(learner).insert(
			mine.Served,
			query(learner).rule((r) => {
				const { id, doc } = v(mine.Sitting, "sitting")
				const { pool, size } = v(mine.Pool, "pool")
				return r
					.match(mine.Sitting, { id, doc })
					.match(mine.Pool, { doc, pool, size })
					.where(r.eq(id, r.param("id", uuid)))
					.find({ sitting: id, doc, pool, size })
			})
		)
	)
	const named = (pools: 1 | 2) => {
		const sitting = query(learner).rule((r) =>
			r.find({
				id: r.param("id", uuid),
				doc: r.param("doc", uuid),
				child: r.param("child", pg.integer),
				pools: BigInt(pools)
			})
		)
		const first = query(learner).rule((r) =>
			r.find({
				sitting: r.param("id", uuid),
				doc: r.param("doc", uuid),
				pool: 0,
				size: r.param("a", pg.integer)
			})
		)
		const served =
			pools === 1
				? first
				: first.rule((r) =>
						r.find({
							sitting: r.param("id", uuid),
							doc: r.param("doc", uuid),
							pool: 1,
							size: r.param("b", pg.integer)
						})
					)
		return ChangeSet.empty(learner).insert(mine.Sitting, sitting).insert(mine.Served, served)
	}
	const workloads = [
		workload(importer, extended ? { import1, import2, extend } : { import1, import2 }),
		members === "start"
			? workload(learner, { start })
			: workload(learner, { begin1: named(1), begin2: named(2) })
	] as const
	return {
		schema: base,
		roles: { importer, learner },
		login: login(base, "app", [importer, learner], { workload: workloads })
	}
}

const Invoice = relation(
	"Invoice",
	{ id: uuid, amount: pg.integer, lines: drawn(natural), total: accumulated(pg.integer, 0) },
	["id"]
)
const Line = relation("Line", { invoice: uuid, n: pg.integer, amount: pg.integer }, [
	"invoice",
	"n"
])
const invoiceLines = counted(on(Line, "invoice"), fin(Invoice, "lines"))
const Copied = relation("Copied", { invoice: uuid, n: pg.integer, amount: pg.integer }, [
	"invoice",
	"n"
])

/** The fold shape under the name `name`. */
export const foldShape = (name: string) => {
	const relations = { Invoice, Line, Copied } as const
	const base = schema(name, Rec.values(relations), [
		invoiceLines,
		fold(invoiceLines, Monoid.sum, on(Line, "invoice", "amount"), on(Invoice, "id", "total")),
		check("Settled", Invoice, (i) => i.eq(i.total, i.amount))
	])
	const learner = role(base, "learner", relations, { insert: ["Invoice", "Line"] })
	const auditor = role(base, "auditor", relations, { insert: ["Copied"] })
	const mine = learner.relations
	const post = ChangeSet.empty(learner).insert(mine.Invoice, []).insert(mine.Line, [])
	const copy = ChangeSet.empty(auditor).insert(
		auditor.relations.Copied,
		query(auditor).rule((r) => {
			const { invoice, n, amount } = v(auditor.relations.Line, "line")
			return r
				.match(auditor.relations.Line, { invoice, n, amount })
				.where(r.eq(invoice, r.param("id", uuid)))
				.find({ invoice, n, amount })
		})
	)
	const workloads = [workload(learner, { post }), workload(auditor, { copy })] as const
	return {
		schema: base,
		roles: { learner, auditor },
		login: login(base, "app", [learner, auditor], { workload: workloads })
	}
}

const A = relation("A", { v: pg.integer }, ["v"])
const B = relation("B", { v: pg.integer }, ["v"])
const SingleA = relation("SingleA", { v: pg.integer }, ["v"])
const SpanA = relation("SpanA", { v: pg.integer }, ["v"])
const SpanB = relation("SpanB", { v: pg.integer }, ["v"])

/** The readers shape under the name `name`: the roles `writer`, `single` and `spanning`. */
export const readersShape = (name: string) => {
	const relations = { A, B, SingleA, SpanA, SpanB } as const
	const base = schema(name, Rec.values(relations), [])
	const writer = role(base, "writer", relations, { insert: ["A", "B"] })
	const single = role(base, "single", relations, { insert: ["SingleA"] })
	const spanning = role(base, "spanning", relations, { insert: ["SpanA", "SpanB"] })
	const w = writer.relations
	const m1 = ChangeSet.empty(writer).insert(
		w.A,
		query(writer).rule((r) =>
			r.where(r.not(w.B, { v: r.param("v", pg.integer) })).find({ v: r.param("v", pg.integer) })
		)
	)
	const m2 = ChangeSet.empty(writer).insert(
		w.B,
		query(writer).rule((r) =>
			r.where(r.not(w.A, { v: r.param("v", pg.integer) })).find({ v: r.param("v", pg.integer) })
		)
	)
	const m3 = ChangeSet.empty(writer).insert(
		w.B,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const one = ChangeSet.empty(single).insert(
		single.relations.SingleA,
		query(single).rule((r) => {
			const { v: value } = v(single.relations.A, "seen")
			return r
				.match(single.relations.A, { v: value })
				.where(r.eq(value, r.param("v", pg.integer)))
				.find({ v: value })
		})
	)
	const both = ChangeSet.empty(spanning)
		.insert(
			spanning.relations.SpanA,
			query(spanning).rule((r) => {
				const { v: value } = v(spanning.relations.A, "seen")
				return r
					.match(spanning.relations.A, { v: value })
					.where(r.eq(value, r.param("v", pg.integer)))
					.find({ v: value })
			})
		)
		.insert(
			spanning.relations.SpanB,
			query(spanning).rule((r) => {
				const { v: value } = v(spanning.relations.B, "seen")
				return r
					.match(spanning.relations.B, { v: value })
					.where(r.eq(value, r.param("v", pg.integer)))
					.find({ v: value })
			})
		)
	const workloads = [
		workload(writer, { m1, m2, m3 }),
		workload(single, { one }),
		workload(spanning, { both })
	] as const
	return {
		schema: base,
		roles: { writer, single, spanning },
		login: login(base, "app", [writer, single, spanning], { workload: workloads })
	}
}

const ListA = relation("ListA", { v: pg.integer }, ["v"])

/**
 * NEGATION's second history under the name `name`: the `writer`'s `m1` inserts A(v) where B(v) is absent, and its `m4`
 * inserts B(v) and A(w) in one stratum; the `listed` role's `many` copies into ListA the A rows at the keys of its
 * relation parameter `keys`, a read of several keys B-02 sealed as a point.
 */
export const listedShape = (name: string) => {
	const relations = { A, B, ListA } as const
	const base = schema(name, Rec.values(relations), [])
	const writer = role(base, "writer", relations, { insert: ["A", "B"] })
	const listed = role(base, "listed", relations, { insert: ["ListA"] })
	const w = writer.relations
	const m1 = ChangeSet.empty(writer).insert(
		w.A,
		query(writer).rule((r) =>
			r.where(r.not(w.B, { v: r.param("v", pg.integer) })).find({ v: r.param("v", pg.integer) })
		)
	)
	const m4 = ChangeSet.empty(writer)
		.insert(
			w.B,
			query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
		)
		.insert(
			w.A,
			query(writer).rule((r) => r.find({ v: r.param("w", pg.integer) }))
		)
	const many = ChangeSet.empty(listed).insert(
		listed.relations.ListA,
		query(listed).rule((r) => {
			const keys = r.relation("keys", { v: pg.integer })
			const { v: value } = v(keys, "key")
			return r.match(keys, { v: value }).match(listed.relations.A, { v: value }).find({ v: value })
		})
	)
	const workloads = [workload(writer, { m1, m4 }), workload(listed, { many })] as const
	return {
		schema: base,
		roles: { writer, listed },
		login: login(base, "app", [writer, listed], { workload: workloads })
	}
}

const C = relation("C", { v: pg.integer }, ["v"])

/**
 * NEGATION's third history under the name `name`: the `writer`'s `m1` and `m3` as in the readers shape, and the
 * `checker`'s `check` inserting C(v) from B(v), C's v contained in A's by a native foreign key, whose check misses an
 * A row in flight.
 */
export const fkShape = (name: string) => {
	const relations = { A, B, C } as const
	const base = schema(name, Rec.values(relations), [contained(on(C, "v"), on(A, "v"))])
	const writer = role(base, "writer", relations, { insert: ["A", "B"] })
	const checker = role(base, "checker", relations, { insert: ["C"] })
	const w = writer.relations
	const m1 = ChangeSet.empty(writer).insert(
		w.A,
		query(writer).rule((r) =>
			r.where(r.not(w.B, { v: r.param("v", pg.integer) })).find({ v: r.param("v", pg.integer) })
		)
	)
	const m3 = ChangeSet.empty(writer).insert(
		w.B,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const check = ChangeSet.empty(checker).insert(
		checker.relations.C,
		query(checker).rule((r) => {
			const { v: value } = v(checker.relations.B, "b")
			return r
				.match(checker.relations.B, { v: value })
				.where(r.eq(value, r.param("v", pg.integer)))
				.find({ v: value })
		})
	)
	const workloads = [workload(writer, { m1, m3 }), workload(checker, { check })] as const
	return {
		schema: base,
		roles: { writer, checker },
		login: login(base, "app", [writer, checker], { workload: workloads })
	}
}

const Holder = relation("Holder", { v: pg.integer, kind: pg.integer }, ["v"])
const Held = relation("Held", { v: pg.integer }, ["v"])

/**
 * NEGATION's fourth history under the name `name`: the `copier`'s `many` copies into Held the A rows at its `keys`,
 * Held's v contained in the Holders of kind 1, a derived target, which lowers to a foreign key PostgreSQL checks at
 * COMMIT (analysis/theory/laws.ts lowering, DEFERRABLE INITIALLY DEFERRED); the `adder`'s `add` inserts A(v); the
 * `holder`'s `hold` inserts Holder(v, 1) where A(w) is there. A, Holder and Held sit in the level `name`, Kind1 and
 * the containment in the level above it, `<name>_1`, as an installation names its levels.
 */
export const deferredShape = (name: string) => {
	const stored = { A, Holder, Held } as const
	const below = schema(name, Rec.values(stored), [])
	const Kind1 = derived(
		"Kind1",
		query(below).rule((r) => {
			const { v: value } = v(Holder, "holder")
			return r.match(Holder, { v: value, kind: 1 }).find({ v: value })
		})
	)
	const base = schema.extend(
		below,
		`${name}_1`,
		[Kind1],
		[contained(on(Held, "v"), on(Kind1, "v"))]
	)
	const copier = role(base, "copier", stored, { insert: ["Held"] })
	const adder = role(base, "adder", stored, { insert: ["A"] })
	const holder = role(base, "holder", stored, { insert: ["Holder"] })
	const many = ChangeSet.empty(copier).insert(
		copier.relations.Held,
		query(copier).rule((r) => {
			const keys = r.relation("keys", { v: pg.integer })
			const { v: value } = v(keys, "key")
			return r.match(keys, { v: value }).match(copier.relations.A, { v: value }).find({ v: value })
		})
	)
	const add = ChangeSet.empty(adder).insert(
		adder.relations.A,
		query(adder).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const hold = ChangeSet.empty(holder).insert(
		holder.relations.Holder,
		query(holder).rule((r) => {
			const { v: value } = v(holder.relations.A, "a")
			return r
				.match(holder.relations.A, { v: value })
				.where(r.eq(value, r.param("w", pg.integer)))
				.find({ v: r.param("v", pg.integer), kind: 1 })
		})
	)
	const workloads = [
		workload(copier, { many }),
		workload(adder, { add }),
		workload(holder, { hold })
	] as const
	return {
		schema: base,
		roles: { copier, adder, holder },
		login: login(base, "app", [copier, adder, holder], { workload: workloads })
	}
}

const G = relation("G", { v: pg.integer }, ["v"])
const X = relation("X", { k: pg.integer }, ["k"])
const Y = relation("Y", { k: pg.integer }, ["k"])

/**
 * NEGATION's fifth history under the name `name`: the `twice` role's `both` inserts into X, then into Y, the keys of its
 * relation parameter `keys` joined with G(g) each time, a group its first statement reads and its second reads again;
 * the `grower`'s `grow` inserts G(v). B-02's own-row clause admits the second join through the call's input rows,
 * which its carrier holds, though no statement of the call wrote them.
 */
export const carrierShape = (name: string) => {
	const relations = { G, X, Y } as const
	const base = schema(name, Rec.values(relations), [])
	const twice = role(base, "twice", relations, { insert: ["X", "Y"] })
	const grower = role(base, "grower", relations, { insert: ["G"] })
	const mine = twice.relations
	const joined = query(twice).rule((r) => {
		const keys = r.relation("keys", { k: pg.integer })
		const { k } = v(keys, "key")
		const { v: value } = v(mine.G, "g")
		return r
			.match(keys, { k })
			.match(mine.G, { v: value })
			.where(r.eq(value, r.param("g", pg.integer)))
			.find({ k })
	})
	const both = ChangeSet.sequence(
		ChangeSet.empty(twice).insert(mine.X, joined),
		ChangeSet.empty(twice).insert(mine.Y, joined)
	)
	const grow = ChangeSet.empty(grower).insert(
		grower.relations.G,
		query(grower).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const workloads = [workload(twice, { both }), workload(grower, { grow })] as const
	return {
		schema: base,
		roles: { twice, grower },
		login: login(base, "app", [twice, grower], { workload: workloads })
	}
}

const PartialChild = relation("Child", { parent: uuid, k: pg.integer }, ["parent", "k"])
const Seen = relation("Seen", { parent: uuid, reader: pg.integer, k: pg.integer }, [
	"parent",
	"reader",
	"k"
])

/** The partial shape under the name `name`. */
export const partialShape = (name: string) => {
	const relations = { Parent, Child: PartialChild, Seen } as const
	const base = schema(name, Rec.values(relations), [
		contained(on(PartialChild, "parent"), on(Parent, "id")),
		contained(on(Seen, "parent", "k"), on(PartialChild, "parent", "k"))
	])
	const joiner = role(base, "joiner", relations, { insert: ["Parent", "Child", "Seen"] })
	const mine = joiner.relations
	const join = ChangeSet.sequence(
		ChangeSet.empty(joiner).insert(
			mine.Parent,
			query(joiner).rule((r) => r.find({ id: r.param("id", uuid), g: 0 }))
		),
		ChangeSet.sequence(
			ChangeSet.empty(joiner).insert(
				mine.Child,
				query(joiner).rule((r) => {
					const { id } = v(mine.Parent, "parent")
					return r
						.match(mine.Parent, { id })
						.where(r.eq(id, r.param("id", uuid)))
						.find({ parent: id, k: r.param("k", pg.integer) })
				})
			),
			ChangeSet.empty(joiner).insert(
				mine.Seen,
				query(joiner).rule((r) => {
					const { parent, k } = v(mine.Child, "child")
					return r
						.match(mine.Child, { parent, k })
						.where(r.eq(parent, r.param("id", uuid)))
						.find({ parent, reader: r.param("k", pg.integer), k })
				})
			)
		)
	)
	const workloads = [workload(joiner, { join })] as const
	return {
		schema: base,
		roles: { joiner },
		login: login(base, "app", [joiner], { workload: workloads })
	}
}

const P = relation("P", { v: pg.integer }, ["v"])
const Q = relation("Q", { v: pg.integer }, ["v"])

/** Counterexample (a) under the name `name`: the role `copier`, whose two members each copy the other's relation. */
export const copiesShape = (name: string) => {
	const relations = { A, B, P, Q } as const
	const base = schema(name, Rec.values(relations), [])
	const copier = role(base, "copier", relations, { insert: ["A", "B", "P", "Q"] })
	const mine = copier.relations
	const m1 = ChangeSet.sequence(
		ChangeSet.empty(copier).insert(
			mine.A,
			query(copier).rule((r) => r.find({ v: r.param("v", pg.integer) }))
		),
		ChangeSet.empty(copier).insert(
			mine.P,
			query(copier).rule((r) => {
				const { v: value } = v(mine.B, "from")
				return r.match(mine.B, { v: value }).find({ v: value })
			})
		)
	)
	const m2 = ChangeSet.sequence(
		ChangeSet.empty(copier).insert(
			mine.B,
			query(copier).rule((r) => r.find({ v: r.param("v", pg.integer) }))
		),
		ChangeSet.empty(copier).insert(
			mine.Q,
			query(copier).rule((r) => {
				const { v: value } = v(mine.A, "from")
				return r.match(mine.A, { v: value }).find({ v: value })
			})
		)
	)
	const workloads = [workload(copier, { m1, m2 })] as const
	return {
		schema: base,
		roles: { copier },
		login: login(base, "app", [copier], { workload: workloads })
	}
}

/** (a) by point reads under the name `name`: the role `copier`, each member copying one row of the other's relation. */
export const pointCopiesShape = (name: string) => {
	const relations = { A, B, P, Q } as const
	const base = schema(name, Rec.values(relations), [])
	const copier = role(base, "copier", relations, { insert: ["A", "B", "P", "Q"] })
	const mine = copier.relations
	const m1 = ChangeSet.sequence(
		ChangeSet.empty(copier).insert(
			mine.A,
			query(copier).rule((r) => r.find({ v: r.param("x", pg.integer) }))
		),
		ChangeSet.empty(copier).insert(
			mine.P,
			query(copier).rule((r) => {
				const { v: value } = v(mine.B, "from")
				return r
					.match(mine.B, { v: value })
					.where(r.eq(value, r.param("y", pg.integer)))
					.find({ v: value })
			})
		)
	)
	const m2 = ChangeSet.sequence(
		ChangeSet.empty(copier).insert(
			mine.B,
			query(copier).rule((r) => r.find({ v: r.param("y", pg.integer) }))
		),
		ChangeSet.empty(copier).insert(
			mine.Q,
			query(copier).rule((r) => {
				const { v: value } = v(mine.A, "from")
				return r
					.match(mine.A, { v: value })
					.where(r.eq(value, r.param("x", pg.integer)))
					.find({ v: value })
			})
		)
	)
	const workloads = [workload(copier, { m1, m2 })] as const
	return {
		schema: base,
		roles: { copier },
		login: login(base, "app", [copier], { workload: workloads })
	}
}

const D = relation("D", { v: pg.integer }, ["v"])
const E = relation("E", { v: pg.integer }, ["v"])
const PubA = relation("PubA", { v: pg.integer }, ["v"])
const PubB = relation("PubB", { v: pg.integer }, ["v"])
const SeenB = relation("SeenB", { v: pg.integer }, ["v"])
const SpanAB = relation("SpanAB", { v: pg.integer }, ["v"])
const PubC = relation("C", { v: pg.integer }, ["v"])
const PubList = relation("ListA", { v: pg.integer }, ["v"])
const PubCopy = relation("Copy", { v: pg.integer }, ["v"])
const PubParent = relation("PubParent", { v: pg.integer, kind: pg.integer }, ["v"])

/**
 * NEGATION's publication layer under the name `name`, the shape that decides edullm's next ledger change. In the level
 * `name`: content A, B, D, E; publications PubA, PubB, PubParent, each contained in its content by a native foreign
 * key; the learner's SeenB, SpanAB and C, C contained in PubA; the lister's ListA and Copy. In the level `<name>_1`: DE,
 * the join of D and E by v, keyed by v, a rule over a query held by triggers on D and E, each reading the other, as
 * pantry's are; and Kind1, the PubParents of kind 1, into which Copy is contained by a foreign key PostgreSQL checks at
 * COMMIT (the lowering's DEFERRABLE INITIALLY DEFERRED). Every role writes by an insert list, so it holds SELECT and
 * INSERT alone:
 * - `writer`, pantry's like: `m1(v)` inserts A(v) where B(v) is absent; `m3(v)` B(v); `m6(v, w)` B(v) and A(w) in one
 *   ChangeSet; `m5(v)` D(v); `m7(v)` E(v);
 * - `publisher`, every key a parameter: `pubA(v)`, `pubB(v)`, `pubParent(v, kind)`;
 * - `learner`, reading publications only: `one(v)` copies PubB(v) into SeenB; `joint(v)` PubA(v) joined with PubB(v)
 *   into SpanAB; `check(v)` PubB(v) into C, whose foreign key reads PubA(v);
 * - `listed`, reading the publications at a relation parameter's keys: `many(keys)` into ListA, `copy(keys)` into Copy.
 */
export const publishedShape = (name: string) => {
	const stored = {
		A,
		B,
		D,
		E,
		PubA,
		PubB,
		SeenB,
		SpanAB,
		C: PubC,
		ListA: PubList,
		Copy: PubCopy,
		PubParent
	} as const
	const below = schema(name, Rec.values(stored), [
		contained(on(PubA, "v"), on(A, "v")),
		contained(on(PubB, "v"), on(B, "v")),
		contained(on(PubParent, "v"), on(A, "v")),
		contained(on(PubC, "v"), on(PubA, "v"))
	])
	const DE = derived(
		"DE",
		query(below).rule((r) => {
			const { v: value } = v(D, "d")
			return r.match(D, { v: value }).match(E, { v: value }).find({ v: value })
		})
	)
	const Kind1 = derived(
		"Kind1",
		query(below).rule((r) => {
			const { v: value } = v(PubParent, "parent")
			return r.match(PubParent, { v: value, kind: 1 }).find({ v: value })
		})
	)
	const base = schema.extend(
		below,
		`${name}_1`,
		[DE, Kind1],
		[key(on(DE, "v")), contained(on(PubCopy, "v"), on(Kind1, "v"))]
	)
	const writer = role(base, "writer", stored, { insert: ["A", "B", "D", "E"] })
	const publisher = role(base, "publisher", stored, { insert: ["PubA", "PubB", "PubParent"] })
	const learner = role(base, "learner", stored, { insert: ["SeenB", "SpanAB", "C"] })
	const listed = role(base, "listed", stored, { insert: ["ListA", "Copy"] })
	const w = writer.relations
	const m1 = ChangeSet.empty(writer).insert(
		w.A,
		query(writer).rule((r) =>
			r.where(r.not(w.B, { v: r.param("v", pg.integer) })).find({ v: r.param("v", pg.integer) })
		)
	)
	const m3 = ChangeSet.empty(writer).insert(
		w.B,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const m6 = ChangeSet.empty(writer)
		.insert(
			w.B,
			query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
		)
		.insert(
			w.A,
			query(writer).rule((r) => r.find({ v: r.param("w", pg.integer) }))
		)
	const m5 = ChangeSet.empty(writer).insert(
		w.D,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const m7 = ChangeSet.empty(writer).insert(
		w.E,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const p = publisher.relations
	const pubA = ChangeSet.empty(publisher).insert(
		p.PubA,
		query(publisher).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const pubB = ChangeSet.empty(publisher).insert(
		p.PubB,
		query(publisher).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const pubParent = ChangeSet.empty(publisher).insert(
		p.PubParent,
		query(publisher).rule((r) =>
			r.find({ v: r.param("v", pg.integer), kind: r.param("kind", pg.integer) })
		)
	)
	const l = learner.relations
	const one = ChangeSet.empty(learner).insert(
		l.SeenB,
		query(learner).rule((r) =>
			r.match(l.PubB, { v: r.param("v", pg.integer) }).find({ v: r.param("v", pg.integer) })
		)
	)
	const joint = ChangeSet.empty(learner).insert(
		l.SpanAB,
		query(learner).rule((r) =>
			r
				.match(l.PubA, { v: r.param("v", pg.integer) })
				.match(l.PubB, { v: r.param("v", pg.integer) })
				.find({ v: r.param("v", pg.integer) })
		)
	)
	const check = ChangeSet.empty(learner).insert(
		l.C,
		query(learner).rule((r) =>
			r.match(l.PubB, { v: r.param("v", pg.integer) }).find({ v: r.param("v", pg.integer) })
		)
	)
	const s = listed.relations
	const many = ChangeSet.empty(listed).insert(
		s.ListA,
		query(listed).rule((r) => {
			const keys = r.relation("keys", { v: pg.integer })
			const { v: value } = v(keys, "key")
			return r.match(keys, { v: value }).match(s.PubA, { v: value }).find({ v: value })
		})
	)
	const copy = ChangeSet.empty(listed).insert(
		s.Copy,
		query(listed).rule((r) => {
			const keys = r.relation("keys", { v: pg.integer })
			const { v: value } = v(keys, "key")
			return r.match(keys, { v: value }).match(s.PubA, { v: value }).find({ v: value })
		})
	)
	const workloads = [
		workload(writer, { m1, m3, m6, m5, m7 }),
		workload(publisher, { pubA, pubB, pubParent }),
		workload(learner, { one, joint, check }),
		workload(listed, { many, copy })
	] as const
	return {
		schema: base,
		roles: { writer, publisher, learner, listed },
		login: login(base, "app", [writer, publisher, learner, listed], { workload: workloads })
	}
}

const Word = str.bytes(16, str.regex("^[a-z]*$", "u"))
const ProbeServed = relation(
	"Served",
	{ sitting: pg.integer, step: pg.integer, item: pg.integer },
	["sitting", "step"]
)
const ProbeSave = relation(
	"Save",
	{ id: pg.integer, sitting: pg.integer, step: pg.integer, item: pg.integer },
	["id"]
)
const SaveValue = relation(
	"SaveValue",
	{
		save: pg.integer,
		response: Word,
		at: pg.integer,
		sitting: pg.integer,
		step: pg.integer,
		value: Word
	},
	["save", "response", "at"]
)

/**
 * B-03c's neutral probes under the name `name`, edullm's saveSelection over a Served row another role inserts: the
 * `starter`'s `start(sitting, step, item)` inserts Served from its parameters; the `saver`'s `save` inserts the Save
 * header and its SaveValue rows, each joined with the Served point at (sitting, step), under grizzle's insert protocol,
 * whose refusal arm and duplicate check reach Served only through that positive read.
 */
export const probeShape = (name: string) => {
	const relations = { Served: ProbeServed, Save: ProbeSave, SaveValue } as const
	const base = schema(name, Rec.values(relations), [
		contained(on(ProbeSave, "sitting", "step", "item"), on(ProbeServed, "sitting", "step", "item")),
		contained(on(SaveValue, "save", "sitting", "step"), on(ProbeSave, "id", "sitting", "step"))
	])
	const starter = role(base, "starter", relations, { insert: ["Served"] })
	const saver = role(base, "saver", relations, { insert: ["Save", "SaveValue"] })
	const start = ChangeSet.empty(starter).insert(
		starter.relations.Served,
		query(starter).rule((r) =>
			r.find({
				sitting: r.param("sitting", pg.integer),
				step: r.param("step", pg.integer),
				item: r.param("item", pg.integer)
			})
		)
	)
	const mine = saver.relations
	const save = ChangeSet.empty(saver)
		.insert(
			mine.Save,
			query(saver).rule((r) => {
				const { item } = v(mine.Served, "served")
				return r
					.match(mine.Served, {
						sitting: r.param("sitting", pg.integer),
						step: r.param("step", pg.integer),
						item
					})
					.where(r.eq(item, r.param("item", pg.integer)))
					.find({
						id: r.param("save", pg.integer),
						sitting: r.param("sitting", pg.integer),
						step: r.param("step", pg.integer),
						item
					})
			})
		)
		.insert(
			mine.SaveValue,
			query(saver).rule((r) => {
				const given = r.relation("selection", { response: Word, at: pg.integer, value: Word })
				const { response, at, value } = v(given, "given")
				const { item } = v(mine.Served, "served")
				return r
					.match(given, { response, at, value })
					.match(mine.Served, {
						sitting: r.param("sitting", pg.integer),
						step: r.param("step", pg.integer),
						item
					})
					.where(r.eq(item, r.param("item", pg.integer)))
					.find({
						save: r.param("save", pg.integer),
						response,
						at,
						sitting: r.param("sitting", pg.integer),
						step: r.param("step", pg.integer),
						value
					})
			})
		)
	const workloads = [workload(starter, { start }), workload(saver, { save })] as const
	return {
		schema: base,
		roles: { starter, saver },
		login: login(base, "app", [starter, saver], { workload: workloads })
	}
}

const Mark = relation("Y", { v: pg.integer }, ["v"])

/**
 * B-03c's boundary under the name `name`: the `skewer`'s `mark(v, sitting, step)` inserts Y(v) where Served(sitting,
 * step) is absent, and the `starterB`'s `startIfFree(sitting, step, item, v)` inserts Served where Y(v) is absent, the
 * classic write skew: a NOT EXISTS on a sealed point that no positive read of the same group gates.
 */
export const skewShape = (name: string) => {
	const relations = { Served: ProbeServed, Y: Mark } as const
	const base = schema(name, Rec.values(relations), [])
	const skewer = role(base, "skewer", relations, { insert: ["Y"] })
	const starterB = role(base, "starterB", relations, { insert: ["Served"] })
	const mark = ChangeSet.empty(skewer).insert(
		skewer.relations.Y,
		query(skewer).rule((r) =>
			r
				.where(
					r.not(skewer.relations.Served, {
						sitting: r.param("sitting", pg.integer),
						step: r.param("step", pg.integer)
					})
				)
				.find({ v: r.param("v", pg.integer) })
		)
	)
	const startIfFree = ChangeSet.empty(starterB).insert(
		starterB.relations.Served,
		query(starterB).rule((r) =>
			r.where(r.not(starterB.relations.Y, { v: r.param("v", pg.integer) })).find({
				sitting: r.param("sitting", pg.integer),
				step: r.param("step", pg.integer),
				item: r.param("item", pg.integer)
			})
		)
	)
	const workloads = [workload(skewer, { mark }), workload(starterB, { startIfFree })] as const
	return {
		schema: base,
		roles: { skewer, starterB },
		login: login(base, "app", [skewer, starterB], { workload: workloads })
	}
}

const ClaimSitting = relation(
	"Sitting",
	{ id: pg.uuidv7, child: pg.integer, test: pg.integer, attempt: pg.integer, opener: pg.integer },
	["id"]
)
const Claim = relation("Claim", { sitting: uuid, by: pg.integer }, ["sitting", "by"])
const Pt = relation("Pt", { test: pg.integer }, ["test"])

/**
 * NEGATION's arbitrated-read history under the name `name`: a Sitting whose id the database draws (pg.uuidv7), keyed
 * also by (child, test, attempt), with the call that opened it; the `claimer`'s `claimStart(child, test, attempt, by)`
 * inserts a Sitting opened by `by` and then a Claim of the Sitting at (child, test, attempt), and the `publisher`'s
 * `publish(test)` inserts Pt(test). The opener makes a call's Sitting its own: two calls' Sittings at one key differ,
 * so a call that comes after another's is refused, where an exact repeat would be a no-change that shows nothing. Where
 * `gated`, the Sitting's insert reads the published Pt(test), so a call that misses it inserts none and its second
 * statement claims another call's Sitting: two snapshots of rows another call writes. Where not, the Sitting comes from
 * the parameters alone, CHUNK's startSitting, the positive twin.
 */
export const claimShape = (name: string, gated: boolean) => {
	const relations = { Sitting: ClaimSitting, Claim, Pt } as const
	const base = schema(name, Rec.values(relations), [
		key(on(ClaimSitting, "child", "test", "attempt")),
		contained(on(Claim, "sitting"), on(ClaimSitting, "id"))
	])
	const claimer = role(base, "claimer", relations, { insert: ["Sitting", "Claim"] })
	const publisher = role(base, "publisher", relations, { insert: ["Pt"] })
	const mine = claimer.relations
	const sitting = gated
		? query(claimer).rule((r) =>
				r.match(mine.Pt, { test: r.param("test", pg.integer) }).find({
					child: r.param("child", pg.integer),
					test: r.param("test", pg.integer),
					attempt: r.param("attempt", pg.integer),
					opener: r.param("by", pg.integer)
				})
			)
		: query(claimer).rule((r) =>
				r.find({
					child: r.param("child", pg.integer),
					test: r.param("test", pg.integer),
					attempt: r.param("attempt", pg.integer),
					opener: r.param("by", pg.integer)
				})
			)
	const claimStart = ChangeSet.sequence(
		ChangeSet.empty(claimer).insert(mine.Sitting, sitting),
		ChangeSet.empty(claimer).insert(
			mine.Claim,
			query(claimer).rule((r) => {
				const { id } = v(mine.Sitting, "sitting")
				return r
					.match(mine.Sitting, {
						id,
						child: r.param("child", pg.integer),
						test: r.param("test", pg.integer),
						attempt: r.param("attempt", pg.integer)
					})
					.find({ sitting: id, by: r.param("by", pg.integer) })
			})
		)
	)
	const publish = ChangeSet.empty(publisher).insert(
		publisher.relations.Pt,
		query(publisher).rule((r) => r.find({ test: r.param("test", pg.integer) }))
	)
	const workloads = [workload(claimer, { claimStart }), workload(publisher, { publish })] as const
	return {
		schema: base,
		roles: { claimer, publisher },
		login: login(base, "app", [claimer, publisher], { workload: workloads })
	}
}

const FallbackG = relation("G", { k: pg.integer, x: pg.integer }, ["k"])
const FallbackW = relation("W", { k: pg.integer, val: pg.integer }, ["k"])
const FallbackZ = relation("Z", { k: pg.integer }, ["k"])

/**
 * The ways the `fallback` reads G, each a B-03c negative of NEGATION's: "rules", two rules of its insert's query, the
 * first writing G(k)'s x from G's row, the second 0 from G's absence; "bound", a match of a bound two-rule query, G's
 * row in one rule and the default 0 in the other, filtered by G's absence; "recursive", a match of a bound recursive
 * query whose base row is k itself and whose recursive rule joins G, filtered by G's absence, writing 0.
 */
export type FallbackForm = "rules" | "bound" | "recursive"

/**
 * NEGATION's B-03c negatives under the name `name`: the `fallback`'s `fallback(k)` inserts W(k) 0 where G holds no k,
 * and in the forms "rules" and "bound" G(k)'s x where it does, reading G in the form `form`; the `inserter`'s
 * `insertG(k, x)` inserts G(k); the `observer`'s `observe(k)` inserts Z(k) where W(k) and G(k) are both there.
 */
export const fallbackShape = (name: string, form: FallbackForm) => {
	const relations = { G: FallbackG, W: FallbackW, Z: FallbackZ } as const
	const base = schema(name, Rec.values(relations), [])
	const fallbackRole = role(base, "fallback", relations, { insert: ["W"] })
	const inserter = role(base, "inserter", relations, { insert: ["G"] })
	const observer = role(base, "observer", relations, { insert: ["Z"] })
	const f = fallbackRole.relations
	const writes = ChangeSet.empty(fallbackRole)
	const present = query(fallbackRole).rule((r) => {
		const { x } = v(f.G, "g")
		return r
			.match(f.G, { k: r.param("k", pg.integer), x })
			.find({ k: r.param("k", pg.integer), val: x })
	})
	const fallbackOf = () => {
		switch (form) {
			case "rules":
				return writes.insert(
					f.W,
					present.rule((r) =>
						r
							.where(r.not(f.G, { k: r.param("k", pg.integer) }))
							.find({ k: r.param("k", pg.integer), val: 0 })
					)
				)
			case "bound": {
				const candidates = present.rule((r) => r.find({ k: r.param("k", pg.integer), val: 0 }))
				return writes.insert(
					f.W,
					query(fallbackRole).rule((r) => {
						const c = candidates.bind({ k: r.param("k", pg.integer) })
						const { k, val } = v(c, "c")
						return r
							.match(c, { k, val })
							.where(r.not(f.G, { k: r.param("k", pg.integer) }))
							.find({ k, val })
					})
				)
			}
			case "recursive": {
				const chain = query(fallbackRole).recursive("Chain", {
					row: { k: pg.integer },
					base: [(r) => r.find({ k: r.param("k", pg.integer) })],
					rec: [
						(r, s) => {
							const { k } = v(s, "s")
							const { x } = v(f.G, "g")
							return r
								.match(s, { k })
								.match(f.G, { k: r.param("k", pg.integer), x })
								.where(r.eq(k, r.param("k", pg.integer)))
								.find({ k: x })
						}
					]
				})
				return writes.insert(
					f.W,
					query(fallbackRole).rule((r) => {
						const c = chain.bind({ k: r.param("k", pg.integer) })
						const { k } = v(c, "c")
						return r
							.match(c, { k })
							.where(r.not(f.G, { k: r.param("k", pg.integer) }))
							.find({ k, val: 0 })
					})
				)
			}
		}
	}
	const fallback = fallbackOf()
	const insertG = ChangeSet.empty(inserter).insert(
		inserter.relations.G,
		query(inserter).rule((r) =>
			r.find({ k: r.param("k", pg.integer), x: r.param("x", pg.integer) })
		)
	)
	const o = observer.relations
	const observe = ChangeSet.empty(observer).insert(
		o.Z,
		query(observer).rule((r) => {
			const { val } = v(o.W, "w")
			const { x } = v(o.G, "g")
			return r
				.match(o.W, { k: r.param("k", pg.integer), val })
				.match(o.G, { k: r.param("k", pg.integer), x })
				.find({ k: r.param("k", pg.integer) })
		})
	)
	const workloads = [
		workload(fallbackRole, { fallback }),
		workload(inserter, { insertG }),
		workload(observer, { observe })
	] as const
	return {
		schema: base,
		roles: { fallback: fallbackRole, inserter, observer },
		login: login(base, "app", [fallbackRole, inserter, observer], { workload: workloads })
	}
}

const Gate = relation("Gate", { v: pg.integer }, ["v"])
const FencedPub = relation("Pub", { v: pg.integer, s: pg.integer }, ["v"])
const FencedPubA = relation("PubA", { v: pg.integer }, ["v"])
const FencedPubZ = relation("PubZ", { v: pg.integer }, ["v"])
const FencedSeen = relation("Seen", { k: pg.integer, v: pg.integer }, ["k"])
const FencedSeenA = relation("SeenA", { k: pg.integer, v: pg.integer }, ["k"])
const FencedSeenZ = relation("SeenZ", { k: pg.integer, v: pg.integer }, ["k"])

/**
 * G3's replace under the name `name`: a published relation a publisher deletes and inserts again, beside a learner
 * whose rows reference it, certified READ COMMITTED by the fence its publisher's login takes (analysis/isolation
 * certify.ts Fence). Pub(v, s) holds a field beyond its key, so the learner's key into it is DEFERRABLE INITIALLY
 * DEFERRED, checked at the learner's COMMIT; PubA(v) and PubZ(v) hold their keys alone, so the keys into them are
 * checked at each insert, in the learner's statement order. Every role but the publisher writes by an insert list:
 * - `writer`: `gate(v)` inserts Gate(v);
 * - `publisher`, writing Pub, PubA and PubZ: `replace(v, s)` deletes the stored Pub at v and inserts Pub(v, s) in one
 *   ChangeSet, which deletes and inserts again the key v where s differs from the stored one and leaves an identical
 *   fact as it is; `remove(v)` deletes Pub at v; `publish(v, s)` inserts Pub(v, s) where Gate(v) is absent, a read of
 *   another call's rows, so the publisher may miss another call's write (NEGATION's case 3); `removeBoth(v)` deletes
 *   PubA and PubZ at v, its lock taking PubA, then PubZ;
 * - `learner`: `see(k, v)` inserts Seen(k, v); `za(k, v)` inserts SeenZ(k, v), then SeenA(k, v), each checking its
 *   publication at its insert, the order opposite to removeBoth's lock; `az(k, v)` the other way round.
 */
export const fencedShape = (name: string) => {
	const stored = {
		Gate,
		Pub: FencedPub,
		PubA: FencedPubA,
		PubZ: FencedPubZ,
		Seen: FencedSeen,
		SeenA: FencedSeenA,
		SeenZ: FencedSeenZ
	} as const
	const base = schema(name, Rec.values(stored), [
		contained(on(FencedSeen, "v"), on(FencedPub, "v")),
		contained(on(FencedSeenA, "v"), on(FencedPubA, "v")),
		contained(on(FencedSeenZ, "v"), on(FencedPubZ, "v"))
	])
	const writer = role(base, "writer", stored, { insert: ["Gate"] })
	const publisher = role(base, "publisher", stored, { write: ["Pub", "PubA", "PubZ"] })
	const learner = role(base, "learner", stored, { insert: ["Seen", "SeenA", "SeenZ"] })
	const w = writer.relations
	const gate = ChangeSet.empty(writer).insert(
		w.Gate,
		query(writer).rule((r) => r.find({ v: r.param("v", pg.integer) }))
	)
	const p = publisher.relations
	const storedPub = query(publisher).rule((r) => {
		const row = v(p.Pub, "p")
		return r
			.match(p.Pub, row)
			.where(r.eq(row.v, r.param("v", pg.integer)))
			.find(row)
	})
	const replace = ChangeSet.empty(publisher)
		.delete(p.Pub, storedPub)
		.insert(
			p.Pub,
			query(publisher).rule((r) =>
				r.find({ v: r.param("v", pg.integer), s: r.param("s", pg.integer) })
			)
		)
	const remove = ChangeSet.empty(publisher).delete(p.Pub, storedPub)
	const publish = ChangeSet.empty(publisher).insert(
		p.Pub,
		query(publisher).rule((r) =>
			r
				.where(r.not(p.Gate, { v: r.param("v", pg.integer) }))
				.find({ v: r.param("v", pg.integer), s: r.param("s", pg.integer) })
		)
	)
	const keyed = (relation: typeof p.PubA | typeof p.PubZ) =>
		query(publisher).rule((r) => {
			const row = v(relation, "p")
			return r
				.match(relation, row)
				.where(r.eq(row.v, r.param("v", pg.integer)))
				.find(row)
		})
	const removeBoth = ChangeSet.empty(publisher)
		.delete(p.PubA, keyed(p.PubA))
		.delete(p.PubZ, keyed(p.PubZ))
	const l = learner.relations
	const row = query(learner).rule((r) =>
		r.find({ k: r.param("k", pg.integer), v: r.param("v", pg.integer) })
	)
	const see = ChangeSet.empty(learner).insert(l.Seen, row)
	const za = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(l.SeenZ, row),
		ChangeSet.empty(learner).insert(l.SeenA, row)
	)
	const az = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(l.SeenA, row),
		ChangeSet.empty(learner).insert(l.SeenZ, row)
	)
	const workloads = [
		workload(writer, { gate }),
		workload(publisher, { replace, remove, publish, removeBoth }),
		workload(learner, { see, za, az })
	] as const
	return {
		schema: base,
		roles: { writer, publisher, learner },
		login: login(base, "app", [writer, publisher, learner], { workload: workloads })
	}
}
