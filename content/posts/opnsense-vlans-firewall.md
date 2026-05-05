---
title: "OPNsense: 5 VLANs, Aislamiento y Seguridad de Perímetro"
date: 2026-04-07
tags: ["opnsense", "vlan", "firewall", "seguridad", "rfc1918"]
description: "Configuración completa de 5 VLANs en OPNsense: asignación de IPs, aislamiento inter-VLAN vía firewall, permitir internet bloqueando RFC 1918, y hardening del perímetro."
---

OPNsense es un firewall serio. Pero la GUI puede generar confusión sobre el orden correcto de operaciones — especialmente cuando combinas VLANs, interfaces, y reglas de firewall que dependen unas de otras. Este post sigue el orden exacto en que debes hacer cada paso para llegar a una configuración funcional y segura.

## Escenario

Un único puerto físico (`em1`) actúa como trunk hacia un switch administrado. Cinco VLANs para segmentos distintos:

| VLAN | ID  | Red              | Propósito            |
|------|-----|------------------|----------------------|
| MGT  | 10  | 10.0.10.0/24     | Gestión de red       |
| SRV  | 20  | 10.0.20.0/24     | Servidores internos  |
| USR  | 30  | 10.0.30.0/24     | Usuarios / endpoints |
| IOT  | 40  | 10.0.40.0/24     | Dispositivos IoT     |
| DMZ  | 50  | 10.0.50.0/24     | Servicios publicados |

El router tiene IP `.1` en cada subred. WAN en `em0`.

---

## 1. Crear las VLANs

**Interfaces → Other Types → VLAN → Add**

Repite para cada VLAN:

| Parent    | VLAN tag | Description |
|-----------|----------|-------------|
| em1       | 10       | VLAN_MGT    |
| em1       | 20       | VLAN_SRV    |
| em1       | 30       | VLAN_USR    |
| em1       | 40       | VLAN_IOT    |
| em1       | 50       | VLAN_DMZ    |

Guarda cada una. Aún no son interfaces asignadas — son solo subinterfaces lógicas.

---

## 2. Asignar interfaces

**Interfaces → Assignments → Add**

Asigna cada VLAN a una interfaz con nombre descriptivo:

| Network port       | Interface name |
|--------------------|----------------|
| em1.10 (VLAN_MGT)  | MGT            |
| em1.20 (VLAN_SRV)  | SRV            |
| em1.30 (VLAN_USR)  | USR            |
| em1.40 (VLAN_IOT)  | IOT            |
| em1.50 (VLAN_DMZ)  | DMZ            |

Guarda. Ahora aparecen en **Interfaces →** como entradas editables.

---

## 3. Configurar cada interfaz

**Interfaces → MGT** (repite para cada una):

- **Enable**: ✓
- **IPv4 Configuration Type**: Static IPv4
- **IPv4 address**: `10.0.10.1 / 24`
- **Block private networks**: ✗ (esto va en WAN, no aquí)
- **Block bogon networks**: ✗

Guarda y aplica. Haz lo mismo para SRV (`.20.1`), USR (`.30.1`), IOT (`.40.1`), DMZ (`.50.1`).

> Si no habilitas la interfaz explícitamente, OPNsense no crea la entrada en la tabla de rutas ni activa DHCP para esa red.

---

## 4. DHCP por VLAN

**Services → ISC DHCPv4 → [Interface]**

Para cada interfaz:

| Interfaz | Range start  | Range end      | DNS          |
|----------|--------------|----------------|--------------|
| MGT      | 10.0.10.100  | 10.0.10.200    | 10.0.10.1    |
| SRV      | 10.0.20.100  | 10.0.20.200    | 10.0.20.1    |
| USR      | 10.0.30.100  | 10.0.30.200    | 10.0.30.1    |
| IOT      | 10.0.40.100  | 10.0.40.200    | 10.0.40.1    |
| DMZ      | 10.0.50.100  | 10.0.50.200    | 10.0.50.1    |

Activa **Enable DHCP server on [interface]** y guarda.

---

## 5. Lógica de firewall: el modelo mental

OPNsense evalúa reglas **por interfaz de entrada**, de arriba hacia abajo, primera coincidencia gana. Hay un **deny implícito** al final de cada interfaz — no necesitas escribirlo.

El objetivo para cada VLAN interna:

