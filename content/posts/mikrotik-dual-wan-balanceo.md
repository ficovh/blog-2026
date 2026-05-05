---
title: "Dual WAN en MikroTik RouterOS v7: Balanceo y Failover con PCC"
date: 2026-04-07
tags: ["mikrotik", "routeros", "wan", "balanceo", "firewall", "mangle"]
description: "Configuración completa de balanceo de carga y failover sobre dos enlaces WAN en MikroTik RouterOS v7 usando PCC, mangle, routing tables y netwatch."
---

El balanceo de dos enlaces WAN en MikroTik es uno de esos temas donde la documentación oficial muestra el esqueleto pero omite los detalles que hacen que la configuración sea estable en producción. Este post cubre la implementación completa con **Per-Connection Classifier (PCC)**, failover automático con **Netwatch**, y las reglas de mangle necesarias para que el tráfico saliente y las conexiones establecidas se comporten correctamente.

## Escenario

```
ISP1 ─── ether1 (100 Mbps)  ┐
                              ├─── MikroTik ─── LAN (192.168.1.0/24)
ISP2 ─── ether2 (100 Mbps)  ┘
```

| Variable      | ISP1             | ISP2             |
|---------------|------------------|------------------|
| Interfaz      | `ether1`         | `ether2`         |
| IP del router | `203.0.113.2/30` | `198.51.100.2/30` |
| Gateway       | `203.0.113.1`    | `198.51.100.1`   |

Ajusta las IPs a tu entorno. El procedimiento es idéntico con direcciones DHCP — solo cambia cómo obtienes el gateway.

---

## 1. Tablas de enrutamiento

RouterOS v7 tiene soporte nativo para múltiples routing tables. Creamos una tabla por WAN:

```routeros
/routing table
add name=wan1 fib
add name=wan2 fib
```

---

## 2. Rutas por defecto

Una ruta default en la tabla principal y una en cada tabla WAN:

```routeros
/ip route
add dst-address=0.0.0.0/0 gateway=203.0.113.1  routing-table=main distance=1 check-gateway=ping comment="WAN1 default"
add dst-address=0.0.0.0/0 gateway=198.51.100.1 routing-table=main distance=2 check-gateway=ping comment="WAN2 default (failover)"

add dst-address=0.0.0.0/0 gateway=203.0.113.1  routing-table=wan1 comment="WAN1 tabla propia"
add dst-address=0.0.0.0/0 gateway=198.51.100.1 routing-table=wan2 comment="WAN2 tabla propia"
```

El `distance` en la tabla `main` da failover puro si no activas el balanceo. Con PCC reemplazamos este comportamiento para repartir tráfico entre ambos.

> `check-gateway=ping` es crítico: RouterOS elimina la ruta de la tabla cuando el gateway no responde, lo que activa el failover automático sin necesidad de scripts adicionales.

---

## 3. Mangle: marcado de conexiones con PCC

PCC divide las conexiones en grupos según un hash de la tupla src/dst. Con `per-connection-classifier=both-addresses:2/0` y `/2/1` repartimos al 50%.

```routeros
/ip firewall mangle

# --- Tráfico que ya tiene marca de conexión: seguir por el mismo enlace ---
add chain=prerouting connection-state=established,related \
    connection-mark=via-wan1 action=mark-routing new-routing-mark=wan1 \
    passthrough=no comment="Established: seguir por WAN1"

add chain=prerouting connection-state=established,related \
    connection-mark=via-wan2 action=mark-routing new-routing-mark=wan2 \
    passthrough=no comment="Established: seguir por WAN2"

# --- Nuevas conexiones: balanceo PCC ---
add chain=prerouting connection-state=new in-interface=!ether1 in-interface=!ether2 \
    per-connection-classifier=both-addresses:2/0 \
    action=mark-connection new-connection-mark=via-wan1 passthrough=yes \
    comment="PCC nuevo → WAN1"

add chain=prerouting connection-state=new in-interface=!ether1 in-interface=!ether2 \
    per-connection-classifier=both-addresses:2/1 \
    action=mark-connection new-connection-mark=via-wan2 passthrough=yes \
    comment="PCC nuevo → WAN2"

add chain=prerouting connection-mark=via-wan1 \
    action=mark-routing new-routing-mark=wan1 passthrough=no \
    comment="Rutear conexiones WAN1"

add chain=prerouting connection-mark=via-wan2 \
    action=mark-routing new-routing-mark=wan2 passthrough=no \
    comment="Rutear conexiones WAN2"

# --- Output (tráfico originado en el propio router) ---
add chain=output connection-state=established,related \
    connection-mark=via-wan1 action=mark-routing new-routing-mark=wan1 passthrough=no

add chain=output connection-state=established,related \
    connection-mark=via-wan2 action=mark-routing new-routing-mark=wan2 passthrough=no

add chain=output connection-state=new \
    per-connection-classifier=both-addresses:2/0 \
    action=mark-connection new-connection-mark=via-wan1 passthrough=yes

add chain=output connection-state=new \
    per-connection-classifier=both-addresses:2/1 \
    action=mark-connection new-connection-mark=via-wan2 passthrough=yes

add chain=output connection-mark=via-wan1 \
    action=mark-routing new-routing-mark=wan1 passthrough=no

add chain=output connection-mark=via-wan2 \
    action=mark-routing new-routing-mark=wan2 passthrough=no
```

