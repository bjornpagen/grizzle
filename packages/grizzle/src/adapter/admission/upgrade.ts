import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import type { DriftFound, Fact } from "#adapter/admission/drift.ts"
import {
	type Departure,
	type GraphIdent,
	parseIdent,
	type PhysicalKind,
	staleReplaced
} from "#compiler/plan/migration.ts"

/**
 * How the live catalog holds a target, read off the drift check of the target against it (drift.ts DriftFound), as
 * `grizzle upgrade` rebases an installation onto a new compile of the source it was deployed from (cli/upgrade.ts).
 *
 * Each fact the check compared is an object's. A fact of the target's replay is the object of the target that owns it
 * (drift.ts factOwner). A fact of the database is the target object owning the target's fact of its key, where the
 * target holds that key; else its own object, by the identity the catalog spells it by (a constraint, a trigger, an
 * index, a function...), or, a column, its relation's where the target holds the relation and the column is no
 * generated one: a column the target lacks of a table it holds is its table's difference, a generated one an object of
 * its own, which PostgreSQL computes from its row.
 *
 * Then each object of the target PostgreSQL describes is held (a row of the proofs proves it, or every fact of it is
 * the target's), stale (the database holds each of its keys, some otherwise, or a function's source differs), or
 * absent (the database holds none of it); and each object of the database's facts that no target object is, departed.
 * Every case the upgrade cannot rebase without loss or guess is a fault, by name (UpgradeFault).
 */
export interface LiveObjects {
	readonly held: ReadonlySet<string>
	readonly stale: ReadonlySet<string>
	readonly absent: ReadonlySet<string>
	readonly departed: ReadonlyArray<Departed>
}

/** An object of the database no object of the target is: its identity, and its drop. */
export interface Departed {
	readonly object: string
	readonly departure: Departure
}

/**
 * What the upgrade cannot rebase, by object, each with the facts that show it:
 * - `stored`: a stored relation, a column of one, or a relation of no kind grizzle drops, that the database holds
 *   otherwise than the target or that no target object is, whose rows no rebase may drop or rewrite;
 * - `unreplaceable`: an object of a kind no draft changes (deploy/diff/diff.ts staleReplaced), defined otherwise;
 * - `reshaped`: an object the database holds under other keys than the target's, a function under another signature
 *   or a domain under other constraints, which no record names;
 * - `collision`: a key the database holds as another object than the target's, a name two kinds share.
 */
export type UpgradeFault = {
	readonly kind: "stored" | "unreplaceable" | "reshaped" | "collision"
	readonly object: string
	readonly facts: ReadonlyArray<string>
}

/** A fact as a fault lists it: its key, and its description. */
const factText = (f: Fact): string => `${f.key} as ${f.description}`

/** The parts of a column's description that say PostgreSQL generates it (drift.ts descriptionSelect's columnDefault). */
const generatedParts = ["; generated stored as ", "; generated virtual as "] as const

/** Whether a column's fact describes a generated column. */
const generated = (f: Fact): boolean =>
	Arr.some(generatedParts, (part) => Str.includes(part)(f.description))

/**
 * The object of the database a fact no target key holds is, by the identity the catalog spells: its own, a column's
 * relation's where the relation is the target's and the column no generated one.
 */
const ownerOf = (described: ReadonlySet<string>, f: Fact): string => {
	if (described.has(f.object)) {
		return f.object
	}
	const ident = parseIdent(f.object)
	if (ident.kind === "column") {
		return generated(f) ? f.object : f.within
	}
	return ident.kind === "other" ? f.within : f.object
}

/** The drop of an object of the database no target object is, by its identity and its facts; none for one holding rows. */
const departureOf = (ident: GraphIdent, facts: ReadonlyArray<Fact>): Option.Option<Departure> => {
	switch (ident.kind) {
		case "function":
			return Option.some({ kind: "function", name: { schema: ident.schema, name: ident.name } })
		case "constraint":
		case "trigger":
		case "policy":
			return Option.some({
				kind: ident.kind,
				table: { schema: ident.schema, name: ident.relation },
				name: ident.name
			})
		case "index":
		case "statistics":
		case "view":
		case "domain":
		case "type":
			return Option.some({ kind: ident.kind, name: { schema: ident.schema, name: ident.name } })
		case "column":
			return Arr.every(facts, generated)
				? Option.some({
						kind: "generatedColumn",
						table: { schema: ident.schema, name: ident.relation },
						column: ident.name
					})
				: Option.none()
		case "rowSecurity":
		case "replicaIdentity":
			return Option.some({ kind: ident.kind, table: { schema: ident.schema, name: ident.name } })
		case "schema":
			return Option.some({ kind: "schema", name: ident.name })
		case "table":
		case "extension":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
		case "other":
			return Option.none()
	}
}

