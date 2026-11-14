import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted,
	proportional
} from "@grizzle/testing/gen"
import { WILD_KINDS } from "@grizzle/testing/lsw"
import type { Source } from "@grizzle/testing/source"
import { Array as Arr, Option, pipe, Record } from "effect"
import { valueText } from "#test/support/laws/model.ts"
import {
	fieldsOfSource,
	inDomain,
	knownNonEmpty,
	pool,
	pooled
} from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { enumerateKind } from "#test/support/worlds/generate/enumerate.ts"
import {
	allowedFor,
	applicable,
	forcedMoves,
	type SessionKind,
	useOf,
	wildCalls
} from "#test/support/worlds/generate/offered.ts"
import { viaArms } from "#test/support/worlds/generate/reads.ts"
import {
	type Aiming,
	actionKinds,
	drawsLive,
	everyRole,
	type RoleFocus,
	type Weights
} from "#test/support/worlds/generate/weights.ts"
import { catalogVariants, worldFunctionsOf } from "#test/support/worlds/invalid/catalog.ts"
import { claimsArms } from "#test/support/worlds/invalid/claims.ts"
import {
	baseFactGen,
	liveOpGen,
	opStrata,
	type FactWriter
} from "#test/support/worlds/invalid/facts.ts"

import {
	isolationArms,
	liveSessions,
	type Reader,
	relationArms,
	sessionStrata,
	snapshotArms,
	wildSiteGen
} from "#test/support/worlds/invalid/handles.ts"

import {
	anyOf,
	armsStrata,
	chainStrata,
	mapStrata,
	offLive,
	type Share,
	type Strata,
	strataOf,
	underStrata,
	unionStrata
} from "#test/support/worlds/invalid/kinds.ts"
import { migrationStrata } from "#test/support/worlds/invalid/migrations.ts"
import { roleArms } from "#test/support/worlds/invalid/roles.ts"
import { tokenArms } from "#test/support/worlds/invalid/tokens.ts"
import { nameableFacts } from "#test/support/worlds/model/draws.ts"
import { classifyEntry, isMember } from "#test/support/worlds/model/host.ts"
import { membershipOf } from "#test/support/worlds/model/session/catalog.ts"
import { parametersOf } from "#test/support/worlds/model/session/direct.ts"
import {
	loginOf,
	noFacts,
	relationSpecOf,
	roleOf,
	seenThrough
} from "#test/support/worlds/model/session/state.ts"

import {
	claimFixedFields,
	keysOf,
	updatableFields,
	writtenOf
} from "#test/support/worlds/model/session/writes.ts"
import { step } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	BaseSpec,
	ClaimsSetting,
	ContextFacts,
	DirectSessionState,
	DirectStart,
	DirectStatement,
	EntryOp,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	HostFact,
	HostState,
	InvalidKind,
	Isolation,
	ModelState,
	ConflictResolution,
	PreparedRead,
	RoleRef,
	RoleSpec,
	SmallScope,
	SnapshotRef,
	Token,
	HostValue,
	ViewFilter,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/** The role a session reads through: a Db's, or none. */
const readerOf = (state: ModelState, session: number): Reader =>
	Option.match(dbWriter(state, session), {
		onNone: (): Reader => ({ kind: "none" }),
		onSome: (w): Reader => ({ kind: "role", role: w.role })
	})

/** An open Db session's role and claims; none for a session that is no open Db. */
const dbWriter = (state: ModelState, session: number): Option.Option<FactWriter> => {
	const s = state.sessions[session]
	return s?.kind === "db"
		? Option.map(
				Arr.findFirst(state.install.roles, (r) => r.name === s.role),
				(role): FactWriter => ({ role, facts: s.facts })
			)
		: Option.none()
}

/**
 * Who a call through a session writes as: an open Db's role and claims; through a session that is no open Db (whose
 * call grizzle refuses at the handle), the installation's first role with no claims, so its arguments are still drawn.
 */
const writerOf = (state: ModelState, session: number): FactWriter =>
	Option.match(dbWriter(state, session), {
		onNone: (): FactWriter => ({ role: state.install.roles[0], facts: {} }),
		onSome: (w) => w
	})

/** An entry by name, from the role holding it under that name. */
const entrySpecOf = (state: ModelState, writer: FactWriter, name: string): EntrySpec => {
	const holder = Record.has(writer.role.entries, name)
		? Option.some(writer.role)
		: Arr.findFirst(state.install.roles, (r) => Record.has(r.entries, name))
	return pipe(
		holder,
		Option.flatMap((r) => Option.fromUndefinedOr(r.entries[name])),
		Option.getOrThrowWith(() => new Error(`no role holds an entry ${name}`))
	)
}

/** The only live draw of strata that always have one. */
const liveOf = <T>(strata: Strata<T>, what: string): Gen<T> => {
	const [first, ...rest] = strata.live
	if (first === undefined) {
		throw new Error(`${what} has no live draw`)
	}
	return anyOf([first, ...rest])
}

/** The sessions an action of a kind may name, stratified. */
const sessionsFor = (state: ModelState, kind: SessionKind): Strata<number> =>
	sessionStrata(state, useOf(kind), allowedFor(state, kind))

/** The live sessions an action of a kind may name. */
const liveFor = (state: ModelState, kind: SessionKind): ReadonlyArray<number> =>
	liveSessions(state, useOf(kind), allowedFor(state, kind))

/** The role a role reference names, when it names an installed one. */
const namedRole = (state: ModelState, ref: RoleRef): Option.Option<RoleSpec> => {
	switch (ref.kind) {
		case "own":
		case "other-login":
		case "dropped":
			return Arr.findFirst(state.install.roles, (r) => r.name === ref.role)
		case "nonexistent":
		case "owner":
			return Option.none()
	}
}

const open = (role: RoleRef, token: Token, snapshot: SnapshotRef): Action => ({
	kind: "open-db",
	role,
	token,
	snapshot
})

const own = (r: RoleSpec): RoleRef => ({ kind: "own", role: r.name })

/**
 * Db.open, stratified: live, an own role of the run's focus with a live token for it and the current snapshot; a
 * stratum per token kind the role's contexts offer (an own role of the focus), per role reference kind (a live token for
 * the role it names, the first focused role's for one it does not; another login's role is that login's handle too),
 * and per snapshot kind (an own role of the focus).
 */
