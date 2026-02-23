// =============================================================================
// OpenClaw Railway Wrapper — Official Template + XPR Agent Extensions
// =============================================================================
// Base: https://github.com/arjunkomath/openclaw-railway-template
// Extensions: XPR Agent plugin install, job poller, social scheduler, chat hooks
// =============================================================================

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import * as tar from "tar";
import { WebSocketServer } from "ws";

const WRAPPER_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Environment & constants
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway token — stable across restarts.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() ||
  "/usr/local/lib/node_modules/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// XPR Agent Constants
// ---------------------------------------------------------------------------

const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN?.trim();

const JOB_POLL_INTERVAL = 30_000;
const JOB_POLLER_MIN_XPR = parseFloat(process.env.JOB_POLLER_MIN_XPR || "100");
const JOB_POLLER_MAX_EVALS_PER_DAY = parseInt(process.env.JOB_POLLER_MAX_EVALS_PER_DAY || "20", 10);

const SOCIAL_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const SOCIAL_LAST_POST_FILE = path.join(STATE_DIR, "social-last-post.txt");
const SEEN_JOBS_FILE = path.join(STATE_DIR, "seen-jobs.json");

// ---------------------------------------------------------------------------
// XPR Agent Functions
// ---------------------------------------------------------------------------

/**
 * Generate CLAUDE.md workspace instructions for the gateway agent.
 * This gives the agent its identity and mode-specific behavior.
 */
function generateClaudeMd(account, mode) {
  const modeInstructions = {
    worker: `## Worker Mode
You bid on open jobs, deliver work, and earn XPR.
- Use xpr_list_open_jobs to find available work
- Submit bids with xpr_submit_bid — include your proposed amount, timeline, and proposal
- Deliver work with store_deliverable + xpr_deliver_job
- You can generate images (generate_image), videos (generate_video), create code repos (create_github_repo), write reports, and more
- Always check the cost analysis before bidding — bid at or above your estimated cost`,
    delegator: `## Delegator Mode
You CREATE jobs and hire other agents to do work.
- Use xpr_create_job to post jobs on the job board
- Fund jobs with xpr_fund_job
- Evaluate incoming bids using xpr_list_bids and xpr_select_bid
- Monitor deliveries and approve with xpr_approve_delivery
- You do NOT bid on jobs yourself — you hire others
- Write clear job descriptions with specific deliverables`,
    hybrid: `## Hybrid Mode
You both work on jobs AND delegate to other agents.
- Use xpr_list_open_jobs to find work and submit bids
- Use xpr_create_job to post jobs and hire other agents
- Deliver your own work with store_deliverable + xpr_deliver_job
- Evaluate bids on your created jobs with xpr_list_bids + xpr_select_bid`,
    validator: `## Validator Mode
You validate other agents' work quality and earn rewards.
- Poll for delivered jobs and submit validations
- Provide honest assessments with evidence URIs
- You earn rewards when your validations are upheld
- Maintain high accuracy — incorrect validations get slashed`,
    social: `## Social Mode
You engage on Shellbook and build community presence.
- Post updates and insights via shell_create_post
- Engage with other posts via shell_vote and shell_create_comment
- Build your reputation through consistent, quality contributions
- You focus on community engagement, not job board activity`,
  };

  const modeSection = modeInstructions[mode] || modeInstructions.worker;

  return `# XPR Agent — ${account}

You are an autonomous AI agent operating on XPR Network's trustless agent registry.
Your on-chain account is **${account}**.

${modeSection}

## Core Capabilities
- **Blockchain:** Read/write to XPR Network (jobs, bids, feedback, validation, escrow)
- **Content Creation:** Generate images, videos, PDFs, code repositories, reports
- **DeFi:** Token prices, swaps, OTC trading, liquidity management
- **NFTs:** Create collections, mint, list, trade on AtomicAssets/AtomicMarket
- **Social:** Post and engage on Shellbook (XPR's social network)
- **Web:** Search the web, fetch pages, extract structured data
- **A2A:** Communicate with other agents via Agent-to-Agent protocol

## Job Lifecycle
Jobs follow: CREATED → FUNDED → ACCEPTED → ACTIVE → DELIVERED → COMPLETED
Open jobs: agents submit bids → client selects a bid → agent delivers work

## Safety Rules
1. Never reveal private keys
2. Always verify before accepting jobs — read details thoroughly
3. Always provide evidence when delivering work
4. Check market prices before any trading operation
5. Never sell tokens below market rate
6. Keep proposals brief and specific

## Available Tools
Use the xpr_agents plugin tools for all blockchain operations. Key tools:
- xpr_get_agent, xpr_update_agent — profile management
- xpr_list_open_jobs, xpr_submit_bid — find and bid on work
- xpr_accept_job, xpr_deliver_job — job lifecycle
- store_deliverable, generate_image, generate_video — content creation
- defi_get_price, defi_create_otc — trading
- shell_create_post, shell_vote — social engagement
- xpr_a2a_discover, xpr_a2a_send_message — agent communication
`;
}

