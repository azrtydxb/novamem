/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
      colors: {
        // Semantic tokens — referenced everywhere instead of raw colors so
        // the theme is one place to tune.
        bg: {
          DEFAULT: "#0b0d12",
          panel: "#11141b",
          subtle: "#161a23",
          hover: "#1c2230",
        },
        border: {
          DEFAULT: "#222836",
          strong: "#2c3344",
        },
        text: {
          DEFAULT: "#e8ebf1",
          muted: "#8b94a6",
          subtle: "#5b6373",
        },
        accent: {
          DEFAULT: "#7c9cff",
          hover: "#8fb0ff",
          subtle: "#1a2340",
        },
        success: { DEFAULT: "#4ade80", subtle: "#0e2a1a" },
        warning: { DEFAULT: "#fbbf24", subtle: "#2a1f0a" },
        danger: { DEFAULT: "#f87171", subtle: "#2a1212" },
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "12px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.03), 0 4px 12px rgba(0,0,0,0.25)",
        modal: "0 20px 50px rgba(0,0,0,0.6)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "scale-in": "scale-in 120ms ease-out",
        "slide-in-right": "slide-in-right 200ms ease-out",
      },
    },
  },
  plugins: [],
};
