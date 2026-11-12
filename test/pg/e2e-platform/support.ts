import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { DbOf } from "#adapter/types/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { literalDescShape } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { isSpanCarrier, type ScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import { Identities } from "#test/support/kernel/identity.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import { Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { distinctRows, equal, type Row, type Value } from "#test/support/oracle/reference/values.ts"
import type { SqlError } from "#test/support/pg.ts"
import { loadOrder, type PlatformFacts } from "#test/support/platform/generate.ts"
import { stateOf, withDrawn } from "#test/support/platform/laws.ts"
import { type ServedFixture, servedGenerated } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The platform rebuilt under an installed name, with its world. */
type PlatformWorld = ReturnType<typeof P.platformAt>

export type PlatformDb = DbOf<PlatformWorld["billing"], P.BillingPrograms>

export interface OpenedPlatform {
	readonly installed: Installed
	readonly schema: PlatformWorld
	/** The login `server` served from the file generate wrote for it: billing's workload (P.BillingPrograms). */
	readonly served: ServedFixture<PlatformWorld["server"]>
	/** A relation's table, schema-qualified and quoted. */
	readonly table: (relation: string) => string
	/** Every stored relation's rows deleted, as the owner: the next case starts from an empty platform. */
	readonly clear: Effect.Effect<void, SqlError>
	/**
	 * Runs `body` on the platform opened as `billing` through the served login, in a scope of its own, with whatever
	 * else it needs.
	 */
	readonly withDb: <A, E, R>(
		body: (db: PlatformDb) => Effect.Effect<A, E, R | Scope.Scope>
	) => Effect.Effect<A, E | OpenError, R>
}

/**
 * Shared helpers of the platform's end-to-end suites (test/pg/e2e-platform).
 *
 * The platform (test/support/fixtures/api/platform.ts) installs as a deployment installs it, as `grizzle generate`
 * drafts and serves it (test/support/install-migrate.ts installGenerated): built under a name the substrate allocates
 * (platformAt), its first migration drafted with its logins' workloads, their access paths and the live source of their
 * reads, and applied by the real apply runner. Its login is served from the file generate wrote for it, and a Db is
 * opened through Db.open as the full role `billing` of the schema rebuilt under that name, whose levels hold the
 * declared schemas' types, so every workload read and write runs on it unchanged, as a member of billing's served
 * workload.
 *
 * Facts load through the public API only: the workload's `load`, one ChangeSet inserting every relation's facts given
 * with each call, within the input limit, each call of which the laws must accept. A generated platform is lawful by construction (test/support/platform/generate.ts), so a
 * refused load is a defect of the generator or of grizzle, reported with the law.
 *
 * The reference evaluator (test/support/oracle/reference) reads a workload read's checked IR, the compiler's own
 * translation, over the same facts as typed literals; what it delivers per statement (the root's rows, and each
 * attachment's parent keys with their children) is compared with what the public read decoded, flattened the same way,
 * each column by its type's own equality and each statement as a set.
 *
 * Installs the platform with its workload under a fresh name and opens it (see the header).
 */
export const openPlatform = (
	label: string
): Effect.Effect<
	OpenedPlatform,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => openPlatformWith(label, () => [])

/**
 * openPlatform, installing `also`'s logins beside billing's: the logins a suite reads the platform through besides
 * billing, built by `also` over the platform under the allocated name to install and, by the suite, over the installed
 * one (OpenedPlatform's `schema`) to open.
 */