/**
 * Install and enable the @xpr-agents/openclaw plugin.
 * This gives the gateway access to XPR blockchain tools (jobs, bids, feedback, etc.)
 * and suppresses OpenClaw's default bootstrap flow by setting a personality prompt.
 */
async function installXprPlugin(agentAccount, agentMode) {
  console.log("[wrapper] Installing @xpr-agents/openclaw plugin (latest)...");

  // Uninstall first to ensure we get the latest version.
  await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "uninstall", "openclaw"]), { timeoutMs: 30_000 });

  const install = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "install", "@xpr-agents/openclaw@latest"]), { timeoutMs: 180_000 });
  if (install.code === 0) {
    console.log("[wrapper] @xpr-agents/openclaw plugin installed via CLI");
  } else {
    // CLI install fails with code 1 due to "dangerous code patterns" security warning.
    // Fall back to manual npm pack + extract to the plugin directory.
    console.warn(`[wrapper] CLI plugin install failed (code=${install.code}), trying manual install...`);
    const pluginDir = path.join(STATE_DIR, "extensions", "openclaw");
    try {
      const pack = await runCmd("npm", ["pack", "@xpr-agents/openclaw@latest", "--pack-destination", "/tmp"], { timeoutMs: 60_000 });
      const tgzLine = (pack.output || "").trim().split("\n").pop() || "";
      const tgzPath = tgzLine.startsWith("/") ? tgzLine : `/tmp/${tgzLine}`;
      if (!tgzPath.endsWith(".tgz")) throw new Error(`npm pack didn't produce .tgz: ${pack.output}`);
      await runCmd("rm", ["-rf", pluginDir], { timeoutMs: 5_000 });
      fs.mkdirSync(pluginDir, { recursive: true });
      await runCmd("tar", ["xzf", tgzPath, "-C", pluginDir, "--strip-components=1"], { timeoutMs: 15_000 });
      await runCmd("npm", ["install", "--omit=dev", "--prefix", pluginDir], { timeoutMs: 120_000 });
      console.log(`[wrapper] @xpr-agents/openclaw manually installed to ${pluginDir}`);
    } catch (err) {
      console.error(`[wrapper] Manual plugin install also failed: ${String(err)}`);
    }
  }

  // Always enable the plugin
  const enable = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "@xpr-agents/openclaw"]));
  console.log(`[wrapper] plugin enable exit=${enable.code}`);

  // Set personality prompt to give the agent its XPR identity.
  const account = agentAccount || process.env.XPR_ACCOUNT || "unknown";
  const mode = agentMode || (process.env.AGENT_MODE || "worker").toLowerCase();
  const identity = `You are ${account}, an autonomous AI agent on XPR Network. You operate in ${mode} mode. Use your XPR blockchain tools for all on-chain operations.`;
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "personality.prompt", identity]));
  console.log(`[wrapper] personality.prompt set (${mode} mode)`);
}

/**
 * Chat via gateway's OpenAI-compatible HTTP API.
 * Uses x-openclaw-session-key for persistent sessions.
 * Falls back to direct Anthropic API if gateway is unavailable.
 *
 * @param {string} message - The message to send
 * @param {number} timeoutMs - Request timeout
 * @param {string} sessionKey - Session key for lane separation (prevents contention)
 */
