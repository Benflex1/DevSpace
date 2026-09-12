import path from "node:path";
import type { NextConfig } from "next";

interface WebpackConfiguration {
  readonly externals: unknown[];
  readonly resolve: { alias?: Record<string, string>; extensionAlias?: Record<string, string[]> };
}

function developmentOrigins(): string[] {
  if (process.env.NODE_ENV === "production") return [];
  const configured = process.env.DEVSPACE_ALLOWED_DEV_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const appOrigin = process.env.DEVSPACE_APP_ORIGIN;
  if (appOrigin !== undefined) {
    try { configured.push(new URL(appOrigin).hostname); } catch { /* Web runtime config reports the invalid origin. */ }
  }
  return [...new Set(configured)];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: developmentOrigins(),
  serverExternalPackages: ["better-sqlite3", "@devspace/database"],
  webpack(config: WebpackConfiguration) {
    config.externals.push({ "@devspace/database": "commonjs @devspace/database" });
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"]
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      "monaco-editor/esm": path.resolve(process.cwd(), "node_modules/monaco-editor/esm")
    };
    return config;
  },
  headers() {
    return Promise.resolve([{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
    }]);
  }
};

export default nextConfig;
