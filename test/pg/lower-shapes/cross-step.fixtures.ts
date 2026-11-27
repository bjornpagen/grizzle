/** What cross-step.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { BenchSession } from "#bench/harness/session.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import {
	fullWorldRole,
	type PgClassState,
	pgClassStates,
	servedRead,
	servedRun,
	type StateLoad,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { readWork } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"

const i = pg.integer

/** A file's path or a media type's suffix or name, up to 256 bytes of any text. */
const Path = str.bytes(256, str.regex("^.*$", "su"))

/**
 * A package's documents and media, as pantry holds them: each media file a document names, by the document's place and
 * the file's path; each media file of a package by its path; and the media types the application serves, each by the
 * suffix a path ends with, a policy's rows; and a learner's sessions, each of a document of a package.
 */
const Session = relation("Session", { child: i, n: i, package: i, path: i }, ["child", "n"])
const Named = relation("Named", { package: i, path: i, target: Path }, [
	"package",
	"path",
	"target"
])
const Media = relation("Media", { package: i, path: Path }, ["package", "path"])
const MediaType = relation("MediaType", { suffix: Path, type: Path }, ["suffix"])
const Content = schema("CrossStep", [Session, Named, Media, MediaType], [])

/**
 * Every media file of a package whose path ends with a media type's suffix, with the type it is served as, as pantry's
 * listedMedia reads it: a suffix test, no equality, joins the type to the file, so the type is read whole for each file.
 */
const listed = query(Content).rule((r) => {
	const { package: pkg, path } = v(Media, "media")
	const { suffix, type } = v(MediaType, "policy")
	return r
		.match(Media, { package: pkg, path })
		.match(MediaType, { suffix, type })
		.where(Logic.eq(Text.endsWith(Text.lowerAscii(path), suffix), true))
		.find({ package: pkg, path, type })
})

/**
 * Each media file a document names that a media type serves, by the document's place, as pantry's ServedFile. No unit
 * holds it, so nothing stores it.
 */
const Served = derived(
	"Served",
	query(Content).rule((r) => {
		const { package: pkg, path, target } = v(Named, "named")
		const { type } = v(listed, "listed")
		return r
			.match(Named, { package: pkg, path, target })
			.match(listed, { package: pkg, path: target, type })
			.find({ package: pkg, path, target, type })
	})
)
const Served_ = schema.extend([Content], "CrossStepServed", [Served], [])

/**
 * A learner's sessions, at the parameter, each with the files its document serves attached, as metis's resume reads
 * pantry's served files at each session's package and path: the chain reads the document's named files by its key, each
 * file by its key, and the media types whole beside it.
 */
const filesRead = query(Served_)
	.rule((r) => {
		const { child, n, package: pkg, path } = v(Session, "session")
		return r
			.match(Session, { child, n, package: pkg, path })
			.where(r.eq(child, r.param("child", i)))
			.find({ child, n, package: pkg, path })
	})
	.attach(
		"files",
		(head) =>
			query(Served_).rule((r) => {
				const { target, type } = v(Served, "served")
				return r
					.match(Served, { package: head.package, path: head.path, target, type })
					.find({ target, type })
			}),
		"array"
	)

/** The schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const crossTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "cross step",
	fixture: Served_,
	programs: { filesRead },
	contexts: [],
	label: "cross_step",
	ambient: ordinarySession
})

/**
 * A case: `packages` packages stored, each of `documents` documents naming `named` files each, every file of the package
 * at its own path, a third of them of no served type; `types` media types; the learner's `sessions` sessions, each of a
 * document of package 1; then `more` packages stored beside them before the read is explained again; and the pg_class
 * state its tables stand in as each load ends (test/support/advice.ts PgClassState).
 */
export interface CrossCase {
	readonly packages: number
	readonly documents: number
	readonly named: number
	readonly types: number
	readonly sessions: number
	readonly more: number
	readonly state: PgClassState
}

export const crossGen: Gen<CrossCase> = (s) => {
	const documents = s.draw(int(1, 6))
	return {
		packages: s.draw(int(1, 4)),
		documents,
		named: s.draw(int(1, 4)),
		types: s.draw(int(1, 6)),
		sessions: s.draw(int(1, documents)),
		more: s.draw(int(20, 60)),
		state: s.draw(element(pgClassStates))
	}
}

export type CrossFeature =
	| "beside few packages"
	| "beside many packages"
	| `its tables ${PgClassState}`

