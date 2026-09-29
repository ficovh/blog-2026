---
title: "VyOS 1.5: MultiWAN con Balanceo de Carga y Failover"
date: 2026-09-28
tags: ["vyos", "router", "wan", "balanceo", "failover", "nat", "firewall", "linux"]
description: "Guía paso a paso para montar un router VyOS 1.5 con dos enlaces WAN: balanceo de carga por conexión, failover automático con health checks, exclusiones, pesos asimétricos y verificación."
---

Tener dos proveedores de internet solo sirve si el router sabe usarlos. VyOS resuelve esto con el módulo **WAN Load Balancing** (`load-balancing wan`), que reparte las conexiones nuevas entre varios enlaces, vigila la salud de cada uno y los saca de rotación cuando fallan — todo desde el mismo árbol de configuración, sin scripts externos ni marcas de mangle a mano como en otras plataformas.

Este post construye la configuración completa sobre **VyOS 1.5 (Circinus)**, paso a paso, explicando qué hace cada bloque y por qué está ahí.

## Escenario de referencia

```
ISP1 ─── eth0 (100 Mbps) ┐
                          ├─── VyOS ─── eth2 ─── LAN (192.168.10.0/24)
ISP2 ─── eth1 (100 Mbps) ┘
```

| Variable        | ISP1              | ISP2               | LAN                |
|-----------------|-------------------|--------------------|--------------------|
| Interfaz        | `eth0`            | `eth1`             | `eth2`             |
| IP del router   | `203.0.113.2/30`  | `198.51.100.2/30`  | `192.168.10.1/24`  |
| Gateway         | `203.0.113.1`     | `198.51.100.1`     | —                  |
| Host de monitoreo | `1.1.1.1`       | `9.9.9.9`          | —                  |

Ajusta las direcciones a tu entorno. Al final hay una sección con los cambios necesarios si uno o ambos ISPs te entregan la IP por DHCP.

### Cómo funciona el balanceo en VyOS

Antes de configurar conviene entender el mecanismo, porque explica varias decisiones posteriores:

1. Cada **conexión nueva** que entra por la LAN se evalúa contra las reglas de `load-balancing wan`, en orden numérico.
2. La regla que coincide elige una WAN según los **pesos** de las interfaces que estén sanas en ese momento.
3. La conexión queda marcada en conntrack; todos sus paquetes siguientes salen por la misma WAN. El balanceo es **por conexión**, no por paquete, así que una descarga individual nunca suma el ancho de banda de ambos enlaces — lo que se reparte es el conjunto de conexiones.
4. Un proceso de health check prueba cada WAN periódicamente. Si una falla, deja de recibir conexiones nuevas hasta que se recupere.
5. Por defecto, el módulo aplica **source NAT (masquerade)** automáticamente con la IP de la WAN elegida.

---

## 1. Interfaces

Entra al modo de configuración:

```bash
configure
```

Asigna direcciones y descripciones:

```
set interfaces ethernet eth0 description 'WAN1-ISP1'
set interfaces ethernet eth0 address '203.0.113.2/30'

set interfaces ethernet eth1 description 'WAN2-ISP2'
set interfaces ethernet eth1 address '198.51.100.2/30'

set interfaces ethernet eth2 description 'LAN'
set interfaces ethernet eth2 address '192.168.10.1/24'
```

```
commit
```

Antes de seguir, comprueba que cada gateway responde desde su propia interfaz:

```bash
run ping 203.0.113.1 interface eth0 count 3
run ping 198.51.100.1 interface eth1 count 3
```

Si alguno no responde, no tiene sentido continuar: el balanceador necesita que ambos enlaces funcionen a nivel de capa 3.

---

## 2. Rutas estáticas

Necesitamos dos tipos de rutas.

### Ruta default en la tabla principal

El balanceador crea sus propias tablas de enrutamiento para el tráfico que viene de la LAN, pero el **tráfico originado por el propio router** (DNS del router, NTP, actualizaciones, `ping` desde la CLI) usa la tabla principal. Le damos una default por cada ISP con distancias distintas:

