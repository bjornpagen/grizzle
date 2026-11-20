import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Record,
	Ref,
	Stdio,
	Stream,
	Terminal
} from "effect"
import { TerminalCapabilities } from "effect/cli"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import * as Auth from "#runtime-src/runtime/auth.ts"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import * as Client from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"
import { receiving } from "#test/support/stdio.ts"

/** The environment prefix every harness run's CLI reads its settings under. */
export const PREFIX = "EXAMPLE"

/** What one request the CLI sent looked like on the wire: its method, URL, headers in order, and body. */
export type Wire = Readonly<{
	method: string
	url: string
	headers: ReadonlyArray<readonly [string, string]>
}>

/**
 * One run of a generated CLI's send, as the generated entry runs it (Output.send inside finalCatch): the operation and
 * the request built for it, the root servers and security tables, the environment, the values the run recorded, how
 * the server answers each request it receives, whether stdin and stdout are terminals, `--verbose`, `--dry-run`,
 * `--server`, and `--output` with `--force`, written in the case's own directory.
 */
export type SendWorld = Readonly<{
	operation: Output.OperationMeta
	request: HttpClientRequest.HttpClientRequest
	servers: BaseUrl.ServersTable
	security: Auth.SecurityTable
	env: Readonly<Record<string, string>>
	recorded: ReadonlyArray<ScrubEntry>
	reply: (received: number, url: string) => Response
	tty: boolean
	verbose: boolean
	dryRun: boolean
	server: Option.Option<string>
	output: Option.Option<Readonly<{ name: string; force: boolean; dir: ScratchDir }>>
}>

/**
 * A world's defaults: one server bound to its origin, no scheme, no environment, a 200 with an empty JSON array, and no
 * flag.
 */
export const plainWorld = (
	operation: Output.OperationMeta,
	request: HttpClientRequest.HttpClientRequest
): SendWorld => ({
	operation,
	request,
	servers: {
		boundOrigins: ["https://api.example.com"],
		defaultServer: 0,
		servers: [{ url: "https://api.example.com/v1" }]
	},
	security: { schemes: {} },
	env: {},
	recorded: [],
	reply: () => new Response("[]", { status: 200 }),
	tty: false,
	verbose: false,
	dryRun: false,
	server: Option.none(),
	output: Option.none()
})

/**
 * What a run left: its exit, its failure, both streams, which stream each text written to them went to, the requests sent
 * and the prompts.
 */
export type Sent = Readonly<{
	exit: Exit.Exit<unknown, unknown>
	failure: Option.Option<unknown>
	stdout: string
	stderr: string
	writes: ReadonlyArray<"stdout" | "stderr">
	requests: ReadonlyArray<Wire>
	prompts: number
}>

/** Runs the world's send to its end, every service the generated entry provides built for this run alone. */
export const sendIn = (world: SendWorld) =>
	Effect.scoped(
		Effect.gen(function* () {
			const out: Array<string> = []
			const err: Array<string> = []
			const writes: Array<"stdout" | "stderr"> = []
			const requests: Array<Wire> = []
			const prompts = yield* Ref.make(0)
			const capture = (into: Array<string>, stream: "stdout" | "stderr") =>
				receiving((text) => {
					into.push(text)
					writes.push(stream)
				})
			const client = HttpClient.make((sent, url) =>
				Effect.sync(() => {
					requests.push({
						method: sent.method,
						url: url.href,
						headers: Arr.flatMap(Record.toEntries(sent.headers), ([name, value]) =>
							typeof value === "string" ? [[name, value] as const] : []
						)
					})
					return HttpClientResponse.fromWeb(sent, world.reply(requests.length, url.href))
				})
			)
			const key = (name: string, input: Option.Option<string>): Terminal.UserInput => ({
				input,
				key: { ctrl: false, meta: false, name, shift: false }
			})
			const terminal = Terminal.make({
				columns: Effect.succeed(80),
				display: () => Effect.void,
				readInput: Effect.gen(function* () {
					yield* Ref.update(prompts, (count) => count + 1)
					const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
					yield* Queue.offerAll(queue, [key("x", Option.some("x")), key("enter", Option.none())])
					return queue
				}),
				readLine: Effect.die("a harness terminal reads no line"),
				rows: Effect.succeed(24),
				size: Effect.die("a harness terminal has no size")
			})
			const stdio = Stdio.layerTest({
				stderr: capture(err, "stderr"),
				stdin: Stream.empty,
				stdinIsTerminal: Effect.succeed(world.tty),
				stdout: capture(out, "stdout"),
				stdoutIsTerminal: Effect.succeed(world.tty)
			})
			const fileSystem = Option.isSome(world.output)
				? yield* FileSystem.FileSystem
				: FileSystem.makeNoop({})
			const path = yield* Path.Path
			const context = yield* Layer.build(
				Layer.mergeAll(
					BaseUrl.layer(world.servers, PREFIX),
					Auth.layer(world.security, PREFIX, []),
					ConfigProvider.layer(ConfigProvider.fromEnvRecord(world.env)),
					Layer.succeed(FileSystem.FileSystem, fileSystem),
					Layer.succeed(Path.Path, path),
					stdio,
					TerminalCapabilities.layer.pipe(Layer.provide(stdio)),
					Layer.succeed(Terminal.Terminal, terminal),
					Input.stdinClaimLayer,
					Layer.effect(RunCredentials)(Ref.make(world.recorded)),
					Layer.succeed(Client.Transport, {
						certified: Option.none(),
						plain: { direct: client, environment: client }
					}),
					Layer.succeed(Output.ClientPolicy, { binName: "example", version: "1.2.3" }),
					Layer.succeed(
						Output.OutputPath,
						Option.map(world.output, (target) => path.join(target.dir, target.name))
					),
					Layer.succeed(
						Output.Force,
						Option.exists(world.output, (target) => target.force)
					),
					Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
					Layer.succeed(BaseUrl.serverSetting, world.server),
					Layer.succeed(BaseUrl.serverVariableSetting, []),
					Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
					Layer.succeed(Client.verboseSetting, world.verbose),
					Layer.succeed(Output.dryRunSetting, world.dryRun)
				)
			)
			const exit = yield* Effect.exit(
				world.request.pipe(
					Output.send(world.operation),
					Output.finalCatch([], { envPrefix: PREFIX }),
					Effect.provideContext(context)
				)
			)
			const sent: Sent = {
				exit,
				failure: Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none(),
				stdout: Arr.join(out, ""),
				stderr: Arr.join(err, ""),
				writes,
				requests,
				prompts: yield* Ref.get(prompts)
			}
			return sent
		})
	)