1. **Permitir** tráfico hacia internet (cualquier IP que no sea RFC 1918 ni bogon).
2. **Bloquear** tráfico hacia otras VLANs y redes privadas (aislamiento).
3. **Permitir** consultas DNS y DHCP hacia el router si usas el resolver local.
4. **Bloquear** acceso a la GUI de OPNsense desde VLANs no administrativas.

El orden importa: coloca los bloques específicos antes de los permisos amplios.

---

## 6. Alias: RFC 1918 y Bogons

Antes de escribir reglas, define aliases reutilizables.

**Firewall → Aliases → Add**

**Alias: RFC1918**

| Campo       | Valor                                      |
|-------------|--------------------------------------------|
| Name        | `RFC1918`                                  |
| Type        | Network                                    |
| Networks    | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| Description | Espacio privado RFC 1918                   |

**Alias: VLANS_ALL** (todas las subredes propias, útil para reglas de bloqueo)

| Campo    | Valor                                                                                      |
|----------|--------------------------------------------------------------------------------------------|
| Name     | `VLANS_ALL`                                                                                |
| Type     | Network                                                                                    |
| Networks | `10.0.10.0/24`, `10.0.20.0/24`, `10.0.30.0/24`, `10.0.40.0/24`, `10.0.50.0/24`           |

**Alias: OPNSENSE_GUI** (proteger acceso a la gestión)

| Campo    | Valor                        |
|----------|------------------------------|
| Name     | `OPNSENSE_GUI`               |
| Type     | Port                         |
| Ports    | `443`, `80`                  |

---

## 7. Reglas de firewall por interfaz

Las reglas se crean en **Firewall → Rules → [Interface]**.

### Plantilla aplicable a USR, IOT y DMZ

Estas tres VLANs son las menos confiables. Aplica este set de reglas en ese orden:

**Regla 1 — Permitir DNS hacia el router** *(opcional si usas Unbound)*

| Campo           | Valor                    |
|-----------------|--------------------------|
| Action          | Pass                     |
| Interface       | USR / IOT / DMZ          |
| Protocol        | TCP/UDP                  |
| Source          | USR net / IOT net / DMZ net |
| Destination     | This Firewall            |
| Dest. Port      | DNS (53)                 |
| Description     | Permitir DNS local        |

**Regla 2 — Bloquear acceso a la GUI del firewall**

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Block              |
| Protocol        | TCP                |
| Source          | *net               |
| Destination     | This Firewall      |
| Dest. Port      | OPNSENSE_GUI       |
| Description     | Bloquear acceso GUI |

**Regla 3 — Bloquear hacia RFC 1918 (aislamiento inter-VLAN)**

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Block              |
| Protocol        | any                |
| Source          | *net               |
| Destination     | RFC1918            |
| Description     | Bloquear RFC 1918  |

**Regla 4 — Permitir hacia internet**

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Pass               |
| Protocol        | any                |
| Source          | *net               |
| Destination     | any                |
| Description     | Permitir internet  |

El orden 2→3→4 es el que importa. La regla 3 bloquea todas las IPs privadas (incluyendo las otras VLANs y el propio router excepto el DNS ya permitido en regla 1). La regla 4 solo alcanza lo que no fue bloqueado antes — es decir, IPs públicas.

### MGT — Interfaz administrativa

MGT es la red desde donde administras equipos. Tiene más permisos pero sigue sin acceso directo a IOT ni DMZ sin regla explícita:

**Regla 1 — Permitir todo desde MGT** *(o limitar por puerto si quieres ser estricto)*

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Pass               |
| Protocol        | any                |
| Source          | MGT net            |
| Destination     | any                |
| Description     | MGT acceso total   |

> Si el principio de mínimo privilegio importa aquí, sustituye "any" por un alias con destinos explícitos. En muchos entornos MGT es la red del operador y esta concesión es aceptable.

### SRV — Servidores internos

Los servidores pueden necesitar hablar entre ellos y hacia internet, pero no deben iniciar conexiones hacia USR ni IOT:

**Regla 1 — Bloquear hacia USR e IOT**

| Campo           | Valor                  |
|-----------------|------------------------|
| Action          | Block                  |
| Source          | SRV net                |
| Destination     | USR net, IOT net       |

**Regla 2 — Permitir hacia DMZ** *(si los servidores publican hacia DMZ)*

| Campo           | Valor        |
|-----------------|--------------|
| Action          | Pass         |
| Source          | SRV net      |
| Destination     | DMZ net      |

