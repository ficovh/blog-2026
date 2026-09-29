---
title: "Respaldos de MariaDB con Python: mariadb-dump, Rotación y systemd"
date: 2026-09-28
tags: ["mariadb", "mysql", "python", "backup", "linux", "systemd", "automation"]
description: "Un script de respaldo para MariaDB en Python, sin dependencias externas: un volcado comprimido por base, detección de volcados truncados, checksums, usuarios y permisos, rotación, timer de systemd y restauración probada."
---

El respaldo más común de MariaDB es una línea en el crontab:

```bash
mysqldump --all-databases | gzip > /backup/db-$(date +%F).sql.gz
```

Funciona hasta el día en que no. Si `mysqldump` falla a la mitad — el servidor se reinicia, se llena el disco, una tabla está corrupta — `gzip` recibe un flujo cortado, lo comprime sin quejarse y el pipeline termina con código 0, porque el shell solo mira el código del **último** comando. Tienes un archivo con fecha de hoy, tamaño razonable y la mitad de tus datos. Te enteras cuando intentas restaurar.

Este post construye un script en Python que resuelve eso y otros detalles que la línea del crontab ignora: revisa el código de salida y el final de cada volcado, separa cada base en su propio archivo, respalda usuarios y permisos, genera checksums, rota los respaldos viejos solo cuando el actual salió bien y corre desde un timer de systemd. Usa solo la librería estándar: nada de `pip install`.

Todo lo que aparece aquí se probó contra **MariaDB 12.3**, incluyendo la restauración. Funciona igual desde MariaDB 10.5, donde los binarios pasaron a llamarse `mariadb` y `mariadb-dump` (los nombres `mysql` y `mysqldump` siguen existiendo como enlaces, y el script los usa como respaldo).

## Lógico o físico

Hay dos formas de respaldar MariaDB, y conviene elegir a propósito:

|                          | Lógico (`mariadb-dump`)              | Físico (`mariadb-backup`)                 |
|--------------------------|--------------------------------------|-------------------------------------------|
| Qué genera               | SQL: `CREATE TABLE`, `INSERT`...      | Copia de los archivos de datos de InnoDB  |
| Portabilidad             | Entre versiones y arquitecturas      | Misma versión mayor de MariaDB            |
| Restaurar una sola tabla | Fácil (es texto)                     | Posible, pero laborioso                   |
| Velocidad de restauración| Lenta: re-ejecuta todo y reconstruye índices | Rápida: copiar archivos y arrancar |
| Tamaño práctico          | Hasta decenas de GB                  | Cientos de GB o más                       |

Para la mayoría de servidores — aplicaciones web, un ERP, un Zabbix pequeño, el FreeRADIUS de un ISP — el respaldo lógico es la opción correcta: es legible, portable y fácil de restaurar parcialmente. Cuando la restauración de un volcado empieza a tardar horas, es momento de pasar a `mariadb-backup`. Hay una nota sobre eso al final.

---

## 1. Un usuario solo para respaldos

No uses `root`. Crea un usuario con los privilegios mínimos para leer todo sin poder modificar nada:

```sql
CREATE USER 'backup'@'localhost' IDENTIFIED BY 'una-contraseña-larga-y-aleatoria';

GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT, PROCESS
  ON *.* TO 'backup'@'localhost';
```

| Privilegio    | Para qué lo necesita `mariadb-dump`                    |
|---------------|--------------------------------------------------------|
| `SELECT`      | Leer los datos, y `mysql.proc` para los procedimientos |
| `SHOW VIEW`   | Volcar la definición de las vistas                     |
| `TRIGGER`     | Volcar los triggers                                    |
| `LOCK TABLES` | Bloquear tablas que no son InnoDB durante el volcado   |
| `EVENT`       | Volcar los eventos programados                         |
| `PROCESS`     | Leer información de tablespaces                        |

`'backup'@'localhost'` solo acepta conexiones locales: el script corre en el mismo servidor.

## 2. Credenciales fuera de la línea de comandos

