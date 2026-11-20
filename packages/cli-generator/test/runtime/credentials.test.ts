/**
 * A generated CLI sends exactly the credentials its operation's security names, to exactly the origins that may carry
 * them, and never shows one. Each scheme's credential is read once, from its file flag (a path, or `-` under the one
 * stdin claim), else its variable, else the TTY prompt when both streams are terminals and stdin is free; the first
 * alternative whose every scheme has one is sent, `{}` only when none does, and a chosen deprecated scheme is named
 * once. The attach transform strips every managed credential and writes the configured ones only on a bound origin
 * (`--allow-credentials-for-base-url` adding an operator's base, never a server's or a redirect's), refusing a value no
 * header or cookie can carry, naming the scheme and never the value. A plaintext http base the flag let credentials
 * reach is warned once, unless its host is loopback. `send` writes a deprecated operation's notice before its request,
 * one notice when it withholds a token from an unbound base, and scrubs every credential an error body echoes. AUTH
 * help marks a deprecated scheme.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	actualAttached,
	actualAuth,
	actualCalled,
	actualWarned,
	type AuthFeature,
	authArms,
	authFeatures,
	authHelps,
	type CallFeature,
	callArms,
	callFeatures,
	calls,
	type ChoiceFeature,
	choiceFeatures,
	evaluated,
	expectedAttached,
	expectedAuth,
	expectedCalled,
	expectedChoice,
	expectedSettings,
	expectedWarned,
	type PlacementFeature,
	placementFeatures,
	placements,
	type PlaintextFeature,
	plaintextArms,
	plaintextFeatures,
	plaintexts,
	secretsOf,
	settingsRead,
	worlds
} from "#test/runtime/credentials.fixtures.ts"

/**
 * `Auth.evaluate` settles every drawn world as the run-time choice model does, prompting exactly as often, naming a
 * chosen deprecated scheme once, and rendering no credential. It replaces 30 example cases (auth.test.ts's credential
 * sources and requirement evaluation, auth-prompt.test.ts, deprecated-scheme.test.ts's notices); its budget is that
 * count, 30 drawn worlds, and up to 48 steered while a situation is unreached.
 */
