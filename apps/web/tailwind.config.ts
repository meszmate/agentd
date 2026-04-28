import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1320px" },
    },
    extend: {
      colors: {
        // ── brae editorial palette ───────────────────────────────────
        cream: {
          DEFAULT: "#F5F1E8",
          50: "#FBF8F1",
          100: "#F5F1E8",
          200: "#EFE9D9",
          300: "#E8E1D3",
          400: "#D4CBB5",
        },
        ink: {
          50: "#FAFAF9",
          100: "#F1EFEC",
          200: "#E1DFDB",
          300: "#C5C2BC",
          400: "#8E8B83",
          500: "#5C5953",
          600: "#3F3D38",
          700: "#26241F",
          800: "#141310",
          900: "#0A0A0A",
        },
        vermilion: {
          50: "#FFF1EB",
          100: "#FFE0D3",
          200: "#FFC1A6",
          300: "#FF9A75",
          400: "#FF7544",
          500: "#FF5C28",
          600: "#E84416",
          700: "#C03511",
          800: "#8E2509",
          900: "#5A1604",
        },

        // ── shadcn semantic tokens (mapped per-mode in index.css) ────
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: "hsl(var(--success))",
        warn: "hsl(var(--warn))",
        info: "hsl(var(--info))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        display: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        sans: ['"Geist"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
      letterSpacing: {
        "tightest-2": "-0.04em",
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        edit: "0 1px 0 rgba(10, 10, 10, 0.06), 0 12px 30px -16px rgba(10, 10, 10, 0.2)",
        deep: "0 30px 80px -30px rgba(10, 10, 10, 0.35)",
      },
      backgroundImage: {
        noise:
          "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        rise: {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "fade-in": "fade-in 0.25s ease-out both",
        rise: "rise 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both",
        blink: "blink 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
