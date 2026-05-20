# Directus extensions snapshot — bb-dev-cluster

โฟลเดอร์นี้เป็น snapshot ของ `/directus/extensions` จาก Directus บน Kubernetes:

- **context:** `bb-dev-cluster`
- **namespace:** `bis-backoffice-dev`

ใช้เป็นต้นทางคัดลอกไปยัง Directus ที่รันใน Docker / Portainer (volume `/directus/extensions`)

อัปเดตได้ด้วย:

```bash
POD="$(kubectl --context bb-dev-cluster -n bis-backoffice-dev get pods -l app=directus -o jsonpath='{.items[0].metadata.name}')"
kubectl --context bb-dev-cluster -n bis-backoffice-dev cp "${POD}:/directus/extensions/." ./directus-extensions-bb-dev/
```

## รายการโฟลเดอร์

| Directory |
|-----------|
| bis-api |
| bis-birads-mass |
| bis-bulk-delete |
| bis-delete-api |
| bis-pacs-sync-api |
| bis-pacs-sync-manager |
| bis-pricing-bundle |
| bis-report |
| bis-sign-to-pacs-api |
| bis-status-hook |
| directus-extension-sync |
| directus-migration-bundle |
