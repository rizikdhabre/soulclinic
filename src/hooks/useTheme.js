"use client";

import { useEffect, useState } from "react";

export function useTheme() {
  const [theme, setTheme] = useState("dark"); // default dark

  useEffect(() => {
    const saved = localStorage.getItem("theme") || "dark";
    setTheme(saved);

    if (saved === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);

    if (next === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  return { theme, toggleTheme };
}
