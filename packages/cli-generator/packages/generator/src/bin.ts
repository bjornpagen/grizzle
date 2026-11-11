#!/usr/bin/env node
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { main } from "#main.ts"

NodeRuntime.runMain(main.pipe(Effect.provide([NodeServices.layer, NodeCrypto.layerDigest])))
