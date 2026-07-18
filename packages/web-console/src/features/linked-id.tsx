/**
 * A resource id rendered per console-spec §7.6: monospaced, one-click
 * copyable, and a deep link to its detail route. ONE parameterized
 * composition of the router `<Link>` into the router-agnostic `CopyableId`
 * (src/ui) for every id family — sessions, vaults, environments, memory
 * stores — replacing the former per-family wrapper files. Lives at the
 * features root because it is router-aware (src/ui stays router-agnostic;
 * see the CopyableId row in src/ui/README.md) and shared across features.
 */
import { Link } from "@tanstack/react-router";
import type {
  AbsoluteToPath,
  LinkProps,
  RegisteredRouter,
} from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { CopyableId } from "../ui/copyable-id.js";
import styles from "./linked-id.module.css";

/**
 * Every absolute path of the registered route tree (with `TFrom = "/"`,
 * `AbsoluteToPath` reduces to exactly that union — per @tanstack/router-core
 * link.d.ts). Constraining `TTo` to it makes an unregistered `to` a type
 * error at the call site; the `$param`-derived `params` check then rides on
 * the literal, same as a literal `<Link>`.
 */
type ConsolePath = AbsoluteToPath<RegisteredRouter, "/">;

export type LinkedIdProps<TTo extends ConsolePath> = {
  /** The full id; always copied whole, truncated only visually. */
  id: string;
  /** Max rendered characters before middle-truncation. */
  maxLength?: number;
} & Pick<LinkProps<"a", RegisteredRouter, string, TTo>, "to" | "params">;

export function LinkedId<const TTo extends ConsolePath>({
  id,
  maxLength,
  to,
  params,
}: LinkedIdProps<TTo>) {
  // The pair is already validated against the route tree by LinkedIdProps;
  // Link's own inference cannot re-correlate a pre-typed `to`/`params` pair
  // through the generic seam, so the checked pair is asserted here.
  const link = { to, params } as ComponentProps<typeof Link>;
  return (
    <CopyableId
      id={id}
      maxLength={maxLength}
      link={(code) => (
        <Link
          {...link}
          className={styles.link}
          // Inside an interactive table row the link IS the row's action;
          // don't double-fire the row activation.
          onClick={(event) => event.stopPropagation()}
        >
          {code}
        </Link>
      )}
    />
  );
}
