import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	String as Str
} from "effect"
import { login } from "#compiler/program/workload/login.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { role } from "#compiler/schema/world.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { fixedDefaults, searchDefaults } from "#test/support/catalog/installed.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { migrated, type Version, worldRoleOf } from "#test/support/installed.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { roleSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The vector library's search policy as login defaults, over drawn worlds on one schema: Doc (a text domain of its
 * own), Embedding (a vector column), Tag (another text domain) and Vectors, a derived relation over Embedding.
 *
 * A case draws three roles, each holding a nonempty set of the four relations whole, writing some of the stored ones it
 * holds and refreshing Vectors when it holds it, and puts each in the login `alpha` or `beta`. A role reaches the
 * vector type when it holds Embedding or Vectors, so it may reach it through the derived relation alone. Every install
 * runs the installed-catalog checker (test/support/catalog/installed.ts), which judges what the catalog stores: each
 * login's defaults are the fixed ones plus, exactly when one of its roles reaches the vector type, the search policy's
 * session parameters; a role holds USAGE on the vector schema exactly when it reaches the type, and on a domain of the
 * schema at least when its views or its writes bind the type and at most when its privileges need it; MAINTAIN on the
 * materialized view goes to exactly its refreshers. Here:
 *
 * - a session of a login whose roles reach the vector type reads the policy's values, PostgreSQL applying them at
 *   login;
 * - a migration between versions whose worlds differ stores the policy for a login that gains it and resets it for one
 *   that loses it, and leaves alone a login whose reach does not change.
 */
const Slug = str.regex("^[a-z]{1,8}$")
const State = str.regex("^(on|off)$")
const Doc = relation("Doc", { id: uuid, slug: Slug }, ["id"])
const Embedding = relation("Embedding", { doc: uuid, value: pg.vector(3) }, ["doc"])
const Tag = relation("Tag", { doc: uuid, state: State }, ["doc"])

/** The schema under `name`: the stored relations, and Vectors in a level that extends them. */
const searchAt = (name: string) => {
	const core = schema(name, { Doc, Embedding, Tag }, [])
	const Vectors = derived(
		"Vectors",
		query(core).rule((r) => {
			const { doc, value } = v(Embedding, "embedding")
			return r.match(Embedding, { doc, value }).find({ doc, value })
		})
	)
	return schema.extend(core, { Vectors }, [])
}
type SearchSchema = ReturnType<typeof searchAt>

const readable = ["Doc", "Embedding", "Tag", "Vectors"] as const
type Readable = (typeof readable)[number]
const stored = ["Doc", "Embedding", "Tag"] as const
type Stored = (typeof stored)[number]
const loginNames = ["alpha", "beta"] as const
type LoginName = (typeof loginNames)[number]

/** A role's scope: what it holds whole, writes and refreshes. */
interface Scope {
	readonly holds: ReadonlyArray<Readable>
	readonly writes: ReadonlyArray<Stored>
	readonly refreshes: boolean
}

/** Whether a role reaches the vector type: Embedding's own column, or the derived relation's over it. */
const reaches = (s: Scope): boolean => s.holds.includes("Embedding") || s.holds.includes("Vectors")

/** A role drawn: its scope's masks and its login. */
interface RoleDraw {
	readonly holds: number
	readonly writes: number
	readonly refreshes: boolean
	readonly login: LoginName
}

const roleDrawGen =
	(vectorFree: boolean): Gen<RoleDraw> =>
	(source) => ({
		/** A vector-free draw holds Doc or Tag alone (bits 0 and 2). */
		holds: source.draw(vectorFree ? element<number>([1, 4, 5]) : int(1, 15)),
		writes: source.draw(int(0, 7)),
		refreshes: source.draw(boolean),
		login: source.draw(element(loginNames))
	})

const scopeOf = (d: RoleDraw): Scope => {
	const holds = whereIndex(readable, (i) => (d.holds & (1 << i)) !== 0)
	return {
		holds,
		writes: Arr.filter(stored, (r, i) => (d.writes & (1 << i)) !== 0 && holds.includes(r)),
		refreshes: d.refreshes && holds.includes("Vectors")
	}
}

/** Each login with its roles' scopes, a login no role is drawn into left out. */
interface SearchCase {
	readonly logins: ReadonlyArray<{
		readonly name: LoginName
		readonly scopes: ReadonlyArray<Scope>
	}>
}

/** Three roles; planted, one draw in four, none reaching the vector type. */
const caseGen: Gen<SearchCase> = (source) => {
	const vectorFree = source.draw(
		weighted([
			[3, constant(false)],
			[1, constant(true)]
		])
	)
	const roleDraw = roleDrawGen(vectorFree)
	const draws = [source.draw(roleDraw), source.draw(roleDraw), source.draw(roleDraw)]
	return {
		logins: Arr.flatMap(loginNames, (name) => {
			const scopes = Arr.map(
				Arr.filter(draws, (d) => d.login === name),
				scopeOf
			)
			return scopes.length === 0 ? [] : [{ name, scopes }]
		})
	}
}

/** The worlds of `logins` over `base`: each scope a role `<login>_<n>`. */
const worldsOf = (base: SearchSchema, logins: SearchCase["logins"]) =>
	Arr.map(logins, (l) => {
		const roles = Arr.map(l.scopes, (s, n) => {
			const entries: Record<string, EntryValue> = {}
			for (const r of s.holds) {
				entries[r] = base.relations[r]
			}
			return role(base, `${l.name}_${n}`, entries, {
				write: [...s.writes],
				refresh: s.refreshes ? ["Vectors"] : []
			})
		})
		const [first, ...rest] = roles
		if (first === undefined) {
			throw new Error(`the login ${l.name} has no role`)
		}
		return {
			name: l.name,
			reaches: Arr.some(l.scopes, reaches),
			value: login(base, l.name, [first, ...rest])
		}
	})

