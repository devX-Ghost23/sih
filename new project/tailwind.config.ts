import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./store/**/*.{ts,tsx}",
    "./types/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0b0f14",
        surface: {
          DEFAULT: "#111821",
          elevated: "#182130",
        },
        border: {
          DEFAULT: "#243041",
          subtle: "#1a2432",
        },
        foreground: {
          DEFAULT: "#e6ebf2",
          secondary: "#a5b1c2",
          muted: "#6b788a",
        },
        accent: {
          DEFAULT: "#4a8bd4",
          hover: "#5d9ae0",
          muted: "#1d3350",
        },
        success: "#3da57a",
        warning: "#d19a3a",
        danger: "#d15b5e",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgba(0, 0, 0, 0.4), 0 4px 12px -2px rgba(0, 0, 0, 0.35)",
      },
    },
  },
  plugins: [],
};

export default config;
