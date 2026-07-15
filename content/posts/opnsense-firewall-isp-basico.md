---
title: "OPNsense como Firewall Básico para ISP"
date: 2026-07-14
tags: ["opnsense", "firewall", "isp", "bgp", "nat", "pppoe", "infraestructura"]
description: "Configuración base de OPNsense en un entorno ISP: interfaces de tránsito, protección de infraestructura, NAT o sin NAT, firewall de perímetro y acceso de gestión seguro."
---

Un ISP tiene requisitos distintos a una red corporativa. No hay usuarios internos navegando sitios de entretenimiento — hay clientes con IPs asignadas, tránsito hacia upstream providers, equipos de red que deben protegerse del tráfico de clientes, y un plano de gestión que no puede quedar expuesto. OPNsense cubre este caso de uso con solidez si entiendes qué configurar y en qué orden.

## Topología de referencia

```
Upstream (tránsito)
       │
   [ em0 ] — WAN / Transit
   OPNsense
   [ em1 ] — Red de clientes (PPPoE o IPs estáticas)
   [ em2 ] — Gestión (OOB / equipos de red)
```

| Interfaz | Nombre  | Red              | Propósito                        |
|----------|---------|------------------|----------------------------------|
| em0      | WAN     | IP del upstream  | Tránsito hacia internet          |
| em1      | CLIENTES| 100.64.0.0/22    | Segmento de clientes (CG-NAT o pública) |
| em2      | MGMT    | 10.255.0.0/24    | Gestión de infraestructura       |

> `100.64.0.0/10` es el espacio CGNAT (RFC 6598). Úsalo si no tienes IPs públicas para todos tus clientes.

---

## 1. Interfaces

**Interfaces → Assignments**

Asigna las tres interfaces y nómbralas. Luego configura cada una:

### WAN (em0)
- **IPv4 Type**: Static (o DHCP si tu upstream lo requiere)
- **IPv4**: IP asignada por tu upstream / BGP peer
- **Block private networks**: ✓
- **Block bogon networks**: ✓

### CLIENTES (em1)
- **Enable**: ✓
- **IPv4 Type**: Static
- **IPv4**: `100.64.0.1 / 22`
- **Block private networks**: ✗

### MGMT (em2)
- **Enable**: ✓
- **IPv4 Type**: Static
- **IPv4**: `10.255.0.1 / 24`
- **Block private networks**: ✗

---

## 2. Routing

Si tu upstream te da una ruta default vía DHCP o un gateway estático:

**System → Gateways → Add**

| Campo        | Valor                   |
|--------------|-------------------------|
| Name         | GW_UPSTREAM             |
| Interface    | WAN                     |
| IP Address   | IP de tu upstream       |
| Monitor IP   | 8.8.8.8 (o tu upstream) |

**System → Routes → Add**

| Campo       | Valor         |
|-------------|---------------|
| Network     | 0.0.0.0/0     |
| Gateway     | GW_UPSTREAM   |

Si usas BGP, instala el plugin `os-frr` desde **System → Firmware → Plugins** y configura FRR — la ruta default llegará por el proceso de routing sin necesidad de entrada manual.

---

## 3. NAT

### Opción A — Sin NAT (IPs públicas para clientes)

Si asignas IPs públicas directamente a tus clientes, desactiva el NAT de salida automático:

**Firewall → NAT → Outbound** → Selecciona **Disable Outbound NAT**

El tráfico de clientes sale con su IP de origen real. Asegúrate de que tu upstream acepta esos prefijos (filtra por AS origin o prefix-list en BGP).

### Opción B — CG-NAT (100.64.0.0/22 → IP pública)

**Firewall → NAT → Outbound** → Selecciona **Manual Outbound NAT**

Agrega una regla:

| Campo       | Valor                    |
|-------------|--------------------------|
| Interface   | WAN                      |
| Source      | 100.64.0.0/22            |
| Translation | WAN address (o pool)     |
| Description | CG-NAT clientes          |

> CG-NAT introduce limitaciones en aplicaciones que dependen de IP de origen único (gaming, VoIP, algunos VPNs). Considera port block allocation si tu volumen de clientes lo requiere.

