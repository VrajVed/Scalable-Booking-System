import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function NavBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <header className="border-b border-line">
      <div className="max-w-5xl mx-auto flex items-center gap-6 px-6 py-4">
        <Link to="/" className="font-display font-extrabold text-lg tracking-tight text-ink flex items-baseline gap-1.5">
          FlashSeat
          <span className="text-accent text-xl leading-none">●</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm text-text-dim">
          <Link to="/events" className="hover:text-text">Browse</Link>
          {user && (
            <Link to="/bookings" className="hover:text-text">My bookings</Link>
          )}
        </nav>
        <div className="flex-1" />
        {user ? (
          <button
            type="button"
            onClick={handleLogout}
            className="text-sm font-semibold text-text-dim hover:text-text"
          >
            Log out
          </button>
        ) : (
          <Link
            to="/login"
            className="text-sm font-semibold bg-accent text-accent-ink px-4 py-2 rounded-lg"
          >
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