const openDbStrata = (state: ModelState, focus: RoleFocus): Strata<Action> => {
	const install = state.install
	const focused = Arr.filter(
		install.roles,
		(r) => focus.kind === "every" || focus.roles.includes(r.name)
	)
	const [firstFocused, ...moreFocused] = focused
	const tokens = Arr.map(focused, (r) =>
		mapStrata(armsStrata(tokenArms(state, r.name)), (token) => open(own(r), token, "current"))
	)
	const named = chainStrata(armsStrata(roleArms(install, { kind: "open" })), (ref) => {
		const role = Option.getOrElse(namedRole(state, ref), () => firstFocused ?? install.roles[0])
		return map(tokenArms(state, role.name).live, (token) => open(ref, token, "current"))
	})
	/** The snapshot strata, each an own role's live open: none where the focus names no installed role. */
	const snapshots =
		firstFocused === undefined
			? []
			: [
					offLive(
						chainStrata(armsStrata(snapshotArms), (snapshot) => (source) => {
							const r = source.draw(element([firstFocused, ...moreFocused]))
							return open(own(r), source.draw(tokenArms(state, r.name).live), snapshot)
						})
					)
				]
	/** A role of another login opened in its login's layer is that login's handle too. */
	const otherLogin = Arr.flatMap(named.stale, (v) =>
		v.invalid === "role:other-login" ? [{ invalid: "handle:other-login" as const, gen: v.gen }] : []
	)
	return unionStrata([
		...tokens,
		offLive(named),
		...snapshots,
		{ live: [], stale: otherLogin, wild: [] }
	])
}

/** The relations a session's reader prefers among its entries, through the role's list `prefer` picks. */
const preferredBy = (
	reader: Reader,
	prefer: (role: RoleSpec) => ReadonlyArray<string>
): ReadonlyArray<string> => (reader.kind === "role" ? prefer(reader.role) : [])

/** The base relations a query entry's rules read besides its target: what its filter reads. */
const filterReads = (spec: EntrySpec, target: string): ReadonlyArray<string> =>
	spec.kind === "whole"
		? []
		: Arr.flatMap(spec.rules, (r) =>
				Arr.flatMap([...r.matches, ...r.negations.flat()], (o) =>
					o.source.kind === "ordinary" && o.source.name !== target ? [o.source.name] : []
				)
			)

/**
 * A write to a query entry beside a write to a relation its filter reads, in one stratum (which grizzle refuses, since
 * membership would hang on statement order) or sequenced either way; none when the role writes no such pair.
 */
const orderedGen = (
	state: ModelState,
	writer: FactWriter
): Gen<Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>> | undefined => {
	const written = writtenOf(state.install.base, writer.role)
	const pairs = Arr.flatMap(written, (e) => {
		if (e.kind !== "query") {
			return []
		}
		const spec = entrySpecOf(state, writer, e.entry)
		const reads = filterReads(spec, e.target)
		return Arr.map(
			Arr.filter(written, (w) => w.entry !== e.entry && reads.includes(w.target)),
			(w) => ({ entry: e.entry, other: w.entry })
		)
	})
	const [first, ...rest] = pairs
	if (first === undefined) {
		return undefined
	}
	const opOf = (name: string): Gen<EntryOp> => liveOp(state, writer, name)
	return (source): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>> => {
		const pair = source.draw(element([first, ...rest]))
		const e = source.draw(opOf(pair.entry))
		const o = source.draw(opOf(pair.other))
		const order = source.draw(element(["together", "entry-first", "other-first"] as const))
		return order === "together" ? [[e, o]] : order === "entry-first" ? [[e], [o]] : [[o], [e]]
	}
}

/** The ops through an entry of a writer's role, stratified. */
const opsThrough = (state: ModelState, writer: FactWriter, name: string): Strata<EntryOp> =>
	opStrata(state, writer, { name, spec: entrySpecOf(state, writer, name) })

/** A live op through an entry of a writer's role. */
const liveOp = (state: ModelState, writer: FactWriter, name: string): Gen<EntryOp> =>
	liveOpGen(state, writer, { name, spec: entrySpecOf(state, writer, name) })

const applyOf = (
	session: number,
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): Action => ({ kind: "apply", session, strata, reads })

/**
 * An apply, stratified. Live: one to three strata (`ChangeSet.sequence`), each the union of one or two live ops through
 * relations of the session's role (its written ones first); sometimes a query entry's write ordered against a write to
 * a relation its filter reads, both ways and in one stratum; and read-backs of up to two of the role's relations. Each
 * stratum is one invalid input beside live ones: the session (closed, or a direct writer's), the relation (another
 * role's), or one op through an entry the role writes (a fact kind its strata offer).
 */
const applyStrata = (state: ModelState): Strata<Action> => {
	const liveApply = (session: number): Gen<Action> => {
		const writer = writerOf(state, session)
		const reader = readerOf(state, session)
		const relation = relationArms(
			state,
			reader,
			preferredBy(reader, (r) => r.write)
		).live
		const op: Gen<EntryOp> = (source) => source.draw(liveOp(state, writer, source.draw(relation)))
		const stratum = map(array(op, { min: 1, max: 2 }), (ops) =>
			knownNonEmpty(ops, "a stratum's ops")
		)
		const strata = map(array(stratum, { min: 1, max: 3 }), (xs) => knownNonEmpty(xs, "the strata"))
		const ordered = orderedGen(state, writer)
		const held = Record.keys(writer.role.entries)
		const reads = map(shuffled(held, { min: 0, max: Math.min(2, held.length) }), (picked) =>
			Arr.filter(held, (name) => picked.includes(name))
		)
		return (source) =>
			applyOf(
				session,
				source.draw(ordered === undefined ? strata : oneOf([strata, ordered])),
				source.draw(reads)
			)
	}
	const aimed = Arr.map(liveFor(state, "apply"), (session) => {
		const writer = writerOf(state, session)
		const reader = readerOf(state, session)
		const others = chainStrata(
			armsStrata(
				relationArms(
					state,
					reader,
					preferredBy(reader, (r) => r.write)
				)
			),
			(name) => map(liveOp(state, writer, name), (op) => applyOf(session, [[op]], []))
		)
		const ops = Arr.map(writtenOf(state.install.base, writer.role), (w) =>
			mapStrata(opsThrough(state, writer, w.entry), (op) => applyOf(session, [[op]], []))
		)
		return unionStrata(Arr.map([others, ...ops], offLive))
	})
	return unionStrata([chainStrata(sessionsFor(state, "apply"), liveApply), ...aimed])
}

/**
 * A view filter: none, or one raising on a value of one of the relation's fields, half the time a value a fact the
 * transaction sees holds in the field's domain (so the predicate meets a row inside the world, or one row security or a
 * security barrier hides), otherwise a pool value.
 */