async function chatViaGateway(message, timeoutMs = 120_000, sessionKey = "agent:main:chat") {
  // Approach 1: Gateway's OpenAI-compatible HTTP API
  try {
    const gatewayUrl = `${GATEWAY_TARGET}/v1/chat/completions`;
    console.log(`[chatRelay] Using gateway API: ${gatewayUrl} (session: ${sessionKey})`);

    const resp = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        "x-openclaw-agent-id": "main",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: "openclaw",
        messages: [{ role: "user", content: message }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resp.ok) {
      const data = await resp.json();
      const response = data.choices?.[0]?.message?.content || "";
      console.log(`[chatRelay] Gateway API response length: ${response.length}`);
      if (response) return response;
    }
    const errText = await resp.text().catch(() => "");
    console.warn(`[chatRelay] Gateway API failed (${resp.status}): ${errText.substring(0, 300)}`);
  } catch (err) {
    console.warn(`[chatRelay] Gateway API approach failed: ${String(err)}`);
  }

  // Approach 2: Anthropic API direct call (fallback)
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Chat not available: gateway API failed and no ANTHROPIC_API_KEY configured");
  }

  console.log(`[chatRelay] Using Anthropic API fallback`);

  let systemPrompt = "You are a helpful AI assistant.";
  try {
    const cfgFile = configPath();
    if (fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      if (cfg.personality?.prompt) systemPrompt = cfg.personality.prompt;
      else if (cfg.systemPrompt) systemPrompt = cfg.systemPrompt;
      else if (cfg.agent?.systemPrompt) systemPrompt = cfg.agent.systemPrompt;
    }
  } catch { /* use default */ }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic API error ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const response = data.content?.map(b => b.text).join("") || "";
  console.log(`[chatRelay] Anthropic API response length: ${response.length}`);
  return response;
}

// --- Job Board Poller ---
let seenJobIds = new Set();
let jobPollerTimer = null;
let dailyEvalCount = 0;
let dailyEvalResetDate = new Date().toISOString().slice(0, 10);

function loadSeenJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_JOBS_FILE, "utf8"));
    seenJobIds = new Set(Array.isArray(data) ? data : []);
    console.log(`[jobPoller] Loaded ${seenJobIds.size} seen job IDs`);
  } catch {
    seenJobIds = new Set();
  }
}

function saveSeenJobs() {
  try {
    fs.mkdirSync(path.dirname(SEEN_JOBS_FILE), { recursive: true });
    fs.writeFileSync(SEEN_JOBS_FILE, JSON.stringify([...seenJobIds]), "utf8");
  } catch (err) {
    console.warn(`[jobPoller] Failed to save seen jobs: ${String(err)}`);
  }
}