Pasar la contraseña con `-p` la deja visible en `ps` para cualquier usuario del sistema. En su lugar, guárdala en un archivo de opciones que solo root pueda leer:

```bash
sudo mkdir -p /etc/mariadb-backup
sudo tee /etc/mariadb-backup/backup.cnf > /dev/null <<'CNF'
[client]
user = backup
password = una-contraseña-larga-y-aleatoria
# socket = /run/mysqld/mysqld.sock
CNF
sudo chmod 600 /etc/mariadb-backup/backup.cnf
```

Si el cliente no encuentra el socket, descomenta la línea `socket` con la ruta de tu distribución (Debian usa `/run/mysqld/mysqld.sock`; openSUSE, `/run/mysql/mysql.sock`).

El script le pasa este archivo a cada comando con `--defaults-extra-file`. Pruébalo a mano:

```bash
sudo mariadb --defaults-extra-file=/etc/mariadb-backup/backup.cnf -e 'SHOW DATABASES'
```

`--defaults-extra-file` debe ser **la primera opción** de la línea de comandos; si va después de otra, el cliente lo ignora o falla.

## 3. Las opciones de mariadb-dump

Antes del script, vale la pena entender qué le vamos a pedir a `mariadb-dump`, porque los valores por defecto no bastan para un respaldo completo:

| Opción                              | Qué hace                                                                                     |
|-------------------------------------|----------------------------------------------------------------------------------------------|
| `--single-transaction`              | Abre una transacción `REPEATABLE READ` y vuelca todo desde esa foto. Consistente para InnoDB **sin bloquear** escrituras. |
| `--quick`                           | Lee fila por fila en lugar de cargar cada tabla completa en memoria.                        |
| `--routines`                        | Incluye procedimientos y funciones almacenadas (no van por defecto).                       |
| `--triggers`                        | Incluye triggers (van por defecto, pero mejor explícito).                                   |
| `--events`                          | Incluye eventos del event scheduler (no van por defecto).                                   |
| `--hex-blob`                        | Escribe columnas binarias en hexadecimal, inmune a problemas de codificación.               |
| `--default-character-set=utf8mb4`   | Evita que los acentos y emojis se corrompan en el viaje.                                    |

Lo que **no** usamos: `--all-databases`. Un solo archivo con todo es cómodo hasta que necesitas restaurar una base de 200 MB que está enterrada en un volcado de 40 GB. El script vuelca cada base por separado.

Tampoco volcamos la base `mysql` directamente. Sus tablas internas cambian entre versiones, y restaurarlas sobre un servidor más nuevo puede romperlo. En su lugar, el script genera un `_grants.sql` con sentencias `CREATE USER` y `GRANT`, que son portables.

---

## 4. El script

Guárdalo como `/usr/local/sbin/mariadb-backup.py`:

