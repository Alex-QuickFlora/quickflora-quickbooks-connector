/**
 * Adapter registry — how the edge-function wrappers resolve a product name
 * to its adapter. The core never imports this (core stays product-blind);
 * only the deployable wrappers do.
 */

import type { AdapterFactory } from "../core/contract.ts";
import { createFlorachainAdapter } from "./florachain/adapter.ts";
import { createFloricaAdapter } from "./florica/adapter.ts";
import { createEventaAdapter } from "./eventa/adapter.ts";

const REGISTRY: Record<string, AdapterFactory> = {
  florachain: createFlorachainAdapter,
  florica: createFloricaAdapter,
  eventa: createEventaAdapter,
  // quickflora-pos: read-only SQL Server source — see
  // adapters/quickflora-pos/MAPPING.md; no adapter until #1205 lands.
};

export function adapterFor(product: string): AdapterFactory {
  const factory = REGISTRY[product];
  if (!factory) {
    throw new Error(`No QBO adapter registered for product "${product}"`);
  }
  return factory;
}
