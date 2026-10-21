---
title: "WireGuard en OpenBSD 8.0 para Road Warriors con Acceso a la LAN"
date: 2026-10-21
tags: ["openbsd", "wireguard", "vpn", "pf", "firewall", "roadwarrior", "unbound"]
description: "Un servidor WireGuard en OpenBSD 8.0 con wg(4) del sistema base: llaves, hostname.wg0, reenvío, pf con NAT y control de acceso por cliente, DNS interno con unbound y configuración de clientes en split y full tunnel."
---

Un *road warrior* es el usuario que se conecta desde donde esté: la laptop en un hotel, el teléfono en la red del aeropuerto, la casa de un técnico de guardia. No tiene IP fija, cambia de red varias veces al día y necesita llegar a lo mismo de siempre: el NAS, la consola del hipervisor, el ERP, la impresora de la oficina.

WireGuard es la herramienta correcta para esto. Es pequeño, rápido, sobrevive a los cambios de red sin renegociar nada y su configuración cabe en una pantalla. En OpenBSD además no hay que instalar nada: el driver [`wg(4)`](https://man.openbsd.org/wg.4) es parte del kernel desde la 6.8, y todo se configura con `ifconfig` y `pf`, las mismas herramientas con las que ya administras el resto del firewall.

Este post arma un servidor WireGuard en **OpenBSD 8.0** que actúa como gateway de la red interna. Al final, cada cliente podrá llegar a la LAN, usar el DNS interno y, si así lo decides, sacar todo su tráfico a internet por la oficina.

## Escenario de referencia

```
         Internet
            │
     203.0.113.10 (em0, WAN)
   ┌────────┴────────┐
   │  OpenBSD 8.0    │  wg0: 10.10.10.1/24   UDP 51820
   │  pf + unbound   │
   └────────┬────────┘
     192.168.10.1 (em1, LAN)
            │
   ─────────┴──────────────────────
   192.168.10.0/24  NAS, servidores, impresoras
```

| Elemento           | Valor                     |
|--------------------|---------------------------|
| Interfaz WAN       | `em0` — `203.0.113.10`    |
| Interfaz LAN       | `em1` — `192.168.10.1/24` |
| Túnel WireGuard    | `wg0` — `10.10.10.1/24`   |
| Puerto             | UDP `51820`               |
| Nombre público     | `vpn.example.com`         |
| Cliente 1 (laptop) | `10.10.10.2`              |
| Cliente 2 (móvil)  | `10.10.10.3`              |

El OpenBSD es el **gateway por defecto de la LAN**. Esto importa: los equipos de la LAN responden a los clientes VPN enviando el tráfico a su gateway, y como el gateway es el mismo equipo que tiene `wg0`, las respuestas regresan solas por el túnel. Si tu OpenBSD es solo un host más dentro de la LAN, revisa la sección [Si OpenBSD no es el gateway de la LAN](#si-openbsd-no-es-el-gateway-de-la-lan).

### Elige bien la subred de la LAN

Antes de empezar, un detalle que causa más tickets que cualquier error de configuración: si tu LAN es `192.168.0.0/24` o `192.168.1.0/24`, tarde o temprano un usuario se conectará desde un hotel o una casa que usa **la misma subred**. Su laptop tendrá dos caminos hacia `192.168.1.0/24` — la red local y el túnel — y la red local gana. Para road warriors, usa subredes poco comunes para la LAN y para el túnel (`192.168.10.0/24`, `10.10.10.0/24`, o mejor aún algo dentro de `172.16.0.0/12`).

---

## 1. Llaves del servidor

WireGuard identifica a cada extremo por un par de llaves Curve25519. La llave privada son 32 bytes aleatorios en base64, así que el sistema base alcanza para generarla:

```sh
# openssl rand -base64 32
yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
```

No necesitas calcular la pública a mano: `wg(4)` la deriva en cuanto la interfaz tiene llave privada, y `ifconfig` la muestra.

Para generar las llaves de los clientes, instala `wireguard-tools`. No es obligatorio para el servidor, pero trae `wg genkey`, `wg pubkey`, `wg genpsk` y `wg show`, que son cómodos:

```sh
# pkg_add wireguard-tools
```

## 2. La interfaz wg0

Crea `/etc/hostname.wg0`. Cada línea se pasa a `ifconfig` al arrancar:

```sh
# /etc/hostname.wg0
wgkey yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
wgport 51820
inet 10.10.10.1 255.255.255.0
up
```

El archivo contiene la llave privada, así que restringe sus permisos (`netstart` además se queja si cualquier usuario puede leerlo):

```sh
# chmod 600 /etc/hostname.wg0
# sh /etc/netstart wg0
```

Revisa que la interfaz exista y anota la llave pública; es la que irá en la configuración de cada cliente:

```sh
# ifconfig wg0
wg0: flags=80c3<UP,BROADCAST,RUNNING,NOARP,MULTICAST> mtu 1420
        index 5 priority 0 llprio 3
        wgport 51820
        wgpubkey HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
        groups: wg
        inet 10.10.10.1 netmask 0xffffff00 broadcast 10.10.10.255
```

El MTU de 1420 es el valor por defecto de `wg(4)`: 1500 menos los 80 bytes que agregan los encabezados de IPv6, UDP y WireGuard en el peor caso. Déjalo así.

## 3. Reenvío de paquetes

OpenBSD no enruta entre interfaces a menos que se lo pidas. Activa el reenvío ahora y al arrancar:

```sh
# sysctl net.inet.ip.forwarding=1
# echo 'net.inet.ip.forwarding=1' >> /etc/sysctl.conf
```

Si también vas a llevar IPv6 por el túnel, haz lo mismo con `net.inet6.ip6.forwarding`.

## 4. Agregar clientes

Cada cliente necesita su propio par de llaves. Lo ideal es que la llave privada **se genere en el dispositivo del cliente y nunca salga de él**: las apps oficiales de WireGuard para Windows, macOS, iOS y Android generan el par al crear un túnel nuevo y te muestran solo la pública. Si vas a entregar la configuración ya hecha (por ejemplo, como código QR), genera las llaves en el servidor:

```sh
# umask 077
# mkdir -p /etc/wireguard/clientes && cd /etc/wireguard/clientes
# wg genkey | tee laptop.key | wg pubkey > laptop.pub
# wg genpsk > laptop.psk
```

La *preshared key* es opcional. Agrega una capa simétrica sobre el intercambio Curve25519, que sirve como protección a futuro contra criptoanálisis cuántico. No cuesta nada y conviene usar una distinta por cliente.

Agrega el peer a `/etc/hostname.wg0`, **antes** de la línea `up`:

```sh
wgpeer kL2WKt9yX8v0Lx9Hc7Kqrmf0b6iC2Fa+Bv8R0cq1n1E= wgpsk 1f9Y3m0q9pWm8m3s7vQyJ2y0Jm8tQn5gWm1Z0aP4h6k= wgaip 10.10.10.2/32 wgdescr laptop-paco
wgpeer cN7pB0f3l3t4q2r1m0P5ZsA6Hk2qW9u8Y7oT1vR0eXg= wgpsk Zq3m8Hn1V0bX4cW7rT2yP9uL6sA5dF0gJ3kE1iO8qMw= wgaip 10.10.10.3/32 wgdescr movil-paco
```

| Opción     | Qué hace                                                              |
|------------|-----------------------------------------------------------------------|
| `wgpeer`   | Llave pública del cliente                                             |
| `wgpsk`    | Preshared key de ese cliente                                          |
| `wgaip`    | IPs que ese peer tiene permitido usar como origen (*allowed IPs*)      |
| `wgdescr`  | Etiqueta que aparece en `ifconfig wg0`; úsala sin espacios            |

No hay `wgendpoint`: el servidor no sabe dónde está un road warrior, y no le hace falta. WireGuard aprende la IP y el puerto del cliente del primer paquete autenticado que recibe, y los actualiza cada vez que el cliente cambia de red.

Aplica el cambio:

```sh
# sh /etc/netstart wg0
```

También puedes agregar un peer en caliente sin tocar a los demás, y luego dejarlo en el archivo para que sobreviva al reinicio:

```sh
# ifconfig wg0 wgpeer cN7pB0f3...eXg= wgpsk Zq3m8Hn1...qMw= wgaip 10.10.10.3/32 wgdescr movil-paco
```

Para revocar un cliente, quítalo del archivo y bórralo de la interfaz:

```sh
# ifconfig wg0 -wgpeer cN7pB0f3l3t4q2r1m0P5ZsA6Hk2qW9u8Y7oT1vR0eXg=
```

### Por qué un /32 por cliente

`wgaip` es la pieza más importante de WireGuard y la menos obvia. Funciona en las dos direcciones:

- **Al enviar**, `wg(4)` elige el peer según la IP de destino: un paquete para `10.10.10.2` sale cifrado con las llaves de la laptop.
- **Al recibir**, descarta cualquier paquete cuya IP de origen no esté en el `wgaip` del peer que lo cifró.

Esto se llama *cryptokey routing*, y tiene una consecuencia directa para el firewall: dentro de `wg0`, **la IP de origen identifica a la llave**. Si un paquete llega de `10.10.10.2`, lo envió quien tiene la llave privada de la laptop; nadie más puede falsificar esa dirección. Por eso puedes escribir reglas de `pf` por IP de cliente y confiar en ellas, que es justo lo que haremos en la sección 6.

## 5. pf: NAT y acceso a la LAN

Este es un `/etc/pf.conf` completo para el escenario. Si ya tienes uno, las líneas relevantes son las que mencionan `wg0`, `$wg_net` y `$wg_port`.

```sh
# /etc/pf.conf

wan     = "em0"
lan     = "em1"
lan_net = "192.168.10.0/24"
wg_net  = "10.10.10.0/24"
wg_port = "51820"

set skip on lo
set block-policy drop

# LAN y clientes VPN salen a internet con la IP pública
match out on $wan inet from { $lan_net $wg_net } nat-to ($wan)

block log all
antispoof quick for { $lan wg0 }

# Tráfico que el firewall origina o reenvía hacia afuera
pass out on $wan
pass out on $lan
pass out on wg0

# El puerto de WireGuard, abierto a internet
pass in on $wan proto udp to ($wan) port $wg_port

# LAN y VPN: acceso a todo (la sección 6 lo restringe)
pass in on $lan from $lan_net
pass in on wg0  from $wg_net
```

Carga y verifica:

```sh
# pfctl -nf /etc/pf.conf     # solo revisa la sintaxis
# pfctl -f /etc/pf.conf
```

Algunos puntos que vale la pena entender:

- **En OpenBSD, un paquete reenviado se evalúa dos veces**: al entrar por una interfaz y al salir por otra. Un paquete de la laptop hacia el NAS necesita `pass in on wg0` *y* `pass out on $lan`. Con `block all` al inicio, olvidar el segundo es el error más común.
- **El NAT solo se aplica hacia `em0`**. El tráfico entre `wg0` y la LAN viaja enrutado, con la IP real del cliente. Así, los logs del NAS muestran `10.10.10.2` en lugar de la IP del firewall, y sabes exactamente quién hizo qué.
- **`antispoof` en `wg0`** bloquea paquetes con origen `10.10.10.0/24` que lleguen por cualquier otra interfaz. Dentro del túnel, el `wgaip` ya hace ese trabajo por peer.

Con esto, los clientes llegan a todo: LAN, internet y el propio firewall. Para muchos casos es suficiente. Si no lo es, sigue leyendo.

## 6. Acceso distinto por cliente

Un técnico de guardia necesita la consola del hipervisor; el teléfono del gerente solo necesita el ERP. Gracias al cryptokey routing, puedes separar a los clientes por IP. Reemplaza la última línea del `pf.conf` (`pass in on wg0 from $wg_net`) por esto:

```sh
table <wg_admins>  { 10.10.10.2 }
table <wg_users>   { 10.10.10.3 10.10.10.4 }

erp     = "192.168.10.20"
nas     = "192.168.10.30"

# Todos los clientes VPN: DNS del firewall e internet
pass in on wg0 proto { udp tcp } from $wg_net to wg0 port domain
pass in on wg0 from $wg_net to ! { $lan_net $wg_net (self) }

# Administradores: toda la LAN y SSH al firewall
pass in on wg0 from <wg_admins> to $lan_net
pass in on wg0 proto tcp from <wg_admins> to (self) port ssh

# Usuarios: solo el ERP por HTTPS y el NAS por SMB
pass in on wg0 proto tcp from <wg_users> to $erp port https
pass in on wg0 proto tcp from <wg_users> to $nas port 445
```

La segunda regla deja salir a internet sin abrir nada interno: `! { $lan_net $wg_net (self) }` significa "cualquier destino que no sea la LAN, la VPN ni las direcciones del firewall". Fíjate también en que ningún cliente puede hablar con otro cliente, porque nada permite tráfico hacia `$wg_net`; si quieres que se vean entre ellos, agrégalo explícitamente.

Puedes mover un cliente de grupo sin recargar las reglas:

```sh
# pfctl -t wg_admins -T add 10.10.10.3
# pfctl -t wg_users  -T delete 10.10.10.3
```

Para que el cambio sobreviva a un reinicio, actualiza también la tabla en `pf.conf`, o carga las tablas desde archivos con `table <wg_admins> persist file "/etc/pf/wg_admins"`.

## 7. DNS interno con unbound

Los clientes deben resolver los nombres internos (`nas.oficina.lan`) y, en full tunnel, no deberían usar el DNS de la red del hotel. OpenBSD trae `unbound` en el sistema base. Edita `/var/unbound/etc/unbound.conf`:

```yaml
server:
    interface: 127.0.0.1
    interface: 192.168.10.1
    interface: 10.10.10.1

    access-control: 0.0.0.0/0       refuse
    access-control: 127.0.0.0/8     allow
    access-control: 192.168.10.0/24 allow
    access-control: 10.10.10.0/24   allow

    hide-identity: yes
    hide-version: yes

    # Nombres internos
    private-domain: "oficina.lan"
    local-zone: "oficina.lan." static
    local-data: "nas.oficina.lan.  IN A 192.168.10.30"
    local-data: "erp.oficina.lan.  IN A 192.168.10.20"
    local-data-ptr: "192.168.10.30 nas.oficina.lan"
    local-data-ptr: "192.168.10.20 erp.oficina.lan"
```

```sh
# unbound-checkconf
# rcctl enable unbound
# rcctl start unbound
```

`unbound` se enlaza a `10.10.10.1` al arrancar. Esto funciona porque `netstart`, que levanta `wg0`, corre antes que los servicios de `rc.d`. Si alguna vez reinicias `wg0` a mano, reinicia también `unbound`.

## 8. Configuración de los clientes

Todas las plataformas usan el mismo formato de archivo, el de `wg-quick`. Para la laptop:

```ini
[Interface]
PrivateKey = <contenido de laptop.key>
Address    = 10.10.10.2/32
DNS        = 10.10.10.1, oficina.lan

[Peer]
PublicKey           = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
PresharedKey        = <contenido de laptop.psk>
Endpoint            = vpn.example.com:51820
AllowedIPs          = 10.10.10.0/24, 192.168.10.0/24
PersistentKeepalive = 25
```

- **`PublicKey`** es la `wgpubkey` que mostró `ifconfig wg0` en el servidor.
- **`DNS`** acepta servidores y dominios de búsqueda. Con `oficina.lan` ahí, `ssh nas` resuelve a `nas.oficina.lan`.
- **`PersistentKeepalive = 25`** envía un paquete vacío cada 25 segundos. Sin él, el NAT del hotel olvida la sesión UDP tras un rato de inactividad, y el servidor ya no tiene cómo llegar al cliente hasta que este vuelva a hablar. En un road warrior siempre va.

### Split tunnel o full tunnel

`AllowedIPs` del lado del cliente decide qué tráfico entra al túnel:

| `AllowedIPs`                          | Modo         | Qué pasa                                                        |
|---------------------------------------|--------------|-----------------------------------------------------------------|
| `10.10.10.0/24, 192.168.10.0/24`      | Split tunnel | Solo la LAN de la oficina va por la VPN; internet sale directo  |
| `0.0.0.0/0, ::/0`                     | Full tunnel  | Todo va por la oficina, incluido internet                       |

Split tunnel consume menos ancho de banda de la oficina y es lo habitual. Full tunnel tiene sentido en redes no confiables (Wi-Fi público) o cuando el tráfico a internet debe salir con la IP de la oficina, por ejemplo para servicios que filtran por IP de origen. El `pf.conf` de este post sirve para los dos modos sin cambios, porque el `nat-to` ya incluye a `$wg_net`.

### Entregar la configuración por QR

Para los teléfonos, lo más práctico es un código QR que la app escanea:

```sh
# pkg_add libqrencode
# qrencode -t ansiutf8 < /etc/wireguard/clientes/movil.conf
```

El QR aparece en la terminal. Escanéalo, y luego borra el `.conf` y la `.key` del servidor: ya no los necesitas y contienen la llave privada del cliente.

## 9. Verificación

Conecta un cliente y revisa el servidor:

```sh
# ifconfig wg0
wg0: flags=80c3<UP,BROADCAST,RUNNING,NOARP,MULTICAST> mtu 1420
        index 5 priority 0 llprio 3
        wgport 51820
        wgpubkey HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
        wgpeer kL2WKt9yX8v0Lx9Hc7Kqrmf0b6iC2Fa+Bv8R0cq1n1E=
                wgdescr: laptop-paco
                wgpsk (present)
                wgendpoint 198.51.100.77 41234
                tx: 15820, rx: 21344
                last handshake: 12 seconds ago
                wgaip 10.10.10.2/32
        ...
```

`wgendpoint` muestra desde dónde se conecta el cliente ahora mismo, y `last handshake` confirma que el intercambio de llaves funcionó. Con `wireguard-tools` instalado, `wg show wg0` da la misma información en el formato de Linux.

Desde el cliente:

```sh
ping 10.10.10.1              # el servidor, por el túnel
ping 192.168.10.30           # un host de la LAN
dig nas.oficina.lan          # debe responder 10.10.10.1 con 192.168.10.30
curl -4 ifconfig.me          # full tunnel: debe mostrar 203.0.113.10
```

Y en el servidor, para ver los estados y lo que bloquea `pf`:

```sh
# pfctl -ss | grep 10.10.10
# tcpdump -nei pflog0
```

## Si algo no funciona

**No hay handshake** (`last handshake` no aparece):

- El puerto no llega. Confirma con `tcpdump -ni em0 udp port 51820` mientras el cliente intenta conectar. Si no ves nada, el problema está antes del firewall: un router del ISP sin el puerto reenviado, o una IP de CGNAT (`100.64.0.0/10`) en la WAN.
- Las llaves están cruzadas. En el servidor va la **pública** del cliente; en el cliente va la **pública** del servidor. Un error en una sola letra no genera ningún mensaje: los paquetes simplemente se descartan.
- La PSK no coincide. Debe ser la misma en los dos lados.

**Hay handshake pero no llega a la LAN**:

- `sysctl net.inet.ip.forwarding` debe devolver `1`.
- Falta un `pass out on $lan`. Mira `tcpdump -nei pflog0` mientras haces ping.
- El host destino no usa el OpenBSD como gateway, o su firewall rechaza tráfico de una subred que no conoce. Windows bloquea el ping de otras subredes por defecto.
- El cliente está en una red que usa la misma subred que tu LAN (ver [Elige bien la subred de la LAN](#elige-bien-la-subred-de-la-lan)).

**Se conecta, pero algunas páginas o transferencias se congelan**: es MTU. Algún enlace en el camino tiene un MTU menor y bloquea los mensajes ICMP que avisarían de ello. Ajusta el MSS de TCP en el túnel agregando esto al `pf.conf`, antes de las reglas `pass`:

```sh
match in on wg0 scrub (max-mss 1380)
```

## Si OpenBSD no es el gateway de la LAN

Si el OpenBSD es un servidor dentro de la LAN y otro equipo es el gateway, los hosts de la LAN enviarán sus respuestas para `10.10.10.0/24` al gateway, que no sabe nada del túnel. Hay dos salidas:

1. **Ruta estática en el gateway** (preferible): `10.10.10.0/24 vía 192.168.10.5`, la IP LAN del OpenBSD. Los hosts siguen viendo la IP real de cada cliente.
2. **NAT hacia la LAN**: si no controlas el gateway, haz que el OpenBSD traduzca los paquetes de los clientes a su propia IP LAN:

   ```sh
   match out on $lan inet from $wg_net to $lan_net nat-to ($lan)
   ```

   Funciona sin tocar nada más, pero pierdes la IP del cliente en los logs de los servidores. Además, en este caso tendrás que reenviar el UDP 51820 desde el gateway hacia el OpenBSD.

---

## Resumen

| Pieza             | Archivo / comando                      | Para qué                                    |
|-------------------|----------------------------------------|---------------------------------------------|
| Interfaz y peers  | `/etc/hostname.wg0`                    | Llave del servidor, puerto, clientes        |
| Reenvío           | `/etc/sysctl.conf`                     | Enrutar entre `wg0`, LAN e internet         |
| Firewall y NAT    | `/etc/pf.conf`                         | Abrir 51820, NAT a internet, acceso por cliente |
| DNS interno       | `/var/unbound/etc/unbound.conf`        | Nombres de la LAN para los clientes         |
| Estado            | `ifconfig wg0`, `pfctl -ss`            | Handshakes, endpoints, estados              |

No hay daemon de VPN que mantener, ni un panel web que parchar, ni una configuración paralela al firewall. El túnel es una interfaz más, y `pf` lo trata igual que a la LAN. Agregar un usuario es una línea en `hostname.wg0`; revocarlo, borrar esa línea. Y como cada IP del túnel está atada a una llave, las reglas de `pf` controlan *quién* entra a *qué* con la misma precisión que si cada usuario tuviera su propio cable.