const viewFilterGen = (heading: ReadonlyArray<FieldSpec>, view: HostState): Gen<ViewFilter> => {
	const [first, ...rest] = heading
	const valueGen = (f: FieldSpec): Gen<HostValue> => {
		const pool = map(int(0, 7), (n) => pooled(f.domain, n))
		const [held, ...more] = heldIn(view, f.domain)
		return held === undefined ? pool : oneOf([pool, element([held, ...more])])
	}
	return first === undefined
		? constant<ViewFilter>({ kind: "none" })
		: oneOf([
				constant<ViewFilter>({ kind: "none" }),
				(source): ViewFilter => {
					const f = source.draw(element([first, ...rest]))
					return { kind: "raise-on", field: f.name, value: source.draw(valueGen(f)) }
				}
			])
}

/**
 * How a direct writer's INSERT resolves a conflict: do nothing, or return or update the stored row under the writer's
 * predicate over it, drawn as a view filter is (`viewFilterGen`), or raising on the value the requested fact holds in
 * one of its fields, which is the stored row's own where the request repeats a stored fact, so the predicate raises on
 * exactly the row the conflict meets, whether row security shows it to the role or hides it.
 */
const onConflictGen = (
	heading: ReadonlyArray<FieldSpec>,
	view: HostState,
	fact: HostFact
): Gen<ConflictResolution> => {
	const [held, ...more] = Arr.flatMap(heading, (f) => {
		const value = fact[f.name]
		return value === undefined ? [] : [{ field: f.name, value }]
	})
	const own: ReadonlyArray<Gen<ViewFilter>> =
		held === undefined
			? []
			: [map(element([held, ...more]), (at): ViewFilter => ({ kind: "raise-on", ...at }))]
	const where = oneOf([viewFilterGen(heading, view), ...own])
	return oneOf<ConflictResolution>([
		constant<ConflictResolution>({ kind: "nothing" }),
		map(where, (w): ConflictResolution => ({ kind: "select", where: w })),
		map(where, (w): ConflictResolution => ({ kind: "update", where: w }))
	])
}

/** The values the facts of a view hold in a domain, each once. */
const heldIn = (view: HostState, domain: FieldDomain): ReadonlyArray<HostValue> => [
	...new Map(
		Arr.flatMap([...view.values()].flat(), (fact) =>
			Arr.flatMap(Record.values(fact), (v) =>
				inDomain(domain, v) ? [[valueText(v), v] as const] : []
			)
		)
	).values()
]

/** Arguments of a function's parameters: a value of each parameter's domain, from its pool. */
const argumentsGen =
	(params: ReadonlyArray<FieldDomain>): Gen<ReadonlyArray<HostValue>> =>
	(source) =>
		Arr.map(params, (domain) => pooled(domain, source.draw(int(0, 7))))