export const credentialChoice = property.explore(
	aimed(worlds.space, [
		["the prompt answered", worlds.prompted],
		["a quit prompt", worlds.quit],
		["an empty answer", worlds.emptyAnswer],
		["a variable override", worlds.override],
		["an AND alternative", worlds.andAlternative],
		["a credential read from stdin", worlds.fromStdin],
		["an empty file refused", worlds.emptyFile],
		["an unreadable file refused", worlds.unreadableFile],
		["a file not UTF-8 refused", worlds.notUtf8File],
		["an alternative not all configured skipped", worlds.skippedAlternative],
		["no requirement, anonymous", worlds.noRequirement],
		["a stdin file before the prompt", worlds.stdinBeforePrompt],
		["two stdin readers refused", worlds.twoStdin],
		["stdin held by the body", worlds.bodyHoldsStdin],
		["a deprecated scheme chosen", worlds.deprecatedChosen],
		["the file beats the variable", worlds.fileBeatsEnv]
	]),
	{
		needs: {},
		situations: [
			"the first qualifying alternative",
			"an alternative not all configured skipped",
			"an AND alternative",
			"anonymous allowed",
			"no requirement, anonymous",
			"a variable override",
			"the file beats the variable",
			"a credential read from stdin",
			"an empty variable unset",
			"an empty file refused",
			"an unreadable file refused",
			"a file not UTF-8 refused",
			"two stdin readers refused",
			"stdin held by the body",
			"an undeclared scheme",
			"the prompt answered",
			"the prompt skipped off a TTY",
			"an empty answer",
			"a quit prompt",
			"a stdin file before the prompt",
			"a deprecated scheme chosen",
			"CredentialMissing"
		] satisfies ReadonlyArray<Reached<ChoiceFeature>>,
		check: (_, c: Case<ChoiceFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(choiceFeatures(drawn))
				const run = yield* evaluated(drawn)
				const settings = yield* settingsRead(drawn)
				assert.deepEqual(run.chosen, expectedChoice(drawn))
				assert.deepEqual(
					Arr.filter(secretsOf(drawn), (secret) => Str.includes(secret)(run.rendered)),
					[]
				)
				assert.deepEqual<ReturnType<typeof expectedSettings>>(settings, expectedSettings(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "design 6.5's run-time choice: file flag over variable over prompt, first full alternative, then anonymous, then CredentialMissing"
		},
		kept: [],
		budget: { runs: 30, steered: 48 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "\t\t\t\tconfigured.push([scheme, found])",
				replacement: "\t\t\t\tconfigured.push([found])",
				why: "The prompt phase drops each scheme's name from what it resolved, so a prompted alternative never fills; the property fails (CATCH's evidence, mutant 0e3ad0d2d5)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: '\t\t\tonSuccess: Option.filter((value) => Redacted.value(value) !== "")',
				replacement: "\t\t\tonSuccess: Option.filter((value) => false)",
				why: "No environment variable is ever read as a credential; the property fails (CATCH's evidence, mutant c68a3b9b56)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					"if (credentials.length === alternative.length) {\n\t\t\t\treturn Option.some(credentials)\n\t\t\t}",
				replacement: "{}",
				why: "No fully configured alternative is ever chosen; the property fails (CATCH's evidence, mutant 9767cfe1a5)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "\t\t\tif (credentials.length === alternative.length) {",
				replacement: "\t\t\tif (credentials.length !== alternative.length) {",
				why: "An alternative is chosen exactly when some scheme of it is unconfigured; the property fails (CATCH's evidence, mutant b83ea22735)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					"\trequirement.length === 0 || Arr.some(requirement, (alternative) => alternative.length === 0)",
				replacement:
					"\trequirement.length === 1 || Arr.some(requirement, (alternative) => alternative.length === 0)",
				why: "No requirement at all stops being anonymous, and a one-alternative requirement becomes anonymous; the property fails (CATCH's evidence, mutant cc0dd2c6f2)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					"\trequirement.length === 0 || Arr.some(requirement, (alternative) => alternative.length === 0)",
				replacement: "\trequirement.length === 0 || Arr.some(requirement, (alternative) => true)",
				why: "Any alternative allows anonymous access, so a requirement nothing satisfies sends no credential instead of prompting or failing; the property fails (CATCH's evidence, mutant 696bf6361b)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					"requirement.length === 0 || Arr.some(requirement, (alternative) => alternative.length === 0)",
				replacement: "false",
				why: "No requirement is ever anonymous, so an operation with no security fails CredentialMissing; the property fails (CATCH's evidence, mutant 90baf745e0)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "\t\t\tif (alternative.length === 0) {",
				replacement: "\t\t\tif (alternative.length === 1) {",
				why: "A one-scheme alternative is skipped as if it were `{}`; the property fails (CATCH's evidence, mutant 5fd822da4d)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "\t\t\tif (alternative.length === 0) {",
				replacement: "\t\t\tif (alternative.length !== 0) {",
				why: "Every credentialed alternative is skipped; the property fails (CATCH's evidence, mutant b73ea094d9)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "if (Option.isNone(credential)) {\n\t\t\t\t\tbreak\n\t\t\t\t}",
				replacement: "{}",
				why: "An alternative goes on resolving its later schemes after one has no credential, reading their files and stdin out of turn; the property fails (CATCH's evidence, mutant ea5c26878e)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "each.id === name",
				replacement: "false",
				why: "A scheme's file flag is never found, so a credential file is never read; the property fails (CATCH's evidence, mutant 8c07a3d8ff)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: `Flag.String(name).pipe(\n\t\t\tFlag.withMetavar("path|-"),\n\t\t\tFlag.withDescription(\n\t\t\t\t\`Read the \${scheme} credential from <path>, or from stdin when <path> is -\`\n\t\t\t),\n\t\t\tFlag.optional\n\t\t)`,
				replacement: `Flag.String(name).pipe(Flag.withMetavar("path|-"), Flag.withDescription(\n\t\t\t\t\`Read the \${scheme} credential from <path>, or from stdin when <path> is -\`\n\t\t\t))`,
				why: "A scheme's file setting is required, not optional, so a run that does not give it fails to parse; the property fails (CATCH's evidence, mutant ee5060f3d1)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: '\tpath === "-"\n\t\t? Effect.service(StdinClaim)',
				replacement: '\tpath !== "-"\n\t\t? Effect.service(StdinClaim)',
				why: "`-` is opened as a file and a credential file path reads stdin; the property fails (CATCH's evidence, mutant fada6f4a7d)."
			}
		]
	}
)

/**
 * `Auth.credentialOrigins` and `Auth.attach` place every drawn credential set on every drawn request exactly as the
 * placement model does. It replaces 30 example cases (auth.test.ts's attach and origin cases, auth-token.test.ts's
 * malformed tokens, serialize-cookie-request.test.ts's cookie strip); its budget is that count, 30 drawn requests, and
 * up to 40 steered while a situation is unreached.
 */
export const credentialPlacement = property.explore(
	aimed(placements.space, [
		["a managed cookie pair replaced", placements.cookieStrip],
		["the gate widened to the operator base", placements.widened],
		["a cookie name refused", placements.oddCookie],
		["a basic credential refused", placements.basicRefused],
		["a lone surrogate refused", placements.loneSurrogate],
		["http basic", placements.schemesOnBound],
		["a bearer token", placements.schemesOnBound],
		["an origin matched by origin, not case or port", placements.upperCase],
		["a header value refused", placements.headerRefused],
		["the gate ignores a server base", placements.serverBase],
		["a sibling host carries nothing", placements.sibling]
	]),
	{
		needs: {},
		situations: [
			"an apiKey header",
			"an apiKey query pair",
			"an apiKey cookie after kept cookies",
			"a managed cookie pair replaced",
			"http basic",
			"a bearer token",
			"an oauth2 or OIDC token",
			"an unbound origin stripped",
			"a managed query name in the url stripped",
			"an origin matched by origin, not case or port",
			"a sibling host carries nothing",
			"an unparseable url carries nothing",
			"a header value refused",
			"a cookie value refused",
			"a cookie name refused",
			"a basic credential refused",
			"a lone surrogate refused",
			"a bad value unchecked off origin",
			"the gate widened to the operator base",
			"the gate ignores a server base"
		] satisfies ReadonlyArray<Reached<PlacementFeature>>,
		check: (_, c: Case<PlacementFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(placementFeatures(drawn))
				const attached = yield* actualAttached(drawn)
				assert.deepEqual(attached, expectedAttached(drawn))
			}),
		oracle: {
			kind: "second-implementation",
			name: "a credential placement model: strip every managed name, then write each credential on a bound origin, refusing what no header or cookie carries"
		},
		kept: [],
		budget: { runs: 30, steered: 40 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: '\t\treturn definition.scheme === "bearer"',
				replacement: '\t\treturn definition.scheme !== "bearer"',
				why: "http bearer is sent as basic and basic as bearer; the property fails (CATCH's evidence, mutant 07371ae0e9)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: '\tif (definition.kind === "http") {',
				replacement: '\tif (definition.kind !== "http") {',
				why: "An http scheme is written as an apiKey and the token schemes' path is skipped; the property fails (CATCH's evidence, mutant 0e3725e566)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'if (loneSurrogate.test(value)) {\n\t\t\t\treturn refuse(scheme, "has a lone surrogate")\n\t\t\t}',
				replacement: "{}",
				why: "A basic credential with a lone surrogate is sent; the property fails (CATCH's evidence, mutant 25609c9162)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "headerValueBreaks(value) || value !== Str.trim(value)",
				replacement: "value !== Str.trim(value)",
				why: "A header credential holding a CR, LF, NUL or a code point above U+00FF is sent; the property fails (CATCH's evidence, mutant 6e0a72ce39)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "headerValueBreaks(value) || value !== Str.trim(value)",
				replacement: "true",
				why: "Every header credential is refused; the property fails (CATCH's evidence, mutant f6056a343f)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "!cookieNames.has(cookieName(pair))",
				replacement: "false",
				why: "Every cookie pair is stripped, so an unmanaged cookie never reaches the server; the property fails (CATCH's evidence, mutant f7ce739c1a)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'[\n\t\t...apiKeyNames(table, "header"),\n\t\t...(hasAuthorizationScheme(table) ? ["authorization"] : [])\n\t]',
				replacement: '[...(hasAuthorizationScheme(table) ? ["authorization"] : [])]',
				why: "A stale apiKey header survives the strip; the property fails (CATCH's evidence, mutant aef0e8ccf2)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: `[...cookiePairs(existing), \`\${name}=\${value}\`]`,
				replacement: "[...cookiePairs(existing)]",
				why: "An apiKey cookie is never appended; the property fails (CATCH's evidence, mutant db70021100)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'\t\t\tdefinition.kind === "apiKey" && definition.in === place ? [definition.name] : []',
				replacement:
					'\t\t\tdefinition.kind === "apiKey" && definition.in !== place ? [definition.name] : []',
				why: "The strip takes the other places' apiKey names, so a managed query or cookie name survives; the property fails (CATCH's evidence, mutant fa69cd11ce)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "Option.isSome(origin) && allowed.has(origin.value)",
				replacement: "Option.isSome(origin)",
				why: "Every parseable origin counts as bound, so a credential reaches any host; the property fails (CATCH's evidence, mutant 9b96950aa3)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: 'gate.provenance === "operator" && gate.allowUnboundBase',
				replacement: 'gate.provenance === "operator"',
				why: "An operator base widens the credential origins without the flag; the property fails (CATCH's evidence, mutant 9c2535407c)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'\tconst base = gate.provenance === "operator" && gate.allowUnboundBase ? [gate.baseOrigin] : []',
				replacement:
					'\tconst base = gate.provenance !== "operator" && gate.allowUnboundBase ? [gate.baseOrigin] : []',
				why: "The flag widens the origins to a server base and never to the operator's; the property fails (CATCH's evidence, mutant d6015a4f1f)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'\t\tonSuccess: ({ origin }) => (origin === "null" ? Option.none() : Option.some(origin))',
				replacement:
					'\t\tonSuccess: ({ origin }) => (origin !== "null" ? Option.none() : Option.some(origin))',
				why: "Every real origin reads as unparsed, so no credential is ever attached; the property fails (CATCH's evidence, mutant 739be366bd)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'if (!cookieNameToken.test(definition.name)) {\n\t\treturn refuse(scheme, "has a cookie name that is not a token")\n\t}',
				replacement: "{}",
				why: "An apiKey cookie whose name is not a token is sent; the property fails (CATCH's evidence, mutant a4f96519a2)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "!cookieNameToken.test(definition.name)",
				replacement: "cookieNameToken.test(definition.name)",
				why: "Every token cookie name is refused, so a cookie credential is never sent; the property fails (EOCG-RT-SERIALIZE's handoff from serialize-cookie-request.test.ts, mutant 038ff9c7c3)."
			}
		]
	}
)

/**
 * Every drawn base URL's host is loopback exactly as design 6.5 says, and the plaintext warning is printed exactly when
 * the model says, naming the host and never its userinfo. It replaces 15 example cases (auth-plain-http.test.ts,
 * auth.test.ts's loopback forms); its budget is that count, 15 drawn bases, and up to 24 steered while a situation is
 * unreached.
 */
export const plaintextHosts = property.explore(
	aimed(plaintexts, [
		["an IPv4-mapped loopback", plaintextArms.mapped],
		["two trailing dots", plaintextArms.twoDots],
		["userinfo left out", plaintextArms.userinfo],
		["https never warned", plaintextArms.https],
		["IPv6 loopback", plaintextArms.ipv6],
		["a dotted 127/8 address", plaintextArms.dotted],
		["a trailing dot", plaintextArms.trailingDot],
		["no warning without the flag", plaintextArms.noFlag]
	]),
	{
		needs: {},
		situations: [
			"a dotted 127/8 address",
			"a 127/8 address in another notation",
			"IPv6 loopback",
			"an IPv4-mapped loopback",
			"a localhost name",
			"a trailing dot",
			"two trailing dots",
			"a name only holding localhost",
			"a public address warned",
			"userinfo left out",
			"https never warned",
			"no warning without the flag"
		] satisfies ReadonlyArray<Reached<PlaintextFeature>>,
		check: (_, c: Case<PlaintextFeature>) => (drawn) =>
			Effect.sync(() => {
				c.noteAll(plaintextFeatures(drawn))
				assert.deepEqual(actualWarned(drawn), expectedWarned(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "design 6.5's loopback hosts over every IPv4 notation, IPv6 form and localhost name; the R3 warning line"
		},
		kept: [],
		budget: { runs: 15, steered: 24 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: "!isLoopbackHost(hostname)",
				replacement: "isLoopbackHost(hostname)",
				why: "The plaintext warning goes to loopback hosts and never to public ones; the property fails (CATCH's evidence, mutant 106f64b584)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original: '\t\t\tprotocol === "http:" && !isLoopbackHost(hostname)',
				replacement: '\t\t\tprotocol !== "http:" && !isLoopbackHost(hostname)',
				why: "The plaintext warning goes to https bases and never to http ones; the property fails (CATCH's evidence, mutant fb8865481b)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					'name === "localhost" ||\n\t\tStr.endsWith(".localhost")(name) ||\n\t\tname === "[::1]" ||\n\t\tdottedLoopback.test(name) ||\n\t\tmappedLoopback.test(name)',
				replacement:
					'name === "localhost" || Str.endsWith(".localhost")(name) || name === "[::1]" || dottedLoopback.test(name)',
				why: "An IPv4-mapped 127/8 address is no longer loopback; the property fails (CATCH's evidence, mutant c3a5eacbbd)."
			}
		]
	}
)

/**
 * `Output.send` sends every drawn call as the model says: the chosen token on every hop of a bound origin and none
 * elsewhere, the deprecation notice before the request, one withheld notice, and every echoed credential scrubbed. It
 * replaces 18 example cases (auth-token.test.ts's sends, deprecated-operation.test.ts, input-secret-file.test.ts's
 * echo before send); its budget is that count, 18 drawn calls, and up to 26 steered while a situation is unreached.
 */
export const sentCredentials = property.explore(
	aimed(calls, [
		["a token withheld from an unbound base, one notice", callArms.withheld],
		["an echoed credential scrubbed", callArms.echoed],
		["a same-origin redirect keeps the token", callArms.sameOrigin],
		["the allow flag sends to an unbound base", callArms.allowed],
		["a redirect off origin strips the token", callArms.away],
		["an alternative falls through", callArms.fallsThrough]
	]),
	{
		needs: {},
		situations: [
			"an oauth2 token as Bearer",
			"an OIDC token as Bearer",
			"an apiKey header sent",
			"a same-origin redirect keeps the token",
			"a redirect off origin strips the token",
			"a token withheld from an unbound base, one notice",
			"the allow flag sends to an unbound base",
			"an alternative falls through",
			"CredentialMissing before any request",
			"a deprecated operation named by its id",
			"a deprecated operation named by method and path",
			"deprecated: false writes nothing",
			"an echoed credential scrubbed"
		] satisfies ReadonlyArray<Reached<CallFeature>>,
		check: (_, c: Case<CallFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(callFeatures(drawn))
				const called = yield* actualCalled(drawn)
				assert.deepEqual(called, expectedCalled(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "send's contract: the choice, the credential gate per hop, the notices before the request, a scrubbed error body"
		},
		kept: [],
		budget: { runs: 18, steered: 26 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
				original: '\treturn at === -1 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)]',
				replacement:
					'\treturn at !== -1 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)]',
				why: "A request target with no query is split as all query, so the request goes to the base alone; the property fails (CATCH's evidence, mutant 45b047a1eb)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
				original: "\t\t\tif (index % 2 === 0) {",
				replacement: "\t\t\tif (index % 2 !== 0) {",
				why: "A path template's literal and parameter parts swap, so the request path is wrong; the property fails (CATCH's evidence, mutant 55d24c7b8a)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
				original:
					'{\n\tconst decoded = Str.replaceAll(encodedDot, ".")(segment)\n\n\treturn decoded === "." || decoded === ".."\n}',
				replacement: "{ return true }",
				why: "Every path parameter value reads as a dot segment and is refused; the property fails (CATCH's evidence, mutant e5388547ef)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
				original:
					"\trequirement.length === 0 || Arr.some(requirement, (alternative) => alternative.length === 0)",
				replacement:
					"\trequirement.length === (-1) || Arr.some(requirement, (alternative) => alternative.length === 0)",
				why: "No requirement at all stops being anonymous, so an operation without security fails CredentialMissing; the property fails (CATCH's evidence, mutant 599095b292)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
				original: "if (meta.deprecated === true) {",
				replacement: "if (meta.deprecated !== undefined) {",
				why: "An operation marked `deprecated: false` writes the deprecation notice; the property fails."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
				original: "if (headersWithheld || certificateWithheld) {",
				replacement: "if (certificateWithheld) {",
				why: "A token withheld from an unbound base writes no notice; the property fails."
			}
		]
	}
)

/**
 * The AUTH help line lists every alternative in order, marking each deprecated scheme and only those. It replaces 2
 * example cases (deprecated-scheme.test.ts's help); its budget is 4 drawn operations, its floor one, and up to 12
 * steered while a situation is unreached.
 */
export const authHelp = property.explore(
	aimed(authHelps, [
		["a deprecated scheme marked", authArms.deprecated],
		["a current scheme unmarked", authArms.current],
		["an anonymous alternative", authArms.anonymous],
		["an undefined scheme named", authArms.undefinedName],
		["no alternatives", authArms.none]
	]),
	{
		needs: {},
		situations: [
			"a deprecated scheme marked",
			"a current scheme unmarked",
			"an anonymous alternative",
			"an undefined scheme named",
			"no alternatives"
		] satisfies ReadonlyArray<Reached<AuthFeature>>,
		check: (_, c: Case<AuthFeature>) => (drawn) =>
			Effect.sync(() => {
				c.noteAll(authFeatures(drawn))
				assert.equal(actualAuth(drawn), expectedAuth(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "the AUTH line: alternatives joined by or, uses by and, `no authentication` for `{}`, `[deprecated]` on a deprecated scheme"
		},
		kept: [],
		budget: { runs: 4, steered: 12 },
		kills: [
			{
				file: "packages/cli-generator/src/emit/help.ts",
				original: "\t\t\talternative.uses.length === 0",
				replacement: "\t\t\talternative.uses.length !== 0",
				why: "An anonymous alternative is shown as its uses and a scheme alternative as no authentication; the property fails (CATCH's evidence, mutant 26864832de)."
			},
			{
				file: "packages/cli-generator/src/model/brands.ts",
				original: '(method: string) => method !== "CONNECT"',
				replacement: '(method: string) => method === "CONNECT"',
				why: "The CONNECT check of a method token is inverted, so GET is refused and the operation never decodes; the property fails (CATCH's evidence, mutant e9d5044ef1)."
			}
		]
	}
)