```python
#!/usr/bin/env python3
"""Respaldo lógico de MariaDB: un archivo .sql.gz por base de datos."""

import argparse
import fcntl
import gzip
import hashlib
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

EXCLUDE = {"information_schema", "performance_schema", "sys", "mysql"}
DUMP_OPTS = [
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--default-character-set=utf8mb4",
]
STAMP = "%Y%m%d-%H%M%S"
CHUNK = 1024 * 1024

log = logging.getLogger("mariadb-backup")


class BackupError(Exception):
    pass


def find_binary(*names):
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    raise BackupError(f"no se encontró ninguno de: {', '.join(names)}")


def run_query(client, defaults_file, sql):
    """Ejecuta SQL con el cliente mariadb y devuelve las filas como listas."""
    result = subprocess.run(
        [client, f"--defaults-extra-file={defaults_file}", "-N", "-B", "-r", "-e", sql],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise BackupError(result.stderr.strip())
    return [line.split("\t") for line in result.stdout.splitlines()]


def list_databases(client, defaults_file):
    rows = run_query(client, defaults_file, "SHOW DATABASES")
    return [row[0] for row in rows if row[0] not in EXCLUDE]


def dump_grants(client, defaults_file, dest):
    """Genera CREATE USER + GRANT para cada usuario (sin roles ni cuentas internas)."""
    users = run_query(
        client, defaults_file,
        "SELECT user, host FROM mysql.user "
        "WHERE is_role = 'N' AND user NOT IN ('', 'mariadb.sys')",
    )
    if not users:
        return
    sql = ""
    for user, host in users:
        account = "'{}'@'{}'".format(user.replace("'", "''"), host.replace("'", "''"))
        sql += f"SHOW CREATE USER {account}; SHOW GRANTS FOR {account};"
    rows = run_query(client, defaults_file, sql)
    dest.write_text("".join(f"{row[0]};\n" for row in rows))


def dump_database(dump_bin, defaults_file, db, dest):
    """Vuelca una base a dest (.sql.gz). Escribe primero a .partial y renombra al final."""
    partial = dest.with_name(dest.name + ".partial")
    cmd = [dump_bin, f"--defaults-extra-file={defaults_file}", *DUMP_OPTS, db]
    tail = b""

    with tempfile.TemporaryFile() as err:
        with open(partial, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6) as gz:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err)
            for chunk in iter(lambda: proc.stdout.read(CHUNK), b""):
                gz.write(chunk)
                tail = (tail + chunk)[-512:]
            proc.stdout.close()
            rc = proc.wait()
        err.seek(0)
        stderr = err.read().decode(errors="replace").strip()

    if rc != 0:
        partial.unlink(missing_ok=True)
        raise BackupError(f"mariadb-dump salió con código {rc}: {stderr}")
    if b"-- Dump completed" not in tail:
        partial.unlink(missing_ok=True)
        raise BackupError("el volcado no terminó con '-- Dump completed'")
    if stderr:
        log.warning("%s: %s", db, stderr)

    os.replace(partial, dest)


def sha256sum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prune(root, keep_days, current):
    cutoff = datetime.now() - timedelta(days=keep_days)
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry == current:
            continue
        try:
            taken = datetime.strptime(entry.name, STAMP)
        except ValueError:
            continue  # no es un directorio creado por este script
        if taken < cutoff:
            log.info("eliminando respaldo antiguo %s", entry.name)
            shutil.rmtree(entry)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--defaults-file", default="/etc/mariadb-backup/backup.cnf")
    parser.add_argument("--dest", type=Path, default=Path("/var/backups/mariadb"))
    parser.add_argument("--keep-days", type=int, default=14)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    os.umask(0o077)
    args.dest.mkdir(parents=True, exist_ok=True)

    lock = open(args.dest / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.error("otro respaldo está en curso")
        return 1

    try:
        client = find_binary("mariadb", "mysql")
        dump_bin = find_binary("mariadb-dump", "mysqldump")
        databases = list_databases(client, args.defaults_file)
    except BackupError as exc:
        log.error("%s", exc)
        return 1

    run_dir = args.dest / datetime.now().strftime(STAMP)
    run_dir.mkdir()
    log.info("respaldando %d bases en %s", len(databases), run_dir)

    failed = []
    try:
        dump_grants(client, args.defaults_file, run_dir / "_grants.sql")
    except BackupError as exc:
        log.error("usuarios y permisos: %s", exc)
        failed.append("_grants")

    for db in databases:
        dest = run_dir / f"{db}.sql.gz"
        try:
            dump_database(dump_bin, args.defaults_file, db, dest)
        except BackupError as exc:
            log.error("%s: %s", db, exc)
            failed.append(db)
            continue
        log.info("%s: %.1f MiB", db, dest.stat().st_size / 2**20)

    files = sorted(p for p in run_dir.iterdir() if p.is_file())
    (run_dir / "SHA256SUMS").write_text(
        "".join(f"{sha256sum(p)}  {p.name}\n" for p in files)
    )

    if failed:
        log.error("fallaron: %s — no se borran respaldos antiguos", ", ".join(failed))
        return 1

    prune(args.dest, args.keep_days, run_dir)
    log.info("respaldo completo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

```bash
sudo chmod 700 /usr/local/sbin/mariadb-backup.py
```

### Qué hace y por qué

**Lista las bases en cada corrida.** `SHOW DATABASES` en lugar de una lista fija: si mañana alguien crea una base nueva, entra al respaldo sin tocar nada. `EXCLUDE` deja fuera las bases virtuales (`information_schema`, `performance_schema`, `sys`) y `mysql`, que se cubre con `_grants.sql`.

**Transmite en bloques.** `dump_database()` lee la salida de `mariadb-dump` de a 1 MiB y la escribe directo al `GzipFile`. El volcado nunca vive completo en memoria, así que una base de 30 GB consume lo mismo que una de 30 MB.

**Detecta volcados truncados, de dos formas.** Primero, revisa el código de salida de `mariadb-dump` — justo lo que el pipeline de shell pierde. Segundo, guarda los últimos 512 bytes del flujo y busca la marca `-- Dump completed` que `mariadb-dump` escribe solo cuando termina bien. Si cualquiera de las dos falla, el archivo se descarta.

**Escribe a `.partial` y renombra.** El volcado se escribe a `tienda.sql.gz.partial` y solo al terminar se renombra con `os.replace()`, que es atómico. Nunca existe un `tienda.sql.gz` a medias: o está completo, o no está.

**stderr a un archivo temporal.** Si `stderr` fuera un `PIPE` que nadie lee mientras leemos `stdout`, un proceso que escribe muchas advertencias llenaría el buffer del pipe y se bloquearía para siempre. Mandarlo a un `TemporaryFile` elimina ese riesgo. Si el volcado sale bien pero hubo advertencias, se registran.

**Una base que falla no detiene las demás.** Se registra el error, se sigue con la siguiente y el script termina con código 1. Así systemd marca el servicio como fallido.

**Rotación solo si todo salió bien.** `prune()` borra los directorios con más de `--keep-days` días, pero únicamente cuando **ninguna** base falló. Si los respaldos llevan una semana fallando sin que nadie lo note, lo último que quieres es que el script borre los últimos buenos. Además, solo borra directorios cuyo nombre coincide con el formato de fecha del script; cualquier otra cosa en `/var/backups/mariadb` queda intacta.

**Un solo respaldo a la vez.** `fcntl.flock()` sobre `.lock` evita que dos ejecuciones se pisen si una se alarga más que el intervalo del timer. El kernel libera el lock automáticamente al terminar el proceso, incluso si muere de forma abrupta.

**Permisos restrictivos.** `os.umask(0o077)` hace que todo lo creado sea legible solo por el dueño. Un respaldo contiene todos tus datos y los hashes de contraseña de todos los usuarios: trátalo como tal.

**Checksums compatibles con `sha256sum`.** `SHA256SUMS` usa el mismo formato que la herramienta estándar, así que se verifica con `sha256sum -c` en cualquier máquina, sin el script.

---

## 5. Primera ejecución

```bash
sudo /usr/local/sbin/mariadb-backup.py
```

```
INFO respaldando 3 bases en /var/backups/mariadb/20260928-185715
INFO radius: 412.3 MiB
INFO tienda: 18.7 MiB
INFO wiki: 2.1 MiB
INFO respaldo completo
```

El resultado:

```
/var/backups/mariadb/
├── .lock
└── 20260928-185715/
    ├── _grants.sql
    ├── SHA256SUMS
    ├── radius.sql.gz
    ├── tienda.sql.gz
    └── wiki.sql.gz