/** A fact's values at some of its fields. */
const projectionOf = (fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Record.fromEntries(
		Arr.flatMap(fields, (f) => {
			const v = fact[f]
			return v === undefined ? [] : [[f, v] as const]
		})
	)

/**
 * The statements of a direct writer's open transaction, stratified. Live: every statement with live arguments (an
 * insert naming a serial field's value, or leaving it to its identity), and as the login, half the time SET ROLE to one
 * of its roles; a stratum per role reference kind of SET ROLE and SET SESSION AUTHORIZATION, and per claims kind of
 * setting `grizzle.claims`. Every write and table read names a base relation: a derived one changes only through its
 * declaration or a refresh (README "Derived tables"), and its role relations read it.
 */
const statementStrata = (state: ModelState, session: number): Strata<DirectStatement> => {
	const s = state.sessions[session]
	const login = s?.kind === "direct" ? s.login : state.install.logins[0].name
	const current = s?.kind === "direct" ? s.current : { kind: "login" as const }
	/** What the transaction sees: its view; a session that is no direct writer's (a stale handle) sees reality. */
	const view = s?.kind === "direct" ? s.view : state.reality
	const base = state.install.base
	const relations = knownNonEmpty(
		Arr.map(base.relations, (r) => r.name),
		"the relations"
	)
	const relationGen = element(relations)
	const preparedNames = ["p0", "p1"] as const
	const entries = knownNonEmpty(
		Arr.flatMap(state.install.roles, (r) =>
			Arr.map(Record.toEntries(r.entries), ([relation, spec]) => ({ role: r.name, relation, spec }))
		),
		"the entries"
	)
	const serialFields = Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f) =>
			f.domain.kind === "serial" ? [{ relation: r.name, field: f.name }] : []
		)
	)
	const [firstSerial, ...moreSerials] = serialFields
	const [firstFunction, ...moreFunctions] = worldFunctionsOf(state)
	const roles = roleArms(state.install, { kind: "login", login })
	const claims = claimsArms(state, current)
	const roleRef = roles.live
	const keyOf = (relation: string): ReadonlyArray<string> =>
		Option.match(
			Arr.findFirst(base.relations, (r) => r.name === relation),
			{ onNone: () => Arr.map(fieldsOfSource(base, relation), (f) => f.name), onSome: (r) => r.key }
		)
	const allFields = knownNonEmpty(
		Arr.flatMap(base.relations, (r) => r.fields),
		"the base's fields"
	)
	const withRelation =
		(statement: (relation: string) => Gen<DirectStatement>): Gen<DirectStatement> =>
		(source) =>
			source.draw(statement(source.draw(relationGen)))
	const anyStatement = oneOf<DirectStatement>([
		map(roleRef, (role): DirectStatement => ({ kind: "set-role", role })),
		constant<DirectStatement>({ kind: "reset-role" }),
		map(roleRef, (role): DirectStatement => ({ kind: "set-session-authorization", role })),
		map(claims.live, (setting): DirectStatement => ({ kind: "set-claims", setting })),
		(source) => {
			const e = source.draw(element(entries))
			return {
				kind: "select-view",
				role: e.role,
				relation: e.relation,
				filter: source.draw(viewFilterGen(headingOf(state.install.base, e.spec), view))
			}
		},
		withRelation((relation) =>
			map(viewFilterGen(fieldsOfSource(base, relation), view), (filter): DirectStatement => ({
				kind: "select-table",
				relation,
				filter
			}))
		),
		withRelation((relation) =>
			map(insertedGen(state, relation), (fact): DirectStatement => ({
				kind: "insert",
				relation,
				fact
			}))
		),
		withRelation((relation) => (source) => {
			const fact = source.draw(insertedGen(state, relation))
			return {
				kind: "insert-on-conflict",
				relation,
				fact,
				onConflict: source.draw(onConflictGen(fieldsOfSource(base, relation), view, fact))
			}
		}),
		withRelation((relation) =>
			map(array(baseFactGen(state, relation), { min: 1, max: 2 }), (facts): DirectStatement => ({
				kind: "merge-delete",
				relation,
				keys: Arr.map(facts, (f) => projectionOf(f, keyOf(relation)))
			}))
		),
		(source) => ({
			kind: "prepare",
			name: source.draw(element(preparedNames)),
			read: source.draw(
				oneOf<PreparedRead>([
					map(element(entries), (e): PreparedRead => ({
						kind: "view",
						role: e.role,
						relation: e.relation
					})),
					map(relationGen, (relation): PreparedRead => ({ kind: "table", relation }))
				])
			)
		}),
		map(
			element([
				...preparedNames,
				...(s?.kind === "direct" ? Record.keys(s.prepared) : [])
			] as const),
			(name): DirectStatement => ({ kind: "execute-prepared", name })
		),
		withRelation((relation) =>
			map(baseFactGen(state, relation), (fact): DirectStatement => ({
				kind: "delete",
				relation,
				key: projectionOf(fact, keyOf(relation))
			}))
		),
		withRelation((relation) => (source): DirectStatement => {
			const at = source.draw(baseFactGen(state, relation))
			const to = source.draw(baseFactGen(state, relation))
			const key = keyOf(relation)
			const payload = Arr.filter(Record.keys(to), (f) => !key.includes(f))
			return {
				kind: "update",
				relation,
				key: projectionOf(at, key),
				set: projectionOf(to, payload.length > 0 ? payload : key)
			}
		}),
		map(relationGen, (relation): DirectStatement => ({ kind: "truncate", relation })),
		...(firstFunction === undefined
			? []
			: [
					(source: Source): DirectStatement => {
						const fn = source.draw(element([firstFunction, ...moreFunctions]))
						/** Values of any of the base's fields, zero to two of them, whatever the function's parameters. */
						const anyArgs = array(
							(inner) => inner.draw(element(pool(inner.draw(element(allFields)).domain))),
							{
								min: 0,
								max: 2
							}
						)
						const params = parametersOf(state, fn)
						return {
							kind: "call",
							fn,
							args: source.draw(
								params === undefined ? anyArgs : oneOf([argumentsGen(params), anyArgs])
							)
						}
					}
				]),
		...(firstSerial === undefined
			? []
			: [
					(source: Source): DirectStatement => {
						const at = source.draw(element([firstSerial, ...moreSerials]))
						return {
							kind: "setval",
							relation: at.relation,
							field: at.field,
							value: source.draw(element([0, 1, 12, 13, 1000, -1, 2_147_483_647]))
						}
					}
				])
	])
	/**
	 * As its login a writer holds no privilege, so every write, call and read it sends is refused and aborts the
	 * transaction: half its statements take on one of its login's roles, so a session goes on to act as one. As one of
	 * its roles, half its statements act within that role's world (worldStatements).
	 */
	const acting = current.kind === "role" ? roleOf(state.install, current.role) : undefined
	const [firstWorldly, ...moreWorldly] =
		acting === undefined || s?.kind !== "direct"
			? []
			: worldStatements(state, acting, s.view, claimedFacts(s), claims.live)
	const live: Gen<DirectStatement> =
		current.kind === "login"
			? weighted([
					[3, map(roleRef, (role): DirectStatement => ({ kind: "set-role", role }))],
					[1, anyStatement]
				])
			: firstWorldly === undefined
				? anyStatement
				: oneOf([oneOf([firstWorldly, ...moreWorldly]), anyStatement])
	return unionStrata([
		{ live: [live], stale: [], wild: [] },
		offLive(mapStrata(armsStrata(roles), (role): DirectStatement => ({ kind: "set-role", role }))),
		offLive(
			mapStrata(armsStrata(roles), (role): DirectStatement => ({
				kind: "set-session-authorization",
				role
			}))
		),
		offLive(
			mapStrata(armsStrata(claims), (setting): DirectStatement => ({ kind: "set-claims", setting }))
		)
	])
}

/**
 * The statements of a direct writer acting as a role within that role's world, so they meet the facts inside it,
 * outside it and hidden from it as the claims it sets decide: a read of one of its views; claims a real user holds
 * (claimsArms' live); and for each relation it writes whose stored facts the transaction sees, a read of its table, a
 * delete, MERGE delete and update at a stored fact's key, an insert of a stored fact under a fresh key, an insert of a
 * stored fact itself that ON CONFLICT resolves, and a call of each key probe and filter function of its entry with a
 * stored fact's values.
 */
