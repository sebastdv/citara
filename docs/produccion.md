# Producción

Citara corre en un VPS con Docker Compose: Postgres, Redis, la API, el worker y Caddy, que
pone el TLS. Las imágenes se construyen en el propio servidor y un despliegue se lanza a mano
desde tu máquina. Esta guía va desde un servidor vacío hasta el primer negocio atendiendo.

| Pieza | Dónde |
|---|---|
| Compose de producción | `deploy/compose.yml` |
| Proxy y TLS | `deploy/caddy/Caddyfile` (Let's Encrypt automático) |
| Operaciones en el servidor | `deploy/server.sh` (despliegue, rollback, respaldos, restauración) |
| Desde tu máquina | `deploy/deploy.sh`, `deploy/backup-pull.sh` |
| CLI contra producción | `deploy/citara` |
| Secretos | `/opt/citara/.env.production` (plantilla: `.env.production.example`) |
| Respaldos | `/opt/citara/backups` |

## 1. Antes de empezar

- **Un VPS con Ubuntu 24.04.** Con 2 vCPU y 4 GB alcanza (Hetzner CX22 o similar). La
  imagen se compila en el servidor; con menos de 4 GB, el swap del paso 2 es obligatorio.
- **Un dominio** con un registro **A** apuntando a la IP del VPS. Compruébalo antes del
  primer despliegue: si Caddy pide el certificado sin DNS, Let's Encrypt lo rechaza, y
  tras varios rechazos te bloquea un rato.

  ```bash
  dig +short citas.tudominio.com
  ```

- Tu llave SSH pública en el VPS (la mayoría de proveedores la piden al crearlo).

## 2. Preparar el servidor

Como `root`, una sola vez.

Actualizaciones, y que las de seguridad se instalen solas:

```bash
apt update && apt -y upgrade && apt -y install unattended-upgrades git
```

Un usuario para operar, con tu llave SSH:

```bash
adduser --disabled-password --gecos "" citara && mkdir -p /home/citara/.ssh && cp ~/.ssh/authorized_keys /home/citara/.ssh/ && chown -R citara:citara /home/citara/.ssh && chmod 700 /home/citara/.ssh
```

SSH solo con llave:

```bash
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-citara.conf && systemctl reload ssh
```

Firewall: entra solo SSH, HTTP y HTTPS. **No bloquees la salida** (`ufw default deny
outgoing`): Docker publica los puertos a través de la red de sus contenedores, y con la
salida bloqueada las conexiones quedan colgadas sin ningún error.

```bash
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

Swap de 2 GB, para que compilar la imagen no se quede sin memoria:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Docker, desde su repositorio oficial (los pasos vigentes están en
[docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)).
Instala `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin` y
`docker-compose-plugin`, y después da acceso al usuario:

```bash
usermod -aG docker citara
```

Estar en el grupo `docker` equivale a ser root en ese servidor (se puede montar `/` en un
contenedor). Por eso `citara` no lleva sudo, pero su llave SSH es tan sensible como la de root.

La carpeta de la app, del usuario `citara`:

```bash
mkdir -p /opt/citara && chown citara:citara /opt/citara
```

Ojo: Docker publica los puertos de los contenedores por encima de `ufw`. Por eso el compose
solo publica los de Caddy (80 y 443); Postgres, Redis y la API quedan en la red interna.

## 3. Traer el código

Como `citara` (`ssh citara@<ip>`). El repo es privado: el servidor entra con una **llave de
despliegue** de solo lectura.

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy -C "citara-vps"
```

```bash
cat ~/.ssh/github_deploy.pub
```

Pega esa llave en GitHub → el repo → Settings → Deploy keys → Add deploy key, **sin**
permiso de escritura. Luego:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

```bash
git clone git@github.com:sebastdv/citara.git /opt/citara
```

## 4. Secretos

```bash
cd /opt/citara && cp .env.production.example .env.production && chmod 600 .env.production
```

Completa `.env.production`. Las contraseñas, solo con letras y números (van dentro de URLs
de conexión):

```bash
openssl rand -hex 32
```

`DB_ENCRYPTION_KEY` cifra los tokens de Meta y Google guardados en la base. **Guárdala
también en tu gestor de contraseñas**: un respaldo sin esa llave no permite leer esos tokens.

```bash
openssl rand -base64 32
```

`server.sh` se niega a desplegar si el archivo no tiene permisos 600 o si alguna contraseña
es corta o lleva caracteres que romperían las URLs.

## 5. Primer despliegue

Desde **tu máquina**, en la carpeta del repo. El servidor construye desde GitHub: lo que
despliegues tiene que estar subido.

```bash
export CITARA_SSH=citara@citas.tudominio.com
```

```bash
./deploy/deploy.sh main
```

Qué hace, en orden (ver `deploy/server.sh`):

1. `git fetch` y checkout del commit en `/opt/citara`.
2. Construye la imagen `citara:<sha>`; si ese sha ya tiene imagen, no recompila.
3. Levanta Postgres y Redis y espera a que estén sanos.
4. **Respalda la base** (`backups/pre-deploy-<fecha>-<sha>.dump`).
5. **Migra** con la imagen nueva y fija la contraseña de `citara_app` desde
   `APP_DB_PASSWORD`. Si una migración falla, se detiene: la versión anterior sigue corriendo.
6. Cambia la API y el worker a la versión nueva.
7. Espera a que `/healthz` responda bien y a que el worker siga en pie sin reiniciarse. Si
   no pasa, **vuelve solo a la versión anterior** (y al checkout de esa versión) y lo informa.

El despliegue corre en el servidor desacoplado de tu sesión: si se corta el SSH o pulsas
Ctrl-C, solo dejas de mirar y la operación termina igual. Su salida queda en
`/opt/citara/.deploy-last.log`. Si GitHub no responde, el despliegue se detiene en vez de
desplegar lo último que se había descargado.

El primer despliegue tarda unos minutos (compila y Caddy saca el certificado). Después crea
tu operador del panel, en el servidor:

```bash
cd /opt/citara && ./deploy/citara operator create tu@correo.com
```

## 6. Respaldo nocturno

En el servidor, como `root` (el usuario `citara` no tiene sudo, a propósito):

```bash
cp /opt/citara/deploy/systemd/citara-backup.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now citara-backup.timer
```

Pruébalo una vez a mano y mira que aparezca el archivo:

```bash
systemctl start citara-backup.service && ls -lh /opt/citara/backups
```

Corre a las 03:30 de Bogotá. Se quedan **14 diarios y 8 semanales** (el de cada domingo); los
de antes de cada despliegue se borran a los 30 días. Viven **en el disco del VPS**: si se
pierde el servidor, se pierden con él. Trae una copia a tu máquina de vez en cuando:

```bash
./deploy/backup-pull.sh
```

Queda en `backups/` (ignorado por git). Tiene datos de los clientes de tus negocios:
guárdalo en un disco cifrado.

## 7. Comprobar que todo quedó bien

- [ ] `https://<dominio>/healthz` responde `{"status":"ok",…}` y el candado del navegador
      muestra un certificado válido.
- [ ] `https://<dominio>/panel` te pide entrar, y entras.
- [ ] Desde fuera solo responden 22, 80 y 443: `nc -zv <ip> 5432` y `nc -zv <ip> 6379`
      tienen que fallar.
- [ ] `./deploy/deploy.sh status` muestra los cinco servicios en marcha.
- [ ] Hay un respaldo en `/opt/citara/backups`.

## 8. Conectar Meta y Google

- **Webhook de WhatsApp** (app de Meta → WhatsApp → Configuración):
  `https://<dominio>/webhooks/whatsapp`, con el `META_VERIFY_TOKEN` de `.env.production`.
- **Google OAuth** (Google Cloud → Credenciales → tu cliente web), URI de redirección:
  `https://<dominio>/connect/google/callback`.
- La política de privacidad y el dominio que piden las verificaciones de Meta y Google son
  este mismo dominio.

## 9. Operar

| Qué | Cómo |
|---|---|
| Desplegar la punta de `main` | `./deploy/deploy.sh main` |
| Desplegar una versión concreta | `./deploy/deploy.sh <sha o tag>` |
| Volver a la anterior | `./deploy/deploy.sh rollback` (no recompila; alterna entre las dos últimas) |
| Estado y últimos respaldos | `./deploy/deploy.sh status` (avisa si el último respaldo nocturno tiene más de 26 h) |
| Logs | `./deploy/deploy.sh logs api` (o `worker`, `caddy`, `postgres`) |
| CLI de la app | en el servidor: `./deploy/citara tenant list`, `./deploy/citara operator …` |

**Un negocio nuevo** se sigue dando de alta como en local (ver
[desarrollo-local.md](desarrollo-local.md)), con `./deploy/citara` en el servidor. El YAML del
negocio va en `/opt/citara/clientes`:

```bash
scp clientes/peluqueria-ana.yaml citara@citas.tudominio.com:/opt/citara/clientes/
```

```bash
./deploy/citara tenant:apply clientes/peluqueria-ana.yaml
```

El banco de regresión del agente también corre ahí (`./deploy/citara agent:bench
clientes/peluqueria-ana.yaml`), sobre su propia base `citara_bench`, y deja el resultado en
`/opt/citara/bench-results`, que es donde `tenant:apply` lo busca.

Un despliegue corta la API unos segundos mientras cambia de versión. Meta reintenta los
webhooks que no recibieron respuesta, así que no se pierde ningún mensaje.

## 10. La regla de las migraciones

**Toda migración tiene que funcionar con el código de la versión anterior.** Rollback no
revierte migraciones: vuelve el código, y ese código va a correr sobre la base ya migrada.

- Columna nueva: con `DEFAULT` o nullable. El código viejo no la conoce y no la escribe.
- Quitar o renombrar una columna o tabla: en dos despliegues. Primero el código deja de
  usarla; en un despliegue posterior, la migración la quita.
- Una restricción nueva (`NOT NULL`, `CHECK`) que el código viejo podría violar: primero el
  código que la respeta, después la restricción.

## 11. Restaurar un respaldo

En el servidor:

```bash
cd /opt/citara && ./deploy/server.sh restore backups/<archivo>.dump
```

Restaura en una base aparte (si el respaldo está dañado, se detiene sin tocar nada), te muestra cuántos negocios, conversaciones, mensajes y citas
hay ahora y cuántos en el respaldo, y solo con tu confirmación (escribir `restaurar`) la pone
en lugar de la actual. La base actual queda guardada como `citara_prev_<fecha>`; cuando
confirmes que todo está bien, el propio comando te dice cómo borrarla. Las colas de Redis se
vacían: lo que tenían se refería a la base que sale. Después corre las migraciones, por si
el respaldo es de antes de la última, y vuelve a levantar la app. Si algo falla a mitad, la
vuelve a levantar igual y te muestra qué bases quedaron.

Para restaurar en un servidor nuevo: pasos 2 a 5, y antes del primer despliegue copia el
archivo con `scp` a `/opt/citara/backups/`. Despliega y luego restaura (la restauración
pone el respaldo al día con las migraciones del código desplegado). Necesitas la misma
`DB_ENCRYPTION_KEY` que tenía el servidor viejo.

## 12. Si algo sale mal

- **«Hay otra operación en curso»:** un despliegue anterior se cortó a la mitad. Si de
  verdad no hay otro corriendo, borra `/opt/citara/.deploy-lock`.
- **La versión nueva no arranca:** el despliegue ya volvió solo a la anterior; mira el
  porqué con `./deploy/deploy.sh logs api` o `logs worker`.
- **No sale el certificado:** casi siempre es el DNS (paso 1) o el puerto 80 cerrado
  (Let's Encrypt valida por ahí). `./deploy/deploy.sh logs caddy` lo dice.
- **Disco lleno:** `docker system df` muestra qué ocupa. Se guardan las imágenes de las
  últimas 5 versiones; `docker builder prune` libera la caché de compilación.
- **Probar cambios del despliegue sin servidor:** `./deploy/smoke/smoke.sh` levanta todo en
  tu máquina (proyecto `citara-smoke`, con certificado interno), lo ejercita y lo borra.