```

Verifica la integridad:

```bash
cd /var/backups/mariadb/20260928-185715 && sha256sum -c SHA256SUMS
```

Las opciones se pueden cambiar sin editar el script:

```bash
sudo /usr/local/sbin/mariadb-backup.py --dest /srv/backups/db --keep-days 30
```

---

## 6. Programarlo con systemd

Un timer de systemd tiene ventajas claras sobre cron: los logs quedan en el journal, `Persistent=true` ejecuta el respaldo perdido si el servidor estaba apagado a la hora programada, y el servicio puede aislarse del resto del sistema.

`/etc/systemd/system/mariadb-backup.service`:

```ini
[Unit]
Description=Respaldo lógico de MariaDB
After=mariadb.service
Requires=mariadb.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mariadb-backup.py
Nice=10
IOSchedulingClass=idle
ProtectSystem=strict
ReadWritePaths=/var/backups/mariadb
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
```

`/etc/systemd/system/mariadb-backup.timer`:

```ini
[Unit]
Description=Respaldo diario de MariaDB

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

- `Nice` e `IOSchedulingClass=idle` hacen que el respaldo ceda CPU y disco a la base de datos si hay carga.
- `ProtectSystem=strict` monta todo el sistema de archivos como solo lectura para este servicio, excepto `ReadWritePaths`. Si un error en el script intentara escribir en otro lado, fallaría.
- `RandomizedDelaySec` evita que varios servidores con la misma configuración golpeen el almacenamiento compartido al mismo segundo.