const worldStatements = (
	state: ModelState,
	role: RoleSpec,
	view: HostState,
	facts: ContextFacts,
	liveClaims: Gen<ClaimsSetting>
): ReadonlyArray<Gen<DirectStatement>> => {
	const base = state.install.base
	const [firstEntry, ...moreEntries] = Record.toEntries(role.entries)
	const views =
		firstEntry === undefined
			? []
			: [
					(source: Source): DirectStatement => {
						const [relation, spec] = source.draw(element([firstEntry, ...moreEntries]))
						return {
							kind: "select-view",
							role: role.name,
							relation,
							filter: source.draw(viewFilterGen(headingOf(base, spec), view))
						}
					}
				]
	const claims = map(liveClaims, (setting): DirectStatement => ({ kind: "set-claims", setting }))
	const writes = Arr.flatMap(writtenOf(base, role), (w): ReadonlyArray<Gen<DirectStatement>> => {
		const target = relationSpecOf(base, w.target)
		const [firstStored, ...moreStored] = nameableFacts(view, w.target)
		if (target === undefined || firstStored === undefined) {
			return []
		}
		const relation = w.target
		const stored = byMembership(seenThrough(state, view), role, w.entry, facts, relation, [
			firstStored,
			...moreStored
		])
		const key = (fact: HostFact): HostFact => projectionOf(fact, target.key)
		const updatable = updatableFields(base, w)
		const claimFixed = claimFixedFields(w)
		const rekeyed: Gen<HostFact> = (source) => {
			const fact = source.draw(stored)
			const picks = source.draw(
				array(int(0, 7), { min: target.key.length, max: target.key.length })
			)
			return {
				...fact,
				...Record.fromEntries(
					Arr.flatMap(target.key, (k, i) => {
						const field = Option.getOrUndefined(Arr.findFirst(target.fields, (f) => f.name === k))
						return field === undefined ? [] : [[k, pooled(field.domain, picks[i] ?? 0)] as const]
					})
				)
			}
		}
		const functions = Arr.filter(
			worldFunctionsOf(state),
			(fn) =>
				(fn.kind === "key-probe" || fn.kind === "filter") &&
				fn.role === role.name &&
				fn.entry === w.entry
		)
		const membership = w.kind === "query" ? membershipOf(base, w.rules, target) : undefined
		/** A call's arguments from a stored fact: a key probe's key fields, a filter function's membership fields. */
		const argsOf = (fn: WorldFunction, fact: HostFact): ReadonlyArray<HostValue> => {
			const fieldsOf = (): ReadonlyArray<string> => {
				switch (fn.kind) {
					case "key-probe":
						return keysOf(base, relation)[fn.key] ?? []
					case "filter":
					case "advance":
						return membership ?? []
				}
			}
			return Arr.flatMap(fieldsOf(), (f) => {
				const v = fact[f]
				return v === undefined ? [] : [v]
			})
		}
		const [firstFn, ...moreFns] = functions
		return [
			constant<DirectStatement>({ kind: "select-table", relation, filter: { kind: "none" } }),
			map(stored, (fact): DirectStatement => ({ kind: "delete", relation, key: key(fact) })),
			map(array(stored, { min: 1, max: 2 }), (at): DirectStatement => ({
				kind: "merge-delete",
				relation,
				keys: Arr.map(at, key)
			})),
			...(updatable.length === 0
				? []
				: [
						(source: Source): DirectStatement => {
							const at = source.draw(stored)
							const to = source.draw(stored)
							return { kind: "update", relation, key: key(at), set: projectionOf(to, updatable) }
						}
					]),
			...(claimFixed.length === 0
				? []
				: [
						map(stored, (at): DirectStatement => ({
							kind: "update",
							relation,
							key: key(at),
							set: projectionOf(at, claimFixed)
						}))
					]),
			map(rekeyed, (fact): DirectStatement => ({ kind: "insert", relation, fact })),
			(source: Source): DirectStatement => {
				const fact = source.draw(stored)
				return {
					kind: "insert-on-conflict",
					relation,
					fact,
					onConflict: source.draw(onConflictGen(target.fields, view, fact))
				}
			},
			...(firstFn === undefined
				? []
				: [
						(source: Source): DirectStatement => {
							const fn = source.draw(element([firstFn, ...moreFns]))
							return { kind: "call", fn, args: argsOf(fn, source.draw(stored)) }
						}
					])
		]
	})
	return [...views, claims, ...writes]
}

/** The facts a direct writer's claims setting holds: none when unset or malformed. */
const claimedFacts = (session: DirectSessionState): ContextFacts =>
	session.claims.kind === "set" && session.claims.setting.kind === "facts"
		? session.claims.setting.facts
		: noFacts

/**
 * A stored fact of a relation a role writes through `entry`, drawn evenly among how the role sees it under its claims:
 * in that entry, in another of its entries, or in none (features.ts's memberships), each class evenly among its facts,
 * so a statement at a stored fact meets each membership the reality offers whatever its share of the facts.
 */
const byMembership = (
	seen: ModelState,
	role: RoleSpec,
	entry: string,
	facts: ContextFacts,
	relation: string,
	stored: Arr.NonEmptyReadonlyArray<HostFact>
): Gen<HostFact> => {
	/** Whether an entry holds a fact of the relation: a whole entry all of them, a writable query entry its members. */
	const holds = (name: string, spec: EntrySpec, fact: HostFact): boolean => {
		if (spec.kind === "whole") {
			return spec.relation === relation
		}
		const classified = classifyEntry(seen.install.base, spec)
		return (
			classified.kind === "writable" &&
			classified.target === relation &&
			isMember(seen, role.name, name, facts, fact)
		)
	}
	const inside = (fact: HostFact): boolean =>
		Option.exists(Option.fromUndefinedOr(role.entries[entry]), (spec) => holds(entry, spec, fact))
	const elsewhere = (fact: HostFact): boolean =>
		Arr.some(
			Record.toEntries(role.entries),
			([name, spec]) => name !== entry && holds(name, spec, fact)
		)
	const [first, ...rest] = Arr.flatMap(
		[
			Arr.filter(stored, inside),
			Arr.filter(stored, (f) => !inside(f) && elsewhere(f)),
			Arr.filter(stored, (f) => !inside(f) && !elsewhere(f))
		],
		(facts): ReadonlyArray<Gen<HostFact>> =>
			Arr.isReadonlyArrayNonEmpty(facts) ? [element(facts)] : []
	)
	return first === undefined ? element(stored) : oneOf([first, ...rest])
}

/** A fact a direct writer inserts: a base fact naming its serial fields' values, or leaving them to the identity. */
const insertedGen =
	(state: ModelState, relation: string): Gen<HostFact> =>
	(source) => {
		const fact = source.draw(baseFactGen(state, relation))
		return source.draw(boolean) ? fact : withoutSerials(state.install.base, relation, fact)
	}

/** A fact without its relation's serial fields. */
const withoutSerials = (base: BaseSpec, relation: string, fact: HostFact): HostFact => {
	const serials = new Set(
		Arr.flatMap(base.relations, (r) =>
			r.name === relation
				? Arr.flatMap(r.fields, (f) => (f.domain.kind === "serial" ? [f.name] : []))
				: []
		)
	)
	return Record.fromEntries(Arr.filter(Record.toEntries(fact), ([field]) => !serials.has(field)))
}

/**
 * How a direct writer begins: three times in four as one of its login's roles (the README's direct-writer shape, SET
 * ROLE and the claims sent with BEGIN), setting its live claims (claimsArms) half the time, so its first statement meets
 * the facts inside, outside and hidden from that role's world; otherwise as its login, whose statements take a role,
 * set claims or are refused one at a time.
 */
const startGen = (state: ModelState, login: string): Gen<DirectStart> => {
	const [first, ...rest] = loginOf(state.install, login)?.roles ?? []
	const asLogin = constant<DirectStart>({ current: { kind: "login" }, claims: { kind: "none" } })
	if (first === undefined) {
		return asLogin
	}
	const asRole: Gen<DirectStart> = (source) => {
		const role = source.draw(element([first, ...rest]))
		return source.draw(
			oneOf<DirectStart>([
				constant({ current: { kind: "role", role }, claims: { kind: "none" } }),
				map(claimsArms(state, { kind: "role", role }).live, (setting): DirectStart => ({
					current: { kind: "role", role },
					claims: { kind: "set", setting }
				}))
			])
		)
	}
	return weighted([
		[1, asLogin],
		[3, asRole]
	])
}

