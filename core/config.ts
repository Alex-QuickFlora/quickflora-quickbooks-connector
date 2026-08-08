/**
 * Push-config resolution (#1225–#1227): reads the product's
 * qb_connector_config row and returns the knobs the push paths need, with
 * defaults that preserve the pre-hardening behavior when the row (or the new
 * columns) is absent.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { PushOptions } from "./qbo-client.ts";

export interface PushConfig {
  depositMode: "direct" | "undeposited";
  closingDateMode: "warn" | "block" | "off";
  autoCreate: boolean;
  clearingCustomerName?: string;
}

export async function resolvePushConfig(
  supabase: SupabaseClient,
  product: string,
): Promise<PushConfig> {
  const { data } = await supabase
    .from("qb_connector_config")
    .select("deposit_mode, closing_date_mode, auto_create_entities, clearing_customer_name")
    .eq("product", product)
    .maybeSingle();
  return {
    depositMode: data?.deposit_mode === "undeposited" ? "undeposited" : "direct",
    closingDateMode: ["warn", "block", "off"].includes(data?.closing_date_mode)
      ? data.closing_date_mode
      : "warn",
    autoCreate: data?.auto_create_entities === "auto",
    clearingCustomerName: data?.clearing_customer_name ?? undefined,
  };
}

export function pushOptionsFrom(cfg: PushConfig, extra: Partial<PushOptions> = {}): PushOptions {
  return {
    closingDateMode: cfg.closingDateMode,
    autoCreate: cfg.autoCreate,
    clearingCustomerName: cfg.clearingCustomerName,
    ...extra,
  };
}
