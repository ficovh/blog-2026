---
title: "OSPF LSA Types: A Field Reference"
date: 2025-06-14
tags: ["ospf", "routing", "reference"]
description: "A concise reference for OSPF LSA types 1–7, what they carry, and which routers originate them."
---

OSPF link-state advertisements are the currency of the protocol. Understanding which LSA type carries what information — and who generates it — is essential for troubleshooting convergence issues.

## Quick Reference

| Type | Name | Originated By | Scope |
|------|------|---------------|-------|
| 1 | Router LSA | Every router | Single area |
| 2 | Network LSA | DR on broadcast segment | Single area |
| 3 | Summary LSA | ABR | Area → backbone |
| 4 | ASBR Summary | ABR | Area → backbone |
| 5 | AS External | ASBR | Entire OSPF domain |
| 7 | NSSA External | ASBR in NSSA | Single NSSA area |

## Type 1 — Router LSA

Every OSPF router originates one Type 1 LSA per area it belongs to. It describes:

- Router links (point-to-point)
- Transit links (multi-access segments)
- Stub links (no neighbor, just a subnet)
- Virtual links

```
# Cisco IOS
show ip ospf database router self-originate
```

## Type 3 — Summary LSA

ABRs generate Type 3 LSAs to advertise intra-area routes into other areas. This is where OSPF route summarization lives.

```
area 10 range 10.10.0.0 255.255.0.0
```

This collapses all routes from area 10 into a single Type 3 when advertised toward area 0.

## Type 5 vs Type 7

The classic confusion point. External routes (redistributed into OSPF) are carried as Type 5 LSAs domain-wide. But NSSA areas don't accept Type 5s — so ASBRs within an NSSA originate Type 7 LSAs instead.

The ABR on the boundary converts Type 7 → Type 5 when flooding toward area 0.

## Debug Tip

When an external route isn't showing up where expected, check:

1. Is the ASBR reachable? (Type 4 LSA present in the area?)
2. Is the area a stub/NSSA blocking Type 5?
3. Is there a Type 7 → Type 5 translation happening at the ABR?

```
show ip ospf database external
show ip ospf database nssa-external
```

Knowing your LSA types turns a confusing `show ip route` gap into a five-minute debug.
