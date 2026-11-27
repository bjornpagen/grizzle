import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { hostInputs, type InputFailure, valuesFailure } from "#adapter/apply/run.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { CallInputRefused } from "#adapter/errors/failures.ts"
import {
	type LoadedChange,
	type LoadedLogin,
	type LoadedRead,
	loadServed
} from "#adapter/served/load.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import {
	appliedGenerated,
	generatedDraft,
	type Installed,
	noPlaceholders,
	templateGenerated
} from "#test/support/install-migrate.ts"
import { type Names, namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import type { DirectBegin } from "#test/support/schedules/types.ts"
import { installTemplate, type SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * A shape as the oracle installs it (shapes.ts, drawn.ts): its schema, its roles by name, and the login over them, whose
 * workloads hold the members a race calls.
 */
export interface Shape {
	readonly schema: AnySchema
	readonly roles: Readonly<Record<string, AnyRole>>
	readonly login: AnyLogin
}

/**
 * A shape installed as `grizzle generate` drafts and serves it: the installation, its names, each role's ChangeSets and
 * reads as its served file loads them, the level each role's served writes begin at, the one generate certifies it at,
 * and the BEGIN of a write at each level, as the served file states them.
 */
export interface InstalledShape {
	readonly installed: Installed
	readonly names: Names
	readonly shape: Shape
	readonly changes: ReadonlyMap<string, ReadonlyMap<string, LoadedChange>>
	readonly reads: ReadonlyMap<string, ReadonlyMap<string, LoadedRead>>
	readonly levels: ReadonlyMap<string, Isolation>
	readonly writeBegins: LoadedLogin["session"]["begin"]["write"]
}

/**
 * What a call passes its member, as the loaded member takes it (adapter/served/load.ts ChangeCall): its parameters, or
 * each call's facts beside them where the member's ChangeSet holds array members.
 */
export type CallInput =
	| { readonly kind: "params"; readonly params: ParamMap }
	| { readonly kind: "facts"; readonly facts: unknown; readonly params: ParamMap }

/**
 * A call a race makes in a session of its own: a ChangeSet member of a role with its input, which the oracle binds and
 * sends statement by statement as the served write's one flight states them; a read member of a role with its
 * parameters, whose one statement the oracle sends in the read's own transaction, SERIALIZABLE READ ONLY; or a
 * transaction of the installation's owner, its statements as written, at the harness session's default level,
 * SERIALIZABLE (test/support/pg.ts harnessSessionOptions), as an operator runs what no role holds.
 */
type RaceCall =
	| {
			readonly kind: "change"
			readonly session: string
			readonly role: string
			readonly member: string
			readonly input: CallInput
	  }
	| {
			readonly kind: "read"
			readonly session: string
			readonly role: string
			readonly member: string
			readonly params: ParamMap
	  }
	| {
			readonly kind: "owner"
			readonly session: string
			readonly statements: (s: InstalledShape) => Arr.NonEmptyReadonlyArray<string>
	  }

/** A race's ChangeSet call (RaceCall). */
type ChangeCall = Extract<RaceCall, { readonly kind: "change" }>

/**
 * Each role's ChangeSets and reads in `loaded`, by role and member, each role's served level, and a read's BEGIN texts.
 */
const servedOf = (loaded: LoadedLogin) => ({
	reads: new Map(
		Arr.map(loaded.roles, (r) => [
			r.name,
			new Map(
				Arr.flatMap(r.members, (member) =>
					member.kind === "read" || member.kind === "key"
						? [[member.name, member.read] as const]
						: []
				)
			)
		])
	),
	writeBegins: loaded.session.begin.write,
	changes: new Map(
		Arr.map(loaded.roles, (r) => [
			r.name,
			new Map(
				Arr.flatMap(r.members, (member) =>
					member.kind === "change" && member.variants.kind === "change"
						? [[member.name, member.variants.change] as const]
						: []
				)
			)
		])
	),
	levels: new Map(Arr.map(loaded.roles, (r) => [r.name, r.isolation] as const))
})

/**
 * The installation of `build(name)` as `grizzle generate` drafts and serves it, all but its install: its draft under
 * `name` (install-migrate.ts generatedDraft), each role at the level generate certifies it at, the shape built under
 * `name`, and its login's served file of the draft, loaded.
 */
const shapePlan = (build: (name: string) => Shape, name: string) =>
	Effect.gen(function* () {
		const shape = build(name)
		const drafted = yield* shapeDraft(shape, name)
		const file = yield* fromEngine(
			servedFile(
				defined(
					drafted.served.get(shape.login.name),
					`the served file of login ${shape.login.name}`
				)
			)
		)
		const login = yield* Effect.fromResult(loadServed(file, shape.login.name))
		return { drafted, shape, served: servedOf(login) }
	})

/** `shape`, built under `name`, drafted as `grizzle generate` drafts its first migration (generatedDraft). */
const shapeDraft = (shape: Shape, name: string) =>
	generatedDraft(
		{ schema: shape.schema, logins: [shape.login], declarations: noDeclarations },
		{ installation: identity.schema(parsedSchemaName(name)), previous: fromEmpty, step: 0 },
		noPlaceholders
	)

/** What a shape's plan (shapePlan) reads once its draft is installed as `installed`. */
const shapeOf = (
	plan: Effect.Success<ReturnType<typeof shapePlan>>,
	installed: Installed
): InstalledShape => ({
	installed,
	names: namesOf(installed),
	shape: plan.shape,
	...plan.served
})

/**
 * A shape's installation as `grizzle generate` drafts and serves it, as a template (substrate.ts installTemplate):
 * `build(name)`'s draft, its certificates and its login's served file planned once per worker under the template's
 * name (shapePlan), and installed once per member (install-migrate.ts appliedGenerated); each case's InstalledShape the
 * installation in its clone, every login logging in with the password its template derived. `name` tells it from the
 * other templates its declaring module states.
 */
export const shapeTemplate = (
	declaredIn: ImportMeta,
	name: string,
	build: (name: string) => Shape
): SubstrateTemplate<InstalledShape> =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn,
		name,
		content: { shape: name },
		plan: (names) =>
			Effect.map(shapePlan(build, names.schema), (plan) => ({
				names,
				plan
			})),
		install: ({ names, plan }) =>
			Effect.asVoid(
				appliedGenerated([plan.drafted], names.schema, ordinarySession, (fresh) =>
					Effect.map(shapeDraft(build(fresh), fresh), (again) => again.plan)
				)
			),
		bind: ({ names, plan }, binding) =>
			shapeOf(plan, templateGenerated(names, [plan.drafted], ordinarySession, binding).installed)
	})