Actívalo:

```bash
sudo mkdir -p /var/backups/mariadb
sudo systemctl daemon-reload
sudo systemctl enable --now mariadb-backup.timer
```

Comprueba la próxima ejecución, lanza una manual y revisa el log:

```bash
systemctl list-timers mariadb-backup.timer
sudo systemctl start mariadb-backup.service
journalctl -u mariadb-backup.service -n 20
```

### Enterarte cuando falla

Un respaldo que falla en silencio es casi igual de malo que no tener respaldo. Como el script sale con código 1 ante cualquier error, systemd marca el servicio como `failed`, y puedes engancharle una notificación con `OnFailure=`:

```ini
[Unit]
OnFailure=notify-failure@%n.service
```

Donde `notify-failure@.service` es un servicio tuyo que manda un correo, un mensaje de Telegram o un webhook. Si ya tienes Zabbix o Prometheus, otra opción es monitorear la antigüedad del directorio más reciente en `/var/backups/mariadb`: alerta si supera 26 horas.

---

## 7. Restaurar

Un respaldo vale lo que su restauración. Estos son los casos habituales.

### Una base en el mismo servidor

Los volcados no incluyen `CREATE DATABASE` (no usamos `--databases`), así que primero hay que crearla. Eso es a propósito: te deja restaurar con el nombre que quieras.

```bash
cd /var/backups/mariadb/20260928-185715
sha256sum -c SHA256SUMS

sudo mariadb -e 'CREATE DATABASE tienda'
gunzip -c tienda.sql.gz | sudo mariadb tienda
```

### Una base con otro nombre, para inspeccionarla

El caso más común en la vida real: alguien borró registros ayer y hay que recuperarlos sin pisar la base de producción.

```bash
sudo mariadb -e 'CREATE DATABASE tienda_ayer'
gunzip -c tienda.sql.gz | sudo mariadb tienda_ayer
```

Ahora puedes comparar y copiar solo lo necesario con un `INSERT ... SELECT` entre `tienda_ayer` y `tienda`.

Un gotcha que encontré probando esto: si algún trigger, vista o procedimiento se creó con el nombre de la base escrito explícitamente (`CREATE TRIGGER tienda.t ...`), el volcado conserva ese texto tal cual, y al restaurar en `tienda_ayer` el objeto intenta crearse en `tienda`. La restauración falla con `Trigger 'tienda.t' already exists`. Los objetos definidos sin prefijo (lo normal cuando se crean con `USE tienda`) se restauran sin problema en cualquier nombre.

### Solo una tabla

Como el volcado es texto, puedes extraer una sola tabla. El bloque de cada tabla empieza con un comentario `-- Table structure for table` y termina donde empieza el siguiente:

```bash
gunzip -c tienda.sql.gz \
  | sed -n '/^-- Table structure for table `productos`/,/^-- Table structure for table/p' \
  > productos.sql
```

Revisa el archivo antes de aplicarlo: contiene un `DROP TABLE IF EXISTS`. Aplícalo sobre la base de pruebas, no sobre producción.