**Por qué `in-interface=!ether1` y `!ether2`**: el PCC solo debe aplicarse a tráfico que viene de la LAN. El tráfico que entra por las WAN ya tiene una conexión establecida y no debe ser reclasificado.

---

## 4. NAT

Masquerade diferenciado por interfaz de salida:

```routeros
/ip firewall nat
add chain=srcnat out-interface=ether1 action=masquerade comment="SNAT WAN1"
add chain=srcnat out-interface=ether2 action=masquerade comment="SNAT WAN2"
```

No uses `action=masquerade` global sin `out-interface` — aplicaría a tráfico interno también.

---

## 5. Failover automático con Netwatch

`check-gateway=ping` en las rutas maneja el failover a nivel de routing table. Sin embargo, si el gateway responde pero no hay conectividad real hacia internet (corte del ISP aguas arriba), la ruta permanece activa. Netwatch resuelve esto verificando un host externo por cada enlace.

```routeros
/tool netwatch

add host=8.8.8.8 interval=10s timeout=2s \
    up-script="/ip route set [find comment=\"WAN1 default\"] distance=1" \
    down-script="/ip route set [find comment=\"WAN1 default\"] distance=10" \
    comment="Monitor WAN1 via 8.8.8.8"

add host=1.1.1.1 interval=10s timeout=2s \
    up-script="/ip route set [find comment=\"WAN2 default\"] distance=2" \
    down-script="/ip route set [find comment=\"WAN2 default\"] distance=10" \
    comment="Monitor WAN2 via 1.1.1.1"
```

Cuando WAN1 cae, su distancia sube a 10 y todo el tráfico sale por WAN2 (distancia 2). Cuando vuelve, la distancia regresa a 1 y el balanceo se reanuda.

> Usa hosts de monitoreo distintos por WAN para evitar falsos positivos. Si usas el mismo host (8.8.8.8) para ambas, un bloqueo puntual de ese IP derribaría los dos enlaces simultáneamente en tu tabla de rutas.

---

## 6. Tráfico que NO debe balancearse

Algunos servicios rompen si la conexión migra de IP pública. Fíjalos a un enlace específico antes de las reglas PCC:

```routeros
/ip firewall mangle

# VPN saliente siempre por WAN1
add chain=prerouting dst-port=1194 protocol=udp \
    action=mark-connection new-connection-mark=via-wan1 passthrough=yes \
    comment="OpenVPN fijo a WAN1"

# Tráfico hacia una red corporativa específica siempre por WAN2
add chain=prerouting dst-address=10.0.0.0/8 \
    action=mark-connection new-connection-mark=via-wan2 passthrough=yes \
    comment="Red corporativa fija a WAN2"
```

Coloca estas reglas **antes** de las reglas PCC en la cadena `prerouting`. El orden en mangle es secuencial.

---

## 7. Verificación

**Confirmar que ambas rutas están activas:**

```routeros
/ip route print where dst-address=0.0.0.0/0
```

Debes ver ambas rutas con la flag `A` (active). Si una cae por `check-gateway`, aparecerá sin `A`.

**Ver marcas de conexión activas:**

```routeros
/ip firewall connection print where connection-mark~"via-wan"
```

**Verificar distribución de tráfico:**

```routeros
/interface monitor-traffic ether1,ether2 interval=1
```

**Simular caída de WAN1:**

```routeros
/ip route set [find comment="WAN1 default"] distance=10
```

Verifica que el tráfico migre a ether2, luego restaura:

```routeros
/ip route set [find comment="WAN1 default"] distance=1
```

---

## Consideraciones de producción

**Sesiones TCP largas**: PCC garantiza que una misma conexión siempre use el mismo enlace, pero si el enlace cae mientras la conexión está activa, esa sesión TCP muere. No hay solución a esto sin ECMP a nivel de sesión o un proxy intermedio. El cliente simplemente reconectará.

**Links asimétricos**: Si WAN1 tiene 100 Mbps y WAN2 tiene 50 Mbps, ajusta el PCC para repartir en proporción 2:1:

```routeros
# Divide en 3 grupos: 0 y 1 van a WAN1, 2 va a WAN2
per-connection-classifier=both-addresses:3/0   → WAN1
per-connection-classifier=both-addresses:3/1   → WAN1
per-connection-classifier=both-addresses:3/2   → WAN2
```

**IPv6**: Si tus ISPs entregan prefijos IPv6, replica la lógica en `/ipv6 firewall mangle` y `/ipv6 route`. PCC funciona igual sobre IPv6.

**Conexiones entrantes (servidores publicados)**: el balanceo aplica solo a tráfico saliente. Si publicas servicios, usa DNS con TTL bajo apuntando a una sola IP pública, o un proveedor de DNS con failover (Cloudflare, Route 53) que cambie el registro cuando detecte que la IP no responde.
