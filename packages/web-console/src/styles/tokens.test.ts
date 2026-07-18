/**
 * Guards for the design-token contract (WP-C1.4):
 *
 * 1. Components use tokens only — no hardcoded color values anywhere in
 *    src/ui (CSS Modules or TSX). Raw colors live in tokens.css alone.
 * 2. The two dark blocks in tokens.css (media-query and data-theme) must be
 *    identical — the file's documented invariant, since pure CSS cannot
 *    combine a media query with an attribute selector.
 * 3. Every token a dark block overrides exists in the light :root block.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "..", "ui");
const tokensCss = readFileSync(join(here, "tokens.css"), "utf8");

/**
 * #hex, rgb()/rgba(), hsl()/hsla(), and CSS named colors we'd reach for.
 * The lookarounds keep compound words like `white-space` legal.
 */
const RAW_COLOR =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![-\w])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple)(?![-\w])/;

describe("design-token contract", () => {
  it("src/ui contains no hardcoded color values (tokens only)", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(uiDir)) {
      if (!/\.(module\.css|tsx?)$/.test(name)) continue;
      const lines = readFileSync(join(uiDir, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (RAW_COLOR.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the two dark blocks in tokens.css identical", () => {
    expect(darkMediaBlock()).toEqual(darkAttributeBlock());
  });

  it("only overrides tokens in dark that the light :root declares", () => {
    const light = declarationNames(blockContent(/:root \{([\s\S]*?)\n\}/));
    for (const name of darkAttributeBlock()) {
      const token = name.split(":")[0] ?? "";
      if (!token.startsWith("--")) continue;
      expect(light, `dark-only token ${token}`).toContain(token);
    }
  });
});

function blockContent(re: RegExp): string {
  const match = tokensCss.match(re);
  if (!match?.[1]) throw new Error(`tokens.css: no match for ${re}`);
  return match[1];
}

/** Normalized declaration lines of the prefers-color-scheme dark block. */
function darkMediaBlock(): string[] {
  return normalize(
    blockContent(/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/),
  );
}

/** Normalized declaration lines of the [data-theme="dark"] block. */
function darkAttributeBlock(): string[] {
  return normalize(blockContent(/:root\[data-theme="dark"\] \{([^}]*)\}/));
}

function normalize(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("/*"));
}

function declarationNames(block: string): string[] {
  return normalize(block)
    .map((line) => line.split(":")[0] ?? "")
    .filter((name) => name.startsWith("--"));
}