---

## 4. Aliases

**Firewall → Aliases → Add**

Define estos antes de escribir reglas:

**RFC1918** — espacio privado

| Campo    | Valor                                          |
|----------|------------------------------------------------|
| Name     | RFC1918                                        |
| Type     | Network                                        |
| Networks | 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16     |

**CGNAT_SPACE**

| Campo    | Valor           |
|----------|-----------------|
| Name     | CGNAT_SPACE     |
| Type     | Network         |
| Networks | 100.64.0.0/10   |

**INFRA_MGMT** — equipos de red bajo gestión

| Campo    | Valor                             |
|----------|-----------------------------------|
| Name     | INFRA_MGMT                        |
| Type     | Network                           |
| Networks | 10.255.0.0/24, 10.255.1.0/24, ... |

**PUERTOS_GESTION** — acceso SSH/HTTPS a routers

| Campo | Valor       |
|-------|-------------|
| Name  | PUERTOS_GESTION |
| Type  | Port        |
| Ports | 22, 443, 8291 (Winbox) |

---

## 5. Reglas de firewall

### WAN — perímetro externo

**Firewall → Rules → WAN**

OPNsense bloquea todo por defecto en WAN. Solo agrega lo que necesitas:

**Regla 1 — Bloquear spoofing de origen privado** *(logging útil)*

| Campo       | Valor                           |
|-------------|---------------------------------|
| Action      | Block                           |
| Source      | RFC1918                         |
| Destination | any                             |
| Log         | ✓                               |
| Description | Bloquear spoof RFC1918 desde WAN|

**Regla 2 — Bloquear spoofing de espacio CGNAT**

| Campo       | Valor                            |
|-------------|----------------------------------|
| Action      | Block                            |
| Source      | CGNAT_SPACE                      |
| Destination | any                              |
| Log         | ✓                                |
| Description | Bloquear spoof 100.64/10 desde WAN|

**Regla 3 — Permitir BGP** *(si aplica)*

| Campo       | Valor             |
|-------------|-------------------|
| Action      | Pass              |
| Protocol    | TCP               |
| Source      | IP del peer BGP   |
| Destination | WAN address       |
| Dest. Port  | 179               |
| Description | BGP upstream      |

El deny implícito final bloquea cualquier otro tráfico entrante no solicitado.

---

### CLIENTES — el segmento más riesgoso

**Firewall → Rules → CLIENTES**

Los clientes no deben alcanzar tu infraestructura de gestión. Solo deben tener internet.

**Regla 1 — Bloquear acceso a infraestructura de gestión**

| Campo       | Valor         |
|-------------|---------------|
| Action      | Block         |
| Source      | CLIENTES net  |
| Destination | INFRA_MGMT    |
| Log         | ✓             |
| Description | Bloquear clientes → infraestructura |

**Regla 2 — Bloquear acceso a la GUI de OPNsense**

| Campo       | Valor          |
|-------------|----------------|
| Action      | Block          |
| Protocol    | TCP            |
| Source      | CLIENTES net   |
| Destination | This Firewall  |
| Dest. Port  | 443, 80        |
| Description | Bloquear acceso GUI |

**Regla 3 — Bloquear tráfico lateral entre clientes** *(si están en la misma subred)*

| Campo       | Valor         |
|-------------|---------------|
| Action      | Block         |
| Source      | CLIENTES net  |
| Destination | CLIENTES net  |
| Description | Bloquear tráfico cliente-cliente |

> Esta regla es importante en CGNAT: evita que un cliente escanee o ataque a otro dentro del mismo bloque 100.64/22.

**Regla 4 — Permitir DNS hacia el resolver local** *(si sirves DNS a clientes)*

| Campo       | Valor         |
|-------------|---------------|
| Action      | Pass          |
| Protocol    | TCP/UDP       |
| Source      | CLIENTES net  |
| Destination | This Firewall |
| Dest. Port  | 53            |
| Description | DNS local     |

**Regla 5 — Permitir internet**