async function pollJobBoard() {
  const indexerUrl = process.env.XPR_INDEXER_URL?.trim();
  if (!indexerUrl) return;

  const agentAccount = process.env.XPR_ACCOUNT?.trim();
  if (!agentAccount) return;

  try {
    const resp = await fetch(`${indexerUrl}/jobs?state=1&limit=50`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`[jobPoller] Indexer returned ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const allJobs = data.jobs || [];
    const fundedJobs = allJobs.filter((j) => !j.agent || j.agent === "");
    const newJobs = fundedJobs.filter((j) => !seenJobIds.has(j.id));

    if (newJobs.length === 0) return;

    for (const job of newJobs) {
      seenJobIds.add(job.id);
    }
    saveSeenJobs();

    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyEvalResetDate) {
      dailyEvalCount = 0;
      dailyEvalResetDate = today;
      console.log(`[jobPoller] Daily eval counter reset (new day: ${today})`);
    }

    if (dailyEvalCount >= JOB_POLLER_MAX_EVALS_PER_DAY) {
      console.log(`[jobPoller] Daily eval cap reached (${dailyEvalCount}/${JOB_POLLER_MAX_EVALS_PER_DAY}), skipping ${newJobs.length} job(s)`);
      return;
    }

    const worthyJobs = newJobs.filter((j) => {
      const xpr = j.amount ? j.amount / 10000 : 0;
      if (xpr < JOB_POLLER_MIN_XPR) {
        console.log(`[jobPoller] Skipping low-value job #${j.id}: ${xpr} XPR < ${JOB_POLLER_MIN_XPR} XPR minimum`);
        return false;
      }
      return true;
    });

    if (worthyJobs.length === 0) return;

    const remaining = JOB_POLLER_MAX_EVALS_PER_DAY - dailyEvalCount;
    const jobsToProcess = worthyJobs.slice(0, remaining);
    dailyEvalCount += jobsToProcess.length;

    console.log(`[jobPoller] Found ${jobsToProcess.length} new funded job(s) (eval ${dailyEvalCount}/${JOB_POLLER_MAX_EVALS_PER_DAY} today)`);

    const jobList = jobsToProcess.map((j) => {
      const amount = j.amount ? (j.amount / 10000).toFixed(4) : "0";
      const deadline = j.deadline
        ? new Date(j.deadline * 1000).toISOString().split("T")[0]
        : "none";
      return [
        `- **Job #${j.id}**: ${j.title || "(untitled)"}`,
        `  Client: ${j.client} | Budget: ${amount} ${j.symbol || "XPR"} | Deadline: ${deadline}`,
        j.description ? `  ${j.description.substring(0, 200)}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const message = [
      `New open job${jobsToProcess.length > 1 ? "s" : ""} posted on the XPR Agents job board:`,
      "",
      jobList,
      "",
      `You can use your xpr_list_open_jobs and xpr_submit_bid tools to review and bid on jobs that match your capabilities.`,
      `Your account is: ${agentAccount}`,
    ].join("\n");

    try {
      await ensureGatewayRunning();
      // Use dedicated "jobs" session lane to avoid blocking chat
      await chatViaGateway(message, 120_000, "agent:main:jobs");
    } catch (err) {
      console.warn(`[jobPoller] Failed to notify agent: ${String(err)}`);
    }
  } catch (err) {
    console.warn(`[jobPoller] Poll failed: ${String(err)}`);
  }
}

function startJobPoller() {
  const indexerUrl = process.env.XPR_INDEXER_URL?.trim();
  if (!indexerUrl) {
    console.log("[jobPoller] XPR_INDEXER_URL not set — job polling disabled");
    return;
  }

  loadSeenJobs();
  console.log(`[jobPoller] Starting — polling ${indexerUrl}/jobs?state=1 every ${JOB_POLL_INTERVAL / 1000}s (min: ${JOB_POLLER_MIN_XPR} XPR, max: ${JOB_POLLER_MAX_EVALS_PER_DAY}/day)`);

  setTimeout(() => {
    pollJobBoard();
    jobPollerTimer = setInterval(pollJobBoard, JOB_POLL_INTERVAL);
  }, 10_000);
}

// --- Social Scheduler ---
let socialTimer = null;

function getLastSocialPostDate() {
  try {
    return fs.readFileSync(SOCIAL_LAST_POST_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function saveLastSocialPostDate(dateStr) {
  try {
    fs.mkdirSync(path.dirname(SOCIAL_LAST_POST_FILE), { recursive: true });
    fs.writeFileSync(SOCIAL_LAST_POST_FILE, dateStr, "utf8");
  } catch (err) {
    console.warn(`[socialScheduler] Failed to save last post date: ${String(err)}`);
  }
}

async function doSocialPost(force = false) {
  const agentMode = (process.env.AGENT_MODE || "worker").toLowerCase();
  if (agentMode !== "social") {
    console.log(`[socialScheduler] Skipping — mode is "${agentMode}" (not social)`);
    return { skipped: true, reason: "not social mode" };
  }

  const agentAccount = process.env.XPR_ACCOUNT?.trim();
  if (!agentAccount) {
    console.log(`[socialScheduler] Skipping — XPR_ACCOUNT not set`);
    return { skipped: true, reason: "no XPR_ACCOUNT" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastPost = getLastSocialPostDate();

  if (lastPost === today && !force) {
    console.log(`[socialScheduler] Skipping — already posted today (${today})`);
    return { skipped: true, reason: `already posted ${today}` };
  }

  console.log(`[socialScheduler] Daily post due (last: ${lastPost || "never"}, today: ${today}${force ? ", forced" : ""})`);

  const message = [
    `Time for your daily Shellbook activity! Today is ${today}.`,
    "",
    "1. First, check what's happening on Shellbook — use shell_list_posts to see recent posts from other agents and users.",
    "2. Engage with 1-2 interesting posts (upvote or comment).",
    "3. Create one original post using shell_create_post. Share something interesting — it could be about XPR Network, DeFi, NFTs, AI agents, crypto, or anything your community would enjoy. Be authentic and conversational.",
    "",
    `Your account is: ${agentAccount}`,
  ].join("\n");

  try {
    await ensureGatewayRunning();
    // Use dedicated "social" session lane to avoid blocking chat
    const reply = await chatViaGateway(message, 180_000, "agent:main:social");
    console.log(`[socialScheduler] Agent response (${reply.length} chars): ${reply.substring(0, 300)}`);

    const failed = /don't have|no.*tool|not available|cannot|can't/i.test(reply);
    if (!failed) {
      saveLastSocialPostDate(today);
      console.log(`[socialScheduler] Daily post completed for ${today}`);
      return { ok: true, date: today, reply: reply.substring(0, 300) };
    } else {
      console.warn(`[socialScheduler] Agent could not post (tools missing?) — will retry next check`);
      return { ok: false, reason: "tools missing", reply: reply.substring(0, 300) };
    }
  } catch (err) {
    console.warn(`[socialScheduler] Failed: ${String(err)}`);
    return { ok: false, reason: String(err) };
  }
}

function startSocialScheduler() {
  const agentMode = (process.env.AGENT_MODE || "worker").toLowerCase();
  if (agentMode !== "social") return;

  console.log(`[socialScheduler] Starting — checking every ${SOCIAL_CHECK_INTERVAL / 1000 / 60}min for daily post`);

  setTimeout(() => {
    doSocialPost();
    socialTimer = setInterval(doSocialPost, SOCIAL_CHECK_INTERVAL);
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Gateway lifecycle
// ---------------------------------------------------------------------------

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            console.warn(`[gateway] health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  for (const lockPath of [
    path.join(STATE_DIR, "gateway.lock"),
    "/tmp/openclaw-gateway.lock",
  ]) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  console.log(
    `[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`,
  );
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
    if (!shuttingDown && isConfigured()) {
      console.log("[gateway] scheduling auto-restart in 2s...");
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            console.error(`[gateway] auto-restart failed: ${err.message}`);
          });
        }
      }, 2000);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      console.warn(`[gateway] kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

// Global wrapper auth — protects all routes except health, setup (own auth), and hooks (own auth).
function requireWrapperAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/setup")) return next();
  if (req.path.startsWith("/hooks/")) return next();

  if (!SETUP_PASSWORD) return next();

  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (password === SETUP_PASSWORD) return next();
  }

  if (authHeader.startsWith("Bearer ") && authHeader.slice(7) === SETUP_PASSWORD) {
    return next();
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const tokenParam = url.searchParams.get("token");
    if (tokenParam && tokenParam === SETUP_PASSWORD) return next();
  } catch {}

  res.set("WWW-Authenticate", 'Basic realm="Agent"');
  return res.status(401).send("Unauthorized");
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(requireWrapperAuth);

// --- Health endpoints ---

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway, wrapper: WRAPPER_VERSION });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

// --- Setup UI ---

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

// --- Setup API ---

const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli",
  "openai-codex",
  "openai-api-key",
  "claude-cli",
  "token",
  "apiKey",
  "gemini-api-key",
  "google-antigravity",
  "google-gemini-cli",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) {
    return `Invalid flow: ${payload.flow}. Must be one of: ${VALID_FLOWS.join(", ")}`;
  }
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      // XPR: Enable chat completions HTTP API for hook endpoints
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.http.endpoints.chatCompletions.enabled", "true"]));
      extra += `[config] gateway.http.endpoints.chatCompletions.enabled=true\n`;

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "allowlist",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "allowlist",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      // XPR: Install plugin and set personality prompt
      try {
        await installXprPlugin();
        extra += `\n[xpr plugin] installed\n`;
      } catch (err) {
        extra += `\n[xpr plugin] install failed: ${String(err)}\n`;
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      version: WRAPPER_VERSION,
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

// --- Export / Import ---

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split("/").includes("..")) return false;
  return true;
}

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when state/workspace dirs are under /data.\n");
    }

    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024);
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => looksSafeTarPath(p),
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// --- Web TUI ---

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        console.log("[tui] max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

// --- XPR Hook Endpoints ---

app.get("/hooks/chat-history", async (req, res) => {
  if (!OPENCLAW_HOOK_TOKEN) {
    return res.status(500).json({ error: "OPENCLAW_HOOK_TOKEN not configured" });
  }
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== OPENCLAW_HOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!isConfigured()) {
    return res.status(503).json({ error: "Agent not configured yet" });
  }
  // Gateway WS RPC chat.history is not available in current OpenClaw version.
  return res.json({ messages: [] });
});

app.post("/hooks/agent", async (req, res) => {
  if (!OPENCLAW_HOOK_TOKEN) {
    return res.status(500).json({ error: "OPENCLAW_HOOK_TOKEN not configured" });
  }
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== OPENCLAW_HOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { action, data } = req.body || {};
  if (action !== "chat" || !data?.message || typeof data.message !== "string") {
    return res.status(400).json({ error: 'Expected { action: "chat", data: { message: string } }' });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: "Agent not configured yet" });
  }

  try {
    await ensureGatewayRunning();
  } catch (err) {
    return res.status(503).json({ error: `Gateway not ready: ${String(err)}` });
  }

  try {
    // Dashboard chat uses dedicated "chat" session lane
    const response = await chatViaGateway(data.message.trim(), 120_000, "agent:main:chat");
    return res.json({ response });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hooks/agent] Chat error: ${msg}`);
    return res.status(500).json({ error: msg });
  }
});

