# Directus Extension Deploy

มีสองเป้าหมาย:

- **Portainer / Docker host** → `deploy-extension.sh` (รันบน server, ไม่ restart Directus)
- **Fly.io (`bis-backoffice-dev`)** → `deploy-extension-fly.sh` (อัปโหลดเข้า volume แล้ว restart machine)

---

# A) Fly.io

Directus บน Fly เก็บ extensions ที่ volume `/directus/data/extensions`

ต้อง login แล้ว:

```bash
fly auth login
```

จากเครื่องที่มี `fly` CLI:

```bash
cd db-selective-migration/docker
chmod +x deploy-extension-fly.sh

./deploy-extension-fly.sh deploy ../directus-extensions-bb-dev/bis-report
./deploy-extension-fly.sh list
./deploy-extension-fly.sh list-backups bis-report
./deploy-extension-fly.sh rollback bis-report 20260817-124139
```

ค่าเริ่มต้น:

| Env | Default |
|-----|---------|
| `FLY_APP` | `bis-backoffice-dev` |
| `DIRECTUS_EXTENSIONS_DIR` | `/directus/data/extensions` |
| `DIRECTUS_EXTENSIONS_BACKUP_DIR` | `/directus/data/extensions-backup` |

ใส่ `--no-restart` ถ้าไม่ต้องการ restart machine (พึ่ง `EXTENSIONS_AUTO_RELOAD`)

---

# B) Portainer / Docker host (private network / no restart step)

สคริปต์นี้ deploy extension ไปยังโฟลเดอร์ที่ Directus mount ใช้งาน
**ไม่ restart Directus** (ระบบของคุณ restart อัตโนมัติอยู่แล้ว)

## 1) ตั้งค่าโฟลเดอร์บน server

แนะนำใช้ host path คงที่:

```bash
sudo mkdir -p /opt/bis/directus-extensions /opt/bis/directus-extensions-backup
```

ใน Portainer stack ตั้ง env:

```env
DIRECTUS_EXTENSIONS_DIR=/opt/bis/directus-extensions
```

และแก้ volume ของ `directus`:

```yaml
volumes:
  - ${DIRECTUS_EXTENSIONS_DIR:-/opt/bis/directus-extensions}:/directus/extensions:ro
```

## 2) Seed ครั้งแรก (จาก snapshot ใน repo)

บน server (หลัง git pull):

```bash
cd db-selective-migration/docker
chmod +x deploy-extension.sh pack-extension.sh

export DIRECTUS_EXTENSIONS_DIR=/opt/bis/directus-extensions
./deploy-extension.sh seed ../directus-extensions-bb-dev
```

## 3) Deploy extension ใหม่

### จาก zip

```bash
./pack-extension.sh ../directus-extensions-bb-dev/bis-test-file /tmp/bis-test-file.zip
./deploy-extension.sh deploy bis-test-file /tmp/bis-test-file.zip
```

### จากโฟลเดอร์โดยตรง

```bash
./deploy-extension.sh deploy-dir bis-test-file ../directus-extensions-bb-dev/bis-test-file
```

## 4) Rollback

```bash
./deploy-extension.sh list-backups bis-test-file
./deploy-extension.sh rollback bis-test-file 20260702-153045
```

## 5) คำสั่งที่มี

| คำสั่ง | ความหมาย |
|--------|----------|
| `deploy <name> <zip>` | deploy จาก zip |
| `deploy-dir <name> <dir>` | deploy จากโฟลเดอร์ |
| `rollback <name> [timestamp]` | rollback ไป backup ล่าสุด/ระบุเวลา |
| `list` | ดู extension ที่ติดตั้ง |
| `list-backups <name>` | ดู backup ที่มี |
| `seed [source-dir]` | copy ทุก extension จาก snapshot |

## 6) Zip format ที่รองรับ

```text
bis-test-file.zip
  bis-test-file/
    package.json
    dist/index.js
```

หรือ root เป็น extension เดียว:

```text
bis-test-file.zip
  package.json
  dist/index.js
```

## 7) Private network workflow

รันสคริปต์บน server ใน network เดียวกับ Portainer:

```text
build extension -> pack zip -> deploy-extension.sh deploy ...
```

ไม่ต้อง expose Portainer webhook ออก internet

## 8) หมายเหตุ

- script จะ validate `package.json` และไฟล์ `directus:extension.path`
- backup เก็บที่ `DIRECTUS_EXTENSIONS_BACKUP_DIR` (default 5 ชุดล่าสุดต่อ extension)
- หลัง deploy รอ Directus auto-restart แล้วเช็ก `/server/health`
