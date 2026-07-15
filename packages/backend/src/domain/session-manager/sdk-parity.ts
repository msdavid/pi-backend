/**
 * Compile-time Pi-SDK parity assertions (R1.4).
 *
 * This module contains NO runtime code. It exists so that a `@earendil-works/pi-coding-agent`
 * `^0.80.6` bump that changes the shape of a seam type breaks `tsc` HERE — loudly, at the
 * boundary — instead of silently, via an `as never` cast, at a call site.
 *
 * Two families of assertion:
 *
 * 1. The local structural `*Operations` shims (`operations/remote-operations.ts`) — the
 *    remote sandbox operations injected into Pi's `createXTool(cwd, { operations })`
 *    factories. Each must stay **assignable to** its SDK counterpart (or the injection
 *    stops type-checking). Where the two are exactly equal we also assert the reverse, so
 *    a widening/renaming on the SDK side is caught immediately.
 * 2. The material's `customTools` element type must remain the SDK's real `ToolDefinition`
 *    (not a shim), and the local `InlineExtensionFactory` shim must stay assignable to the
 *    SDK `ExtensionFactory`.
 *
 * These previously hid behind `as never` casts in `materialize.ts`; they are now enforced.
 */

import type {
  BashOperations as SdkBashOperations,
  EditOperations as SdkEditOperations,
  ExtensionFactory as SdkExtensionFactory,
  FindOperations as SdkFindOperations,
  GrepOperations as SdkGrepOperations,
  LsOperations as SdkLsOperations,
  ReadOperations as SdkReadOperations,
  ToolDefinition as SdkToolDefinition,
  WriteOperations as SdkWriteOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "./operations/remote-operations.js";
import type { InlineExtensionFactory, ResolvedAgentMaterial } from "./types.js";

/** Compiles only when `T` is assignable to `U`; errors on the constraint otherwise. */
type AssertAssignable<T extends U, U> = T;

// --- *Operations shims: local -> SDK (required for injection to type-check) ---
type _bashToSdk = AssertAssignable<BashOperations, SdkBashOperations>;
type _readToSdk = AssertAssignable<ReadOperations, SdkReadOperations>;
type _writeToSdk = AssertAssignable<WriteOperations, SdkWriteOperations>;
type _editToSdk = AssertAssignable<EditOperations, SdkEditOperations>;
type _findToSdk = AssertAssignable<FindOperations, SdkFindOperations>;
type _grepToSdk = AssertAssignable<GrepOperations, SdkGrepOperations>;
type _lsToSdk = AssertAssignable<LsOperations, SdkLsOperations>;

// --- *Operations shims: SDK -> local (exact-equal shapes; catches SDK drift) ---
// (Ls is intentionally one-directional: the SDK permits sync stat/readdir returns the
//  remote implementation never uses, so SDK LsOperations is broader than the local shim.)
type _bashFromSdk = AssertAssignable<SdkBashOperations, BashOperations>;
type _readFromSdk = AssertAssignable<SdkReadOperations, ReadOperations>;
type _writeFromSdk = AssertAssignable<SdkWriteOperations, WriteOperations>;
type _editFromSdk = AssertAssignable<SdkEditOperations, EditOperations>;
type _findFromSdk = AssertAssignable<SdkFindOperations, FindOperations>;
type _grepFromSdk = AssertAssignable<SdkGrepOperations, GrepOperations>;

// --- customTools element type IS the SDK ToolDefinition (no shim on the hot path) ---
type MaterialTool = NonNullable<ResolvedAgentMaterial["customTools"]>[number];
type _toolIsSdk = AssertAssignable<MaterialTool, SdkToolDefinition>;
type _sdkIsTool = AssertAssignable<SdkToolDefinition, MaterialTool>;

// --- inline-extension shim -> SDK ExtensionFactory ---
type _extToSdk = AssertAssignable<InlineExtensionFactory, SdkExtensionFactory>;

/** Referenced so `noUnusedLocals` keeps every assertion above live. */
export type SdkParityAssertions = [
  _bashToSdk,
  _readToSdk,
  _writeToSdk,
  _editToSdk,
  _findToSdk,
  _grepToSdk,
  _lsToSdk,
  _bashFromSdk,
  _readFromSdk,
  _writeFromSdk,
  _editFromSdk,
  _findFromSdk,
  _grepFromSdk,
  _toolIsSdk,
  _sdkIsTool,
  _extToSdk,
];
