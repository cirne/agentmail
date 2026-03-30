//! `zmail ask` — two-phase OpenAI pipeline (Nano → context assembly → Mini).
//! Mirrors [`src/ask/agent.ts`](../../../src/ask/agent.ts).

mod agent;
mod context;
mod openai_tools;
pub mod tools;

pub use agent::{run_ask, RunAskError, RunAskOptions};