/**
 * How a direct writer begins, stratified: live, startGen; and as its login and as each of its login's roles, a start
 * setting claims of each invalid kind (claimsArms: another user's, for the session, malformed, a context it does not
 * read, which for the login is every context), so a statement under them is one step from BEGIN.
 */
const startStrata = (state: ModelState, login: string): Strata<DirectStart> =>
	unionStrata([
		{ live: [startGen(state, login)], stale: [], wild: [] },
		...Arr.map(
			[
				{ kind: "login" as const },
				...Arr.map(loginOf(state.install, login)?.roles ?? [], (role) => ({
					kind: "role" as const,
					role
				}))
			],
			(current: DirectStart["current"]) =>
				offLive(
					mapStrata(armsStrata(claimsArms(state, current)), (setting): DirectStart => ({
						current,
						claims: { kind: "set", setting }
					}))
				)
		)
	])

/** A direct writer's BEGIN as a login, at an isolation level, with its start. */
const begin =
	(login: string, isolation: Isolation) =>
	(start: DirectStart): Action => ({ kind: "direct-begin", login, isolation, start })

/** A direct writer's COMMIT or ROLLBACK of the transaction at a session. */
const ended =
	(end: "commit" | "rollback") =>
	(session: number): Action => ({ kind: "direct-end", session, end })

/** A direct writer's COMMIT or ROLLBACK at a session, either. */
const eitherEnd = (session: number): Gen<Action> =>
	map(element(["commit", "rollback"] as const), (end) => ended(end)(session))

/** The action of a session's kind naming a session, its rest drawn by `rest`; per live session, its own strata. */
const bySession = (
	state: ModelState,
	kind: SessionKind,
	rest: (session: number) => Gen<Action>,
	aimed: (session: number) => ReadonlyArray<Strata<Action>>
): Strata<Action> =>
	unionStrata([
		chainStrata(sessionsFor(state, kind), rest),
		...Arr.map(Arr.flatMap(liveFor(state, kind), aimed), offLive)
	])

const refreshOf =
	(session: number) =>
	(relation: string): Action => ({ kind: "refresh", session, relation })

const directOf =
	(session: number) =>
	(statement: DirectStatement): Action => ({ kind: "direct", session, statement })

/**
 * The actions of one kind in a state the kind is applicable in, stratified by the invalid kind each carries; an open
 * names an own role of the focus.
 */
const strataOfKind = (state: ModelState, kind: ActionKind, focus: RoleFocus): Strata<Action> => {
	switch (kind) {
		case "open-db":
			return openDbStrata(state, focus)
		case "read": {
			const readOf = (session: number, relation: string, writer: FactWriter) =>
				map(viaArms(state, writer.role, writer.facts, relation).live, (via): Action => ({
					kind: "read",
					session,
					relation,
					via
				}))
			const relations = (session: number) =>
				armsStrata(
					relationArms(
						state,
						readerOf(state, session),
						preferredBy(readerOf(state, session), (r) => Record.keys(r.entries))
					)
				)
			return bySession(
				state,
				"read",
				(session) => (source) =>
					source.draw(
						readOf(
							session,
							source.draw(liveOf(relations(session), "a read's relations")),
							writerOf(state, session)
						)
					),
				(session) => {
					const writer = writerOf(state, session)
					return [
						chainStrata(relations(session), (relation) => readOf(session, relation, writer)),
						...Arr.map(Record.keys(writer.role.entries), (relation) =>
							mapStrata(
								armsStrata(viaArms(state, writer.role, writer.facts, relation)),
								(via): Action => ({
									kind: "read",
									session,
									relation,
									via
								})
							)
						)
					]
				}
			)
		}
		case "apply":
			return applyStrata(state)
		case "refresh": {
			const relations = (session: number) =>
				armsStrata(
					relationArms(
						state,
						readerOf(state, session),
						preferredBy(readerOf(state, session), (r) => r.refresh)
					)
				)
			return bySession(
				state,
				"refresh",
				(session) => map(liveOf(relations(session), "a refresh's relations"), refreshOf(session)),
				(session) => [mapStrata(relations(session), refreshOf(session))]
			)
		}
		case "close":
			return mapStrata(sessionsFor(state, "close"), (session): Action => ({
				kind: "close",
				session
			}))
		case "direct-begin": {
			const logins = Arr.map(state.install.logins, (l) => l.name)
			return unionStrata([
				chainStrata(armsStrata(isolationArms), (isolation) => (source) => {
					const login = source.draw(element(logins))
					return begin(
						login,
						isolation
					)(source.draw(liveOf(startStrata(state, login), "a direct writer's starts")))
				}),
				...Arr.map(logins, (login) =>
					offLive(mapStrata(startStrata(state, login), begin(login, "serializable")))
				)
			])
		}
		case "direct": {
			return bySession(
				state,
				"direct",
				(session) =>
					map(
						liveOf(statementStrata(state, session), "a direct writer's statements"),
						directOf(session)
					),
				(session) => [mapStrata(statementStrata(state, session), directOf(session))]
			)
		}
		case "direct-end": {
			/**
			 * A transaction a refusal aborted is the writer's to end: its ROLLBACK is live, and its COMMIT, which ends it
			 * as a ROLLBACK, is the input that follows a refusal (session:after-refusal).
			 */
			const sessions = sessionsFor(state, "direct-end")
			const aborted = Arr.flatMap(sessions.stale, (v) =>
				v.invalid === "session:after-refusal" ? [v.gen] : []
			)
			const endedEither =
				(gen: Gen<number>): Gen<Action> =>
				(source) =>
					source.draw(eitherEnd(source.draw(gen)))
			return {
				live: [
					...Arr.map(sessions.live, endedEither),
					...Arr.map(aborted, (gen) => map(gen, ended("rollback")))
				],
				stale: Arr.map(sessions.stale, (v) => ({
					invalid: v.invalid,
					gen:
						v.invalid === "session:after-refusal" ? map(v.gen, ended("commit")) : endedEither(v.gen)
				})),
				wild: Arr.map(sessions.wild, (v) => ({ invalid: v.invalid, gen: endedEither(v.gen) }))
			}
		}
		case "interrupt": {
			const interrupts = mapStrata(sessionsFor(state, "interrupt"), (session): Action => ({
				kind: "interrupt",
				session
			}))
			return {
				live: [],
				stale: interrupts.stale,
				wild: [
					...Arr.map(interrupts.live, (gen) => ({ invalid: "session:interrupted" as const, gen })),
					...interrupts.wild
				]
			}
		}
		case "migrate":
			return mapStrata(migrationStrata(state), (m): Action => ({
				kind: "migrate",
				to: m.to,
				how: m.how
			}))
		case "tamper":
			return {
				live: [],
				stale: [],
				wild: Arr.map(catalogVariants(state), (v) => ({
					invalid: v.invalid,
					gen: map(v.gen, (perturbation): Action => ({ kind: "tamper", perturbation }))
				}))
			}
		case "drift":
			return { live: [constant<Action>({ kind: "drift" })], stale: [], wild: [] }
		case "wild":
			return {
				live: [],
				stale: [],
				wild: [
					{
						invalid: "handle:wild-js-value",
						gen: (source): Action => ({
							kind: "wild",
							at: source.draw(wildSiteGen(state, wildCalls(state))),
							wild: source.draw(element(WILD_KINDS))
						})
					}
				]
			}
	}
}

