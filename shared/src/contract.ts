// #region claude-terminal <-> Loon contract
// Loon is a separate app and repo from claude-terminal, but it plugs into the
// same per-user hosting model. This file is the single typed boundary between
// them. claude-terminal (and the claude-router) only need to know this shape;
// nothing else about Loon's internals leaks across.
//
// Hosting model (mirrors guest-claude): each user gets a Loon instance on a
// port. The router maps a user to their port the same way it maps ttyd ports
// in guests.tsv. Loon can run in its own container or co-located beside a
// user's claude-terminal; only the port + workspace path differ.

export const LOON_CONTRACT_VERSION = "0.1.0";

// A running Loon instance advertises this at GET /.well-known/loon so the
// router/terminal can discover and health-check it without hard-coding.
export interface LoonManifest {
  contract: string; // LOON_CONTRACT_VERSION
  name: "loon";
  version: string;
  // Absolute path of the per-user project workspace this instance serves.
  workspace: string;
  // The user this instance belongs to (matches guests.tsv name), if scoped.
  user?: string;
  // Whether the AI bridge (local `claude` CLI) is available in this instance.
  aiAvailable: boolean;
}

// How Loon runs its AI. It reuses the user's existing Claude subscription by
// invoking the local `claude` binary in headless mode inside the user's
// workspace, exactly like claude-terminal does for a ttyd session. No separate
// API key. claude-terminal owns auth; Loon only shells out.
export interface AiBridgeConfig {
  // Path to the claude binary. Default resolves from PATH.
  claudeBin: string;
  // Working directory for the CLI (the user's project workspace).
  cwd: string;
  // Extra args (model, etc.). Kept minimal so terminal-side config wins.
  extraArgs: string[];
}

// Launch descriptor the router uses to bring up / point at a user's instance.
export interface LoonUserBinding {
  user: string;
  port: number;
  workspace: string;
}