| Campo       | Valor         |
|-------------|---------------|
| Action      | Pass          |
| Protocol    | any           |
| Source      | CLIENTES net  |
| Destination | any           |
| Description | Internet      |

---

### MGMT — plano de gestión

**Firewall → Rules → MGMT**

La red de gestión administra routers, switches y el propio OPNsense. Tiene acceso amplio pero solo desde hosts autorizados.

**Regla 1 — Permitir todo desde MGMT**

| Campo       | Valor     |
|-------------|-----------|
| Action      | Pass      |
| Source      | MGMT net  |
| Destination | any       |
| Description | Acceso total desde gestión |

Si quieres ser más estricto, limita el destino a `INFRA_MGMT` y agrega una segunda regla para internet con destino `any`.

---

## 6. DNS para clientes

Si sirves DNS recursivo a tus clientes desde OPNsense:

**Services → Unbound DNS → General**

- **Enable**: ✓
- **Listen Port**: 53
- **Network Interfaces**: CLIENTES, MGMT
- **DNSSEC**: ✓
- **DNS64**: opcional si mezclas IPv4/IPv6

Agrega ACLs para controlar quién puede consultar:

**Services → Unbound DNS → Access Lists**

| Red              | Acción |
|------------------|--------|
| 100.64.0.0/22    | Allow  |
| 10.255.0.0/24    | Allow  |
| 0.0.0.0/0        | Refuse |

---

## 7. Proteger la GUI de OPNsense

**System → Settings → Administration**

- **TCP Port**: cambia de 443 a un puerto no estándar (ej. 4443)
- **Listen Interfaces**: selecciona solo **MGMT** — la GUI nunca debe escuchar en WAN ni CLIENTES
- **HTTPs only**: ✓
- **Login Protection**: ✓ (rate limiting contra fuerza bruta)
- **Disable web GUI redirect rule**: ✓

Aplica y reconecta desde la interfaz MGMT.

---

## 8. Logging y visibilidad

**Firewall → Log Files → Live View**

Filtra por interfaz **CLIENTES** y acción **block** para ver intentos de acceso a la infraestructura. En un ISP es normal ver:

- Escaneos de puerto hacia `This Firewall`
- Intentos de SSH o Telnet hacia el gateway
- Tráfico CGNAT saliente bloqueado por reglas de aislamiento

**System → Settings → Logging → Remote Syslog**

Apunta hacia tu servidor de logs centralizado (Graylog, Loki, syslog-ng). En producción no quieres confiar solo en el storage local de OPNsense.

---

## 9. Verificación

**Desde un cliente en CLIENTES net:**

```bash
# Debe funcionar
curl https://example.com
dig @100.64.0.1 google.com        # DNS local

# Debe fallar
ping 10.255.0.1                    # Gateway MGMT — bloqueado
ssh 10.255.0.5                     # Router de infraestructura — bloqueado
curl https://100.64.0.1:4443       # GUI OPNsense — bloqueado
ping 100.64.0.100                  # Otro cliente — bloqueado
```

**Desde MGMT:**

```bash
ping 100.64.0.1                    # Gateway clientes — visible
ssh 10.255.0.5                     # Equipo de red — debe funcionar
curl -k https://10.255.0.1:4443    # GUI OPNsense — debe abrir
```

**Verificar rutas activas:**

**System → Routes → Status** — confirma la ruta default hacia `GW_UPSTREAM` y las rutas conectadas de cada interfaz.

---

## Resumen del modelo de acceso

| Desde \ Hacia   | Internet | Infra/MGMT | Otros clientes | GUI OPNsense |
|-----------------|----------|------------|----------------|--------------|
| **WAN**         | —        | ✗          | ✗              | ✗            |
| **CLIENTES**    | ✓        | ✗          | ✗              | ✗            |
| **MGMT**        | ✓        | ✓          | ✓              | ✓            |

El principio es el mismo que en cualquier infraestructura de red: los clientes son tráfico no confiable. La red de gestión es el único plano desde donde se opera la infraestructura, y ningún cliente debe poder alcanzarla — ni por error ni por intento deliberado.