```
set protocols static route 0.0.0.0/0 next-hop 203.0.113.1 distance '1'
set protocols static route 0.0.0.0/0 next-hop 198.51.100.1 distance '10'
```

Con esto el router sale por ISP1 y usa ISP2 si la interfaz `eth0` pierde enlace. Más adelante (paso 8) veremos cómo hacer que también reaccione a caídas upstream.

### Rutas de host para los monitores

Cada WAN se vigilará haciendo ping a un host externo distinto. Fijamos una ruta `/32` para que cada host de monitoreo **siempre** se alcance por su enlace correspondiente:

```
set protocols static route 1.1.1.1/32 next-hop 203.0.113.1
set protocols static route 9.9.9.9/32 next-hop 198.51.100.1
```

**Por qué esto importa**: sin estas rutas, el ping de monitoreo de WAN2 podría resolverse por la tabla principal y salir por WAN1. Resultado: si ISP2 cae aguas arriba, el health check seguiría respondiendo y el enlace nunca se marcaría como caído. La ruta de host garantiza que la prueba mide el enlace correcto.

> El costo es que `1.1.1.1` y `9.9.9.9` quedan atados a un solo ISP. Por eso conviene usar como monitores IPs que no uses para otra cosa (no las pongas como DNS de la LAN), o bien una IP estable dentro de la red de cada ISP.

```
commit
```

---

## 3. Health checks de cada WAN

Aquí se define cómo decide VyOS si un enlace está vivo:

```
# WAN1
set load-balancing wan interface-health eth0 nexthop '203.0.113.1'
set load-balancing wan interface-health eth0 failure-count '3'
set load-balancing wan interface-health eth0 success-count '2'
set load-balancing wan interface-health eth0 test 10 type 'ping'
set load-balancing wan interface-health eth0 test 10 target '1.1.1.1'
set load-balancing wan interface-health eth0 test 10 resp-time '3'

# WAN2
set load-balancing wan interface-health eth1 nexthop '198.51.100.1'
set load-balancing wan interface-health eth1 failure-count '3'
set load-balancing wan interface-health eth1 success-count '2'
set load-balancing wan interface-health eth1 test 10 type 'ping'
set load-balancing wan interface-health eth1 test 10 target '9.9.9.9'
set load-balancing wan interface-health eth1 test 10 resp-time '3'
```

| Parámetro       | Significado |
|-----------------|-------------|
| `nexthop`       | Gateway del ISP. El balanceador lo usa para construir la tabla de ruteo propia de esa WAN. Es obligatorio. |
| `failure-count` | Pruebas fallidas consecutivas para marcar el enlace como caído. |
| `success-count` | Pruebas exitosas consecutivas para devolverlo a rotación. |
| `test N type`   | `ping`, `ttl` (prueba estilo traceroute con TTL limitado) o `user-defined` (script propio). |
| `target`        | Host al que se prueba. |
| `resp-time`     | Segundos máximos de espera por respuesta. |

**Por qué no probar solo el gateway**: el gateway del ISP suele ser el equipo que tienes enfrente (su CPE o su BRAS). Puede responder perfectamente mientras el ISP no tiene salida a internet. Probar un host externo detecta caídas aguas arriba.

**Ajuste de sensibilidad**: `failure-count 3` con `success-count 2` es un balance razonable. Valores más bajos reaccionan más rápido pero provocan *flapping* ante pérdida de paquetes puntual; valores más altos toleran enlaces ruidosos pero tardan más en hacer failover.

---

## 4. Reglas de exclusión

Antes de balancear, sacamos del juego el tráfico que **no** debe ir a internet. Si no lo haces, el tráfico entre tu LAN y otras redes privadas (VLANs, VPN, oficinas remotas) puede terminar marcado y enviado a una WAN.