/**
 * The statements storing packages `from` to `to`: each document's named files `d<doc>-<k>.x<k % 3>`, each a media
 * file; with the first packages, the media types `.x1` to `.x<types>`, of which only `.x1` and `.x2` end a file (`.x0`
 * none serves), and the learner's sessions.
 */
const stored = (
	installed: Installed,
	c: CrossCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const files = `FROM generate_series(${String(from)}, ${String(to)}) AS g(p), generate_series(1, ${String(c.documents)}) AS h(doc), generate_series(1, ${String(c.named)}) AS k(f)`
	const file = `'d' || doc || '-' || f || '.x' || (f % 3)`
	return [
		`INSERT INTO ${names.table(Named)} SELECT p, doc, ${file} ${files}`,
		`INSERT INTO ${names.table(Media)} SELECT p, ${file} ${files}`,
		...(from === 1
			? [
					`INSERT INTO ${names.table(MediaType)} SELECT '.x' || t, 'type ' || t FROM generate_series(1, ${String(c.types)}) AS g(t)`,
					`INSERT INTO ${names.table(Session)} SELECT 1, n, 1, n FROM generate_series(1, ${String(c.sessions)}) AS g(n)`
				]
			: [])
	]
}

/**
 * The packages a case stores beside its own before any of them, numbered past every package a case stores, each of one
 * document naming one media file, and as many other learners' sessions of them: `rows` of each, one past the read's
 * bound, so a read of any of the three whole, or of every package's files, reads past it, where a read of the learner's
 * rows alone never meets them.
 */
const besidePackages = (installed: Installed, rows: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const packages = `FROM generate_series(1000000, ${String(1_000_000 + rows - 1)}) AS g(p)`
	return [
		`INSERT INTO ${names.table(Named)} SELECT p, 1, 'd1-1.x1' ${packages}`,
		`INSERT INTO ${names.table(Media)} SELECT p, 'd1-1.x1' ${packages}`,
		`INSERT INTO ${names.table(Session)} SELECT p, 1, p, 1 ${packages}`
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: the packages beside (`besidePackages`) stored, then
 * packages 1 to `packages` with the media types and the learner's sessions, its tables stood in the case's pg_class
 * state, and the read of the learner's sessions run under its carried advice once the plan laws hold over it
 * (test/support/advice.ts advisedRun); then `more` packages stored beside them, stood again, and the read run again.
 * Both times its work (test/support/judge.ts readWork) is at most three times the learner's own rows, its sessions,
 * their documents' named files, each file and the media types tested against it; and beside more packages no more than
 * beside a few: the files attachment reads each session's document by its key, each named file by its key, and the
 * media types whole beside each (cte-policy Rank `cross`), where a chain stalled at the media types co-grouped the
 * attachment and derived every package's served files.
 */
export const runCross = (
	installed: Installed,
	connection: PgConnection,
	c: CrossCase,
	k: Case<CrossFeature>
) =>
	Effect.gen(function* () {
		const session: BenchSession = { values: connection.queryValues }
		/** The learner's own rows: its sessions, their documents' named files, each file and each type tested against it. */
		const own = c.sessions * (1 + c.named * (2 + c.types))
		const bound = 3 * own
		const names = namesOf(installed)
		const tables: Arr.NonEmptyReadonlyArray<string> = [
			names.table(Session),
			names.table(Named),
			names.table(Media),
			names.table(MediaType)
		]
		const storing = (first: number): StateLoad => ({
			tables,
			units: first === 1 ? c.packages : c.more,
			load: (from, to) =>
				Effect.forEach(
					stored(installed, c, first + from - 1, first + to - 1),
					(sql) => connection.query(sql, []),
					{ discard: true }
				)
		})
		for (const sql of besidePackages(installed, bound + 1)) {
			yield* connection.query(sql, [])
		}
		yield* standIn(session, storing(1), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Served_, []),
			filesRead,
			"the read of the learner's sessions"
		)
		const explained = Effect.map(servedRun(session, read, { child: 1 }), readWork)
		const few = yield* explained
		yield* standIn(session, storing(c.packages + 1), c.state)
		const many = yield* explained
		assert.ok(
			few <= bound && many <= few,
			`${Formatter.format(c)}: the read of the learner's sessions reads ${String(few)} rows beside ${String(c.packages)} packages and ${String(many)} beside ${String(c.packages + c.more)}, its bound ${String(bound)} (the learner's ${String(own)})\n${read.statement.sql}`
		)
		k.note(c.packages < 3 ? "beside few packages" : "beside many packages")
		k.note(`its tables ${c.state}`)
	})
