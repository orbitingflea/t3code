import type { PreviewBrowserRelease } from "../preview/PreviewBrowser.ts";

// Full Chrome for Testing passes Cloudflare where chrome-headless-shell is blocked after one page.
// macOS keeps the shell: its app bundle holds symlinks the installer will not unpack.
// Pin from each chrome zip in known-good-versions-with-downloads.json, never below 156.0.8078.70.
const VERSION = "156.0.8078.80";
const ARCHIVES: Partial<Record<string, { readonly bytes: number; readonly sha256: string }>> = {
  linux64: {
    bytes: 201_329_937,
    sha256: "b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7",
  },
  "linux-arm64": {
    bytes: 200_722_708,
    sha256: "1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724",
  },
  win32: {
    bytes: 188_578_294,
    sha256: "191a656d22c7ebd345bf13c20f04100bd37ed35170e9070dc0ddfd425109ac66",
  },
  win64: {
    bytes: 208_152_768,
    sha256: "16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f",
  },
};

export const FULL_CHROME_PRODUCT = "chrome";

export const fullChromeRelease = (platform: string): PreviewBrowserRelease | null => {
  const archive = ARCHIVES[platform];
  return archive === undefined
    ? null
    : {
        version: VERSION,
        platform,
        product: FULL_CHROME_PRODUCT,
        executable: platform.startsWith("win") ? "chrome.exe" : "chrome",
        url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-${platform}.zip`,
        ...archive,
      };
};

export interface Brand {
  readonly brand: string;
  readonly version: string;
}

const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/**
 * Google Chrome's brand list for a major version, as Chromium's GenerateBrandVersionList builds
 * it: the GREASE brand and the order both follow from the major version.
 */
export const chromeBrands = (
  major: number,
  version: (brandVersion: string) => string,
): Array<Brand> => {
  const [grease, chromium, chrome] = BRAND_ORDERS[major % BRAND_ORDERS.length]!;
  const brands: Array<Brand> = [];
  brands[grease] = {
    brand: `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`,
    version: version(GREASE_VERSIONS[major % GREASE_VERSIONS.length]!),
  };
  brands[chromium] = { brand: "Chromium", version: version(String(major)) };
  brands[chrome] = { brand: "Google Chrome", version: version(String(major)) };
  return brands;
};

/** Libraries full Chrome links that chrome-headless-shell does not (libsmime3 comes with libnss3). */
export const FULL_CHROME_DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libcups2t64", "libcups2"],
  ["libpango-1.0-0"],
  ["libcairo2"],
];
