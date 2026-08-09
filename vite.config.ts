import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const base = "/flashcards/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        id: base,
        name: "暗記カード",
        short_name: "暗記",
        description: "SRS（間隔反復）で学習する個人用フラッシュカードアプリ",
        lang: "ja",
        display: "standalone",
        start_url: base,
        scope: base,
        theme_color: "#2b4a6f",
        background_color: "#f5f6f8",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
          { src: "apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        runtimeCaching: [],
      },
    }),
  ],
});
