import { Effect, Option, type Scope } from "effect"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Shared helpers for the serverless tests (test/pg/serverless). */
export const backendPid = "SELECT pg_catalog.pg_backend_pid()::text"

/**
 * Vercel's request context: @vercel/functions reads `globalThis[Symbol.for("@vercel/request-context")].get()`
 * for `waitUntil` and `deadline` (get-context.js). The Vercel runtime installs it; a test plays that runtime. It is
 * Vercel's global, not grizzle's: grizzle never reads or writes it.
 */
const requestContextSymbol: unique symbol = Symbol.for("@vercel/request-context")

export interface FakeRequestContext {
	/** Every promise handed to waitUntil, in the order it was handed over. */
	readonly waits: Array<Promise<unknown>>
}

/** The variables Vercel's runtime sets, each set or unset. */
export interface VercelEnv {
	readonly VERCEL_URL: Option.Option<string>
	readonly VERCEL_REGION: Option.Option<string>
}

/** A function deployed on Vercel: both variables set. */
export const onVercel: VercelEnv = {
	VERCEL_URL: Option.some("grizzle-test.vercel.app"),
	VERCEL_REGION: Option.some("iad1")
}

type VercelVariable = keyof VercelEnv

const setVariable = (name: VercelVariable, value: Option.Option<string>): void => {
	Option.match(value, {
		onNone: () => {
			delete process.env[name]
		},
		onSome: (text) => {
			process.env[name] = text
		}
	})
}

/**
 * Installs a fake Vercel request context for the scope, its deadline as given, and the VERCEL_URL and VERCEL_REGION
 * variables as `env` states, restoring the variables and the global afterwards.
 */
export const vercelRuntime = (
	env: VercelEnv,
	deadline: Option.Option<number>
): Effect.Effect<FakeRequestContext, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const context: FakeRequestContext = { waits: [] }
			/** The request context installed before this scope, which it restores. */
			const priorContext: unknown = Reflect.get(globalThis, requestContextSymbol)
			const previous = {
				env: {
					VERCEL_URL: Option.fromUndefinedOr(process.env["VERCEL_URL"]),
					VERCEL_REGION: Option.fromUndefinedOr(process.env["VERCEL_REGION"])
				},
				installed: Reflect.has(globalThis, requestContextSymbol),
				context: priorContext
			}
			setVariable("VERCEL_URL", env.VERCEL_URL)
			setVariable("VERCEL_REGION", env.VERCEL_REGION)
			Reflect.set(globalThis, requestContextSymbol, {
				get: () => ({
					waitUntil: (promise: Promise<unknown>) => {
						context.waits.push(promise)
					},
					...Option.match(deadline, { onNone: () => ({}), onSome: (at) => ({ deadline: at }) })
				})
			})
			return { context, previous }
		}),
		({ previous }) =>
			Effect.sync(() => {
				setVariable("VERCEL_URL", previous.env.VERCEL_URL)
				setVariable("VERCEL_REGION", previous.env.VERCEL_REGION)
				if (previous.installed) {
					Reflect.set(globalThis, requestContextSymbol, previous.context)
				} else {
					Reflect.deleteProperty(globalThis, requestContextSymbol)
				}
			})
	).pipe(Effect.map(({ context }) => context))

/** The number of backends logged in as `role`. */
export const roleBackends = (role: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT count(*)::int4 FROM pg_catalog.pg_stat_activity WHERE usename = $1::text",
			[role]
		)
		return Number(rows[0]?.[0])
	})
