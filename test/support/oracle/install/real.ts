import { Array as Arr, Effect, Option, Order, Record as Rec, type Scope, Struct } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { type CompileError, isCompileError, malformedDescription } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type Codebook, codecOf, firstCodebook, type RosterCodec } from "#compiler/ir/codes.ts"
import { decodeDesc, type LoginDesc } from "#compiler/ir/desc.ts"
import {
	baseOf,
	type ContractInfo,
	contractOf,
	Roster,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { columnType, domainBase } from "#compiler/physical/ddl/names.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { fullRoleDesc, type OwnedLogin, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { installationSql } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { foreignKeyColumns, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	type ColumnType,
	type InstallPlan,
	type OracleColumn,
	type OracleDomain,
	type OracleForeignKey,
	type OracleKey,
	type OracleRoster,
	type OracleTable,
	uncontracted,
	type ValueKind
} from "#test/support/oracle/install/model.ts"
import { rosterNamesIdentity } from "#test/support/oracle/install/names.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

interface RealPlanOptions {
	/**
	 * The schema identity to install under, whose identifier is the PostgreSQL schema; tests pass a unique name's
	 * (the substrate's allocation), because roles are cluster-wide.
	 */
	readonly installation: Identity<"schema">
	/** The migration identity, which owns the schema. */
	readonly owner: string
	/** The logins installed with it, each a login value or a LoginDesc over the schema as declared; [] for none. */
	readonly logins: ReadonlyArray<unknown>
	/**
	 * The installer extensions besides the residual laws' and the derived relations', which every installation carries
	 * (physical/complete.ts completeInstallOptions): a workload's index requests; [] for none.
	 */
	readonly extensions: ReadonlyArray<InstallExtension>
	/**
	 * The installation's codes (ir/codes.ts): a fresh installation's (firstCodebook), or the codes a history drafted,
	 * holes included. Every code literal, set width and decoded code of the installation reads them.
	 */
	readonly codes: Codebook
}

/** An installed role of a login: its theory role and its role schema. */
export interface OracleWorld {
	readonly name: string
	readonly role: string
	readonly schema: string
}

/** An installed login: its login role, and its roles by declared name. */
export interface OracleLogin {
	readonly name: string
	readonly role: string
	readonly roles: Readonly<Record<string, OracleWorld>>
}

/** The oracle's plan, with the installation it presents and its logins by declared name. */
export interface RealInstallPlan extends InstallPlan {
	readonly installation: Installation
	readonly logins: Readonly<Record<string, OracleLogin>>
}

/**
 * The one world a generated schema runs as: a full role `app`, writing every stored relation and refreshing every
 * derived one, in the login `server`.
 */
export const oracleLogin = (desc: SchemaDesc): LoginDesc => {
	const loc = SourceLoc(`the oracle login of ${desc.name}`, [])
	const login = Result.flatMap(admitSchemaDesc(desc), (base) =>
		Result.flatMap(fullRoleDesc(base, "app", loc), (app) =>
			decodeDesc("login", { name: "server", base, roles: [app], loc })
		)
	)
	if (!login.ok) {
		throw login.error
	}
	return login.value
}

/** A login value or a LoginDesc, owned; anything else is refused as the installer would refuse it. */
const ownedLogin = (input: unknown): OwnedLogin => {
	const desc = loginDescOf(input)
	const decoded = desc === undefined ? decodeDesc("login", input) : Result.ok(desc)
	const owned = Result.flatMap(decoded, ownLogin)
	if (!owned.ok) {
		throw owned.error
	}
	return owned.value
}

/** The oracle's one login over `desc` (oracleLogin), owned, as compileInstallation takes it. */
export const oracleOwnedLogin = (desc: SchemaDesc): OwnedLogin => ownedLogin(oracleLogin(desc))

const refuse = (location: string, capability: string): CompileError =>
	malformedDescription(SourceLoc(location, []), capability)

/** How a host value of a column of type `t` is spelled as a typed literal (literal.ts), under the installation's codes. */
const valueKind = (t: ScalarType, codes: Codebook): ValueKind => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return { kind: "integer", carrier: b.carrier }
		case "numeric":
			return { kind: "numeric" }
		case "float4":
		case "float8":
			return { kind: "float", carrier: b.carrier }
		case "money":
			return { kind: "money" }
		case "bool":
			return { kind: "bool" }
		case "uuid":
			return { kind: "uuid" }
		case "date":
			return { kind: "date" }
		case "text":
			return { kind: "text" }
		case "code":
		case "bits":
			return { kind: b.carrier, roster: codecOf(codes, b.roster) }
		case "range4":
		case "range8":
			return { kind: "span", carrier: b.carrier }
		case "vector":
			return { kind: "vector", dimensions: b.typmod.dims }
		case "exactInteger":
		case "exactMoney":
			throw new Error(`a stored column of the exact carrier ${b.carrier}, which no field has`)
	}
}