**Regla 3 — Permitir internet**

| Campo           | Valor        |
|-----------------|--------------|
| Action          | Pass         |
| Source          | SRV net      |
| Destination     | any          |

---

## 8. Reglas en WAN: proteger el perímetro

**Firewall → Rules → WAN**

OPNsense por defecto bloquea todo tráfico entrante en WAN sin regla explícita — el deny implícito es suficiente para lo que no publiques. Refuerza el perímetro con estas reglas adicionales:

**Bloquear RFC 1918 entrante** *(spoofing de origen privado)*

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Block              |
| Interface       | WAN                |
| Source          | RFC1918            |
| Destination     | any                |
| Log             | ✓                  |
| Description     | Bloquear spoof RFC1918 desde WAN |

**Bloquear Bogons** *(ya hay opción en la interfaz WAN, pero una regla explícita permite logging)*

Alternativamente, activa **Block private networks** y **Block bogon networks** directamente en **Interfaces → WAN** — OPNsense genera estas reglas internamente y las aplica antes que las reglas manuales.

**Permitir servicios publicados desde DMZ** *(si aplica)*

Solo agrega reglas de permitir para los puertos que realmente publicas. Ejemplo para HTTPS:

| Campo           | Valor              |
|-----------------|--------------------|
| Action          | Pass               |
| Interface       | WAN                |
| Protocol        | TCP                |
| Destination     | DMZ net            |
| Dest. Port      | 443                |
| Description     | HTTPS público → DMZ |

---

## 9. Verificación

**Confirmar que las interfaces tienen IP:**

**Interfaces → Overview** — cada VLAN debe mostrar su IP `.1` y estado `up`.

**Confirmar rutas:**

**System → Routes → Status**

Debes ver una entrada `/24` por cada VLAN apuntando a su interfaz respectiva.

**Probar aislamiento desde un cliente en USR:**

```bash
# Debe fallar (RFC 1918 bloqueado)
ping 10.0.20.1       # SRV gateway
ping 10.0.40.50      # dispositivo IoT

# Debe funcionar
ping 8.8.8.8
curl https://example.com
```

**Ver logs de bloqueos en tiempo real:**

**Firewall → Log Files → Live View** — filtra por interfaz y acción `block` para confirmar que los bloqueos se están generando con las reglas correctas.

**Diagnóstico desde la GUI:**

**Interfaces → Diagnostics → Ping** — selecciona la interfaz de origen para simular tráfico desde cada VLAN sin necesitar un cliente físico.

---

## 10. Hardening adicional del perímetro

**Deshabilitar acceso a la GUI desde WAN:**

**System → Settings → Administration** → desactiva acceso HTTP/HTTPS desde WAN si no usas gestión remota. Usa una VPN para administración remota.

**IDS/IPS con Suricata:**

**Services → Introspection → Suricata** — actívalo en la interfaz WAN en modo IPS (inline). El conjunto de reglas ET Open cubre amenazas comunes sin coste adicional.

**Limitar intentos de acceso a la GUI:**

**System → Settings → Administration → Login Protection** — activa el rate limiting. Evita fuerza bruta contra la GUI incluso desde redes internas.

**Actualizaciones automáticas de reglas IDS:**

**Services → Introspection → Suricata → Download** — configura actualización diaria de reglas. Las amenazas cambian; las reglas estáticas envejecen mal.

---

## Resumen del modelo de confianza

| Desde \ Hacia | MGT | SRV | USR | IOT | DMZ | Internet |
|---------------|-----|-----|-----|-----|-----|----------|
| **MGT**       | ✓   | ✓   | ✓   | ✓   | ✓   | ✓        |
| **SRV**       | ✗   | ✓   | ✗   | ✗   | ✓   | ✓        |
| **USR**       | ✗   | ✗   | ✓   | ✗   | ✗   | ✓        |
| **IOT**       | ✗   | ✗   | ✗   | ✓   | ✗   | ✓        |
| **DMZ**       | ✗   | ✗   | ✗   | ✗   | ✓   | ✓        |
| **WAN**       | ✗   | ✗   | ✗   | ✗   | Puerto específico | — |

El principio es simple: cada segmento puede salir a internet pero no puede hablar lateralmente con otros segmentos salvo que haya una regla explícita que lo justifique. MGT es la excepción controlada — es la red desde la que operas, y tiene visibilidad total a propósito.
