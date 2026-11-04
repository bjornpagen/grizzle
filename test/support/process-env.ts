import { constant, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { type Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"

/**
 * The process environment, the very source node-postgres reads, and never a ConfigProvider's view of it, which a test
 * may set apart from it (adapter/connection/environment.ts reads it so too).
 */
type Environment = Record<string, string | undefined>

/** Sets `env`'s `name` to `value`, or unsets it for none. */
const setVariable = (env: Environment, name: string, value: Option.Option<string>): void => {
	Option.match(value, {
		onNone: () => {
			Reflect.deleteProperty(env, name)
		},
		onSome: (text) => {
			env[name] = text
		}
	})
}

/**
 * The process environment, the one node-postgres reads itself, holding `values` for the scope: each variable at its
 * text, or unset for none, and each as it was again when the scope closes. A file's cases that change it run one at a
 * time.
 */
export const processEnvironment = (
	values: Readonly<Record<string, Option.Option<string>>>
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.asVoid(
		Effect.acquireRelease(
			Effect.sync(() => {
				const env: Environment = process.env
				const previous = Rec.map(values, (_, name) => Option.fromUndefinedOr(env[name]))
				for (const [name, value] of Rec.toEntries(values)) {
					setVariable(env, name, value)
				}
				return previous
			}),
			(previous) =>
				Effect.sync(() => {
					const env: Environment = process.env
					for (const [name, value] of Rec.toEntries(previous)) {
						setVariable(env, name, value)
					}
				})
		)
	)

/**
 * A variable's value in a drawn process environment: absent; the empty text, which pg reads as unset; or a text,
 * options a session would start under or a replication mode, marked where it is long enough to spot in a message.
 */
export type VariableValue =
	| { readonly kind: "absent" }
	| { readonly kind: "empty" }
	| { readonly kind: "text"; readonly text: string }

/** The mark a drawn text carries, which no refusal may quote. */
export const valueMark = "__value_mark__"

const variableTexts: Arr.NonEmptyReadonlyArray<string> = [
	`-c search_path=${valueMark}`,
	`-c extra_float_digits=0 -c application_name=${valueMark}`,
	`database ${valueMark}`,
	" ",
	"true"
]

/** A variable's value: absent, empty, or one of the texts, each with a nonzero weight. */
export const variableGen: Gen<VariableValue> = weighted<VariableValue>([
	[2, constant<VariableValue>({ kind: "absent" })],
	[1, constant<VariableValue>({ kind: "empty" })],
	[2, map(element(variableTexts), (text): VariableValue => ({ kind: "text", text }))]
])

/** A drawn value as the process environment holds it: unset, or its text. */
export const processValue = (value: VariableValue): Option.Option<string> => {
	switch (value.kind) {
		case "absent":
			return Option.none()
		case "empty":
			return Option.some("")
		case "text":
			return Option.some(value.text)
	}
}
