---
title: "Configurando RADIUS con FreeRADIUS y daloRADIUS para autenticación PPPoE"
date: 2026-06-29
tags: ["radius", "freeradius", "daloradius", "pppoe", "isp", "autenticacion", "mikrotik", "linux"]
description: "Guía completa para instalar FreeRADIUS con backend MariaDB, desplegar daloRADIUS como interfaz web de gestión y conectar un servidor PPPoE MikroTik para autenticar usuarios con RADIUS."
---

RADIUS (Remote Authentication Dial-In User Service) es el estándar de facto para centralizar la autenticación, autorización y contabilidad (AAA) de usuarios en redes de acceso. En ISPs pequeños y medianos, la combinación **FreeRADIUS + MariaDB + daloRADIUS** ofrece un stack robusto y gratuito que puede manejar miles de sesiones PPPoE. Este post cubre la instalación completa desde cero en Debian/Ubuntu, con un servidor PPPoE MikroTik como NAS.

## Arquitectura

```
Suscriptor DSL/FTTH
       │
       ▼
  CPE (modem/bridge)
       │  PPPoE
       ▼
┌─────────────────┐        RADIUS (UDP 1812/1813)       ┌────────────────────┐
│  MikroTik L2TP  │ ─────────────────────────────────► │   FreeRADIUS       │
│  / PPPoE Server │                                     │   + MariaDB        │
│  (NAS)          │ ◄─────────────────────────────────  │   (192.168.1.10)   │
└─────────────────┘       Access-Accept / Reject         └────────────────────┘
                                                                  │
                                                         ┌────────────────────┐
                                                         │   daloRADIUS       │
                                                         │   (web UI PHP)     │
                                                         └────────────────────┘
```

| Componente    | Rol                                              |
|---------------|--------------------------------------------------|
| FreeRADIUS    | Servidor AAA, procesa solicitudes del NAS        |
| MariaDB       | Backend con usuarios, grupos y atributos         |
| daloRADIUS    | Interfaz web para gestión de usuarios y reportes |
| MikroTik      | NAS que autentica sesiones PPPoE contra RADIUS   |

---

## Paso 1: Instalar MariaDB y crear la base de datos

```bash
apt update && apt install -y mariadb-server
mysql_secure_installation
```

Crear la base de datos y el usuario:

```sql
mysql -u root -p

CREATE DATABASE radius CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'radius'@'localhost' IDENTIFIED BY 'RadiusP@ss2026';
GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

---

## Paso 2: Instalar FreeRADIUS con módulo SQL

```bash
apt install -y freeradius freeradius-mysql freeradius-utils
```

### Importar el esquema SQL

FreeRADIUS incluye los scripts de esquema en `/etc/freeradius/3.0/mods-config/sql/main/mysql/`:

```bash
mysql -u radius -p radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql
```

Esto crea las tablas fundamentales:

| Tabla            | Propósito                                        |
|------------------|--------------------------------------------------|
| `radcheck`       | Atributos de autenticación por usuario (contraseña) |
| `radreply`       | Atributos que RADIUS devuelve al NAS tras el Accept |
| `radgroupcheck`  | Atributos de verificación por grupo              |
| `radgroupreply`  | Atributos de respuesta por grupo (pool IP, etc.) |
| `radusergroup`   | Asignación de usuarios a grupos                  |
| `radacct`        | Contabilidad de sesiones (Accounting)            |
| `nas`            | Dispositivos NAS autorizados                     |

### Configurar el módulo SQL

Habilitar el módulo:

```bash
ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
```

Editar `/etc/freeradius/3.0/mods-available/sql`:

```
sql {
    dialect = "mysql"

    driver = "rlm_sql_mysql"

    server = "localhost"
    port = 3306
    login = "radius"
    password = "RadiusP@ss2026"
    radius_db = "radius"

    # Leer usuarios de la tabla radcheck
    read_clients = yes
    client_table = "nas"

    pool {
        start = 5
        min = 3
        max = 32
        spare = 10
        uses = 0
        lifetime = 0
        idle_timeout = 60
    }
}
```

### Activar SQL en los sitios virtuales

En `/etc/freeradius/3.0/sites-enabled/default`, dentro de las secciones `authorize`, `accounting` y `session`, descomentar o agregar `sql`:

```
authorize {
    filter_username
    preprocess
    chap
    mschap
    digest
    suffix
    eap {
        ok = return
    }
    sql           # ← agregar/descomentar
    pap
}

