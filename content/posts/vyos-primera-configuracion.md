---
title: "VyOS: Primera Configuración — NAT, Firewall, Rutas Estáticas y VLANs"
date: 2026-04-10
tags: ["vyos", "router", "nat", "firewall", "vlan", "static-route", "linux"]
description: "Guía práctica para dejar un router VyOS funcional desde cero: NAT masquerade, zonas de firewall, rutas estáticas y subinterfaces 802.1Q."
---

VyOS es un router/firewall de código abierto basado en Debian. A diferencia de equipos como MikroTik o Cisco, toda la configuración vive en un árbol jerárquico que se edita en **modo de configuración** y se confirma con `commit`. Este modelo — inspirado en Junos — hace que los cambios sean atómicos y reversibles, lo cual es una ventaja real en producción.

Este post cubre los cuatro bloques fundamentales para dejar un router VyOS operativo: NAT, Firewall, Rutas Estáticas y VLANs.

## Escenario de referencia

```
Internet
    │
  eth0  (WAN — IP pública o DHCP del ISP)
    │
 [VyOS]
    │
  eth1  (LAN — 192.168.1.1/24)
    │
  eth1.10  VLAN 10 — Servidores  (10.10.10.1/24)
  eth1.20  VLAN 20 — Usuarios    (10.10.20.1/24)
```

---

## 1. Configuración inicial de interfaces

Entrar al modo de configuración es siempre el primer paso:

```bash
configure
```

Asignar IPs a las interfaces:

```
set interfaces ethernet eth0 description 'WAN'
set interfaces ethernet eth0 address dhcp

set interfaces ethernet eth1 description 'LAN'
set interfaces ethernet eth1 address '192.168.1.1/24'
```

Confirmar y guardar:

```
commit
save
```

> **Tip:** `compare` antes de `commit` muestra exactamente qué cambiará. Útil para auditar en sesiones largas.

---

## 2. NAT — Masquerade hacia WAN

VyOS implementa NAT como reglas numeradas. Para salida a internet desde cualquier subred interna:

```
set nat source rule 10 description 'LAN a Internet'
set nat source rule 10 outbound-interface name 'eth0'
set nat source rule 10 source address '192.168.0.0/16'
set nat source rule 10 translation address masquerade

commit
save
```

El bloque `192.168.0.0/16` cubre la LAN y las VLANs que se agregarán más adelante. Si preferís ser más estricto, podés crear una regla por subred.

Verificar:

```bash
show nat source rules
show nat source translations
```

---

## 3. Firewall por zonas

VyOS permite un modelo de firewall **basado en zonas**, donde cada interfaz pertenece a una zona y se define la política entre pares de zonas. Es más ordenado que aplicar reglas sueltas por interfaz.

### Definir zonas

```
set firewall zone WAN interface eth0
set firewall zone LAN interface eth1
set firewall zone LOCAL local-zone
```

`local-zone` es el propio router (tráfico que termina o sale de VyOS mismo).

### Política WAN → LOCAL (acceso al router desde internet)

Por defecto denegar todo; permitir solo ICMP y respuestas de conexiones establecidas:

```
set firewall ipv4 name WAN-TO-LOCAL default-action drop
set firewall ipv4 name WAN-TO-LOCAL rule 10 action accept
set firewall ipv4 name WAN-TO-LOCAL rule 10 state established
set firewall ipv4 name WAN-TO-LOCAL rule 10 state related
set firewall ipv4 name WAN-TO-LOCAL rule 20 action accept
set firewall ipv4 name WAN-TO-LOCAL rule 20 protocol icmp

set firewall zone LOCAL from WAN firewall name WAN-TO-LOCAL
```

### Política WAN → LAN (tráfico entrante hacia la red)

```
set firewall ipv4 name WAN-TO-LAN default-action drop
set firewall ipv4 name WAN-TO-LAN rule 10 action accept
set firewall ipv4 name WAN-TO-LAN rule 10 state established
set firewall ipv4 name WAN-TO-LAN rule 10 state related

set firewall zone LAN from WAN firewall name WAN-TO-LAN
```

### Política LAN → WAN (tráfico saliente de la LAN)

```
set firewall ipv4 name LAN-TO-WAN default-action accept

set firewall zone WAN from LAN firewall name LAN-TO-WAN
```

```
commit
save
```

Verificar:

```bash
show firewall zones
show firewall ipv4 name WAN-TO-LOCAL statistics
```

---

## 4. Rutas estáticas

Para redes que no son directamente conectadas ni aprendidas por un protocolo de ruteo dinámico.

### Ruta por defecto manual (si eth0 no usa DHCP)

```
set protocols static route 0.0.0.0/0 next-hop 203.0.113.1
```

### Ruta hacia una red remota detrás de otro router

Supongamos que `192.168.100.0/24` está detrás de un router en `192.168.1.254`:

```
set protocols static route 192.168.100.0/24 next-hop 192.168.1.254
```

### Ruta de descarte (blackhole)

Útil para agregar supernets y evitar loops de ruteo:

```
set protocols static route 10.10.0.0/16 blackhole distance 254
```

```
commit
save
```

Verificar:

```bash
show ip route
show ip route static
```

---

## 5. VLANs — Subinterfaces 802.1Q

VyOS crea VLANs como subinterfaces `ethn.vlan-id` sobre la interfaz troncal.

### Crear subinterfaces

```
set interfaces ethernet eth1 vif 10 description 'Servidores'
set interfaces ethernet eth1 vif 10 address '10.10.10.1/24'

set interfaces ethernet eth1 vif 20 description 'Usuarios'
set interfaces ethernet eth1 vif 20 address '10.10.20.1/24'
```

### Agregar las VLANs a las zonas de firewall

```
set firewall zone LAN interface eth1.10
set firewall zone LAN interface eth1.20
```

### Extender el NAT para las nuevas subredes

La regla de NAT ya usa `192.168.0.0/16`, así que las subredes `10.10.x.x` quedan fuera. Agregar una regla adicional:

```
set nat source rule 20 description 'VLANs a Internet'
set nat source rule 20 outbound-interface name 'eth0'
set nat source rule 20 source address '10.10.0.0/16'
set nat source rule 20 translation address masquerade
```

```
commit
save
```

Verificar:

```bash
show interfaces
show interfaces ethernet eth1 vif
ping 10.10.10.1 from-address 10.10.20.1
```

---

## Resumen de comandos útiles

| Tarea | Comando |
|---|---|
| Ver configuración activa | `show configuration` |
| Ver diff sin hacer commit | `compare` |
| Revertir cambios sin commit | `discard` |
| Rollback al commit anterior | `rollback 1` (en modo config) |
| Ver tabla de ruteo | `show ip route` |
| Ver traducciones NAT activas | `show nat source translations` |
| Ver logs del firewall | `show log firewall` |

---

## Próximos pasos

Con esta base podés avanzar hacia:

- **DHCP Server** por VLAN (`set service dhcp-server`)
- **DNS Forwarder** local (`set service dns forwarding`)
- **BGP / OSPF** con el stack `set protocols bgp` o `set protocols ospf`
- **WireGuard** o **IPsec** para acceso remoto

VyOS tiene la ventaja de que la curva de aprendizaje inicial es confusa, pero una vez que entiendes el modelo de `configure → set → commit → save`, la configuración escala de forma muy limpia.