/** An action kind's strata in a state under a role focus (only an open reads it). */
const kindStrata = (state: ModelState, kind: ActionKind, focus: RoleFocus): Strata<Action> =>
	strataOfKind(state, kind, kind === "open-db" ? focus : everyRole)

/**
 * The actions of a state that carry each invalid kind, every way any applicable action kind carries it, the rest of
 * each action live; none for a kind the state offers nowhere. Every draw is classified as the kind (invalidKindsOf).
 * Each applicable action kind's strata are built once, with the function.
 */
export const invalidGens = (
	state: ModelState
): ((kind: InvalidKind) => Gen<Action> | undefined) => {
	const strata = Arr.map(
		Arr.filter(actionKinds, (k) => applicable(state, k)),
		(k) => kindStrata(state, k, everyRole)
	)
	return (kind) => {
		const [first, ...rest] = Arr.flatMap(strata, (s) => strataOf(s, kind))
		return first === undefined ? undefined : anyOf([first, ...rest])
	}
}

/** A weight scaled to a whole number, keeping the ratios of fractional weights a caller may give. */
const scaled = (weight: number): number => Math.max(0, Math.round(weight * 1000))

/**
 * One action of a run in a state: a kind among those the state offers (a session's action only where a session exists
 * and the serial rule lets it be named), weighted by the run's action weights, each in the share of its draws the
 * validity weights hold there (validShare); then, under the run's validity weights,
 * a live action of the kind or one carrying an invalid input, the stale and wild shares each split evenly among the
 * invalid kinds the state offers for it (its strata), so a rare kind is drawn as often as a common one. Only sessions
 * the state holds are named, a harness invariant; closed and mismatched handles are strata like any other. Only the
 * kinds the run may draw are offered. When no offered kind weighs anything, the state's forced moves among them
 * (opening a session when none is open) are drawn evenly, and failing those every offered kind: no weighting is a dead
 * end, and none leaves the run's kinds. A run aiming at features draws, half the time or every time (Aims), an action
 * reaching one of them (aimedGen).
 */
export const actionGen = (
	state: ModelState,
	{ actions, validity, kinds, roles, aims }: Weights
): Gen<Action> => {
	const offered = Arr.filter(actionKinds, (k) => Arr.contains(kinds, k) && applicable(state, k))
	const drawn = weightedGen(state, offered, actions, validity, kinds, roles)
	switch (aims.kind) {
		case "none":
			return drawn
		case "half":
			return oneOf([drawn, aimedGen(state, kinds, roles, aims, drawn)])
		case "every":
			return aimedGen(state, kinds, roles, aims, drawn)
	}
}

/** The features an action reaches in any of its branches from a state, by the run's reading of an outcome (Aims). */
const reachedBy = (read: Aiming["read"], state: ModelState, action: Action): ReadonlySet<string> =>
	new Set<string>(Arr.flatMap(step(state, action), (outcome) => read(state, action, outcome)))

/** Whether an action is within a role focus: an open of an own role names one the focus holds. */
const focusedOn = (roles: RoleFocus, a: Action): boolean =>
	a.kind !== "open-db" ||
	a.role.kind !== "own" ||
	roles.kind === "every" ||
	roles.roles.includes(a.role.role)

/**
 * Every action the box of a scope offers in a state within a run's kinds, an own role opened only within its focus, in
 * the order of the vocabulary (enumerateKind): the candidates of an aimed draw and of a lead's first move alike.
 */
export const offeredOf = (
	state: ModelState,
	kinds: Weights["kinds"],
	roles: RoleFocus,
	scope: SmallScope
): ReadonlyArray<Action> => {
	const offered: ReadonlyArray<ActionKind> = Arr.filter(actionKinds, (k) => Arr.contains(kinds, k))
	return Arr.filter(
		Arr.flatMap(offered, (k) => enumerateKind(state, k, scope)),
		(a) => focusedOn(roles, a)
	)
}

/** An action the box offers and a feature aimed at that it reaches as the model predicts it. */
interface Way {
	readonly feature: string
	readonly action: Action
}

/**
 * The ways an aim takes in a state, grouped by the feature each reaches: every action the box of the aim's scope offers
 * there (offeredOf) that the aim finds worth a step, each stepped once (reachedBy), with each feature aimed at that it
 * reaches. A required feature one step away is never missed for want of a sample, and nothing derived from the state
 * outlives the call.
 */
const waysOf = (
	state: ModelState,
	kinds: Weights["kinds"],
	roles: RoleFocus,
	aiming: Aiming
): ReadonlyArray<Arr.NonEmptyReadonlyArray<Way>> => {
	const aimed: ReadonlySet<string> = new Set<string>(aiming.features)
	const worth: ReadonlyArray<Action> = Arr.filter(
		offeredOf(state, kinds, roles, aiming.scope),
		(a) => aiming.worth(a, state)
	)
	const reaching = Arr.flatMap(worth, (a) =>
		Arr.flatMap([...reachedBy(aiming.read, state, a)], (f): ReadonlyArray<Way> =>
			aimed.has(f) ? [{ feature: f, action: a }] : []
		)
	)
	return Record.values(Arr.groupBy(reaching, (r): string => r.feature))
}

/** One of the ways an aim takes: a feature among those it reaches, evenly, then an action reaching it, evenly. */
const wayGen =
	(ways: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Way>>): Gen<Action> =>
	(source) =>
		source.draw(element(source.draw(element(ways)))).action

/**
 * An aimed draw (Weights.aims): one of the ways the aim takes in the state (waysOf, wayGen), built only when drawn; the
 * run's own draw where none is reachable.
 */
