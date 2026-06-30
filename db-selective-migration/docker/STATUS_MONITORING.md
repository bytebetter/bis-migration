# BIS Status Monitoring (Windows File Server + Docker)

เอกสารนี้สรุปวิธีทำหน้าเว็บสถานะรวมของระบบ:
- Backoffice
- Directus
- PostgreSQL
- Windows File Share (SMB) ที่ business logic ใช้อ่าน/เขียน

## 1) Mount Windows share บน host

> ทำบนเครื่อง Linux ที่รัน Docker

สร้าง credentials file:

```bash
sudo mkdir -p /etc/smbcredentials
sudo sh -c 'cat > /etc/smbcredentials/bis-share.cred <<EOF
username=YOUR_USER
password=YOUR_PASSWORD
domain=YOUR_DOMAIN
EOF'
sudo chmod 600 /etc/smbcredentials/bis-share.cred
```

เพิ่มใน `/etc/fstab`:

```fstab
//10.20.30.50/BISShare  /mnt/bis-shared  cifs  rw,vers=3.1.1,credentials=/etc/smbcredentials/bis-share.cred,iocharset=utf8,uid=1000,gid=1000,file_mode=0660,dir_mode=0770,_netdev,x-systemd.automount,x-systemd.idle-timeout=600  0  0
```

ทดสอบ mount:

```bash
sudo mkdir -p /mnt/bis-shared
sudo mount -a
mount | rg bis-shared
touch /mnt/bis-shared/.rw-test && rm /mnt/bis-shared/.rw-test
```

## 2) รัน Docker Compose

จากโฟลเดอร์ `db-selective-migration`:

```bash
docker compose --env-file .env.postgres --env-file .env.directus --env-file .env.backoffice -f docker/docker-compose.yml up -d
```

ถ้าไม่ได้ใช้ `/mnt/bis-shared` ให้กำหนดตัวแปร `SMB_SHARE_MOUNT` ก่อนรัน:

```bash
export SMB_SHARE_MOUNT=/your/mounted/share/path
```

## 3) หน้าเว็บสถานะ

- Uptime Kuma: `http://127.0.0.1:3001`

เพิ่ม Monitors:
- HTTP: `http://backoffice:3000`
- HTTP: `http://directus:8055/server/health`
- TCP Port: `postgres:5432`
- HTTP: `http://shared-probe:8081/health`

## 4) สิ่งที่เพิ่มใน compose

- `directus` mount shared path เข้า container ที่ `/data/shared`
- `shared-probe` service เช็ก read/write จริงบน share แล้วเปิด health endpoint
- `uptime-kuma` เป็นหน้า dashboard รวม + ตั้ง alert ได้

## 5) ข้อแนะนำความปลอดภัย

- จำกัดการเข้าถึงพอร์ต 3001 (Kuma) เฉพาะเครือข่ายที่ต้องใช้
- ใช้ credentials file permission 600 เท่านั้น
- ถ้าโฟลเดอร์ไหนไม่ต้องเขียน ให้ mount เป็น `:ro`