```
set load-balancing wan rule 5 description 'No balancear trafico privado'
set load-balancing wan rule 5 inbound-interface 'eth2'
set load-balancing wan rule 5 exclude
set load-balancing wan rule 5 destination address '192.168.0.0/16'

set load-balancing wan rule 6 description 'No balancear trafico privado'
set load-balancing wan rule 6 inbound-interface 'eth2'
set load-balancing wan rule 6 exclude
set load-balancing wan rule 6 destination address '10.0.0.0/8'

set load-balancing wan rule 7 description 'No balancear trafico privado'
set load-balancing wan rule 7 inbound-interface 'eth2'
set load-balancing wan rule 7 exclude
set load-balancing wan rule 7 destination address '172.16.0.0/12'
```

El tráfico excluido se enruta normalmente con la tabla principal. Las reglas se evalúan en orden numérico y la primera que coincide gana, así que las exclusiones deben llevar números **menores** que la regla de balanceo.

---

## 5. Regla de balanceo

La regla principal: todo lo que entra por la LAN se reparte entre ambas WAN.

```
set load-balancing wan rule 100 description 'Balanceo LAN'
set load-balancing wan rule 100 inbound-interface 'eth2'
set load-balancing wan rule 100 protocol 'all'
set load-balancing wan rule 100 interface eth0 weight '1'
set load-balancing wan rule 100 interface eth1 weight '1'
```

Con pesos iguales, cada WAN recibe aproximadamente el 50% de las conexiones nuevas. Si una WAN cae, la regla sigue funcionando con la interfaz que queda: **el failover ya está incluido en el balanceo**, no hace falta configurarlo aparte.

### Enlaces de capacidad distinta

Si ISP1 es de 300 Mbps e ISP2 de 100 Mbps, reparte en proporción 3:1:

```
set load-balancing wan rule 100 interface eth0 weight '3'
set load-balancing wan rule 100 interface eth1 weight '1'
```

Los pesos son relativos: ISP1 recibe 3 de cada 4 conexiones nuevas.

---

## 6. Opciones globales

```
set load-balancing wan sticky-connections inbound
set load-balancing wan flush-connections
```

- **`sticky-connections inbound`**: una conexión que *entra* por una WAN (por ejemplo, un port forward hacia un servidor de la LAN) responde por esa misma WAN. Sin esto, la respuesta podría salir por la otra, con una IP de origen distinta, y el cliente remoto la descartaría.
- **`flush-connections`**: cuando una WAN cambia de estado, VyOS limpia la tabla de conntrack. Las conexiones atadas al enlace caído se reestablecen de inmediato por el enlace sano en lugar de quedar colgadas hasta su timeout. El costo es que las conexiones del enlace sano también se reinician en ese momento; si eso te molesta más que las sesiones colgadas, omite esta opción.

### Source NAT

El balanceador aplica masquerade automáticamente por la interfaz de salida elegida, así que **no necesitas reglas NAT adicionales** para este escenario. Si prefieres controlar NAT tú mismo (por ejemplo, para usar un pool de IPs públicas en lugar de la IP de la interfaz), desactívalo y define las reglas explícitamente:

```
set load-balancing wan disable-source-nat

set nat source rule 100 outbound-interface name 'eth0'
set nat source rule 100 source address '192.168.10.0/24'
set nat source rule 100 translation address 'masquerade'

set nat source rule 110 outbound-interface name 'eth1'
set nat source rule 110 source address '192.168.10.0/24'
set nat source rule 110 translation address 'masquerade'
```

Aplica y guarda:

```
commit
save
```

---

## 7. Tráfico fijo a un enlace (con respaldo)

Algunos servicios se rompen si la IP pública de origen cambia entre conexiones: VPNs site-to-site, sesiones de banca en línea, paneles que validan IP de origen, VoIP con registro SIP. Para ellos, en lugar de balancear, usamos una regla **failover**: siempre sale por el enlace de mayor peso y solo usa el otro si el primero cae.

