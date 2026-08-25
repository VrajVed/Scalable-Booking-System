import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/events";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password);
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-6 py-16">
      <h1 className="text-2xl font-bold text-center mb-8">FlashSeat</h1>
      <div className="flex gap-1 bg-surface-2 p-1 rounded-xl mb-6">
        <button
          type="button"
          onClick={() => setMode("login")}
          className={`flex-1 text-center text-sm font-semibold py-2 rounded-lg ${
            mode === "login" ? "bg-surface text-ink shadow-sm" : "text-text-dim"
          }`}
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => setMode("register")}
          className={`flex-1 text-center text-sm font-semibold py-2 rounded-lg ${
            mode === "register" ? "bg-surface text-ink shadow-sm" : "text-text-dim"
          }`}
        >
          Register
        </button>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-xs text-text-dim">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border border-line-strong rounded-lg px-3 py-2.5 text-sm bg-paper"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-xs text-text-dim">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border border-line-strong rounded-lg px-3 py-2.5 text-sm bg-paper"
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-accent-ink font-semibold text-sm rounded-lg py-2.5 mt-1 disabled:opacity-60"
        >
          {submitting ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
      <p className="text-center text-xs text-text-dim mt-6">
        <Link to="/" className="hover:text-text">
          Back to home
        </Link>
      </p>
    </div>
  );
}