accounting {
    detail
    sql           # ← agregar/descomentar
    exec
    attr_filter.accounting_response
}

session {
    sql           # ← agregar/descomentar
}
```

Lo mismo aplica para `/etc/freeradius/3.0/sites-enabled/inner-tunnel` si se usa EAP.

---

## Paso 3: Registrar el NAS MikroTik

Insertar el NAS en la tabla `nas` para que FreeRADIUS acepte sus solicitudes:

```sql
mysql -u radius -p radius

INSERT INTO nas (nasname, shortname, type, secret, description)
VALUES ('192.168.1.1', 'MikroTik-PPPoE', 'other', 'SecretShared123', 'Router PPPoE principal');
```

> El campo `secret` debe coincidir exactamente con el configurado en el cliente RADIUS del MikroTik.

---

## Paso 4: Agregar un usuario de prueba

```sql
-- Contraseña en texto claro (Cleartext-Password)
INSERT INTO radcheck (username, attribute, op, value)
VALUES ('testuser', 'Cleartext-Password', ':=', 'TestPass2026');

-- Asignar al grupo "pppoe-users"
INSERT INTO radusergroup (username, groupname, priority)
VALUES ('testuser', 'pppoe-users', 1);
```

Definir atributos de respuesta del grupo (pool de IPs):

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES
  ('pppoe-users', 'Framed-Pool',        ':=', 'pool-clientes'),
  ('pppoe-users', 'Session-Timeout',    ':=', '86400'),
  ('pppoe-users', 'Idle-Timeout',       ':=', '3600');
```

---

## Paso 5: Verificar FreeRADIUS en modo debug

Detener el servicio y correr en debug para ver el flujo completo:

```bash
systemctl stop freeradius
freeradius -X
```

En otra terminal, probar con `radtest`:

```bash
radtest testuser TestPass2026 127.0.0.1 0 testing123
```

Respuesta esperada:

```
Sending Access-Request of id 123 to 127.0.0.1 port 1812
        User-Name = "testuser"
        User-Password = "TestPass2026"
        ...
Received Access-Accept of id 123 from 127.0.0.1 port 1812
        Framed-Pool = "pool-clientes"
        Session-Timeout = 86400
```

Si obtienes `Access-Accept`, FreeRADIUS está operando correctamente. Iniciar el servicio:

```bash
systemctl enable --now freeradius
```

---

## Paso 6: Instalar daloRADIUS

daloRADIUS es una interfaz web PHP para gestionar usuarios, NAS y revisar reportes de contabilidad.

### Dependencias

```bash
apt install -y apache2 php php-mysql php-gd php-curl php-mail php-mail-mime \
               php-pear php-db libapache2-mod-php unzip curl
```

### Descargar e instalar

```bash
cd /var/www/html
curl -LO https://github.com/lirantal/daloradius/archive/refs/heads/master.zip
unzip master.zip
mv daloradius-master daloradius
chown -R www-data:www-data /var/www/html/daloradius
chmod -R 755 /var/www/html/daloradius
```

### Importar esquema adicional de daloRADIUS

```bash
mysql -u radius -p radius < /var/www/html/daloradius/contrib/db/mysql-daloradius.sql
```

### Configurar la conexión a la base de datos

Editar `/var/www/html/daloradius/library/daloradius.conf.php`:

```php
$configValues['FREERADIUS_VERSION'] = '3';
$configValues['DB_ENGINE'] = 'mysqli';
$configValues['DB_HOST'] = 'localhost';
$configValues['DB_PORT'] = '3306';
$configValues['DB_USER'] = 'radius';
$configValues['DB_PASS'] = 'RadiusP@ss2026';
$configValues['DB_NAME'] = 'radius';
```

### VirtualHost de Apache (opcional, dominio dedicado)

Crear `/etc/apache2/sites-available/daloradius.conf`:

```apache
<VirtualHost *:80>
    ServerName radius.midominio.com
    DocumentRoot /var/www/html/daloradius

    <Directory /var/www/html/daloradius>
        Options -Indexes
        AllowOverride All
        Require all granted
    </Directory>

    ErrorLog ${APACHE_LOG_DIR}/daloradius_error.log
    CustomLog ${APACHE_LOG_DIR}/daloradius_access.log combined
</VirtualHost>
```

```bash
a2ensite daloradius
a2enmod rewrite
systemctl reload apache2
```

