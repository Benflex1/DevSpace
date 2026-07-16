import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: process.env.DEVSPACE_DRIZZLE_OUT ?? "./src/migrations",
  breakpoints: true
});
