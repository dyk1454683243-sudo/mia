import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${dir}client`,
  publicDir: false,
  build: {
    outDir: `${dir}dist/client`,
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: `${dir}client/index.html`,
        table: `${dir}client/table.html`,
      },
    },
  },
});