/** The installation keeps the emission discipline (oracle/verify checkedStatements). */
const build = (input: unknown, options: RealPlanOptions): RealInstallPlan => {
	const ownership = ownedInput(input)
	if (!ownership.ok) {
		throw ownership.error
	}
	const declared = ownership.value
	const compiled = compileInstallation(declared, {
		...completeInstallOptions(
			declared,
			options.installation,
			Arr.map(options.logins, ownedLogin),
			options.extensions,
			options.codes
		),
		owner: options.owner
	})
	if (!compiled.ok) {
		throw compiled.error
	}
	const installation = compiled.value
	checkedStatements(installation.statements, "installation statement")
	const { owned, names, laws } = installation
	const theory = laws.theory
	const schema = installation.names.schema
	const at = (what: string) => `real install of ${owned.name}: ${what}`

	/**
	 * A column's type, or with `domain` a contract domain's base, which the installer types one level down: an inner
	 * contract's domain or the unrefined base type, never a refined text's `__text_` domain, since the outer domain's
	 * own CHECK carries the pattern (physical/ddl/names.ts domainBase).
	 */
	const typeOf = (t: ScalarType, domain: boolean): ColumnType => {
		const c = domain ? domainBase(names, t) : columnType(names, t)
		const contract = contractOf(t)
		return {
			sql: c.type,
			value: valueKind(t, options.codes),
			contract: contract === undefined ? uncontracted : { kind: "contract", name: contract.name }
		}
	}

	/**
	 * A roster's installed objects: its domain, as the installation names it, and its names constant, as the oracle
	 * predicts it is named (names.ts rosterNamesIdentity), over the installation's codes.
	 */
	const installedRoster = (roster: RosterCodec): OracleRoster => ({
		closed: roster.roster,
		names: { schema, name: identifierOf(rosterNamesIdentity(roster)) },
		domain: names.rosterDomain(roster.roster),
		codes: roster
	})
	const rosters: Record<string, OracleRoster> = {}
	const tables: Record<string, OracleTable> = {}
	for (const r of Rec.values(owned.relations)) {
		if (r.kind === "closed") {
			rosters[r.name] = installedRoster(codecOf(options.codes, new Roster(r.name, r.desc.handles)))
			continue
		}
		if (r.kind !== "relation") {
			continue
		}
		const t = theory.relations[r.name]
		if (t === undefined) {
			throw refuse(at(r.name), "a theory relation for every stored relation")
		}
		const columns: Array<OracleColumn> = Arr.map(Rec.keys(r.fields), (field) => {
			const f = r.fields[field]
			if (f === undefined) {
				throw refuse(at(`${r.name}.${field}`), "a physical field for every field")
			}
			const heading = Arr.findFirst(t.heading, (c) => c.name === field)
			if (Option.isNone(heading)) {
				throw refuse(at(`${r.name}.${field}`), "a heading column for every field")
			}
			const location = at(`${r.name}.${field}`)
			return {
				field,
				column: f.column,
				type: typeOf(heading.value.type, false),
				sequence:
					heading.value.writing.kind === "serial"
						? { kind: "identity", name: names.sequence(r.name, field) }
						: { kind: "none" },
				location
			}
		})
		/** Every theory key has an owned key. */
		const keyOf = (fields: ReadonlyArray<string>): OracleKey => {
			const k = Arr.findFirst(
				r.keys,
				(x) => x.fields.length === fields.length && Arr.every(x.fields, (f, i) => f === fields[i])
			)
			if (Option.isNone(k)) {
				throw refuse(at(r.name), `an owned key over (${Arr.join(fields, ", ")})`)
			}
			const span = Arr.findFirst(fields, (f) =>
				Option.exists(
					Arr.findFirst(t.heading, (h) => h.name === f),
					(c) => spanOf(c.type) !== undefined
				)
			)
			return {
				name: k.value.constraint,
				fields: k.value.fields,
				span: Option.match(span, {
					onNone: () => ({ kind: "none" as const }),
					onSome: (field) => ({ kind: "span" as const, field })
				})
			}
		}
		tables[r.name] = {
			relation: r.name,
			name: names.relation(r.name),
			columns,
			primaryKey: keyOf(t.primaryKey),
			keys: Arr.map(t.keys, keyOf),
			foreignKeys: [],
			mutable: r.mutable,
			location: at(`relation ${r.name}`)
		}
	}

	/** Foreign keys, from the law model's natives, by the table that holds them. */
	const foreignKeys = new Map<string, Array<OracleForeignKey & { readonly deferrable: boolean }>>()
	for (const n of laws.natives) {
		const o = n.object
		if (o.kind !== "ForeignKey" && o.kind !== "PeriodForeignKey") {
			continue
		}
		if (!Rec.has(tables, o.relation.name) || !Rec.has(tables, o.target.name)) {
			continue
		}
		if (n.namespace !== "constraint") {
			throw refuse(
				at(`foreign key of ${o.relation.name}`),
				"a foreign key installed as a named table constraint"
			)
		}
		const list = foreignKeys.get(o.relation.name) ?? []
		const fk = foreignKeyColumns(o)
		list.push({
			name: identifierOf(n.named),
			fields: fk.columns,
			references: fk.target,
			referencedFields: fk.targetColumns,
			period: fk.period,
			location: at(`foreign key ${identifierOf(n.named)}`),
			deferrable: fk.deferrable
		})
		foreignKeys.set(o.relation.name, list)
	}
	for (const [relation, list] of foreignKeys) {
		const table = tables[relation]
		if (table === undefined) {
			throw refuse(at(relation), "a table for every relation with a foreign key")
		}
		tables[relation] = {
			...table,
			foreignKeys: Arr.map(list, (fk) => Struct.omit(fk, ["deferrable"]))
		}
	}

	/**
	 * Referenced tables first, by the immediate foreign keys only; a self-reference constrains nothing across tables.
	 */
	const loadOrder: Array<string> = []
	const state = new Map<string, "visiting" | "done">()
	const visit = (relation: string, path: ReadonlyArray<string>): void => {
		const s = state.get(relation)
		if (s === "done") {
			return
		}
		if (s === "visiting") {
			throw refuse(
				at("load order"),
				`no cycle of immediate foreign keys; ${Arr.join([...path, relation], " -> ")} is one`
			)
		}
		state.set(relation, "visiting")
		for (const fk of foreignKeys.get(relation) ?? []) {
			if (!fk.deferrable && fk.references !== relation) {
				visit(fk.references, [...path, relation])
			}
		}
		state.set(relation, "done")
		loadOrder.push(relation)
	}
	for (const relation of Arr.sort(Rec.keys(tables), Order.String)) {
		visit(relation, [])
	}

	/**
	 * Each contract's domain, over its base one level down: an inner contract's domain or the unrefined base type,
	 * read from a column the theory types by the contract.
	 */
	const domains: Record<string, OracleDomain> = {}
	for (const name of Rec.keys(owned.contracts)) {
		const contract = contractInfo(installation, name)
		if (Option.isNone(contract)) {
			continue
		}
		domains[name] = {
			contract: name,
			name: names.contractDomain(contract.value.name),
			base: typeOf(contract.value.base, true),
			location: at(`contract ${name}`)
		}
	}

	const logins: Record<string, OracleLogin> = {}
	for (const login of installation.worlds) {
		logins[login.name] = {
			name: login.name,
			role: login.role,
			roles: Rec.fromEntries(
				Arr.map(login.roles, (r): readonly [string, OracleWorld] => [
					r.name,
					{ name: r.name, role: r.role, schema: r.schema }
				])
			)
		}
	}

	return {
		declared: owned.name,
		schema,
		tables,
		rosters,
		codes: options.codes,
		domains,
		loadOrder,
		ddl: [],
		sql: installationSql(installation),
		vectorSchema: installation.names.vectorSchema,
		skipped: [],
		fill: {
			order: installation.laws.theory.fill,
			closed: new Map(
				Arr.map(
					[...installation.checked.closed],
					([name, c]) =>
						[
							name,
							{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
						] as const
				)
			)
		},
		installation,
		logins
	}
}

/** The contract named `contract` along a type's contract chain, outermost first. */
const contractAlong = (type: ScalarType, contract: string): Option.Option<ContractInfo> => {
	for (let c = contractOf(type); c !== undefined; c = contractOf(c.base)) {
		if (c.name === contract) {
			return Option.some(c)
		}
	}
	return Option.none()
}

/** The contract's own descriptor, from any column the theory types by it, directly or as a span's endpoint. */
const contractInfo = (installation: Installation, contract: string): Option.Option<ContractInfo> =>
	Arr.findFirst(
		Arr.flatMap(Rec.values(installation.laws.theory.relations), (r) => r.heading),
		(c): Option.Option<ContractInfo> =>
			Option.orElse(contractAlong(c.type, contract), () => {
				const span = spanOf(c.type)
				return span === undefined ? Option.none() : contractAlong(span.endpoint, contract)
			})
	)

/** The plan of `input` on the real installer, or the first refusal. */
export const planRealInstall = (
	input: unknown,
	options: RealPlanOptions
): Result.Result<RealInstallPlan, CompileError> => {
	try {
		return Result.ok(build(input, options))
	} catch (error) {
		if (isCompileError(error)) {
			return Result.err(error)
		}
		throw error
	}
}

/**
 * The plan of a generated schema on the real installer under `installation`, owned by `owner`, with the one login a
 * generated schema runs as (oracleLogin), its rosters numbered by `codes`: the codes its case states, which every
 * literal and parameter of the case is encoded by.
 */
export const oraclePlanUnder = (
	desc: SchemaDesc,
	installation: Identity<"schema">,
	owner: string,
	codes: Codebook
): Result.Result<RealInstallPlan, CompileError> =>
	planRealInstall(desc, {
		installation,
		owner,
		logins: [oracleLogin(desc)],
		extensions: [],
		codes
	})

/**
 * The plan of a generated schema as oraclePlanUnder plans it, as a fresh installation numbers its rosters
 * (firstCodebook): what every oracle suite installs whose case states no codes of its own.
 */
export const oraclePlan = (
	desc: SchemaDesc,
	installation: Identity<"schema">,
	owner: string
): Result.Result<RealInstallPlan, CompileError> =>
	Result.flatMap(ownedInput(desc), (owned) =>
		oraclePlanUnder(desc, installation, owner, firstCodebook(rostersOf(owned)))
	)

interface InstalledRealSchema {
	readonly plan: RealInstallPlan
	/** Login credentials of each login, by declared login name. */
	readonly credentials: Readonly<Record<string, Credentials>>
}

/**
 * The options of installRealSchema:
 * the logins installed with the schema, the extensions, and the label of the allocated schema name, each stated.
 */
export interface RealInstallOptions {
	readonly logins: ReadonlyArray<unknown>
	readonly extensions: ReadonlyArray<InstallExtension>
	readonly label: string
}

/** Runs a plan's DDL on `connection`, which must be the owner. */
const installRealPlan = (
	connection: PgConnection,
	plan: RealInstallPlan
): Effect.Effect<void, SqlError | TransactionRolledBack> => transaction(connection, plan.sql)

/**
 * The oracle on the real installer.
 *
 * test/pg/physical installs generated schemas both through the minimal installer (plan.ts) and the real one and
 * requires the catalogs equivalent but for what the real installer adds by rule; the oracle installs through the real
 * one: runOracle (runner.ts), which every oracle suite and every lowering gate runs through, plans each case with
 * planRealInstall. planRealInstall compiles a schema with packages/engine/src/physical/install and presents the result as the
 * oracle's InstallPlan, so everything that reads a plan (the fact loader, the raw capture, the reference renderer, the
 * physical names the lowerings emit) runs over the real catalog unchanged:
 *
 * - the DDL is the real install script, in its install order, every statement audited (physical/install);
 * - tables, columns, roster domains, contract domains, sequences and roles are named by the installation's own
 *   InstallNames, and each roster's names constant as the oracle predicts it (names.ts rosterNamesIdentity);
 * - a column's type is the one the real installer gives it (physical/ddl/names.ts columnType): a contract's domain, a
 *   refined text's structural `__text_` domain, a roster's domain, a set's bits domain, or the native type;
 * - the load order respects every immediate foreign key; a deferred one is checked at COMMIT and places
 *   no constraint on it;
 * - nothing is skipped and every CHECK is installed: the installation is complete, the residual laws' functions and
 *   triggers and the derived relations' views included, composed as `grizzle generate` composes it
 *   (physical/complete.ts completeInstallOptions).
 *
 * The worlds an installation carries are the logins the caller gives, each a login value or a LoginDesc over the schema
 * as declared (oracleLogin(desc) is the one full role a generated schema runs as); the plan names each login's role and
 * each role's theory role and schema by the installation's own names.
 *
 * installRealSchema installs such a plan under a unique schema of the substrate's database and enables login for every
 * login role; test/support/install-migrate.ts is the general entry point.
 *
 * Plans `input` on the real installer under a unique schema of the substrate's database, as a fresh installation
 * numbers its rosters (firstCodebook), installs it as the owner, and
 * enables login for every login role. The schema and its roles are dropped when the scope closes.
 */
export const installRealSchema = (
	input: unknown,
	options: RealInstallOptions
): Effect.Effect<
	InstalledRealSchema,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schema = yield* substrate.schema({ create: false, label: options.label })
		const owned = yield* fromEngine(ownedInput(input))
		const plan = yield* fromEngine(
			planRealInstall(input, {
				installation: identity.schema(parsedSchemaName(schema)),
				owner: substrate.owner.role,
				logins: options.logins,
				extensions: options.extensions,
				codes: firstCodebook(rostersOf(owned))
			})
		)
		yield* installRealPlan(substrate.admin, plan)
		const credentials: Record<string, Credentials> = {}
		for (const login of Rec.values(plan.logins)) {
			credentials[login.name] = yield* substrate.login(login.role)
		}
		return { plan, credentials }
	})