```
# WireGuard saliente: siempre por ISP1, respaldo ISP2
set load-balancing wan rule 20 description 'WireGuard fijo a WAN1'
set load-balancing wan rule 20 inbound-interface 'eth2'
set load-balancing wan rule 20 protocol 'udp'
set load-balancing wan rule 20 destination port '51820'
set load-balancing wan rule 20 failover
set load-balancing wan rule 20 interface eth0 weight '10'
set load-balancing wan rule 20 interface eth1 weight '1'

# Un host de la LAN (servidor VoIP) siempre por ISP2, respaldo ISP1
set load-balancing wan rule 30 description 'PBX fijo a WAN2'
set load-balancing wan rule 30 inbound-interface 'eth2'
set load-balancing wan rule 30 source address '192.168.10.50'
set load-balancing wan rule 30 failover
set load-balancing wan rule 30 interface eth0 weight '1'
set load-balancing wan rule 30 interface eth1 weight '10'
```

En modo `failover`, el peso no reparte tráfico: define **prioridad**. La interfaz sana con mayor peso es la que se usa.

Observa la numeración final de las reglas:

| Regla | Tipo      | Qué hace                                 |
|-------|-----------|------------------------------------------|
| 5–7   | exclude   | Tráfico privado → tabla principal        |
| 20    | failover  | WireGuard → WAN1 (respaldo WAN2)         |
| 30    | failover  | PBX → WAN2 (respaldo WAN1)               |
| 100   | balanceo  | Todo lo demás → 50/50                    |

Las reglas específicas siempre antes que la general.

```
commit
save
```

---

## 8. Hook: reaccionar a cambios de estado

El balanceador puede ejecutar un script cada vez que una WAN cambia de estado. Lo usaremos para dos cosas: dejar registro en el log y mover la ruta default de la **tabla principal** (la que usa el propio router, paso 2), que por sí sola solo reacciona a caídas de enlace físico.

Crea el script:

```bash
sudo tee /config/scripts/wlb-hook.sh > /dev/null << 'EOF'
#!/bin/vbash
# Variables que entrega VyOS:
#   WLB_INTERFACE_NAME   -> eth0, eth1...
#   WLB_INTERFACE_STATE  -> ACTIVE | FAILED

source /opt/vyatta/etc/functions/script-template

logger -t wlb-hook "WAN ${WLB_INTERFACE_NAME} ahora esta ${WLB_INTERFACE_STATE}"

if [ "${WLB_INTERFACE_NAME}" = "eth0" ]; then
    configure
    if [ "${WLB_INTERFACE_STATE}" = "FAILED" ]; then
        set protocols static route 0.0.0.0/0 next-hop 203.0.113.1 distance '250'
    else
        set protocols static route 0.0.0.0/0 next-hop 203.0.113.1 distance '1'
    fi
    commit
    exit
fi
EOF
sudo chmod +x /config/scripts/wlb-hook.sh
```

Regístralo en la configuración:

```
set load-balancing wan hook '/config/scripts/wlb-hook.sh'
commit
save
```

Cuando ISP1 falla, su ruta default sube a distancia 250 y la de ISP2 (distancia 10) toma el control para el tráfico del propio router. Cuando ISP1 regresa, se restaura.

> `/config/scripts/` sobrevive a las actualizaciones de imagen de VyOS. No guardes scripts en otro lugar.

---

## 9. Firewall

El balanceo no reemplaza al firewall. Una base mínima con la sintaxis de VyOS 1.5 que protege al router en ambas WAN:

```
# Estado de conexiones, global
set firewall global-options state-policy established action 'accept'
set firewall global-options state-policy related action 'accept'
set firewall global-options state-policy invalid action 'drop'

# Tráfico hacia el router
set firewall ipv4 input filter default-action 'drop'
set firewall ipv4 input filter rule 10 description 'LAN al router'
set firewall ipv4 input filter rule 10 action 'accept'
set firewall ipv4 input filter rule 10 inbound-interface name 'eth2'
set firewall ipv4 input filter rule 20 description 'ICMP desde WAN'
set firewall ipv4 input filter rule 20 action 'accept'
set firewall ipv4 input filter rule 20 protocol 'icmp'
set firewall ipv4 input filter rule 30 action 'accept'
set firewall ipv4 input filter rule 30 inbound-interface name 'lo'

# Tráfico a través del router
set firewall ipv4 forward filter default-action 'drop'
set firewall ipv4 forward filter rule 10 description 'LAN a internet'
set firewall ipv4 forward filter rule 10 action 'accept'
set firewall ipv4 forward filter rule 10 inbound-interface name 'eth2'
```