/** A SQL text literal of `text`: in quotes, its quotes doubled. */
const quoted = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/** The element types of the binary arrays grizzle sends (codec/bytea.ts): a text column's and a bytes column's. */
const binaryElements: ReadonlyMap<number, "text" | "bytea"> = new Map([
	[25, "text"],
	[17, "bytea"]
])

/**
 * A binary array placeholder as a SQL array literal: PostgreSQL's array send format (its dimensions, its element type's
 * oid, each dimension's size and lower bound, then each element's length, -1 for NULL, and bytes), of one dimension of
 * text or bytes, which is every one grizzle sends (codec/bytea.ts).
 */
const binaryLiteral = (bytes: Uint8Array): Option.Option<string> => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const dimensions = view.getInt32(0)
	const type = binaryElements.get(view.getInt32(8))
	if (type === undefined || dimensions > 1) {
		return Option.none()
	}
	if (dimensions === 0) {
		return Option.some(`('{}'::${type}[])`)
	}
	const elements: Array<string> = []
	let at = 20
	for (let i = 0; i < view.getInt32(12); i += 1) {
		const length = view.getInt32(at)
		at += 4
		if (length < 0) {
			elements.push("NULL")
			continue
		}
		const element = bytes.subarray(at, at + length)
		at += length
		elements.push(
			type === "text"
				? quoted(defined(utf8Text(element), "a text element of a bound array is UTF-8"))
				: `'\\x${Buffer.from(element).toString("hex")}'::bytea`
		)
	}
	return Option.some(`(ARRAY[${Arr.join(elements, ", ")}]::${type}[])`)
}

/**
 * `sql` with each placeholder replaced by its value's literal, the highest number first so $12 is never read as $1: a
 * text as itself, quoted, and a binary array as its array literal.
 */
