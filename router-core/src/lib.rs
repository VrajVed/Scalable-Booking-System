// =============================================================================
// lib.rs — Crate root for the predictive load balancer router core
// =============================================================================

pub mod types;
pub mod scoreboard;
pub mod router;

// Re-export the main public API so consumers can write:
//   use router_core::{Router, Scoreboard, ...};
pub use types::*;
pub use scoreboard::Scoreboard;
pub use router::Router;
