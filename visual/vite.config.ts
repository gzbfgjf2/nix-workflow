import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { apiPlugin } from "./server/api.mjs";

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
});
