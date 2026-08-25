import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "./api";
import { setAuthToken } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  token: string | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = "flashseat.auth";

function loadStored(): { user: User; token: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setUser(stored.user);
      setToken(stored.token);
      setAuthToken(stored.token);
    }
    setReady(true);
  }, []);

  function persist(user: User, token: string) {
    setUser(user);
    setToken(token);
    setAuthToken(token);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
  }

  async function login(email: string, password: string) {
    const result = await api.login(email, password);
    persist(result.user, result.token);
  }

  async function register(email: string, password: string) {
    const result = await api.register(email, password);
    persist(result.user, result.token);
  }

  function logout() {
    setUser(null);
    setToken(null);
    setAuthToken(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <AuthContext.Provider value={{ user, token, ready, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
