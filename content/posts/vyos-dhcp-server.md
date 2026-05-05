---
title: "VyOS: Configurar un Servidor DHCP con Ejemplos Prácticos"
date: 2026-04-11
tags: ["vyos", "dhcp", "router", "vlan", "networking", "linux"]
description: "Guía práctica para configurar el servidor DHCP en VyOS: subredes, opciones avanzadas, reservas estáticas y troubleshooting."
---

VyOS incluye un servidor DHCP completo basado en ISC DHCP. La configuración vive bajo `set service dhcp-server` y sigue el mismo modelo jerárquico que el resto del sistema: se edita en modo configuración, se valida con `commit` y se persiste con `save`.

Este post parte del escenario definido en [VyOS: Primera Configuración](/posts/vyos-primera-configuracion/) y agrega DHCP para la LAN principal y dos VLANs.

## Escenario de referencia

```
Internet
    │
  eth0  (WAN)
    │
 [VyOS]
    │
  eth1          LAN principal  — 192.168.1.1/24
  eth1.10       VLAN 10 Servidores — 10.10.10.1/24
  eth1.20       VLAN 20 Usuarios   — 10.10.20.1/24
```

Cada segmento necesita su propio servidor DHCP, porque VyOS actúa como gateway de cada red.

---

## 1. DHCP para la LAN principal

El bloque mínimo de configuración requiere:

- Un nombre de **shared-network** (agrupa subredes bajo un mismo servidor)
- La **subred** con su máscara
- El **rango** de IPs a asignar
- El **router** (gateway que se entrega al cliente)
- El **tiempo de lease**

```
configure

set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 start '192.168.1.100'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 stop  '192.168.1.200'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 default-router '192.168.1.1'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 lease '86400'

commit
save
```

El lease de `86400` segundos equivale a 24 horas. Para redes de oficina o hogar es un valor razonable; para redes de invitados con alta rotación, algo entre `3600` y `7200` es más adecuado.

### Agregar servidores DNS

```
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 name-server '1.1.1.1'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 name-server '8.8.8.8'

commit
save
```

Se pueden declarar múltiples `name-server`. Los clientes los reciben en el orden en que se configuran.

### Agregar sufijo de dominio

```
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 domain-name 'corp.local'

commit
save
```

Con esto los clientes resuelven nombres cortos (`server1`) como `server1.corp.local`.

---

## 2. DHCP para las VLANs

Cada VLAN es una subred independiente. Se pueden agrupar bajo el mismo `shared-network` o en redes separadas. Usar redes separadas por VLAN es más claro y facilita el troubleshooting.

### VLAN 10 — Servidores

```
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 range 0 start '10.10.10.10'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 range 0 stop  '10.10.10.50'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 default-router '10.10.10.1'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 lease '86400'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 name-server '10.10.10.1'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 domain-name 'srv.corp.local'

commit
save
```

El rango `10.10.10.10 – 10.10.10.50` deja el espacio `10.10.10.51 – 10.10.10.254` libre para asignaciones estáticas o equipos configurados a mano.

### VLAN 20 — Usuarios

```
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 range 0 start '10.10.20.50'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 range 0 stop  '10.10.20.200'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 default-router '10.10.20.1'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 lease '28800'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 name-server '1.1.1.1'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 name-server '8.8.8.8'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 domain-name 'corp.local'

commit
save
```

Lease de `28800` (8 horas): apropiado para estaciones de trabajo en jornada laboral.

---

## 3. Reservas estáticas (static mappings)

Una reserva vincula una MAC address a una IP fija. El cliente sigue usando DHCP pero siempre recibe la misma dirección. Esto es preferible a configurar la IP directamente en el equipo porque la gestión queda centralizada en el router.

### Reserva para un servidor en VLAN 10

```
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-nfs mac 'aa:bb:cc:dd:ee:01'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-nfs ip-address '10.10.10.100'

commit
save
```

El nombre `srv-nfs` es una etiqueta local; no tiene que coincidir con el hostname del equipo, pero ayuda a identificar la reserva.

### Reserva con opciones adicionales

Es posible sobreescribir DNS y gateway por reserva individual. Útil para equipos que deben usar un DNS interno diferente:

```
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-dc mac 'aa:bb:cc:dd:ee:02'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-dc ip-address '10.10.10.101'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-dc name-server '10.10.10.101'

commit
save
```