Los pings de monitoreo son tráfico saliente del router (cadena `output`, aceptada por defecto) y sus respuestas entran como `established`, así que no necesitan regla adicional.

```
commit
save
```

---

## 10. Verificación

Sal del modo configuración (`exit`) para los comandos operacionales.

**Estado de cada WAN:**

```bash
show wan-load-balance
```

Salida esperada con ambos enlaces sanos:

```
Interface:  eth0
  Status:  active
  Last Status Change:  Mon Sep 28 10:12:44 2026
  +Test:  ping  Target: 1.1.1.1
    Last Interface Success:  0s
    Last Interface Failure:  n/a
    # Interface Failure(s):  0

Interface:  eth1
  Status:  active
  ...
```

**Conexiones y la WAN asignada a cada una:**

```bash
show wan-load-balance connection
```

**Tráfico por interfaz en tiempo real:**

```bash
monitor bandwidth interface eth0
monitor bandwidth interface eth1
```

**Distribución desde un cliente de la LAN**: abre varias conexiones a un servicio que devuelva tu IP pública. Con balanceo 50/50 debes ver alternarse ambas IPs:

```bash
for i in $(seq 1 10); do curl -s https://ifconfig.me; echo; done
```

> Algunos clientes reutilizan la conexión HTTP (keep-alive) y siempre verán la misma IP. `curl` en un bucle abre conexiones nuevas cada vez.

### Simular la caída de una WAN

La prueba más fiel es desconectar el cable de ISP1, pero para simular una caída **aguas arriba** (gateway vivo, internet muerta) bloquea el host de monitoreo:

```
configure
set firewall ipv4 output filter rule 999 action 'drop'
set firewall ipv4 output filter rule 999 destination address '1.1.1.1'
commit
```

En unos segundos (`failure-count` × intervalo de prueba) `show wan-load-balance` debe mostrar `eth0` como `failed`, el log registrará el evento del hook y todo el tráfico nuevo saldrá por `eth1`:

```bash
show log | match wlb-hook
```

Restaura:

```
delete firewall ipv4 output filter rule 999
commit
exit
```

---

## Si tus ISPs entregan IP por DHCP

Solo cambian tres cosas:

```
set interfaces ethernet eth0 address dhcp
set interfaces ethernet eth0 dhcp-options default-route-distance '1'

set interfaces ethernet eth1 address dhcp
set interfaces ethernet eth1 dhcp-options default-route-distance '10'

set load-balancing wan interface-health eth0 nexthop 'dhcp'
set load-balancing wan interface-health eth1 nexthop 'dhcp'
```

- Elimina las rutas default estáticas del paso 2: DHCP las instala con las distancias indicadas.
- `nexthop dhcp` hace que el balanceador tome el gateway que entregue el ISP en cada renovación.
- Las rutas `/32` de los monitores necesitan un gateway fijo. Con DHCP, usa `set protocols static route 1.1.1.1/32 dhcp-interface 'eth0'` (y lo mismo con `9.9.9.9` por `eth1`).
- En el hook, sustituye el cambio de distancia de ruta estática por `set interfaces ethernet eth0 dhcp-options default-route-distance '250'` y su reverso.

---

## Configuración completa