const aimedGen =
	(
		state: ModelState,
		kinds: Weights["kinds"],
		roles: RoleFocus,
		aiming: Aiming,
		drawn: Gen<Action>
	): Gen<Action> =>
	(source) => {
		const [first, ...rest] = waysOf(state, kinds, roles, aiming)
		return source.draw(first === undefined ? drawn : wayGen([first, ...rest]))
	}

/**
 * The share of a kind's draws in a state that the run's validity weights hold: of a kind that draws live inputs
 * (drawsLive), the shares of the classes its strata offer there, over the whole, so a session's action whose every
 * session is closed or refused weighs only the invalid shares and a run draws invalid inputs in its validity shares, not
 * wherever the state leaves a kind nothing live; of a kind invalid by nature, all of them. Validity of zero draws live
 * inputs alone.
 */
const validShare = (
	kind: ActionKind,
	strata: Strata<Action>,
	validity: Weights["validity"]
): number => {
	if (!drawsLive[kind]) {
		return 1
	}
	const total = validity.live + validity.stale + validity.wild
	const offered =
		(strata.live.length > 0 ? validity.live : 0) +
		(strata.stale.length > 0 ? validity.stale : 0) +
		(strata.wild.length > 0 ? validity.wild : 0)
	return total === 0 ? (strata.live.length > 0 ? 1 : 0) : offered / total
}

/** The move that opens a session a session kind can name: a Db for a Db's call, close or interrupt, a direct transaction for a statement or its end. */
const openerOf: { readonly [K in SessionKind]: "open-db" | "direct-begin" } = {
	read: "open-db",
	apply: "open-db",
	refresh: "open-db",
	close: "open-db",
	interrupt: "open-db",
	direct: "direct-begin",
	"direct-end": "direct-begin"
}

/** The kinds that name a session, each once. */
const sessionKinds: ReadonlyArray<SessionKind> = Record.keys(openerOf)

/**
 * The kinds a draw of one kind needs offered: the kind, and for a kind that names a session, the move that opens one,
 * which a state holding no session it can act through draws instead (weightedGen's opening). A lead's move of a
 * session's kind after a refused open draws that open, never an empty offer.
 */
export const withOpener = (kind: ActionKind): Arr.NonEmptyReadonlyArray<ActionKind> => {
	const session = Arr.findFirst(sessionKinds, (k) => k === kind)
	return Option.isSome(session) ? [kind, openerOf[session.value]] : [kind]
}

/** The live share of the run's validity weights: all of them when none is weighted. */
const liveShare = (validity: Weights["validity"]): number => {
	const total = validity.live + validity.stale + validity.wild
	return total === 0 ? 1 : validity.live / total
}

/** Whether a role does what a Db's call of a kind asks of it: writes something for an apply, refreshes something for a refresh. */
const capableOf = (kind: SessionKind, role: RoleSpec): boolean =>
	kind === "apply" ? role.write.length > 0 : kind === "refresh" ? role.refresh.length > 0 : true

/**
 * Whether a state holds a live session an action of a kind can act through: for a Db's call, one whose role does what
 * the call asks (capableOf).
 */
const actsThrough = (state: ModelState, kind: SessionKind): boolean =>
	Arr.some(liveFor(state, kind), (id) => {
		const s = state.sessions[id]
		return (
			s?.kind !== "db" ||
			Option.exists(
				Arr.findFirst(state.install.roles, (r) => r.name === s.role),
				(r) => capableOf(kind, r)
			)
		)
	})

/**
 * The live move that opens a session a kind can act through: a Db of a role of the focus that does what the kind asks
 * (capableOf), with a live token for it and the current snapshot; a direct writer's live begin; none where the run may
 * not draw the move, the state does not offer it, or no role of the focus can.
 */
const openingOf = (
	state: ModelState,
	kind: SessionKind,
	offered: ReadonlyArray<ActionKind>,
	roles: RoleFocus
): Gen<Action> | undefined => {
	const opener = openerOf[kind]
	if (!Arr.contains(offered, opener)) {
		return undefined
	}
	if (opener === "direct-begin") {
		const [live, ...more] = kindStrata(state, opener, roles).live
		return live === undefined ? undefined : anyOf([live, ...more])
	}
	const [first, ...rest] = Arr.filter(
		state.install.roles,
		(r) =>
			(roles.kind === "every" || roles.roles.includes(r.name)) &&
			capableOf(kind, r) &&
			Arr.some(state.install.logins, (l) => l.roles.includes(r.name))
	)
	return first === undefined
		? undefined
		: (source) => {
				const r = source.draw(element([first, ...rest]))
				return open(own(r), source.draw(tokenArms(state, r.name).live), "current")
			}
}

/**
 * A draw of the run's weights: a kind among those offered, weighted, then its strata under the validity weights. A
 * session's kind the run weighs, in a state holding no live session it can act through (actsThrough), draws its live
 * share as the move that opens one (openingOf): the action it would have drawn needs that session first, so a run
 * weighing writes and not opens still opens a Db of a role that writes, and one weighing statements still begins a
 * transaction. Its invalid shares stay its own, on the closed and stale sessions the state holds.
 */
const weightedGen = (
	state: ModelState,
	offered: ReadonlyArray<ActionKind>,
	actions: Weights["actions"],
	validity: Weights["validity"],
	kinds: Weights["kinds"],
	roles: RoleFocus
): Gen<Action> => {
	const weightedKinds = Arr.flatMap(offered, (k): ReadonlyArray<Share<Action>> => {
		if (actions[k] <= 0) {
			return []
		}
		const strata = kindStrata(state, k, roles)
		const weight = scaled(actions[k] * validShare(k, strata, validity))
		return weight > 0 ? [[weight, (source) => source.draw(underStrata(strata, validity))]] : []
	})
	const opening = Arr.flatMap(sessionKinds, (k): ReadonlyArray<Share<Action>> => {
		const weight = scaled(actions[k] * liveShare(validity))
		if (weight === 0 || !Arr.contains(kinds, k) || actsThrough(state, k)) {
			return []
		}
		const gen = openingOf(state, k, offered, roles)
		return gen === undefined ? [] : [[weight, gen]]
	})
	const drawn = [...weightedKinds, ...opening]
	const forced = Arr.filter(forcedMoves(state), (k) => Arr.contains(kinds, k))
	return proportional(
		knownNonEmpty(
			drawn.length > 0
				? drawn
				: Arr.map(forced.length > 0 ? forced : offered, (kind): Share<Action> => [
						1,
						(source) => source.draw(underStrata(kindStrata(state, kind, roles), validity))
					]),
			"the offered action kinds"
		)
	)
}