> **Nota:** La IP de una reserva puede estar dentro o fuera del rango dinámico. Fuera del rango es lo más seguro para evitar conflictos si el pool se agota.

---

## 4. Opciones DHCP avanzadas

### Opciones personalizadas (option 43, 66, 67, etc.)

VyOS permite inyectar opciones DHCP arbitrarias por su número. Por ejemplo, para entregar la IP de un servidor TFTP (opción 66) a teléfonos IP:

```
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 bootfile-server '10.10.10.5'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 bootfile-name 'firmware.bin'
```

### Múltiples rangos en la misma subred

Si se quiere reservar un bloque intermedio (por ejemplo, para impresoras con IP fija entre `.50` y `.99`):

```
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 start '192.168.1.100'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 stop  '192.168.1.149'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 1 start '192.168.1.200'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 1 stop  '192.168.1.250'

commit
save
```

El bloque `192.168.1.150 – 192.168.1.199` queda libre para asignación manual.

---

## 5. Verificación y troubleshooting

### Ver leases activos

```bash
show dhcp server leases
```

Muestra IP asignada, MAC, hostname del cliente y tiempo de expiración.

```bash
show dhcp server leases pool VLAN20
```

Filtra por pool específico.

### Ver estadísticas del servidor

```bash
show dhcp server statistics
```

Útil para detectar pools exhaustos (`pool full`) antes de que los usuarios reporten problemas.

### Ver la configuración actual

```bash
show service dhcp-server
```

### Liberar un lease manualmente

```bash
clear dhcp server lease ip 192.168.1.105
```

Útil cuando un equipo cambió de MAC y el lease anterior todavía está activo.

### Verificar desde el cliente (Linux)

```bash
# Renovar lease
sudo dhclient -r eth0 && sudo dhclient eth0

# Ver qué IP y opciones se recibieron
ip addr show eth0
cat /etc/resolv.conf
```

### Logs del servidor DHCP

```bash
show log dhcp server
```

O en tiempo real:

```bash
monitor log | match DHCP
```

---

## 6. Ejemplo completo — configuración final

Resumen de todo lo anterior en un bloque limpio para copiar y adaptar:

```
configure

# --- LAN principal ---
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 start '192.168.1.100'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 range 0 stop  '192.168.1.200'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 default-router '192.168.1.1'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 name-server '1.1.1.1'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 name-server '8.8.8.8'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 domain-name 'corp.local'
set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 lease '86400'

# --- VLAN 10 Servidores ---
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 range 0 start '10.10.10.10'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 range 0 stop  '10.10.10.50'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 default-router '10.10.10.1'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 name-server '10.10.10.1'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 domain-name 'srv.corp.local'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 lease '86400'

# Reservas VLAN 10
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-nfs mac 'aa:bb:cc:dd:ee:01'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-nfs ip-address '10.10.10.100'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-dc mac 'aa:bb:cc:dd:ee:02'
set service dhcp-server shared-network-name VLAN10 subnet 10.10.10.0/24 static-mapping srv-dc ip-address '10.10.10.101'

# --- VLAN 20 Usuarios ---
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 range 0 start '10.10.20.50'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 range 0 stop  '10.10.20.200'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 default-router '10.10.20.1'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 name-server '1.1.1.1'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 name-server '8.8.8.8'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 domain-name 'corp.local'
set service dhcp-server shared-network-name VLAN20 subnet 10.10.20.0/24 lease '28800'

commit
save
```

---

## Resumen de comandos útiles

| Tarea | Comando |
|---|---|
| Ver todos los leases | `show dhcp server leases` |
| Ver leases de un pool | `show dhcp server leases pool VLAN10` |
| Ver estadísticas | `show dhcp server statistics` |
| Ver configuración | `show service dhcp-server` |
| Liberar lease por IP | `clear dhcp server lease ip <IP>` |
| Ver logs en tiempo real | `monitor log \| match DHCP` |

---

## Próximos pasos

Con DHCP en funcionamiento, los siguientes pasos naturales son:

- **DNS Forwarder local** (`set service dns forwarding`) para que VyOS resuelva nombres internos y reenvíe el resto
- **DHCP Relay** si tienes switches de capa 3 y los servidores DHCP están en otra subred
- **IPv6 con DHCPv6** (`set service dhcpv6-server`) o SLAAC para dual-stack
