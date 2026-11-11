#!/usr/bin/env node
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { main } from "#main.ts"

NodeRuntime.runMain(
	main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest)))
)
