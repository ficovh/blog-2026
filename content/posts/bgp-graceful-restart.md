---
title: "BGP Graceful Restart: What It Is and When It Actually Helps"
date: 2025-11-20
tags: ["bgp", "routing", "high-availability"]
description: "A practical look at BGP Graceful Restart — the mechanism, its limitations, and when it genuinely improves convergence vs. when it's just theater."
---

BGP Graceful Restart (GR) is one of those features you turn on everywhere because the vendor datasheet says it improves availability — and then you spend the next year debugging weird convergence behavior because of it.

Let me break down what GR actually does, and more importantly, when it helps versus when it makes things worse.

## The Problem It Solves

When a BGP speaker restarts (software upgrade, process crash, failover), it tears down all its sessions. Every peer withdraws the routes it learned from that speaker, and the network reconverges. This takes time — seconds to minutes, depending on your topology.

For a route reflector serving 500 clients, that reconvergence is expensive.

Graceful Restart allows a restarting speaker to signal to its peers: *"I'm going down, but my forwarding plane is still up. Keep my routes for a bit."*

## How It Works

GR uses two BGP capabilities:

- **Graceful Restart Capability** (RFC 4724) — advertised during OPEN
- **Long-lived Graceful Restart** (LLGR, RFC 9494) — extends the stale timer

```
Capability Code: 64 (Graceful Restart)
  Restart Flags: 0x08 (Restart)
  Restart Time: 120 seconds
  AFI: IPv4 Unicast (1/1) - Forwarding State: preserved
```

When the session drops, the receiving peer marks those routes as **stale** but keeps them in the RIB (and FIB) for the duration of the restart timer.

## The Gotchas

### 1. Helper mode vs. Restarting mode

Both sides must support GR, but they play different roles:

| Role | Behavior |
|------|----------|
| Restarting | Sets the R bit in OPEN, requests stale route retention |
| Helper | Keeps stale routes, waits for EOR (End-of-RIB) marker |

If your peer doesn't support helper mode, GR gives you nothing.

### 2. The stale timer is a guess

The restart timer is configured statically. If your control plane takes longer to come up than the timer, peers will purge your routes before you've finished converging. Set it too long and you retain black-hole routes for too long.

### 3. BFD + GR = danger

If you're running BFD for fast failure detection, a GR restart event will often trigger BFD to bring down sessions immediately — defeating the whole purpose of GR. You need to tune BFD timers or disable it on GR-enabled sessions.

## When GR Actually Helps

- **In-service software upgrades (ISSU)**: The primary use case. Control plane restarts while forwarding continues.
- **Route Reflectors**: Reduces the blast radius of an RR restart.
- **Single-homed stubs**: Where a brief stale route beats a complete blackout.

## When to Skip It

- Dual-homed environments where you want fast failover to the backup path
- Anywhere you're running BFD aggressively
- When your restart time is unpredictable (e.g., complex policy recompute)

## Takeaway

BGP Graceful Restart is a surgical tool, not a general-purpose HA feature. Understand your restart timing, your BFD interactions, and your topology before enabling it wholesale.