### Usuarios y permisos en un servidor nuevo

`_grants.sql` contiene `CREATE USER` y `GRANT` de todas las cuentas, incluyendo `root@localhost` y el propio usuario `backup`, que en un servidor nuevo ya existen. Edita el archivo, deja solo las cuentas de aplicación y aplícalo:

```bash
sudo mariadb < _grants.sql
```

Las contraseñas van como hash (`IDENTIFIED BY PASSWORD '*...'`), así que los usuarios conservan su contraseña sin que el archivo la contenga en claro. Aun así, esos hashes se pueden atacar por fuerza bruta: el archivo es sensible.

### Prueba la restauración de verdad

Programa una prueba periódica — mensual está bien — en una máquina o contenedor aparte: toma el último respaldo, verifica checksums, restaura todo y corre un par de consultas que confirmen que los datos tienen sentido (conteo de filas de tablas grandes, fecha del registro más reciente). Es la única forma de saber que el procedimiento funciona antes de necesitarlo.

---

## 8. Sacar los respaldos del servidor

Un respaldo en el mismo disco que la base de datos protege contra un `DELETE` sin `WHERE`, pero no contra un disco muerto, un ransomware o un servidor comprometido. Necesitas al menos una copia en otro lugar.

Lo más simple es un segundo timer que corra después del respaldo y copie el directorio con `rsync` a otro servidor o con `rclone` a almacenamiento de objetos (S3, Backblaze B2, MinIO):

```bash
rclone sync /var/backups/mariadb remoto:respaldos-mariadb --exclude .lock
```

Dos recomendaciones:

- **Cifra antes de subir** si el destino no es tuyo. `age` o `gpg` con una clave pública: el servidor puede cifrar, pero solo quien tiene la clave privada (que no vive en el servidor) puede descifrar.
- **Que el servidor no pueda borrar la copia remota.** Si un atacante toma el servidor, lo primero que hará es borrar los respaldos que alcance. Usa credenciales de solo escritura, o activa versionado / object lock en el bucket.

---

## Consideraciones de producción

**`--single-transaction` solo es consistente para InnoDB.** Las tablas MyISAM o Aria no son transaccionales: se vuelcan tal como estén en ese instante, y si cambian durante el respaldo, el resultado puede ser inconsistente con el resto. Revisa qué motores usas:

```sql
SELECT table_schema, engine, COUNT(*)
  FROM information_schema.tables
 WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
 GROUP BY table_schema, engine;
```

Si aparece algo distinto de InnoDB en una base importante, conviértelo con `ALTER TABLE ... ENGINE=InnoDB`.

**Evita cambios de esquema durante el respaldo.** Un `ALTER TABLE`, `RENAME TABLE` o `TRUNCATE TABLE` que ocurra mientras corre `--single-transaction` puede hacer que el volcado de esa tabla salga vacío o falle. Programa las migraciones lejos de la ventana de respaldo.

**Punto en el tiempo.** Un respaldo diario significa que puedes perder hasta 24 horas de datos. Si eso no es aceptable, activa el binary log (`log_bin`) y archívalo: con el último volcado más los binlogs posteriores, `mariadb-binlog` reproduce los cambios hasta el minuto anterior al desastre. Añade `--master-data=2` a `DUMP_OPTS` para que el volcado registre la posición del binlog en la que fue tomado (requiere el privilegio `RELOAD`).

**Cuándo pasar a `mariadb-backup`.** Si una base pasa de unas decenas de GB, o restaurarla toma más tiempo del que el negocio tolera, cambia a respaldo físico con `mariadb-backup`. La estructura del script sirve igual: cambia la función de volcado, conserva el lock, los checksums, la rotación y el timer.

**Espacio en disco.** Con retención de 14 días, necesitas unas 15 veces el tamaño de un respaldo comprimido (14 más el que se está creando). Un SQL comprimido con gzip suele ocupar entre el 10% y el 25% del tamaño de los datos en disco, según qué tan repetitivos sean. Monitorea el espacio libre del volumen de respaldos igual que el de la base.
