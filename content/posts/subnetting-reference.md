---
title: "Subnetting: From First Principles to VLSM"
date: 2026-04-07
tags: ["networking", "ip", "subnetting", "reference"]
description: "A practical subnetting guide covering binary math, CIDR notation, VLSM, and common exam-style calculations — written for engineers who want to understand the why."
---

Subnetting is one of those skills that seems intimidating until it clicks, and then it feels obvious. This post builds from first principles — binary representation, masks, and block sizes — through variable-length subnet masking (VLSM) and summarization.

## IP Address Structure

An IPv4 address is 32 bits divided into two logical parts: **network** and **host**.

```
192.168.10.25 = 11000000.10101000.00001010.00011001
```

The subnet mask defines the split. A `255.255.255.0` mask (or `/24` in CIDR) means the first 24 bits identify the network, the last 8 identify the host.

```
Address:  192.168.10.25   11000000.10101000.00001010.00011001
Mask:     255.255.255.0   11111111.11111111.11111111.00000000
                          ^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^
                          Network portion           Host portion
```

## CIDR Prefix Lengths

The prefix length (`/x`) is just the count of consecutive 1-bits in the mask.

| Prefix | Mask            | Hosts (usable) | Block Size |
|--------|-----------------|----------------|------------|
| /24    | 255.255.255.0   | 254            | 256        |
| /25    | 255.255.255.128 | 126            | 128        |
| /26    | 255.255.255.192 | 62             | 64         |
| /27    | 255.255.255.224 | 30             | 32         |
| /28    | 255.255.255.240 | 14             | 16         |
| /29    | 255.255.255.248 | 6              | 8          |
| /30    | 255.255.255.252 | 2              | 4          |
| /31    | 255.255.255.254 | 2 (point-to-point, RFC 3021) | 2 |
| /32    | 255.255.255.255 | 1 (host route) | 1          |

Usable hosts = 2^(32−prefix) − 2, subtracting network and broadcast addresses.  
Exception: `/31` is used for point-to-point links (RFC 3021) — both addresses are usable.

## The Block Size Trick

Block size = `256 − last octet of mask`.

For a `/26` (mask `255.255.255.192`):

```
Block size = 256 - 192 = 64
```

Subnets in the last octet increment by 64:

```
192.168.1.0/26    → hosts .1–.62,  broadcast .63
192.168.1.64/26   → hosts .65–.126, broadcast .127
192.168.1.128/26  → hosts .129–.190, broadcast .191
192.168.1.192/26  → hosts .193–.254, broadcast .255
```

To find which subnet an address belongs to: divide the host octet by the block size, take the floor, multiply back.

```
Which subnet is 192.168.1.100/26?
100 / 64 = 1 (floor)
1 × 64   = 64  → subnet is 192.168.1.64/26
```

## Calculating Network, Broadcast, and Host Range

Given `10.0.5.87/28`:

1. **Block size**: 256 − 240 = 16
2. **Network address**: 87 / 16 = 5 (floor) → 5 × 16 = 80 → `10.0.5.80`
3. **Broadcast**: network + block − 1 → 80 + 16 − 1 = 95 → `10.0.5.95`
4. **Host range**: `10.0.5.81` – `10.0.5.94`

## VLSM: Allocating Subnets Efficiently

Variable-Length Subnet Masking lets you carve a block into subnets of different sizes. The key rule: **allocate largest subnets first** to avoid fragmentation.

### Example

Assign subnets from `172.16.0.0/24` for:

| Segment         | Hosts needed |
|-----------------|-------------|
| LAN A           | 100         |
| LAN B           | 50          |
| LAN C           | 25          |
| WAN link 1      | 2           |
| WAN link 2      | 2           |

**Step 1 — LAN A (100 hosts):** needs /25 (126 usable)
```
172.16.0.0/25   hosts: .1–.126   broadcast: .127
```

**Step 2 — LAN B (50 hosts):** needs /26 (62 usable)
```
172.16.0.128/26  hosts: .129–.190  broadcast: .191
```

**Step 3 — LAN C (25 hosts):** needs /27 (30 usable)
```
172.16.0.192/27  hosts: .193–.222  broadcast: .223
```

**Step 4 — WAN links (2 hosts each):** /30 (2 usable)
```
172.16.0.224/30  hosts: .225–.226  broadcast: .227
172.16.0.228/30  hosts: .229–.230  broadcast: .231
```

Remaining space: `172.16.0.232/29` through `172.16.0.255` — available for future growth.

## Summarization

Route summarization (aggregation) collapses multiple specific prefixes into one covering advertisement. This is what BGP route aggregation and OSPF inter-area summarization both rely on.

To summarize a set of prefixes:

1. Write all network addresses in binary.
2. Find the longest common bit prefix.
3. The summary prefix length equals that common bit count.

### Example

Summarize `10.1.4.0/24`, `10.1.5.0/24`, `10.1.6.0/24`, `10.1.7.0/24`:

```
10.1.4.0  = 00001010.00000001.00000100.00000000
10.1.5.0  = 00001010.00000001.00000101.00000000
10.1.6.0  = 00001010.00000001.00000110.00000000
10.1.7.0  = 00001010.00000001.00000111.00000000
                                      ^^
                               first difference at bit 23
```

Common prefix: 22 bits → summary is `10.1.4.0/22`.

> **Watch out for over-summarization.** `10.1.4.0/22` also covers `10.1.4.0–10.1.7.255`. If you only own `.4.0–.7.0/24` but advertise `/22`, you'll black-hole traffic for any addresses in that range you don't actually have routes for.

## Private Address Space (RFC 1918)

| Range                        | Prefix        | Common use        |
|------------------------------|---------------|-------------------|
| 10.0.0.0–10.255.255.255      | 10.0.0.0/8    | Large enterprises |
| 172.16.0.0–172.31.255.255    | 172.16.0.0/12 | Mid-size networks |
| 192.168.0.0–192.168.255.255  | 192.168.0.0/16| SOHO / labs       |

And `100.64.0.0/10` (RFC 6598) is reserved for carrier-grade NAT — you'll see it on ISP CPE and in some cloud provider transit ranges.

## Quick Mental Math Tips

- **Powers of 2**: memorize 2^1 through 2^8 (2, 4, 8, 16, 32, 64, 128, 256). Everything else follows.
- **Host count shortcut**: for a /x prefix in the last octet, hosts = block size − 2.
- **Subnet count**: dividing a /24 into /26 gives 2^(26−24) = 4 subnets.
- **/31 for P2P links**: saves address space on transit links; supported by all modern platforms. Use it.
- **/32 for loopbacks**: always. Never put a loopback on a /24 — it wastes 254 addresses and can cause unnecessary routing entries.

## Related Topics

Subnetting is the foundation for:

- **OSPF area design** — summarization at ABRs relies on contiguous address blocks
- **BGP prefix filtering** — prefix-lists match on prefix + le/ge operators
- **ACL design** — wildcard masks are the inverse of subnet masks (`255 − mask octet`)
- **IPv6** — the same CIDR logic applies, just with 128-bit addresses and `/64` as the standard LAN prefix