Acceder a `http://192.168.1.10/daloradius` con las credenciales por defecto:

| Campo    | Valor         |
|----------|---------------|
| Usuario  | `administrator` |
| Password | `radius`      |

**Cambiar la contraseña inmediatamente** en *Config → Operators → Manage Operators*.

---

## Paso 7: Configurar MikroTik como cliente RADIUS

En el RouterOS del MikroTik (PPPoE Server):

```
# Agregar el servidor RADIUS
/radius add \
    address=192.168.1.10 \
    secret=SecretShared123 \
    service=ppp \
    authentication-port=1812 \
    accounting-port=1813

# Activar uso de RADIUS en el perfil PPPoE
/ppp aaa set use-radius=yes accounting=yes

# Verificar
/radius print
```

Confirmar que el perfil de PPPoE apunta a RADIUS:

```
/ppp profile set default use-radius=yes
```

### Pool de IPs administrado por RADIUS

Si RADIUS devuelve el atributo `Framed-Pool`, el MikroTik asignará una IP del pool local con ese nombre:

```
/ip pool add name=pool-clientes ranges=10.20.0.1-10.20.0.254
```

---

## Paso 8: Probar una sesión PPPoE completa

Conectar un cliente PPPoE con usuario `testuser` / `TestPass2026`. En FreeRADIUS logs (`/var/log/freeradius/radius.log`) se verá:

```
Login OK: [testuser] (from client MikroTik-PPPoE port 0 via TLS tunnel)
```

En MikroTik verificar la sesión activa:

```
/ppp active print
```

En daloRADIUS ir a *Accounting → Active Sessions* para ver la sesión en tiempo real.

---

## Atributos RADIUS útiles para PPPoE

| Atributo RADIUS           | Efecto en MikroTik                        |
|---------------------------|-------------------------------------------|
| `Framed-Pool`             | Pool de IPs del que se asigna la dirección |
| `Framed-IP-Address`       | IP fija para el usuario                   |
| `Session-Timeout`         | Tiempo máximo de sesión en segundos       |
| `Idle-Timeout`            | Desconexión por inactividad               |
| `Mikrotik-Rate-Limit`     | Límite de velocidad (ej. `10M/10M`)       |
| `Mikrotik-Address-List`   | Agrega la IP del usuario a una lista      |

Ejemplo para limitar velocidad a 10 Mbps simétrico via `radgroupreply`:

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES ('plan-10mbps', 'Mikrotik-Rate-Limit', ':=', '10M/10M');
```

---

## Solución de problemas comunes

**Access-Reject sin mensaje claro**

Correr `freeradius -X` y buscar la línea `ERROR:` o `WARNING:`. Causas frecuentes:
- El `secret` del NAS no coincide entre MikroTik y la tabla `nas`.
- El módulo SQL no está habilitado en `authorize`.
- La contraseña en `radcheck` usa el operador incorrecto (debe ser `:=`, no `==`).

**daloRADIUS muestra error de conexión a DB**

```bash
# Probar conexión directa
mysql -u radius -p radius -e "SHOW TABLES;"
```

Si falla, revisar permisos del usuario `radius` en MariaDB.

**MikroTik no envía Accounting**

Verificar en `/ppp aaa`:

```
/ppp aaa print
       use-radius: yes
       accounting: yes
```

Si `accounting: no`, los registros de sesión no se guardarán en `radacct`.

---

## Consideraciones de seguridad

- Usar un `secret` compartido largo y aleatorio (mínimo 20 caracteres).
- Limitar el acceso al puerto 1812/1813 UDP únicamente desde las IPs de los NAS (`ufw allow from 192.168.1.1 to any port 1812,1813 proto udp`).
- Proteger daloRADIUS con HTTPS y autenticación básica de Apache si está expuesto fuera de la red de gestión.
- Considerar migrar las contraseñas de `Cleartext-Password` a `MD5-Password` o usar CHAP/MS-CHAPv2 para no transmitir contraseñas en texto claro entre FreeRADIUS y MariaDB.

---

Con esto tienes un stack RADIUS completamente funcional: FreeRADIUS procesa la autenticación, MariaDB persiste usuarios y sesiones, daloRADIUS da visibilidad operativa, y el MikroTik delega toda la AAA al servidor central. Desde aquí puedes escalar agregando más NAS a la tabla `nas`, crear grupos por plan de velocidad, y automatizar altas de usuarios desde daloRADIUS o directamente vía SQL.