export const openPlatformWith = (
	label: string,
	also: (world: PlatformWorld) => ReadonlyArray<AnyLogin>
): Effect.Effect<
	OpenedPlatform,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const generated = yield* installGenerated(
			(name) => {
				const world = P.platformAt(name)
				return { schema: world.Billing, logins: [world.server, ...also(world)] }
			},
			{ label, ambient: ordinarySession }
		)
		const installed = generated.installed
		const schema = P.platformAt(installed.declared)
		const served = servedGenerated(generated, schema.server)
		const table = (relation: string): string => {
			const q = installed.names.relation(relation)
			return `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		}
		const clear = s.admin.query(`TRUNCATE ${Arr.join(Arr.map(loadOrder, table), ", ")}`, [])
		return {
			installed,
			schema,
			served,
			table,
			clear: Effect.asVoid(clear),
			withDb: (body) =>
				Effect.scoped(
					Effect.flatMap(Layer.build(served.layer), (context) =>
						Effect.provideContext(
							Effect.scoped(Effect.flatMap(Db.open(served.login.roles.billing, {}), body)),
							context
						)
					)
				)
		}
	})

const factCount = (f: PlatformFacts): number => Arr.reduce(loadOrder, 0, (n, r) => n + f[r].length)

/** A load the laws refused, or that changed nothing: a defect of the generator or of grizzle. */
class LoadRefused extends Data.TaggedError("LoadRefused")<{ readonly reason: string }> {
	override get message(): string {
		return this.reason
	}
}

/** Applies the facts `f` through the workload's load, one ChangeSet; it must be accepted. */
export const applyFacts = (db: PlatformDb, f: PlatformFacts) =>
	Effect.gen(function* () {
		if (factCount(f) === 0) {
			return
		}
		const outcome = yield* answered(db.workload.load.once({ params: {}, facts: { insert: f } }))
		if (outcome.kind === "refused") {
			return yield* Effect.die(
				new LoadRefused({
					reason: `the load was refused by ${Formatter.format(outcome.refused.laws)}: ${Formatter.format(outcome.witness)}`
				})
			)
		}
		if (outcome.kind === "unchanged") {
			return yield* Effect.die(new LoadRefused({ reason: "the load changed nothing" }))
		}
	})

/** A host value as the literal of `type` it is (a span as its endpoints), or the defect of the test. */
const literalOf = (value: unknown, type: ScalarType, what: string) => {
	const desc = isSpanCarrier(type.carrier) && isRecord(value) ? { span: value } : value
	const decoded = succeeded(
		S.decodeWith(literalDescShape, desc, what),
		`${what} is a Description literal`
	)
	return succeeded(irLiteral(decoded, type), `${what} is a literal of its type`).literal
}

/**
 * The host facts of a relation by declared name: the platform's stored facts, each owner with the count and sums the
 * host draws for its counted families (withDrawn), as a read reads the stored row whole, and DailySpend's refreshed
 * rows.
 */
export type HostFacts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

export const hostFacts = (
	f: PlatformFacts,
	dailySpend: ReadonlyArray<Readonly<Record<string, unknown>>>
): HostFacts => ({
	...Rec.fromEntries([...withDrawn(stateOf(f))]),
	DailySpend: dailySpend
})

/** The relations a checked query reads, with the heading each is read under. */
const baseHeadings = (q: LogicalQuery): ReadonlyMap<string, Heading> => {
	const out = new Map<string, Heading>()
	for (const node of topoOrder(q.dag)) {
		if (node.kind === "Base") {
			out.set(node.relation, node.heading)
		}
	}
	return out
}

/** The reference's input for a checked query over host facts and the caller's parameters by name. */
const referenceOf = (
	q: LogicalQuery,
	facts: HostFacts,
	params: Readonly<Record<string, unknown>>
): Reference => {
	const headings = baseHeadings(q)
	const schema: GenSchema = {
		name: "Platform",
		relations: Arr.map([...headings], ([name, heading]) => ({
			name,
			columns: Arr.map(heading, (c) => ({ name: c.name, type: c.type })),
			primaryKey: [],
			keys: [],
			mutable: false
		})),
		closed: [],
		containments: []
	}
	const valueFacts = Rec.fromEntries(
		Arr.map([...headings], ([name, heading]) => [
			name,
			Arr.map(facts[name] ?? [], (fact) =>
				Arr.map(heading, (c) => literalOf(fact[c.name], c.type, `${name}.${c.name}`))
			)
		])
	)
	const genParams: Record<string, GenParam> = {}
	for (const decl of q.params) {
		const value = params[decl.name]
		if (decl.kind === "relation") {
			const rows = Arr.isArray(value) ? value : []
			genParams[decl.id] = {
				kind: "relation",
				heading: decl.heading,
				rows: Arr.map(rows, (row: unknown) =>
					Arr.map(decl.heading, (c) =>
						literalOf(isRecord(row) ? row[c.name] : undefined, c.type, `${decl.name}.${c.name}`)
					)
				)
			}
		} else {
			genParams[decl.id] = {
				kind: "scalar",
				type: decl.type,
				value: literalOf(value, decl.type, decl.name)
			}
		}
	}
	return Reference.of(q.dag, {
		schema,
		facts: canonicalFacts(valueFacts),
		params: genParams,
		observer: unobserved
	})
}

/** The checked IR of a query over the platform, as the runtime compiles it. */
const checkedOf = (query: unknown): LogicalQuery =>
	succeeded(compileTemplate(query, P.Billing, testCompile), "the workload read compiles").programs
		.checked

/**
 * What a read delivers by the reference, statement by statement, and each attachment's correlation by its name: the
 * parent column each correlation column of its child's heading equals.
 */
export interface Expected {
	readonly statements: ReadonlyArray<ExpectedStatement>
	readonly correlations: ReadonlyMap<
		string,
		ReadonlyArray<{ readonly parent: string; readonly child: string }>
	>
}

export const expectedOf = (
	query: unknown,
	facts: HostFacts,
	params: Readonly<Record<string, unknown>>
): Expected => {
	const q = checkedOf(query)
	const correlations = new Map<
		string,
		ReadonlyArray<{ readonly parent: string; readonly child: string }>
	>()
	for (const node of topoOrder(q.dag)) {
		if (node.kind === "Attach") {
			correlations.set(node.name, node.correlation)
		}
	}
	return {
		statements: expectedStatements(referenceOf(q, facts, params), q.dag.roots[0]),
		correlations
	}
}

/** The rows of DailySpend's definition over the facts: what a refresh stores, by the reference. */
export const dailySpendRows = (
	facts: PlatformFacts
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	const q = checkedOf(P.dailySpendDefinition)
	const [main] = expectedStatements(referenceOf(q, hostFacts(facts, []), {}), q.dag.roots[0])
	if (main === undefined) {
		return []
	}
	return Arr.map(main.rows, (row) =>
		Rec.fromEntries(Arr.map(main.heading, (c, i) => [c.name, hostOf(row[i], c.type)]))
	)
}

/** A reference value as the host value a fact holds. */
const hostOf = (v: Value | undefined, type: ScalarType): unknown => {
	if (v === undefined) {
		return undefined
	}
	if ((type.carrier === "int2" || type.carrier === "int4") && typeof v === "bigint") {
		return Number(v)
	}
	return v
}

/** A decoded host value as the reference's carrier of `type`. */
const carrier = (type: ScalarType, host: unknown, what: string): Value => {
	switch (type.carrier) {
		case "int2":
		case "int4":
			if (typeof host === "number" && Number.isSafeInteger(host)) {
				return BigInt(host)
			}
			break
		case "int8":
		case "exactInteger":
			if (typeof host === "bigint") {
				return host
			}
			break
		case "numeric":
			if (host instanceof Decimal) {
				return host
			}
			break
		case "uuid":
		case "text":
		case "code":
		case "date":
			if (typeof host === "string") {
				return host
			}
			break
		case "bool":
			if (typeof host === "boolean") {
				return host
			}
			break
		case "range4":
		case "range8":
			if (isRecord(host) && typeof host["start"] === "bigint" && typeof host["end"] === "bigint") {
				return { start: host["start"], end: host["end"] }
			}
			break
		case "rangeDate": {
			if (!isRecord(host)) {
				break
			}
			const start = toCalendarDate(host["start"])
			const end = toCalendarDate(host["end"])
			if (start.ok && end.ok) {
				return { start: BigInt(dayNumber(start.value)), end: BigInt(dayNumber(end.value)) }
			}
			break
		}
		case "float4":
		case "float8":
		case "money":
		case "exactMoney":
		case "vector":
		case "bits":
		case "bytes":
			break
	}
	throw new Error(`${what}: a ${type.carrier} column delivered ${typeof host} ${String(host)}`)
}

/**
 * The children an attachment delivered under a parent row: an array as is, an Option as its value or none, the one
 * child as itself.
 */
const childrenOf = (delivered: unknown, what: string): ReadonlyArray<unknown> => {
	if (Arr.isArray(delivered)) {
		return delivered
	}
	if (Option.isOption(delivered)) {
		return Option.isSome(delivered) ? [delivered.value] : []
	}
	if (isRecord(delivered)) {
		return [delivered]
	}
	throw new Error(`${what}: an attachment delivered as ${String(delivered)}`)
}

const field = (row: unknown, name: string, what: string): unknown => {
	if (!isRecord(row) || !Rec.has(row, name)) {
		throw new Error(`${what}: a row without ${name}`)
	}
	return row[name]
}

/**
 * The public rows of a read flattened into the reference's statements: the root's rows under the main heading, and for
 * each attachment statement, each parent's key followed by each of its children, the parents of a nested attachment
 * being its parent statement's children. A child's correlation column, which the public child does not repeat, is its
 * parent's column it equals.
 */
export const flattened = (
	expected: Expected,
	rows: ReadonlyArray<unknown>
): ReadonlyArray<ExpectedStatement> => {
	const delivered = new Map<string, ReadonlyArray<unknown>>([["main", rows]])
	return Arr.map(expected.statements, (statement) => {
		if (statement.role !== "attachment") {
			const values = Arr.map(rows, (row) =>
				Arr.map(statement.heading, (c) =>
					carrier(c.type, field(row, c.name, statement.label), statement.label)
				)
			)
			return {
				...statement,
				rows: distinctRows(values, statement.heading, statement.label, new Identities())
			}
		}
		const path = Str.split(statement.label, "/")
		const parentLabel = Arr.join(Arr.initNonEmpty(path), "/")
		const name = Arr.lastNonEmpty(path)
		const correlation = expected.correlations.get(name) ?? []
		const parents = delivered.get(parentLabel) ?? []
		const keys = statement.heading.slice(0, statement.parentKeyWidth)
		const columns = statement.heading.slice(statement.parentKeyWidth)
		const children: Array<unknown> = []
		const out: Array<Row> = []
		for (const parent of parents) {
			const key = Arr.map(keys, (c) =>
				carrier(c.type, field(parent, c.name, statement.label), statement.label)
			)
			for (const child of childrenOf(field(parent, name, statement.label), statement.label)) {
				children.push(child)
				out.push([
					...key,
					...Arr.map(columns, (c) =>
						Option.match(
							Arr.findFirst(correlation, (x) => x.child === c.name),
							{
								onNone: () =>
									carrier(c.type, field(child, c.name, statement.label), statement.label),
								onSome: (x) =>
									carrier(c.type, field(parent, x.parent, statement.label), statement.label)
							}
						)
					)
				])
			}
		}
		delivered.set(statement.label, children)
		return {
			...statement,
			rows: distinctRows(out, statement.heading, statement.label, new Identities())
		}
	})
}

const showValue = (v: Value | undefined): string => {
	if (typeof v === "bigint") {
		return `${v}n`
	}
	if (v instanceof Decimal) {
		return `${v.toString()}d`
	}
	if (isRecord(v) && "start" in v && "end" in v) {
		return `[${Formatter.format(v.start)},${Formatter.format(v.end)})`
	}
	return Formatter.format(v)
}

const showRow = (row: Row): string => `(${Arr.join(Arr.map(row, showValue), ", ")})`

/** Where two deliveries of one read disagree, statement by statement as sets: none when they agree. */
export const differences = (
	expected: Expected,
	actual: ReadonlyArray<ExpectedStatement>
): ReadonlyArray<string> =>
	Arr.flatMap(expected.statements, (e, i) => {
		const a = actual[i]
		if (a === undefined) {
			return [`${e.label}: not delivered`]
		}
		const same = (x: Row, y: Row) =>
			Arr.every(e.heading, (c, j) => {
				const p = x[j]
				const q = y[j]
				return p !== undefined && q !== undefined && equal(p, q, c.type)
			})
		const missing = Arr.filter(e.rows, (x) => !Arr.some(a.rows, (y) => same(x, y)))
		const extra = Arr.filter(a.rows, (y) => !Arr.some(e.rows, (x) => same(x, y)))
		return missing.length === 0 && extra.length === 0
			? []
			: [
					`${e.label} (${Arr.join(
						Arr.map(e.heading, (c) => c.name),
						", "
					)}): missing ${Arr.join(Arr.map(missing, showRow), " ")}; unexpected ${Arr.join(Arr.map(extra, showRow), " ")}`
				]
	})