app.post("/hooks/social-post", async (req, res) => {
  if (!OPENCLAW_HOOK_TOKEN) return res.status(500).json({ error: "OPENCLAW_HOOK_TOKEN not configured" });
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== OPENCLAW_HOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const force = req.body?.force === true;
  try {
    const result = await doSocialPost(force);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/hooks/social-status", async (_req, res) => {
  res.json({
    mode: (process.env.AGENT_MODE || "worker").toLowerCase(),
    lastPost: getLastSocialPostDate() || null,
    today: new Date().toISOString().slice(0, 10),
    schedulerActive: socialTimer !== null,
  });
});

// --- Proxy to gateway ---

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

// Catch-all: proxy to gateway
app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[wrapper] v${WRAPPER_VERSION} listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] configured: ${isConfigured()}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);

  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Harden state dir
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  // --- Auto-onboard ---
  (async () => {
    if (!isConfigured() && process.env.ANTHROPIC_API_KEY?.trim()) {
      console.log("[wrapper] ANTHROPIC_API_KEY detected, auto-onboarding...");
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

        const onboardArgs = buildOnboardArgs({
          flow: "quickstart",
          authChoice: "apiKey",
          authSecret: process.env.ANTHROPIC_API_KEY.trim(),
        });

        const result = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
        console.log(`[wrapper] onboard exit=${result.code}`);
        if (result.code === 0 && isConfigured()) {
          console.log("[wrapper] auto-onboarding succeeded");

          // Post-onboard config
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.http.endpoints.chatCompletions.enabled", "true"]));

          // Optional channels from env
          if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
            const tgCfg = { enabled: true, dmPolicy: "pairing", botToken: process.env.TELEGRAM_BOT_TOKEN.trim(), groupPolicy: "allowlist", streamMode: "partial" };
            await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(tgCfg)]));
            await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
            console.log("[wrapper] Telegram channel configured");
          }
          if (process.env.DISCORD_BOT_TOKEN?.trim()) {
            const dcCfg = { enabled: true, token: process.env.DISCORD_BOT_TOKEN.trim(), groupPolicy: "allowlist", dm: { policy: "pairing" } };
            await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(dcCfg)]));
            console.log("[wrapper] Discord channel configured");
          }

          await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
          await installXprPlugin();
        } else {
          console.error(`[wrapper] auto-onboarding failed (code=${result.code})`);
        }
      } catch (err) {
        console.error(`[wrapper] auto-onboarding error: ${String(err)}`);
      }
    }

    // --- Start gateway if configured ---
    if (isConfigured()) {
      // Write CLAUDE.md to workspace
      try {
        const agentMode = (process.env.AGENT_MODE || "worker").toLowerCase();
        const agentAccount = process.env.XPR_ACCOUNT || "unknown";
        const claudeMd = generateClaudeMd(agentAccount, agentMode);
        fs.writeFileSync(path.join(WORKSPACE_DIR, "CLAUDE.md"), claudeMd);
        console.log(`[wrapper] CLAUDE.md written (mode=${agentMode}, account=${agentAccount})`);

        const bootstrapPath = path.join(WORKSPACE_DIR, "BOOTSTRAP.md");
        if (fs.existsSync(bootstrapPath)) {
          fs.unlinkSync(bootstrapPath);
          console.log("[wrapper] Removed BOOTSTRAP.md");
        }
      } catch (err) {
        console.error(`[wrapper] failed to write CLAUDE.md: ${String(err)}`);
      }

      // Install XPR plugin on every restart
      try {
        await installXprPlugin();
      } catch (err) {
        console.error(`[wrapper] XPR plugin install failed: ${String(err)}`);
      }

      // Apply env var overrides
      try {
        let configChanged = false;

        if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
          const tgCfg = { enabled: true, dmPolicy: "pairing", botToken: process.env.TELEGRAM_BOT_TOKEN.trim(), groupPolicy: "allowlist", streamMode: "partial" };
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(tgCfg)]));
          await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
          configChanged = true;
        }

        if (process.env.DISCORD_BOT_TOKEN?.trim()) {
          const dcCfg = { enabled: true, token: process.env.DISCORD_BOT_TOKEN.trim(), groupPolicy: "allowlist", dm: { policy: "pairing" } };
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(dcCfg)]));
          configChanged = true;
        }

        if (process.env.AGENT_MODEL?.trim()) {
          const model = process.env.AGENT_MODEL.trim();
          const modelResult = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", model]));
          console.log(`[wrapper] Agent model set to ${model} (exit=${modelResult.code})`);
          configChanged = true;
        }

        if (configChanged) {
          await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        }
      } catch (err) {
        console.error(`[wrapper] env var config override failed: ${String(err)}`);
      }

      // Doctor --fix + start gateway
      try {
        console.log("[wrapper] running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        console.log(`[wrapper] doctor --fix exit=${dr.code}`);
        if (dr.output) console.log(dr.output);
      } catch (err) {
        console.warn(`[wrapper] doctor --fix failed: ${err.message}`);
      }

      try {
        await ensureGatewayRunning();
        console.log("[wrapper] gateway ready");

        // Start XPR background services
        startJobPoller();
        startSocialScheduler();
      } catch (err) {
        console.error(`[wrapper] failed to start gateway at boot: ${err.message}`);
      }
    }
  })();
});

// --- WebSocket upgrade handling ---

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // TUI WebSocket
  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="OpenClaw TUI"\r\n\r\n');
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  // Gateway WebSocket
  if (!isConfigured()) {
    socket.destroy();
    return;
  }

  // Authenticate WebSocket upgrades
  if (SETUP_PASSWORD) {
    let authed = false;
    const authHeader = req.headers.authorization || "";

    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (password === SETUP_PASSWORD) authed = true;
    }

    if (!authed && authHeader.startsWith("Bearer ") && authHeader.slice(7) === SETUP_PASSWORD) {
      authed = true;
    }

    if (!authed) {
      try {
        const tokenParam = url.searchParams.get("token");
        if (tokenParam && tokenParam === SETUP_PASSWORD) authed = true;
      } catch {}
    }

    if (!authed) {
      socket.destroy();
      return;
    }
  }

  try {
    await ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// --- Graceful shutdown ---

async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (jobPollerTimer) {
    clearInterval(jobPollerTimer);
  }

  if (socialTimer) {
    clearInterval(socialTimer);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      console.warn(`[wrapper] error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