/**
 * The defaults a login stores: the fixed ones, and the search policy's when one of its roles reaches the vector type.
 */
const defaultsOf = (reach: boolean): ReadonlyArray<string> =>
	Arr.sort([...fixedDefaults, ...(reach ? searchDefaults : [])], Order.String)

/** A login's stored defaults for every database, sorted, as the owner reads them. */
const storedQuery =
	"SELECT x FROM pg_catalog.pg_db_role_setting AS s, unnest(s.setconfig) AS x " +
	"WHERE s.setdatabase = 0 AND s.setrole = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) " +
	"ORDER BY x"

type SearchFeature =
	| "a role reaching the vector type through the derived relation alone"
	| "a login none of whose roles reaches the vector type"
	| "a login one of whose roles reaches the vector type"
	| "a refresher of the derived relation"
	| "a reader of the derived relation that does not refresh it"

const notesOf = (c: SearchCase, cx: Case<SearchFeature>): void => {
	for (const l of c.logins) {
		cx.note(
			Arr.some(l.scopes, reaches)
				? "a login one of whose roles reaches the vector type"
				: "a login none of whose roles reaches the vector type"
		)
		for (const s of l.scopes) {
			if (s.holds.includes("Vectors") && !s.holds.includes("Embedding")) {
				cx.note("a role reaching the vector type through the derived relation alone")
			}
			if (s.refreshes) {
				cx.note("a refresher of the derived relation")
			} else if (s.holds.includes("Vectors")) {
				cx.note("a reader of the derived relation that does not refresh it")
			}
		}
	}
}

/** Each search default as `[parameter, value]`. */
const searchPairs: ReadonlyArray<readonly [string, string]> = Arr.map(searchDefaults, (d) => {
	const at = Option.getOrThrowWith(
		pipe(d, Str.indexOf("=")),
		() => new Error(`the search default ${d} holds an =`)
	)
	return [Str.slice(0, at)(d), Str.slice(at + 1)(d)] as const
})

layer(Substrate.layer)("the search policy as login defaults", (it) => {
	it.effect(
		"a login's session holds the policy exactly when one of its roles reaches the vector type",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							suite: "pg/physical/search-policy",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<SearchFeature>(
								[
									"a role reaching the vector type through the derived relation alone",
									"a login none of whose roles reaches the vector type",
									"a login one of whose roles reaches the vector type",
									"a refresher of the derived relation",
									"a reader of the derived relation that does not refresh it"
								],
								{ cases: 8, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: { kind: "complete" },
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(c, cx) =>
							Effect.scoped(
								Effect.gen(function* () {
									notesOf(c, cx)
									const base = searchAt("Search")
									/** The install runs the installed-catalog checker over what each login stores. */
									const installed = yield* install(base, {
										ambient: ordinarySession,
										label: "search",
										logins: Arr.map(worldsOf(base, c.logins), (l) => l.value),
										extensions: []
									})
									for (const l of worldsOf(searchAt(installed.declared), c.logins)) {
										if (!l.reaches) {
											continue
										}
										const session = yield* s.session({
											...roleSession(installed.as(l.value)),
											label: l.name
										})
										for (const [parameter, value] of searchPairs) {
											const rows = yield* session.values(
												"SELECT pg_catalog.current_setting($1::text, true)",
												[parameter]
											)
											assert.deepEqual(
												rows,
												[[value]],
												`the login ${l.name}'s session holds ${parameter}`
											)
										}
									}
								})
							)
					)
				})
			)
	)

	it.effect(
		"a migration stores the policy for a login that gains it, resets it for one that loses it, and leaves the rest",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					/**
					 * alpha's role holds Doc, then Doc and Vectors, then Doc again; beta's holds Embedding throughout.
					 */
					const alpha = (holds: ReadonlyArray<Readable>): Scope => ({
						holds,
						writes: [],
						refreshes: false
					})
					const beta: Scope = { holds: ["Embedding"], writes: [], refreshes: false }
					const steps: ReadonlyArray<ReadonlyArray<Readable>> = [
						["Doc"],
						["Doc", "Vectors"],
						["Doc"]
					]
					const built: Array<ReturnType<typeof worldsOf>> = []
					const version =
						(holds: ReadonlyArray<Readable>) =>
						(name: string): Version => {
							const base = searchAt(name)
							const worlds = worldsOf(base, [
								{ name: "alpha", scopes: [alpha(holds)] },
								{ name: "beta", scopes: [beta] }
							])
							built.push(worlds)
							return { schema: base, logins: Arr.map(worlds, (w) => w.value) }
						}
					const observed: Array<ReadonlyArray<ReadonlyArray<string>>> = []
					const [first, ...later] = Arr.map(steps, version)
					yield* migrated({
						label: "search_mig",
						schemaName: { kind: "unique" },
						first: defined(first, "the first version"),
						later,
						apply: { kind: "noPlaceholders" },
						register: false,
						renames: "kept",
						observe: Option.some((i: number, owner: RawSession) =>
							Effect.gen(function* () {
								const worlds = defined(built[i], `version ${i}`)
								const stores: Array<ReadonlyArray<string>> = []
								for (const w of worlds) {
									const rows = yield* owner.values(storedQuery, [worldRoleOf(w.value)])
									stores.push(Arr.map(rows, (row) => String(row[0])))
								}
								observed.push(stores)
							})
						)
					})
					assert.deepEqual(
						observed,
						Arr.map(steps, (holds) => [
							defaultsOf(reaches(alpha(holds))),
							defaultsOf(reaches(beta))
						]),
						"each login's defaults at each version"
					)
				})
			),
		300_000
	)
})