/**
 * The order departed objects are dropped in, by kind, as the diff drops its own (deploy/diff/diff.ts dropOrder): the
 * policies and views before the functions they call, the triggers and foreign keys before the keys and functions they
 * read, the constraints and indexes before the domains, types and functions their definitions read, the generated
 * columns before what their generations read, a role's schema, the former database default, and a former leader's
 * replication slot last.
 */
const departureRank: { readonly [K in Departure["kind"]]: number } = {
	policy: 0,
	view: 1,
	trigger: 2,
	constraint: 3,
	rowSecurity: 4,
	replicaIdentity: 4,
	index: 5,
	statistics: 6,
	storedTable: 7,
	function: 8,
	generatedColumn: 9,
	domain: 10,
	type: 10,
	schema: 11,
	databaseDefault: 12,
	formerLiveSlot: 13
}

/**
 * The departed object that is the database default an installation of format 7 or before set (drift.ts DriftFound
 * `formerDefault`), which the upgrade resets: grizzle sets no database default, so every session it does not open
 * starts at the server's.
 */
const formerDefault = "databaseDefault:default_transaction_isolation"

/** Departed objects in their drop order: by kind (departureRank), then by identity. */
const dropOrder: Order.Order<Departed> = Order.combine(
	Order.mapInput(Order.Number, (d: Departed) => departureRank[d.departure.kind]),
	Order.mapInput(Order.String, (d: Departed) => d.object)
)

/** Whether an object of `kind` holds stored rows, which no rebase drops or rewrites. */
const holdsRows = (kind: PhysicalKind | undefined): boolean =>
	kind === "table" || kind === "ledger" || kind === "liveSecret"

/**
 * How the live catalog holds a target whose objects are of `kinds`, by identity, from the drift check of the target
 * against it (LiveObjects), or the first object it holds as no rebase may change (UpgradeFault).
 */
export const liveObjects = (
	kinds: ReadonlyMap<string, PhysicalKind>,
	found: DriftFound
): Result.Result<LiveObjects, UpgradeFault> => {
	const expectedOwner = new Map<string, Fact & { readonly owner: string }>()
	for (const f of found.expected) {
		const owner = found.described.has(f.object) ? f.object : f.within
		expectedOwner.set(f.key, { ...f, owner })
	}
	const installedBy = new Map<string, Array<Fact>>()
	for (const f of found.installed) {
		const matched = expectedOwner.get(f.key)
		if (matched !== undefined && matched.object !== f.object) {
			return Result.fail({
				kind: "collision",
				object: matched.owner,
				facts: [factText(matched), factText(f)]
			})
		}
		const owner = matched === undefined ? ownerOf(found.described, f) : matched.owner
		installedBy.getOrInsertComputed(owner, () => []).push(f)
	}
	const expectedBy = Arr.groupBy(Arr.fromIterable(expectedOwner.values()), (f) => f.owner)
	const held = new Set<string>()
	const stale = new Set<string>()
	const absent = new Set<string>()
	for (const object of found.described) {
		if (found.proven.has(object) && !found.sources.has(object)) {
			held.add(object)
			continue
		}
		const expected = expectedBy[object] ?? []
		const installed = installedBy.get(object) ?? []
		const keys = new Set(Arr.map(installed, (f) => f.key))
		const sameKeys =
			expected.length === installed.length && Arr.every(expected, (f) => keys.has(f.key))
		const descriptions = new Map(Arr.map(installed, (f) => [f.key, f.description] as const))
		const facts = [...Arr.map(expected, factText), ...Arr.map(installed, factText)]
		const kind = kinds.get(object)
		if (installed.length === 0 && expected.length > 0) {
			absent.add(object)
		} else if (!sameKeys) {
			return Result.fail({ kind: holdsRows(kind) ? "stored" : "reshaped", object, facts })
		} else if (
			found.sources.has(object) ||
			Arr.some(expected, (f) => descriptions.get(f.key) !== f.description)
		) {
			if (kind === undefined || !staleReplaced[kind]) {
				return Result.fail({ kind: holdsRows(kind) ? "stored" : "unreplaceable", object, facts })
			}
			stale.add(object)
		} else {
			held.add(object)
		}
	}
	const departed: Array<Departed> = []
	for (const [object, facts] of installedBy) {
		if (found.described.has(object)) {
			continue
		}
		const departure = departureOf(parseIdent(object), facts)
		if (Option.isNone(departure)) {
			return Result.fail({ kind: "stored", object, facts: Arr.map(facts, factText) })
		}
		departed.push({ object, departure: departure.value })
	}
	if (found.formerDefault) {
		departed.push({ object: formerDefault, departure: { kind: "databaseDefault" } })
	}
	for (const name of found.formerSlots) {
		departed.push({ object: `liveSlot:${name}`, departure: { kind: "formerLiveSlot", name } })
	}
	return Result.succeed({
		held,
		stale,
		absent,
		departed: Arr.sort(departed, dropOrder)
	})
}
