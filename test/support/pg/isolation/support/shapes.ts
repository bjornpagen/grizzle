import { Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { Id } from "#test/support/ids.ts"

const Doc = relation("Doc", { node: Id, n: pg.integer }, ["node"])
const Pool = relation("Pool", { doc: Id, pool: pg.integer, size: pg.integer }, ["doc", "pool"])
const Sitting = relation("Sitting", { id: Id, doc: Id, child: pg.integer, pools: natural }, ["id"])
const Served = relation("Served", { sitting: Id, doc: Id, pool: pg.integer, size: pg.integer }, [
	"sitting",
	"pool"
])

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
	const docOf = (n: number) => query(importer).rule((r) => r.find({ node: r.param("node", Id), n }))
	const poolOf = (pool: number, size: "a" | "b") =>
		query(importer).rule((r) =>
			r.find({ doc: r.param("node", Id), pool, size: r.param(size, pg.integer) })
		)
	const import1 = ChangeSet.empty(importer)
		.insert(theirs.Doc, docOf(1))
		.insert(theirs.Pool, poolOf(0, "a"))
	const import2 = ChangeSet.empty(importer)
		.insert(theirs.Doc, docOf(2))
		.insert(
			theirs.Pool,
			poolOf(0, "a").rule((r) =>
				r.find({ doc: r.param("node", Id), pool: 1, size: r.param("b", pg.integer) })
			)
		)
	const extend = ChangeSet.empty(importer).insert(
		theirs.Pool,
		query(importer).rule((r) => {
			const { node } = v(theirs.Doc, "doc")
			return r
				.match(theirs.Doc, { node })
				.where(r.eq(node, r.param("node", Id)))
				.find({ doc: node, pool: r.param("pool", pg.integer), size: r.param("a", pg.integer) })
		})
	)
	const counted = query(learner).rule((r) => {
		const { pool } = v(mine.Pool, "pool")
		return r.match(mine.Pool, { doc: r.param("doc", Id), pool }).find({ pools: r.count() })
	})
	const start = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(
			mine.Sitting,
			query(learner).rule((r) => {
				const count = counted.bind({ doc: r.param("doc", Id) })
				const { pools } = v(count, "count")
				return r
					.match(mine.Doc, { node: r.param("doc", Id) })
					.match(count, { pools })
					.find({
						id: r.param("id", Id),
						doc: r.param("doc", Id),
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
					.where(r.eq(id, r.param("id", Id)))
					.find({ sitting: id, doc, pool, size })
			})
		)
	)
	const named = (pools: 1 | 2) => {
		const sitting = query(learner).rule((r) =>
			r.find({
				id: r.param("id", Id),
				doc: r.param("doc", Id),
				child: r.param("child", pg.integer),
				pools: BigInt(pools)
			})
		)
		const first = query(learner).rule((r) =>
			r.find({
				sitting: r.param("id", Id),
				doc: r.param("doc", Id),
				pool: 0,
				size: r.param("a", pg.integer)
			})
		)
		const served =
			pools === 1
				? first
				: first.rule((r) =>
						r.find({
							sitting: r.param("id", Id),
							doc: r.param("doc", Id),
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