```
set interfaces ethernet eth0 address '203.0.113.2/30'
set interfaces ethernet eth0 description 'WAN1-ISP1'
set interfaces ethernet eth1 address '198.51.100.2/30'
set interfaces ethernet eth1 description 'WAN2-ISP2'
set interfaces ethernet eth2 address '192.168.10.1/24'
set interfaces ethernet eth2 description 'LAN'

set protocols static route 0.0.0.0/0 next-hop 203.0.113.1 distance '1'
set protocols static route 0.0.0.0/0 next-hop 198.51.100.1 distance '10'
set protocols static route 1.1.1.1/32 next-hop 203.0.113.1
set protocols static route 9.9.9.9/32 next-hop 198.51.100.1

set load-balancing wan flush-connections
set load-balancing wan hook '/config/scripts/wlb-hook.sh'
set load-balancing wan sticky-connections inbound

set load-balancing wan interface-health eth0 failure-count '3'
set load-balancing wan interface-health eth0 nexthop '203.0.113.1'
set load-balancing wan interface-health eth0 success-count '2'
set load-balancing wan interface-health eth0 test 10 resp-time '3'
set load-balancing wan interface-health eth0 test 10 target '1.1.1.1'
set load-balancing wan interface-health eth0 test 10 type 'ping'
set load-balancing wan interface-health eth1 failure-count '3'
set load-balancing wan interface-health eth1 nexthop '198.51.100.1'
set load-balancing wan interface-health eth1 success-count '2'
set load-balancing wan interface-health eth1 test 10 resp-time '3'
set load-balancing wan interface-health eth1 test 10 target '9.9.9.9'
set load-balancing wan interface-health eth1 test 10 type 'ping'

set load-balancing wan rule 5 destination address '192.168.0.0/16'
set load-balancing wan rule 5 exclude
set load-balancing wan rule 5 inbound-interface 'eth2'
set load-balancing wan rule 6 destination address '10.0.0.0/8'
set load-balancing wan rule 6 exclude
set load-balancing wan rule 6 inbound-interface 'eth2'
set load-balancing wan rule 7 destination address '172.16.0.0/12'
set load-balancing wan rule 7 exclude
set load-balancing wan rule 7 inbound-interface 'eth2'

set load-balancing wan rule 20 destination port '51820'
set load-balancing wan rule 20 failover
set load-balancing wan rule 20 inbound-interface 'eth2'
set load-balancing wan rule 20 interface eth0 weight '10'
set load-balancing wan rule 20 interface eth1 weight '1'
set load-balancing wan rule 20 protocol 'udp'

set load-balancing wan rule 30 failover
set load-balancing wan rule 30 inbound-interface 'eth2'
set load-balancing wan rule 30 interface eth0 weight '1'
set load-balancing wan rule 30 interface eth1 weight '10'
set load-balancing wan rule 30 source address '192.168.10.50'

set load-balancing wan rule 100 inbound-interface 'eth2'
set load-balancing wan rule 100 interface eth0 weight '1'
set load-balancing wan rule 100 interface eth1 weight '1'
set load-balancing wan rule 100 protocol 'all'
```

---

## Consideraciones de producción

**El balanceo es por conexión.** Un speedtest de un solo flujo nunca mostrará la suma de ambos enlaces. Los speedtests multi-hilo sí pueden acercarse, porque abren varias conexiones que caen en WANs distintas.

**Sitios que rompen con IPs cambiantes.** Algunos servicios web asocian la sesión a la IP de origen; si la página abre conexiones nuevas que salen por otra WAN, la sesión se invalida. Si detectas uno, fíjalo con una regla `failover` por `destination address` como en el paso 7.

**Servicios publicados hacia internet.** El balanceo gobierna el tráfico saliente. Para servicios entrantes, `sticky-connections inbound` asegura que las respuestas salgan por la WAN correcta, pero el failover de cara al exterior depende de DNS: publica el servicio con TTL bajo y usa un proveedor con health checks que cambie el registro si una IP deja de responder.

**IPv6.** El módulo `load-balancing wan` trabaja sobre IPv4. Con IPv6 lo habitual es no balancear: cada ISP delega su prefijo, y la LAN anuncia ambos o solo el del enlace activo según tu estrategia de failover.

**Monitores robustos.** Un solo host de prueba por WAN es un punto único de falla: si `1.1.1.1` tiene un mal día, sacarás de rotación un enlace sano. En entornos críticos, usa como target una IP dentro de la red del propio ISP (su DNS, por ejemplo), que valida el enlace sin depender de terceros.