const inlined = (sql: string, params: ReadonlyArray<Param>): Effect.Effect<string> =>
	Option.match(
		Option.all(
			Arr.map(params, (p) => (typeof p === "string" ? Option.some(quoted(p)) : binaryLiteral(p)))
		),
		{
			onNone: () =>
				Effect.die(new Error(`a placeholder of no text and no one-dimensional array: ${sql}`)),
			onSome: (literals) =>
				Effect.succeed(
					Arr.reduce(
						Arr.reverse(Arr.map(literals, (literal, i) => [i + 1, literal] as const)),
						sql,
						(text, [n, literal]) => Str.replaceAll(`$${n}`, literal)(text)
					)
				)
		}
	)

/**
 * The statements a session sends before a race's first call of `member` of `role`: the write's stand-ups
 * (runtime/write/flight.ts StandUp), each text in order, the carriers' as the role and the judged tables' as the judge's
 * definer, as a served write's session does before its first call (adapter/apply/stand-up.ts). Each commits alone,
 * outside every race's transaction, so the interleaved statements meet every session object they read standing.
 */
export const callStandUps = (
	s: InstalledShape,
	call: { readonly role: string; readonly member: string }
): ReadonlyArray<string> =>
	Arr.flatMap(
		defined(
			s.changes.get(call.role)?.get(call.member),
			`member ${call.member} of role ${call.role}`
		).entry.program.standUps,
		(standUp) => [standUp.call.sql]
	)

/** The one statement a call the host refuses before any SQL sends: a constant SELECT naming the refusal. */
const hostRefused = `SELECT 'host refused'::text AS refused`

/**
 * The statements of `call` a race interleaves, in the order its served write's one flight sends them: each statement
 * its binding does not skip, each execution its own, every placeholder inlined, the admission's among them
 * (write/program/admission.ts), an entry no query reads, whose parameters are the race's own. A write the host refuses
 * before any SQL sends one constant SELECT naming the refusal, which a serial run of it shows alike.
 */
export const callStatements = (
	s: InstalledShape,
	call: ChangeCall
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>, InputFailure | CallInputRefused> =>
	Effect.gen(function* () {
		const change = defined(
			s.changes.get(call.role)?.get(call.member),
			`member ${call.member} of role ${call.role}`
		)
		const host =
			change.call.kind === "params" && call.input.kind === "params"
				? yield* Effect.fromResult(change.call.call(call.input.params))
				: change.call.kind === "facts" && call.input.kind === "facts"
					? yield* Effect.fromResult(change.call.call(call.input.facts, call.input.params))
					: yield* Effect.die(
							new Error(
								`${call.member} takes ${change.call.kind}, and the race passes ${call.input.kind}`
							)
						)
		const inputs = yield* hostInputs(change.entry, host)
		if (inputs.kind !== "bound") {
			return [hostRefused] as const
		}
		const statements: Array<string> = []
		for (const statement of change.entry.program.statements) {
			if (inputs.bound.skip.has(statement.index)) {
				continue
			}
			const executions = inputs.bound.chunks(statement, inForce(bindFrame))
			if (!executions.ok) {
				return yield* Effect.fail(valuesFailure(executions.error))
			}
			for (const execution of executions.value) {
				const sent = yield* inlined(execution.text.sql, execution.params)
				statements.push(sent)
			}
		}
		const [first, ...rest] = statements
		return first === undefined
			? ([`SELECT 'no statement'::text AS sent`] as const)
			: [first, ...rest]
	})

/** The level `role`'s served writes begin at in `s`, the one generate certifies it at (InstalledShape levels). */
export const servedLevel = (s: InstalledShape, role: string): Isolation =>
	defined(s.levels.get(role), `the served level of role ${role}`)

/**
 * The BEGIN of a call of `role` in `s`: the one its served writes send, at the level generate certifies it at
 * (servedLevel), as the served file states it (schedules/types.ts DirectAction `BeginAs`).
 */
export const writeBegin = (s: InstalledShape, role: string): DirectBegin => ({
	_tag: "BeginAs",
	sql: s.writeBegins[servedLevel(s, role)]
})
