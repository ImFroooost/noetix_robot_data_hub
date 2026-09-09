import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "hub-theme";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}>({
  theme: "dark",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark";
}

export function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document !== "undefined" && isTheme(document.documentElement.dataset.theme)) {
      return document.documentElement.dataset.theme;
    }
    return "dark";
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeState,
      toggleTheme: () => setThemeState((current) => (current === "dark" ? "light" : "dark")),
    }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="外观">
      <button
        type="button"
        className={theme === "light" ? "is-active" : undefined}
        aria-pressed={theme === "light"}
        onClick={() => setTheme("light")}
      >
        <SunIcon />
        白天
      </button>
      <button
        type="button"
        className={theme === "dark" ? "is-active" : undefined}
        aria-pressed={theme === "dark"}
        onClick={() => setTheme("dark")}
      >
        <MoonIcon />
        夜间
      </button>
    </div>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="currentColor" />
      <path
        d="M12 2v2.2M12 19.8V22M4.22 4.22l1.56 1.56M18.22 18.22l1.56 1.56M2 12h2.2M19.8 12H22M4.22 19.78l1.56-1.56M18.22 5.78l1.56-1.56"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M15.4 3.2A8.8 8.8 0 1 0 20.8 15 7.1 7.1 0 0 1 15.4 3.2z"
        fill="currentColor"
      />
    </svg>
  );
}
